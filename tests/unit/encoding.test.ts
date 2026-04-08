import { describe, expect, test } from "bun:test"
import { encodeResult } from "../../src/translate/encoding"

describe("encodeResult", () => {
	// String → base64
	test("simple string is base64-encoded", () => {
		expect(encodeResult("hello")).toBe("aGVsbG8=")
	})

	test('"OK" is base64-encoded (SRH approach, SDK handles both)', () => {
		expect(encodeResult("OK")).toBe("T0s=")
	})

	test('"QUEUED" is base64-encoded', () => {
		expect(encodeResult("QUEUED")).toBe("UVVFVUVE")
	})

	test("empty string is base64-encoded to empty string", () => {
		expect(encodeResult("")).toBe("")
	})

	test("string with spaces", () => {
		expect(encodeResult("hello world")).toBe("aGVsbG8gd29ybGQ=")
	})

	// Numbers pass through
	test("integer passes through", () => {
		expect(encodeResult(42)).toBe(42)
	})

	test("float passes through", () => {
		expect(encodeResult(3.14)).toBe(3.14)
	})

	test("zero passes through", () => {
		expect(encodeResult(0)).toBe(0)
	})

	test("negative number passes through", () => {
		expect(encodeResult(-1)).toBe(-1)
	})

	// Null passes through
	test("null passes through", () => {
		expect(encodeResult(null)).toBe(null)
	})

	test("undefined becomes null", () => {
		expect(encodeResult(undefined)).toBe(null)
	})

	// Array recursion
	test("array of strings is recursively encoded", () => {
		expect(encodeResult(["a", "b"])).toEqual(["YQ==", "Yg=="])
	})

	test("mixed array: strings encoded, numbers/null pass through", () => {
		expect(encodeResult(["hello", 42, null, "world"])).toEqual(["aGVsbG8=", 42, null, "d29ybGQ="])
	})

	test("nested arrays are recursively encoded", () => {
		expect(encodeResult([["a", "b"]])).toEqual([["YQ==", "Yg=="]])
	})

	test("empty array passes through", () => {
		expect(encodeResult([])).toEqual([])
	})

	test("HGETALL-style flat array (alternating key-value strings)", () => {
		const flat = ["field1", "value1", "field2", "value2"]
		const encoded = encodeResult(flat)
		expect(encoded).toEqual([
			Buffer.from("field1").toString("base64"),
			Buffer.from("value1").toString("base64"),
			Buffer.from("field2").toString("base64"),
			Buffer.from("value2").toString("base64"),
		])
	})

	// Unicode and special characters
	test("unicode string is properly base64-encoded", () => {
		const encoded = encodeResult("café")
		// Verify roundtrip: decode should give back the original
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("café")
	})

	test("emoji string is properly base64-encoded", () => {
		const encoded = encodeResult("😀")
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("😀")
	})

	test("CJK characters are properly base64-encoded", () => {
		const encoded = encodeResult("你好")
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("你好")
	})

	// Boolean defensive: normalizeResp3 normally runs first and converts these,
	// but if encodeResult is called directly we still produce a JSON-safe value
	// the SDK can decode (its decode() has no case "boolean").
	test("boolean is normalized to integer (defensive)", () => {
		expect(encodeResult(true)).toBe(1)
		expect(encodeResult(false)).toBe(0)
	})

	test("bigint is base64-encoded as string (defensive)", () => {
		const encoded = encodeResult(BigInt(999))
		expect(encoded).toBe(Buffer.from("999", "utf-8").toString("base64"))
	})

	test("plain object becomes null (defensive)", () => {
		// Should not happen after normalizeResp3, but defend against the case
		// where it doesn't run — null is JSON-safe and the SDK handles it.
		expect(encodeResult({ a: 1 })).toBe(null)
	})

	// Defensive binary handling — these should normally be converted to strings
	// by normalizeResp3 first, but we handle them directly so that bypassing
	// normalization doesn't surface as `null` in the response.
	test("Uint8Array is base64-encoded directly (defensive)", () => {
		const buf = new Uint8Array([104, 101, 108, 108, 111]) // "hello"
		const encoded = encodeResult(buf)
		expect(typeof encoded).toBe("string")
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("hello")
	})

	test("Int8Array is base64-encoded directly (defensive)", () => {
		const buf = new Int8Array([72, 105]) // "Hi"
		const encoded = encodeResult(buf)
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("Hi")
	})

	test("ArrayBuffer is base64-encoded directly (defensive)", () => {
		const buf = new TextEncoder().encode("hello").buffer as ArrayBuffer
		const encoded = encodeResult(buf)
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("hello")
	})

	test("Uint8Array subarray preserves byte range (defensive)", () => {
		const full = new Uint8Array([97, 98, 99, 100, 101]) // "abcde"
		const view = full.subarray(1, 4) // "bcd"
		const encoded = encodeResult(view)
		expect(Buffer.from(encoded as string, "base64").toString("utf-8")).toBe("bcd")
	})
})
