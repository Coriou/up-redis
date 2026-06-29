import { describe, expect, test } from "bun:test"
import { parseRedisUrl, RespParser } from "../../src/redis-pattern"

describe("RespParser", () => {
	test("parses a normal shallow pmessage array", () => {
		const parser = new RespParser()
		const buf = Buffer.from("*4\r\n$8\r\npmessage\r\n$2\r\np*\r\n$2\r\nch\r\n$2\r\nhi\r\n")
		expect(parser.push(buf)).toEqual([["pmessage", "p*", "ch", "hi"]])
	})

	test("throws on pathologically deep nesting instead of overflowing the stack", () => {
		const parser = new RespParser()
		const deep = Buffer.from(`${"*1\r\n".repeat(500)}:1\r\n`)
		expect(() => parser.push(deep)).toThrow()
	})

	describe("RESP type coverage", () => {
		test("simple string (+)", () => {
			expect(new RespParser().push(Buffer.from("+OK\r\n"))).toEqual(["OK"])
		})

		test("error (-) becomes an Error", () => {
			const [val] = new RespParser().push(Buffer.from("-WRONGTYPE nope\r\n"))
			expect(val).toBeInstanceOf(Error)
			expect((val as Error).message).toBe("WRONGTYPE nope")
		})

		test("integer (:)", () => {
			expect(new RespParser().push(Buffer.from(":42\r\n"))).toEqual([42])
		})

		test("double (,)", () => {
			expect(new RespParser().push(Buffer.from(",3.14\r\n"))).toEqual([3.14])
		})

		test("boolean (#t / #f)", () => {
			expect(new RespParser().push(Buffer.from("#t\r\n#f\r\n"))).toEqual([true, false])
		})

		test("null (_)", () => {
			expect(new RespParser().push(Buffer.from("_\r\n"))).toEqual([null])
		})

		test("bulk string ($)", () => {
			expect(new RespParser().push(Buffer.from("$5\r\nhello\r\n"))).toEqual(["hello"])
		})

		test("null bulk string ($-1)", () => {
			expect(new RespParser().push(Buffer.from("$-1\r\n"))).toEqual([null])
		})

		test("null array (*-1)", () => {
			expect(new RespParser().push(Buffer.from("*-1\r\n"))).toEqual([null])
		})

		test("empty bulk string ($0)", () => {
			expect(new RespParser().push(Buffer.from("$0\r\n\r\n"))).toEqual([""])
		})
	})

	describe("partial reads / chunk boundaries", () => {
		test("a bulk string split mid-payload waits, then completes", () => {
			const parser = new RespParser()
			expect(parser.push(Buffer.from("$5\r\nhel"))).toEqual([])
			expect(parser.push(Buffer.from("lo\r\n"))).toEqual(["hello"])
		})

		test("a length prefix split across chunks waits, then completes", () => {
			const parser = new RespParser()
			expect(parser.push(Buffer.from("$1"))).toEqual([])
			expect(parser.push(Buffer.from("1\r\nhello worl"))).toEqual([])
			expect(parser.push(Buffer.from("d\r\n"))).toEqual(["hello world"])
		})

		test("byte-by-byte delivery of a pmessage reassembles correctly", () => {
			const parser = new RespParser()
			const full = "*4\r\n$8\r\npmessage\r\n$2\r\np*\r\n$2\r\nch\r\n$2\r\nhi\r\n"
			let out: unknown[] = []
			for (const byte of Buffer.from(full)) {
				out = out.concat(parser.push(Buffer.from([byte])))
			}
			expect(out).toEqual([["pmessage", "p*", "ch", "hi"]])
		})

		test("multiple messages in one chunk are all returned", () => {
			const parser = new RespParser()
			expect(parser.push(Buffer.from("+OK\r\n:7\r\n$2\r\nhi\r\n"))).toEqual(["OK", 7, "hi"])
		})
	})

	describe("malformed input throws", () => {
		test("invalid prefix", () => {
			expect(() => new RespParser().push(Buffer.from("!nope\r\n"))).toThrow()
		})

		test("non-numeric bulk length", () => {
			expect(() => new RespParser().push(Buffer.from("$abc\r\n"))).toThrow(/bulk string length/)
		})

		test("negative (non -1) bulk length", () => {
			expect(() => new RespParser().push(Buffer.from("$-5\r\n"))).toThrow(/bulk string length/)
		})

		test("bad bulk string terminator", () => {
			expect(() => new RespParser().push(Buffer.from("$5\r\nhelloXX"))).toThrow(/terminator/)
		})

		test("invalid array length", () => {
			expect(() => new RespParser().push(Buffer.from("*abc\r\n"))).toThrow(/array length/)
		})
	})

	describe("resource bounds", () => {
		test("a bulk length over the cap throws before buffering the payload", () => {
			const parser = new RespParser()
			// Declare a 64MB+ bulk string but send no payload — must be rejected at the
			// length declaration, not buffered.
			expect(() => parser.push(Buffer.from("$67108865\r\n"))).toThrow(/maximum|length/)
		})
	})
})

describe("parseRedisUrl", () => {
	test("plain redis URL", () => {
		expect(parseRedisUrl("redis://localhost:6379")).toMatchObject({
			hostname: "localhost",
			port: 6379,
			tls: false,
			db: 0,
		})
	})

	test("rediss:// enables TLS", () => {
		expect(parseRedisUrl("rediss://example.com:6380")).toMatchObject({ tls: true, port: 6380 })
	})

	test("valkeys:// enables TLS", () => {
		expect(parseRedisUrl("valkeys://example.com")).toMatchObject({ tls: true, port: 6379 })
	})

	test("userinfo (username + password) is decoded", () => {
		const info = parseRedisUrl("redis://user:p%40ss@host:6379")
		expect(info.username).toBe("user")
		expect(info.password).toBe("p@ss")
	})

	test("database from path", () => {
		expect(parseRedisUrl("redis://localhost:6379/3").db).toBe(3)
	})

	test("unsupported protocol throws", () => {
		expect(() => parseRedisUrl("http://localhost:6379")).toThrow(/protocol/)
	})

	test("invalid database in path throws", () => {
		expect(() => parseRedisUrl("redis://localhost:6379/abc")).toThrow(/database/)
	})
})
