const BASE_URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"
const TOKEN = process.env.UPREDIS_TOKEN ?? "test-token-123"

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
