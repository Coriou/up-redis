import { describe, expect, test } from "bun:test"
import { envSchema } from "../../src/config"

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
