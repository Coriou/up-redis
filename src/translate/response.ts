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
 */
export function normalizeResp3(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(normalizeResp3);

  if (typeof value === "object") {
    // Binary data (Buffer/Uint8Array) → UTF-8 string
    if (value instanceof Uint8Array)
      return Buffer.from(value).toString("utf-8");

    // JavaScript Map → flat alternating array (safety net)
    if (value instanceof Map) {
      const flat: unknown[] = [];
      for (const [k, v] of value) {
        flat.push(String(k), normalizeResp3(v));
      }
      return flat;
    }

    // JavaScript Set → array (safety net, Bun.redis usually does this already)
    if (value instanceof Set) return [...value].map(normalizeResp3);

    // RESP3 Map → flat alternating array
    // Bun.redis creates null-prototype objects for Maps; Object.entries() handles them
    const entries = Object.entries(value as Record<string, unknown>);
    const flat: unknown[] = [];
    for (const [k, v] of entries) {
      flat.push(k, normalizeResp3(v));
    }
    return flat;
  }

  return String(value); // fallback for bigint etc.
}
