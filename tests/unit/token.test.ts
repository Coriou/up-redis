import { describe, expect, test } from "bun:test"
import { assessTokenStrength, isPlaceholderToken } from "../../src/config"

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

describe("isPlaceholderToken", () => {
	test("flags every entry of the placeholder set", () => {
		for (const token of [
			"your-secret-token-here",
			"changeme",
			"change-me",
			"secret",
			"password",
			"token",
			"test",
		]) {
			expect(isPlaceholderToken(token)).toBe(true)
		}
	})

	test("matches case-insensitively", () => {
		for (const token of ["CHANGEME", "Secret", "PASSWORD", "Token", "TEST", "Change-Me"]) {
			expect(isPlaceholderToken(token)).toBe(true)
		}
	})

	test("rejects strong tokens", () => {
		expect(isPlaceholderToken("k7Qe2mZ9xV4pR1sB8nT6wL3yH0cF5dG")).toBe(false)
	})

	test("rejects non-placeholder weak tokens (placeholder check is exact-match)", () => {
		expect(isPlaceholderToken("test-token-123")).toBe(false)
		expect(isPlaceholderToken("testing")).toBe(false)
		expect(isPlaceholderToken("my-secret-prod-token")).toBe(false)
	})
})
