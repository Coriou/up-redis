import { describe, expect, test } from "bun:test"
import { normalizeMethod, normalizeStatus } from "../../src/metrics"

describe("normalizeMethod", () => {
	test("known methods pass through uppercased", () => {
		expect(normalizeMethod("GET")).toBe("GET")
		expect(normalizeMethod("post")).toBe("POST")
		expect(normalizeMethod("Patch")).toBe("PATCH")
		expect(normalizeMethod("DELETE")).toBe("DELETE")
		expect(normalizeMethod("HEAD")).toBe("HEAD")
		expect(normalizeMethod("OPTIONS")).toBe("OPTIONS")
		expect(normalizeMethod("PUT")).toBe("PUT")
	})

	test("unknown methods collapse to OTHER", () => {
		expect(normalizeMethod("PROPFIND")).toBe("OTHER")
		expect(normalizeMethod("BREW")).toBe("OTHER")
		expect(normalizeMethod("")).toBe("OTHER")
		// Buggy / hostile method labels — must not create unbounded series
		expect(normalizeMethod("\u0000")).toBe("OTHER")
		expect(normalizeMethod("a".repeat(1024))).toBe("OTHER")
	})
})

describe("normalizeStatus", () => {
	test("standard 2xx/3xx/4xx/5xx pass through as strings", () => {
		expect(normalizeStatus(200)).toBe("200")
		expect(normalizeStatus(204)).toBe("204")
		expect(normalizeStatus(301)).toBe("301")
		expect(normalizeStatus(400)).toBe("400")
		expect(normalizeStatus(401)).toBe("401")
		expect(normalizeStatus(404)).toBe("404")
		expect(normalizeStatus(500)).toBe("500")
		expect(normalizeStatus(503)).toBe("503")
	})

	test("1xx informational passes through", () => {
		expect(normalizeStatus(100)).toBe("100")
		expect(normalizeStatus(101)).toBe("101")
	})

	test("boundary values: 100 and 599 are valid", () => {
		expect(normalizeStatus(100)).toBe("100")
		expect(normalizeStatus(599)).toBe("599")
	})

	test("out-of-range values collapse to 0", () => {
		expect(normalizeStatus(0)).toBe("0")
		expect(normalizeStatus(99)).toBe("0")
		expect(normalizeStatus(600)).toBe("0")
		expect(normalizeStatus(1000)).toBe("0")
		expect(normalizeStatus(-1)).toBe("0")
	})

	test("non-integer values collapse to 0", () => {
		expect(normalizeStatus(200.5)).toBe("0")
		expect(normalizeStatus(Number.NaN)).toBe("0")
		expect(normalizeStatus(Number.POSITIVE_INFINITY)).toBe("0")
		expect(normalizeStatus(Number.NEGATIVE_INFINITY)).toBe("0")
	})
})
