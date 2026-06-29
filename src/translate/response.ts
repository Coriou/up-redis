/**
 * Normalize RESP3 values to RESP2-compatible JSON.
 *
 * Bun.redis speaks RESP3 which returns richer types (Map, Boolean, Set).
 * The @upstash/redis SDK expects RESP2-style JSON responses.
 *
 * Key translations:
 * - RESP3 Boolean → integer (true → 1, false → 0)
 * - RESP3 Map (JS Object) → flat alternating array [key, val, key, val]
 * - Arrays → recursively normalize each element
 * - Strings, numbers, null → pass through
 *
 * `depth` guards against a pathologically deep reply (e.g. a deeply-nested array
 * returned by EVAL) recursing into a stack overflow that would crash the process.
 */
const MAX_NORMALIZE_DEPTH = 64

export function normalizeResp3(value: unknown, depth = 0): unknown {
	if (depth > MAX_NORMALIZE_DEPTH) {
		throw new Error(`Redis reply nesting exceeds maximum depth of ${MAX_NORMALIZE_DEPTH}`)
	}
	if (value === null || value === undefined) return null
	if (typeof value === "boolean") return value ? 1 : 0
	if (typeof value === "number") {
		// JSON.stringify turns Infinity/-Infinity/NaN into null, which would silently
		// corrupt e.g. ZSCORE / ZADD INCR / ZINCRBY / GEODIST of an infinite score.
		// Emit the Redis string forms ("inf"/"-inf"/"nan") that real Redis and Upstash return.
		if (!Number.isFinite(value)) {
			if (value === Number.POSITIVE_INFINITY) return "inf"
			if (value === Number.NEGATIVE_INFINITY) return "-inf"
			return "nan"
		}
		return value
	}
	if (typeof value === "string") return value
	if (Array.isArray(value)) return value.map((v) => normalizeResp3(v, depth + 1))

	if (typeof value === "object") {
		// Binary data → UTF-8 string. Bun.redis may surface bytes as Buffer,
		// Uint8Array, or another typed-array view; ArrayBuffer.isView catches them all.
		if (ArrayBuffer.isView(value)) {
			// DataView has no .buffer-as-bytes contract that matches what Buffer.from
			// expects; fall through to the generic object branch instead.
			if (!(value instanceof DataView)) {
				return Buffer.from(value.buffer, value.byteOffset, value.byteLength).toString("utf-8")
			}
		}

		// Raw ArrayBuffer (rare, but possible if a caller hands one in directly)
		if (value instanceof ArrayBuffer) {
			return Buffer.from(value).toString("utf-8")
		}

		// JavaScript Map → flat alternating array (safety net)
		if (value instanceof Map) {
			const flat: unknown[] = []
			for (const [k, v] of value) {
				flat.push(String(k), normalizeResp3(v, depth + 1))
			}
			return flat
		}

		// JavaScript Set → array (safety net, Bun.redis usually does this already)
		if (value instanceof Set) return [...value].map((v) => normalizeResp3(v, depth + 1))

		// RESP3 Map → flat alternating array
		// Bun.redis creates null-prototype objects for Maps; Object.entries() handles them
		const entries = Object.entries(value as Record<string, unknown>)
		const flat: unknown[] = []
		for (const [k, v] of entries) {
			flat.push(k, normalizeResp3(v, depth + 1))
		}
		return flat
	}

	return String(value) // fallback for bigint etc.
}
