const BASE_URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"
const TOKEN = process.env.UPREDIS_TOKEN ?? "test-token-123"

// Preflight: the integration suite targets an already-running server. A stale server
// whose Redis connection has died answers GET / with 200 but fails every command with
// 400 "Connection has failed" — which makes the whole suite fail with opaque 400s that
// look like real regressions. Fail fast here with an actionable message instead.
// Runs once at import (top-level await), before any integration test registers.
await assertServerReady()

async function assertServerReady(): Promise<void> {
	let status: number
	let body: { redis?: string } | null = null
	try {
		const res = await fetch(`${BASE_URL}/health`)
		status = res.status
		body = (await res.json().catch(() => null)) as { redis?: string } | null
	} catch (err) {
		throw new Error(
			`Integration preflight: cannot reach up-redis at ${BASE_URL}. Start one first ` +
				`(e.g. \`UPREDIS_TOKEN=${TOKEN} bun run src/index.ts\`). Cause: ${
					err instanceof Error ? err.message : String(err)
				}`,
		)
	}
	if (status !== 200 || body?.redis !== "connected") {
		throw new Error(
			`Integration preflight: up-redis at ${BASE_URL} is not ready ` +
				`(GET /health → ${status}, redis=${body?.redis ?? "unknown"}). ` +
				`A stale server with a dead Redis connection makes every command fail with 400; ` +
				`restart a fresh server pointed at a reachable Redis.`,
		)
	}
}

export const AUTH = { Authorization: `Bearer ${TOKEN}` }
export const JSON_HEADERS = { ...AUTH, "Content-Type": "application/json" }
export const BASE64_HEADERS = { ...JSON_HEADERS, "Upstash-Encoding": "base64" }

export async function api(
	method: string,
	path: string,
	body?: unknown,
	headers?: Record<string, string>,
): Promise<{ status: number; data: unknown; headers: Headers }> {
	const res = await fetch(`${BASE_URL}${path}`, {
		method,
		headers: { ...JSON_HEADERS, ...headers },
		body: body ? JSON.stringify(body) : undefined,
	})
	const data = await res.json()
	return { status: res.status, data, headers: res.headers }
}

/** Shorthand: send a single command and return the result */
export async function cmd(...args: (string | number)[]): Promise<unknown> {
	const { data } = await api("POST", "/", args)
	return (data as { result: unknown }).result
}

/** Shorthand: send a single command with base64 encoding */
export async function cmdBase64(...args: (string | number)[]): Promise<unknown> {
	const { data } = await api("POST", "/", args, { "Upstash-Encoding": "base64" })
	return (data as { result: unknown }).result
}

/** Generate a unique test key to avoid collisions */
export function testKey(prefix = "test"): string {
	return `${prefix}:${Math.random().toString(36).slice(2, 10)}:${Date.now()}`
}
