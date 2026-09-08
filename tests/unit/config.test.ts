import { describe, expect, test } from "bun:test"
import { assertTokenNotPlaceholder, assessTokenStrength, envSchema } from "../../src/config"

const base = { UPREDIS_TOKEN: "test-token-123" }

describe("envSchema numeric coercion", () => {
	test("empty UPREDIS_REQUEST_TIMEOUT falls back to the default", () => {
		const parsed = envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: "" })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(30000)
	})

	test("unset UPREDIS_REQUEST_TIMEOUT falls back to the default", () => {
		const parsed = envSchema.parse({ ...base })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(30000)
	})

	test("explicit 0 still disables the request timeout", () => {
		const parsed = envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: "0" })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(0)
	})

	test("non-numeric UPREDIS_REQUEST_TIMEOUT fails loudly", () => {
		expect(() => envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: "abc" })).toThrow()
	})

	test("empty UPREDIS_PORT fails loudly instead of coercing to 0", () => {
		expect(() => envSchema.parse({ ...base, UPREDIS_PORT: "" })).toThrow()
	})
})

describe("envSchema whitespace-only UPREDIS_REQUEST_TIMEOUT", () => {
	test("a single space falls back to the default", () => {
		const parsed = envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: " " })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(30000)
	})

	test("a tab falls back to the default", () => {
		const parsed = envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: "\t" })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(30000)
	})

	test("a non-breaking space falls back to the default", () => {
		const parsed = envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: " " })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(30000)
	})

	test("whitespace around an explicit value still parses (0 stays disabled)", () => {
		const parsed = envSchema.parse({ ...base, UPREDIS_REQUEST_TIMEOUT: " 0 " })
		expect(parsed.UPREDIS_REQUEST_TIMEOUT).toBe(0)
	})
})

describe("placeholder token refusal gate", () => {
	const placeholder = {
		UPREDIS_TOKEN: "your-secret-token-here",
	}

	test("refuses a placeholder token with the actionable message", () => {
		const parsed = envSchema.parse(placeholder)
		expect(() => assertTokenNotPlaceholder(parsed)).toThrow(
			/refusing to start — UPREDIS_TOKEN is a well-known placeholder value/,
		)
		expect(() => assertTokenNotPlaceholder(parsed)).toThrow(
			/UPREDIS_ALLOW_PLACEHOLDER_TOKEN=true to accept the risk/,
		)
	})

	test("refuses placeholder tokens case-insensitively", () => {
		const parsed = envSchema.parse({ ...placeholder, UPREDIS_TOKEN: "CHANGEME" })
		expect(() => assertTokenNotPlaceholder(parsed)).toThrow(/refusing to start/)
	})

	test("UPREDIS_ALLOW_PLACEHOLDER_TOKEN=true accepts the risk", () => {
		const parsed = envSchema.parse({
			...placeholder,
			UPREDIS_ALLOW_PLACEHOLDER_TOKEN: "true",
		})
		expect(() => assertTokenNotPlaceholder(parsed)).not.toThrow()
	})

	test("the strength warning still fires for an accepted placeholder token", () => {
		const parsed = envSchema.parse({
			...placeholder,
			UPREDIS_ALLOW_PLACEHOLDER_TOKEN: "true",
		})
		expect(assessTokenStrength(parsed.UPREDIS_TOKEN)).not.toBe(null)
	})

	test("a strong token passes the gate silently", () => {
		const parsed = envSchema.parse({ UPREDIS_TOKEN: "k7Qe2mZ9xV4pR1sB8nT6wL3yH0cF5dG" })
		expect(() => assertTokenNotPlaceholder(parsed)).not.toThrow()
		expect(assessTokenStrength(parsed.UPREDIS_TOKEN)).toBe(null)
	})
})
