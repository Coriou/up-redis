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

	test("error envelope contains only `error` (no status field)", async () => {
		const res = await fetch(`${BASE_URL}/nonexistent`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		})
		const data = (await res.json()) as Record<string, unknown>
		expect(data.error).toBeDefined()
		// Match the Upstash REST API spec: only `error` field, no extras
		expect(data.status).toBeUndefined()
	})

	test("GET /livez returns 200 (does not check Redis)", async () => {
		const res = await fetch(`${BASE_URL}/livez`)
		expect(res.status).toBe(200)
		const data = await res.json()
		expect(data).toEqual({ status: "ok" })
	})

	test("GET /readyz returns 200 with redis status", async () => {
		const res = await fetch(`${BASE_URL}/readyz`)
		expect(res.status).toBe(200)
		const data = await res.json()
		expect(data).toEqual({ status: "ready", redis: "connected" })
	})

	test("/livez and /readyz require no auth", async () => {
		const livez = await fetch(`${BASE_URL}/livez`)
		expect(livez.status).toBe(200)
		const readyz = await fetch(`${BASE_URL}/readyz`)
		expect(readyz.status).toBe(200)
	})
})

describe("Auth", () => {
	test("Bearer scheme is case-insensitive (lowercase)", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `bearer ${TOKEN}`,
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(200)
	})

	test("Bearer scheme is case-insensitive (uppercase)", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `BEARER ${TOKEN}`,
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(200)
	})

	test("non-Bearer scheme returns 401", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Basic ${TOKEN}`,
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("Bearer with no token returns 401", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer ",
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("Bearer with no space returns 401", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer",
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("Authorization with extra leading whitespace in token is trimmed", async () => {
		// "Bearer   token" → token after the first space, trimmed → "token"
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer  ${TOKEN}  `,
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(200)
	})
})

describe("X-Request-ID handling", () => {
	test("safe X-Request-ID is reflected", async () => {
		const id = "trace-abc-123_42.foo"
		const res = await fetch(`${BASE_URL}/`, {
			headers: { "X-Request-ID": id },
		})
		expect(res.headers.get("x-request-id")).toBe(id)
	})

	test("missing X-Request-ID gets a generated UUID", async () => {
		const res = await fetch(`${BASE_URL}/`)
		const id = res.headers.get("x-request-id")
		expect(id).toBeTruthy()
		// UUID v4 pattern
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	})

	test("X-Request-ID with disallowed characters is replaced with a fresh UUID", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			headers: { "X-Request-ID": "with spaces and !@#$%" },
		})
		const id = res.headers.get("x-request-id")
		expect(id).not.toBe("with spaces and !@#$%")
		expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
	})

	test("X-Request-ID over 128 chars is replaced with a fresh UUID", async () => {
		const tooLong = "a".repeat(200)
		const res = await fetch(`${BASE_URL}/`, {
			headers: { "X-Request-ID": tooLong },
		})
		const id = res.headers.get("x-request-id")
		expect(id).not.toBe(tooLong)
		expect((id ?? "").length).toBeLessThanOrEqual(128)
	})
})

describe("Security headers", () => {
	test("X-Content-Type-Options: nosniff", async () => {
		const res = await fetch(`${BASE_URL}/`)
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
	})

	test("X-Frame-Options: DENY", async () => {
		const res = await fetch(`${BASE_URL}/`)
		expect(res.headers.get("x-frame-options")).toBe("DENY")
	})

	test("Cache-Control: no-store", async () => {
		const res = await fetch(`${BASE_URL}/`)
		expect(res.headers.get("cache-control")).toBe("no-store")
	})

	test("security headers on API responses", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
		expect(res.headers.get("x-frame-options")).toBe("DENY")
		expect(res.headers.get("cache-control")).toBe("no-store")
	})

	test("security headers on 401 responses", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
		expect(res.headers.get("x-frame-options")).toBe("DENY")
		expect(res.headers.get("cache-control")).toBe("no-store")
	})

	test("security headers on 404 responses", async () => {
		const res = await fetch(`${BASE_URL}/does-not-exist`, {
			headers: { Authorization: `Bearer ${TOKEN}` },
		})
		expect(res.status).toBe(404)
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
		expect(res.headers.get("x-frame-options")).toBe("DENY")
		expect(res.headers.get("cache-control")).toBe("no-store")
	})

	test("security headers on 400 (bad command) responses", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify(["NOTACOMMAND"]),
		})
		expect(res.status).toBe(400)
		expect(res.headers.get("x-content-type-options")).toBe("nosniff")
		expect(res.headers.get("x-frame-options")).toBe("DENY")
		expect(res.headers.get("cache-control")).toBe("no-store")
	})
})
