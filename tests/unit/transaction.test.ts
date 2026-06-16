import { describe, expect, test } from "bun:test"
import { shapeExecResults } from "../../src/translate/transaction"

describe("shapeExecResults", () => {
	test("maps an array of replies to {result} entries in order", () => {
		expect(shapeExecResults(["OK", 42, null], false)).toEqual([
			{ result: "OK" },
			{ result: 42 },
			{ result: null },
		])
	})

	test("normalizes RESP3 maps inside results", () => {
		expect(shapeExecResults([{ f: "v" }], false)).toEqual([{ result: ["f", "v"] }])
	})

	test("surfaces per-command Error objects as {error}", () => {
		const r = shapeExecResults(["OK", new Error("WRONGTYPE x")], false)
		expect(r[0]).toEqual({ result: "OK" })
		expect(r[1]).toEqual({ error: "WRONGTYPE x" })
	})

	test("base64-encodes string results when requested", () => {
		const r = shapeExecResults(["hello"], true) as Array<{ result?: unknown }>
		expect(r[0].result).toBe(Buffer.from("hello", "utf-8").toString("base64"))
	})

	test("throws on a non-array EXEC reply instead of returning a silent empty array", () => {
		expect(() => shapeExecResults("unexpected", false)).toThrow()
		expect(() => shapeExecResults(42, false)).toThrow()
		expect(() => shapeExecResults(null, false)).toThrow()
	})
})
