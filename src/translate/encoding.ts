/**
 * Recursively base64-encode string values in a response.
 *
 * Called when the SDK sends `Upstash-Encoding: base64` header (the default).
 *
 * The literal "OK" is special. The SDK's `decode()` only honors the unencoded "OK"
 * passthrough for a top-level scalar result and for strings it reaches via a recursive
 * `decode()` call — i.e. at EVEN nesting depths (0, 2, 4…). Direct array children (odd
 * depths) are base64-decoded UNCONDITIONALLY by the SDK, with no "OK" check. So a literal
 * "OK" stored as a value and read back via LRANGE/MGET/SMEMBERS/HVALS/etc. (all odd-depth)
 * MUST be base64-encoded here; leaving it as "OK" makes the SDK decode it to garbage ("8").
 * The `depth` parameter tracks this parity so we are the exact inverse of `decode()`.
 *
 * Uses Buffer.from() instead of btoa() because btoa chokes on non-Latin-1 chars.
 *
 * This function is normally called *after* `normalizeResp3` so it should not
 * receive booleans, objects, or bigints. The fallthrough handling below is
 * defensive: the SDK's `decode()` function has no `case "boolean"` and would
 * silently drop the value (returning undefined → "Request did not return a
 * result" error in the SDK). We coerce to JSON-safe types instead.
 */
export function encodeResult(value: unknown, depth = 0): unknown {
	if (value === null || value === undefined) return null
	if (typeof value === "number") return value
	// "OK" is only passed through unencoded where the SDK's decode() would re-honor it
	// (even depths). At odd depths the SDK always base64-decodes, so "OK" must be encoded.
	if (value === "OK" && depth % 2 === 0) return "OK"
	if (typeof value === "string") return Buffer.from(value, "utf-8").toString("base64")
	if (Array.isArray(value)) return value.map((el) => encodeResult(el, depth + 1))
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
