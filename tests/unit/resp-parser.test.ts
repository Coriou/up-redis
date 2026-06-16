import { describe, expect, test } from "bun:test"
import { RespParser } from "../../src/redis-pattern"

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
})
