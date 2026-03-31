import { describe, expect, test } from "bun:test"

const BASE_URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"
const TOKEN = process.env.UPREDIS_TOKEN ?? "test-token-123"

describe("Health endpoints", () => {
	test("GET / returns 200 with welcome message", async () => {
		const res = await fetch(`${BASE_URL}/`)
		expect(res.status).toBe(200)
		const text = await res.text()
		expect(text).toBe("Welcome to up-redis")
	})

	test("GET /health returns 200 with JSON status", async () => {
		const res = await fetch(`${BASE_URL}/health`)
		expect(res.status).toBe(200)
		const data = await res.json()
		expect(data).toEqual({ status: "ok", redis: "connected" })
	})

	test("GET / requires no auth", async () => {
		// No Authorization header
		const res = await fetch(`${BASE_URL}/`)
		expect(res.status).toBe(200)
	})

	test("GET /health requires no auth", async () => {
		const res = await fetch(`${BASE_URL}/health`)
		expect(res.status).toBe(200)
	})

	test("404 for unknown paths (with auth)", async () => {
		const res = await fetch(`${BASE_URL}/nonexistent`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		})
		expect(res.status).toBe(404)
		const data = await res.json()
		expect((data as { error: string }).error).toBe("Not Found")
	})
})
