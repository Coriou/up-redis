/**
 * Recursively base64-encode all string values in a response.
 *
 * Called when the SDK sends `Upstash-Encoding: base64` header (the default).
 * ALL strings are encoded including "OK" and "QUEUED" — the SDK handles both.
 *
 * Uses Buffer.from() instead of btoa() because btoa chokes on non-Latin-1 chars.
 *
 * This function is normally called *after* `normalizeResp3` so it should not
 * receive booleans, objects, or bigints. The fallthrough handling below is
 * defensive: the SDK's `decode()` function has no `case "boolean"` and would
 * silently drop the value (returning undefined → "Request did not return a
 * result" error in the SDK). We coerce to JSON-safe types instead.
 */
export function encodeResult(value: unknown): unknown {
	if (value === null || value === undefined) return null
	if (typeof value === "number") return value
	if (typeof value === "string") return Buffer.from(value, "utf-8").toString("base64")
	if (Array.isArray(value)) return value.map(encodeResult)
	// Defensive: normalizeResp3 should have converted these already, but if it
	// didn't run (e.g., direct call), still produce a JSON-safe value.
	if (typeof value === "boolean") return value ? 1 : 0
	if (typeof value === "bigint") {
		// Re-encode the stringified bigint so it remains a base64-decoded string
		// in the SDK rather than an unparseable number.
		return Buffer.from(value.toString(), "utf-8").toString("base64")
	}
	// Defensive: binary data that escaped normalizeResp3. Convert to UTF-8 then
	// base64 so the SDK still receives a decodable string.
	if (typeof value === "object" && value !== null) {
		if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
			const buf = Buffer.from(
				(value as ArrayBufferView).buffer,
				(value as ArrayBufferView).byteOffset,
				(value as ArrayBufferView).byteLength,
			)
			return buf.toString("base64")
		}
		if (value instanceof ArrayBuffer) {
			return Buffer.from(value).toString("base64")
		}
	}
	// Plain objects (RESP3 Maps that escaped normalization): drop to null rather
	// than crash JSON.stringify or send the SDK something it can't decode.
	return null
}
