import { describe, expect, test } from "bun:test"
import { assessTokenStrength } from "../../src/config"

describe("assessTokenStrength", () => {
	test("flags the well-known placeholder token", () => {
		expect(assessTokenStrength("your-secret-token-here")).not.toBe(null)
	})

	test("flags a short token", () => {
		expect(assessTokenStrength("short")).not.toBe(null)
	})

	test("flags a low-entropy token (few distinct characters)", () => {
		expect(assessTokenStrength("aaaaaaaaaaaaaaaaaaaa")).not.toBe(null)
	})

	test("accepts a long, diverse random token", () => {
		expect(assessTokenStrength("k7Qe2mZ9xV4pR1sB8nT6wL3yH0cF5dG")).toBe(null)
	})
})
