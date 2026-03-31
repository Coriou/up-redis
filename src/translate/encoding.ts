/**
 * Recursively base64-encode all string values in a response.
 *
 * Called when the SDK sends `Upstash-Encoding: base64` header (the default).
 * ALL strings are encoded including "OK" and "QUEUED" — the SDK handles both.
 *
 * Uses Buffer.from() instead of btoa() because btoa chokes on non-Latin-1 chars.
 */
export function encodeResult(value: unknown): unknown {
	if (value === null || value === undefined) return null
	if (typeof value === "number") return value
	if (typeof value === "string") return Buffer.from(value, "utf-8").toString("base64")
	if (Array.isArray(value)) return value.map(encodeResult)
	return value
}
