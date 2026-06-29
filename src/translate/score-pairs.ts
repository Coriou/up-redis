/**
 * Flatten RESP3 "WITHSCORES"/"WITHVALUES" pair-arrays to the RESP2-flat shape the
 * @upstash/redis SDK and the Upstash REST API expect.
 *
 * Bun.redis speaks RESP3. For sorted-set and hash commands that carry scores/values,
 * RESP3 returns an array of `[member, score]` 2-tuples, e.g.
 *   ZRANGE z 0 -1 WITHSCORES → [["a", 1], ["b", 2]]
 * but Upstash (RESP2 wire) and every SDK deserializer expect a single flat array:
 *   ["a", 1, "b", 2]
 * The SDK's HRANDFIELD/zrange/zpopmin handlers iterate the reply in steps of two, so a
 * nested reply silently breaks them.
 *
 * This flattening is gated on the specific command + option that produces pairs, so
 * legitimately-nested replies stay untouched:
 *   GEOPOS → [[lon, lat]]      XRANGE → [[id, [field, value]]]
 */

// Pair-shaped only when a WITHSCORES token is present.
const WITHSCORES_COMMANDS = new Set([
	"ZRANGE",
	"ZREVRANGE",
	"ZRANGEBYSCORE",
	"ZREVRANGEBYSCORE",
	"ZRANDMEMBER",
	"ZUNION",
	"ZINTER",
	"ZDIFF",
])

// Pair-shaped only when a WITHVALUES token is present.
const WITHVALUES_COMMANDS = new Set(["HRANDFIELD"])

// Pair-shaped only when an explicit count argument is present (`ZPOPMIN key [count]`).
// Without a count these return a single flat `[member, score]`, which must be left as-is.
const COUNT_PAIR_COMMANDS = new Set(["ZPOPMIN", "ZPOPMAX"])

function hasToken(args: string[], token: string): boolean {
	return args.some((a) => typeof a === "string" && a.toUpperCase() === token)
}

export function flattenScorePairs(command: string, args: string[], value: unknown): unknown {
	if (!Array.isArray(value)) return value

	const cmd = command.toUpperCase()
	let shouldFlatten = false
	if (WITHSCORES_COMMANDS.has(cmd)) shouldFlatten = hasToken(args, "WITHSCORES")
	else if (WITHVALUES_COMMANDS.has(cmd)) shouldFlatten = hasToken(args, "WITHVALUES")
	else if (COUNT_PAIR_COMMANDS.has(cmd)) shouldFlatten = args.length >= 2

	if (!shouldFlatten) return value

	// Only flatten a genuine array of 2-tuples. Leave already-flat or unexpected shapes
	// alone (empty result, or a backend that already returned the RESP2-flat form).
	if (value.every((el) => Array.isArray(el) && el.length === 2)) {
		return value.flatMap((el) => el as unknown[])
	}
	return value
}
