import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type SpawnedServer, spawnServer } from "./spawn-server"

const TOKEN = "test-token-123"
const authHeaders = { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" }

describe("UPREDIS_METRICS=true exposes Prometheus metrics", () => {
	let server: SpawnedServer
	beforeAll(async () => {
		server = await spawnServer({ UPREDIS_METRICS: "true" })
	}, 30_000)
	afterAll(() => server?.close())

	test("/metrics is mounted, unauthenticated, and reflects recorded requests", async () => {
		// Generate at least one recorded request.
		await fetch(`${server.baseUrl}/`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(["PING"]),
		})

		const res = await fetch(`${server.baseUrl}/metrics`) // no auth on purpose
		expect(res.status).toBe(200)
		expect(res.headers.get("content-type")).toContain("text/plain")
		const body = await res.text()
		expect(body).toContain("upredis_info 1")
		expect(body).toContain("# TYPE http_requests_total counter")
		expect(body).toMatch(/http_requests_total\{method="POST",status="200"\}\s+\d+/)
		// Histogram exposition: cumulative buckets + +Inf + sum + count.
		expect(body).toContain('http_request_duration_seconds_bucket{method="POST",le="+Inf"}')
		expect(body).toContain('http_request_duration_seconds_count{method="POST"}')
	})
})

describe("UPREDIS_MAX_SUBSCRIPTIONS enforces the cap", () => {
	let server: SpawnedServer
	beforeAll(async () => {
		server = await spawnServer({ UPREDIS_MAX_SUBSCRIPTIONS: "1" })
	}, 30_000)
	afterAll(() => server?.close())

	test("a second concurrent subscription is rejected with 503", async () => {
		const ac = new AbortController()
		try {
			// Hold one subscription open — fetch resolves once SSE headers arrive, by
			// which point the handler has already reserved the only slot.
			const first = await fetch(`${server.baseUrl}/subscribe/chan-a`, {
				headers: { Authorization: `Bearer ${TOKEN}` },
				signal: ac.signal,
			})
			expect(first.status).toBe(200)

			const second = await fetch(`${server.baseUrl}/subscribe/chan-b`, {
				headers: { Authorization: `Bearer ${TOKEN}` },
			})
			expect(second.status).toBe(503)
			const body = (await second.json()) as { error: string }
			expect(body.error).toContain("Too Many Subscriptions")
		} finally {
			ac.abort()
		}
	})
})

describe("UPREDIS_ALLOW_DANGEROUS_COMMANDS=true permits KEYS over HTTP", () => {
	let server: SpawnedServer
	beforeAll(async () => {
		server = await spawnServer({ UPREDIS_ALLOW_DANGEROUS_COMMANDS: "true" })
	}, 30_000)
	afterAll(() => server?.close())

	test("KEYS runs instead of returning 400", async () => {
		const res = await fetch(`${server.baseUrl}/`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(["KEYS", "config-variants:nonexistent:*"]),
		})
		expect(res.status).toBe(200)
		const body = (await res.json()) as { result: unknown }
		expect(Array.isArray(body.result)).toBe(true)
	})
})

describe("UPREDIS_ALLOW_TOKEN_QUERY_PARAM=false requires the header", () => {
	let server: SpawnedServer
	beforeAll(async () => {
		server = await spawnServer({ UPREDIS_ALLOW_TOKEN_QUERY_PARAM: "false" })
	}, 30_000)
	afterAll(() => server?.close())

	test("?_token auth is rejected with 401 when disabled", async () => {
		const res = await fetch(`${server.baseUrl}/?_token=${TOKEN}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("the Authorization header still works", async () => {
		const res = await fetch(`${server.baseUrl}/`, {
			method: "POST",
			headers: authHeaders,
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(200)
	})
})
