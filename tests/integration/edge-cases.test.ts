import { afterAll, describe, expect, test } from "bun:test"
import { api, cmd, cmdBase64, testKey } from "./setup"

const BASE_URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"
const TOKEN = process.env.UPREDIS_TOKEN ?? "test-token-123"

const keys: string[] = []
function k(prefix = "edge") {
	const key = testKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await api("POST", "/", ["DEL", ...keys])
	}
})

describe("Edge cases: empty and special values", () => {
	test("SET + GET empty string", async () => {
		const key = k()
		await cmd("SET", key, "")
		const result = await cmd("GET", key)
		expect(result).toBe("")
	})

	test("SET + GET empty string with base64", async () => {
		const key = k()
		await cmd("SET", key, "")
		const result = await cmdBase64("GET", key)
		// Empty string base64-encoded is empty string
		expect(result).toBe("")
	})

	test("SET + GET value with spaces", async () => {
		const key = k()
		await cmd("SET", key, "hello world foo bar")
		const result = await cmd("GET", key)
		expect(result).toBe("hello world foo bar")
	})

	test("SET + GET value with newlines", async () => {
		const key = k()
		await cmd("SET", key, "line1\nline2\nline3")
		const result = await cmd("GET", key)
		expect(result).toBe("line1\nline2\nline3")
	})

	test("SET + GET value with JSON content", async () => {
		const key = k()
		const json = JSON.stringify({ nested: { data: [1, 2, 3] } })
		await cmd("SET", key, json)
		const result = await cmd("GET", key)
		expect(result).toBe(json)
	})

	test("key with colons and special chars", async () => {
		const key = `edge:special:${Date.now()}:foo/bar`
		keys.push(key)
		await cmd("SET", key, "val")
		const result = await cmd("GET", key)
		expect(result).toBe("val")
	})
})

describe("Edge cases: unknown and case-insensitive commands", () => {
	test("PING returns PONG", async () => {
		const { data } = await api("POST", "/", ["PING"])
		expect((data as { result: string }).result).toBe("PONG")
	})

	test("commands are case-insensitive (lowercase)", async () => {
		const key = k()
		await api("POST", "/", ["set", key, "lower"])
		const { data } = await api("POST", "/", ["get", key])
		expect((data as { result: string }).result).toBe("lower")
	})

	test("commands are case-insensitive (mixed case)", async () => {
		const key = k()
		await api("POST", "/", ["Set", key, "mixed"])
		const { data } = await api("POST", "/", ["Get", key])
		expect((data as { result: string }).result).toBe("mixed")
	})

	test("unknown command returns error", async () => {
		const { data, status } = await api("POST", "/", ["TOTALLYNOTACOMMAND", "arg1"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toBeDefined()
	})

	test("wrong number of args returns error", async () => {
		const { data, status } = await api("POST", "/", ["GET"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("wrong number of arguments")
	})
})

describe("Edge cases: RESP3 type translations", () => {
	test("EXISTS returns integer (not boolean)", async () => {
		const key = k()
		await cmd("SET", key, "val")
		const result = await cmd("EXISTS", key)
		expect(result).toBe(1)
		expect(typeof result).toBe("number")
	})

	test("SISMEMBER returns integer (not boolean)", async () => {
		const key = k()
		await cmd("SADD", key, "member1")
		const r1 = await cmd("SISMEMBER", key, "member1")
		expect(r1).toBe(1)
		const r2 = await cmd("SISMEMBER", key, "nonexistent")
		expect(r2).toBe(0)
	})

	test("CONFIG GET returns flat alternating array", async () => {
		const { data } = await api("POST", "/", ["CONFIG", "GET", "maxmemory"])
		const result = (data as { result: unknown }).result
		expect(Array.isArray(result)).toBe(true)
		const arr = result as string[]
		// Should be ["maxmemory", "<value>"] flat alternating
		expect(arr.length).toBeGreaterThanOrEqual(2)
		expect(arr[0]).toBe("maxmemory")
	})

	test("DBSIZE returns integer", async () => {
		const result = await cmd("DBSIZE")
		expect(typeof result).toBe("number")
	})

	test("TYPE returns string", async () => {
		const key = k()
		await cmd("SET", key, "val")
		const result = await cmd("TYPE", key)
		expect(result).toBe("string")
	})

	test("TTL returns -1 for no expiry", async () => {
		const key = k()
		await cmd("SET", key, "val")
		const result = await cmd("TTL", key)
		expect(result).toBe(-1)
	})

	test("TTL returns -2 for non-existent key", async () => {
		const result = await cmd("TTL", testKey("nonexistent"))
		expect(result).toBe(-2)
	})
})

describe("Edge cases: SCAN cursor behavior", () => {
	test("SCAN returns array with cursor and keys", async () => {
		// Seed some data
		const prefix = `scan:${Date.now()}`
		for (let i = 0; i < 5; i++) {
			const key = `${prefix}:${i}`
			keys.push(key)
			await cmd("SET", key, `val${i}`)
		}

		const { data } = await api("POST", "/", ["SCAN", "0", "MATCH", `${prefix}:*`, "COUNT", "100"])
		const result = (data as { result: unknown }).result
		expect(Array.isArray(result)).toBe(true)
		const arr = result as [string, string[]]
		// Result is [cursor, [keys...]]
		expect(arr.length).toBe(2)
		// Cursor is a string
		expect(typeof arr[0]).toBe("string")
		// Keys is an array
		expect(Array.isArray(arr[1])).toBe(true)
	})

	test("HSCAN returns array with cursor and field-value pairs", async () => {
		const key = k()
		await cmd("HSET", key, "f1", "v1", "f2", "v2", "f3", "v3")

		const { data } = await api("POST", "/", ["HSCAN", key, "0", "COUNT", "100"])
		const result = (data as { result: unknown }).result
		expect(Array.isArray(result)).toBe(true)
		const arr = result as [string, string[]]
		expect(arr.length).toBe(2)
		expect(typeof arr[0]).toBe("string")
		expect(Array.isArray(arr[1])).toBe(true)
		// field-value pairs should be flat array
		expect(arr[1].length).toBe(6) // 3 fields * 2 (field + value)
	})
})

describe("Edge cases: SET with options via raw commands", () => {
	test("SET with NX (only if not exists)", async () => {
		const key = k()
		const r1 = await cmd("SET", key, "first", "NX")
		expect(r1).toBe("OK")
		const r2 = await cmd("SET", key, "second", "NX")
		expect(r2).toBe(null)
		expect(await cmd("GET", key)).toBe("first")
	})

	test("SET with XX (only if exists)", async () => {
		const key = k()
		const r1 = await cmd("SET", key, "val", "XX")
		expect(r1).toBe(null) // key doesn't exist
		await cmd("SET", key, "first")
		const r2 = await cmd("SET", key, "second", "XX")
		expect(r2).toBe("OK")
		expect(await cmd("GET", key)).toBe("second")
	})

	test("SET with GET (return previous value)", async () => {
		const key = k()
		await cmd("SET", key, "old")
		const result = await cmd("SET", key, "new", "GET")
		expect(result).toBe("old")
		expect(await cmd("GET", key)).toBe("new")
	})

	test("SET with PX (milliseconds TTL)", async () => {
		const key = k()
		await cmd("SET", key, "val", "PX", 60000)
		const pttl = await cmd("PTTL", key)
		expect(typeof pttl).toBe("number")
		expect(pttl as number).toBeGreaterThan(0)
	})
})

describe("Edge cases: request body validation", () => {
	test("string body (not JSON) returns 400", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${TOKEN}`,
				"Content-Type": "application/json",
			},
			body: "not json",
		})
		expect(res.status).toBe(400)
	})

	test("array with non-string first element returns 400", async () => {
		const { status } = await api("POST", "/", [123, "key", "value"])
		// Should still work — we String() the command name
		// Actually 123 becomes "123" which is not a valid Redis command
		expect(status).toBe(400)
	})

	test("pipeline with invalid entry skips it gracefully", async () => {
		const key = k()
		const { data, status } = await api("POST", "/pipeline", [
			["SET", key, "val"],
			[], // empty array — invalid
			["GET", key],
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results).toHaveLength(3)
		expect(results[0].result).toBe("OK")
		expect(results[1].error).toBeDefined()
		expect(results[2].result).toBe("val")
	})
})

describe("Edge cases: large payloads", () => {
	test("SET + GET 100KB value", async () => {
		const key = k()
		const bigVal = "x".repeat(100_000)
		await cmd("SET", key, bigVal)
		const result = await cmd("GET", key)
		expect(result).toBe(bigVal)
	})

	test("SET + GET 100KB value with base64", async () => {
		const key = k()
		const bigVal = "y".repeat(100_000)
		await cmd("SET", key, bigVal)
		const encoded = await cmdBase64("GET", key)
		const decoded = Buffer.from(encoded as string, "base64").toString("utf-8")
		expect(decoded).toBe(bigVal)
	})

	test("pipeline with 500 commands", async () => {
		const commands = Array.from({ length: 500 }, (_, i) => {
			const key = k(`bulk-${i}`)
			return ["SET", key, `v${i}`]
		})
		const { data, status } = await api("POST", "/pipeline", commands)
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown }>
		expect(results).toHaveLength(500)
		for (const r of results) {
			expect(r.result).toBe("OK")
		}
	})
})

describe("Edge cases: pipeline / multi-exec size limits", () => {
	test("pipeline exceeding max commands returns 400", async () => {
		// Default limit is 1000. Send 1001 lightweight commands.
		const commands = Array.from({ length: 1001 }, () => ["PING"])
		const { status, data } = await api("POST", "/pipeline", commands)
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("maximum")
		expect((data as { error: string }).error).toContain("1000")
	})

	test("pipeline at exactly max commands succeeds", async () => {
		const commands = Array.from({ length: 1000 }, () => ["PING"])
		const { status, data } = await api("POST", "/pipeline", commands)
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown }>
		expect(results).toHaveLength(1000)
		expect(results[0].result).toBe("PONG")
		expect(results[999].result).toBe("PONG")
	})

	test("multi-exec exceeding max commands returns 400", async () => {
		const commands = Array.from({ length: 1001 }, () => ["PING"])
		const { status, data } = await api("POST", "/multi-exec", commands)
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("maximum")
		expect((data as { error: string }).error).toContain("1000")
	})
})
