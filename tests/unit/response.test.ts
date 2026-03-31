import { describe, expect, test } from "bun:test"
import { normalizeResp3 } from "../../src/translate/response"

describe("normalizeResp3", () => {
	// Passthrough types
	test("string passes through", () => {
		expect(normalizeResp3("hello")).toBe("hello")
	})

	test("empty string passes through", () => {
		expect(normalizeResp3("")).toBe("")
	})

	test("integer passes through", () => {
		expect(normalizeResp3(42)).toBe(42)
	})

	test("float passes through", () => {
		expect(normalizeResp3(3.14)).toBe(3.14)
	})

	test("zero passes through", () => {
		expect(normalizeResp3(0)).toBe(0)
	})

	test("negative number passes through", () => {
		expect(normalizeResp3(-1)).toBe(-1)
	})

	test("null passes through", () => {
		expect(normalizeResp3(null)).toBe(null)
	})

	test("undefined becomes null", () => {
		expect(normalizeResp3(undefined)).toBe(null)
	})

	// Boolean → integer
	test("true becomes 1", () => {
		expect(normalizeResp3(true)).toBe(1)
	})

	test("false becomes 0", () => {
		expect(normalizeResp3(false)).toBe(0)
	})

	// Object → flat alternating array (RESP3 Map)
	test("simple object becomes flat array", () => {
		expect(normalizeResp3({ a: 1, b: 2 })).toEqual(["a", 1, "b", 2])
	})

	test("empty object becomes empty array", () => {
		expect(normalizeResp3({})).toEqual([])
	})

	test("object with string values", () => {
		expect(normalizeResp3({ field: "value", name: "Ben" })).toEqual([
			"field",
			"value",
			"name",
			"Ben",
		])
	})

	test("nested object flattens recursively", () => {
		expect(normalizeResp3({ a: { x: 1 } })).toEqual(["a", ["x", 1]])
	})

	test("null-prototype object (Bun.redis RESP3 Map)", () => {
		const obj = Object.create(null)
		obj.field1 = "val1"
		obj.field2 = "val2"
		expect(normalizeResp3(obj)).toEqual(["field1", "val1", "field2", "val2"])
	})

	// Array handling
	test("simple array passes through", () => {
		expect(normalizeResp3([1, 2, 3])).toEqual([1, 2, 3])
	})

	test("empty array passes through", () => {
		expect(normalizeResp3([])).toEqual([])
	})

	test("array with objects flattens each", () => {
		expect(normalizeResp3([{ a: 1 }])).toEqual([["a", 1]])
	})

	test("array with booleans converts each", () => {
		expect(normalizeResp3([true, false])).toEqual([1, 0])
	})

	test("array with null elements", () => {
		expect(normalizeResp3([null, "a", null])).toEqual([null, "a", null])
	})

	test("deeply nested arrays", () => {
		expect(normalizeResp3([[["a"]]])).toEqual([[["a"]]])
	})

	// Redis command simulations
	test("HGETALL simulation (RESP3 Map → flat array)", () => {
		const resp3Map = { field1: "val1", field2: "val2" }
		expect(normalizeResp3(resp3Map)).toEqual(["field1", "val1", "field2", "val2"])
	})

	test("XRANGE simulation (array of [id, Map])", () => {
		const resp3 = [["stream-id-1", { field: "value" }]]
		expect(normalizeResp3(resp3)).toEqual([["stream-id-1", ["field", "value"]]])
	})

	test("CONFIG GET simulation (RESP3 Map)", () => {
		const resp3Map = { maxmemory: "0", maxclients: "10000" }
		expect(normalizeResp3(resp3Map)).toEqual(["maxmemory", "0", "maxclients", "10000"])
	})

	// Mixed nested structures
	test("mixed nested: object with array containing boolean and nested object", () => {
		expect(normalizeResp3({ k: [true, { x: "y" }] })).toEqual(["k", [1, ["x", "y"]]])
	})

	test("EXEC result simulation (array of mixed types)", () => {
		const execResult = ["OK", 42, null, { f: "v" }, [1, 2]]
		expect(normalizeResp3(execResult)).toEqual(["OK", 42, null, ["f", "v"], [1, 2]])
	})

	// Edge cases
	test("bigint falls back to string", () => {
		expect(normalizeResp3(BigInt(999))).toBe("999")
	})

	test("object with boolean values", () => {
		expect(normalizeResp3({ exists: true, deleted: false })).toEqual(["exists", 1, "deleted", 0])
	})
})
