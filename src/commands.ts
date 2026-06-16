import { config } from "./config"

/**
 * Commands that must NOT be sent through the shared connection.
 *
 * Three categories of risk:
 *
 * 1. **Connection state corruption** — change the state of the shared
 *    Bun.redis connection in ways that affect all concurrent users:
 *    - Subscriber mode: SUBSCRIBE, PSUBSCRIBE, SSUBSCRIBE (+ UNSUBSCRIBE variants)
 *    - Monitor mode: MONITOR
 *    - Transaction state: MULTI/EXEC/DISCARD/WATCH/UNWATCH (use /multi-exec)
 *    - Database switching: SELECT
 *    - Connection termination: QUIT, RESET
 *
 * 2. **Blocking commands** — hold the shared connection until they return,
 *    starving every other request. A `BLPOP key 0` would freeze the proxy
 *    forever. The Upstash SDK does not expose helpers for these commands.
 *    - List/zset blocking pops: BLPOP, BRPOP, BRPOPLPUSH, BLMOVE, BLMPOP,
 *      BZPOPMIN, BZPOPMAX, BZMPOP
 *    - Replication wait: WAIT, WAITAOF
 *    - Blocking stream reads: XREAD BLOCK, XREADGROUP BLOCK
 *
 * 3. **Server/admin commands** — destructive at the cluster/server level
 *    or capable of killing the proxy's own connection:
 *    - SHUTDOWN — terminates the Redis server
 *    - REPLICAOF / SLAVEOF — reconfigures replication
 *    - FAILOVER — manual failover
 *    - DEBUG — DEBUG SLEEP blocks the connection, DEBUG SEGFAULT crashes Redis
 *    - CLIENT KILL — could kill the proxy's own shared connection
 *    - CLIENT PAUSE / CLIENT UNPAUSE — server-wide pause affects everyone
 *    - CLIENT REPLY — changes reply behavior, corrupts protocol
 *    - CLIENT NO-EVICT / NO-TOUCH / SETINFO / SETNAME — per-connection state
 *      leaks across all proxy users on the shared connection
 *    - CLUSTER FAILOVER / RESET / MEET / FORGET — cluster topology changes
 */

/** Single-word blocked commands (lookup by uppercased command name). */
const BLOCKED_COMMANDS = new Set([
	// Subscriber mode (use /subscribe/:channel)
	"SUBSCRIBE",
	"PSUBSCRIBE",
	"SSUBSCRIBE",
	"UNSUBSCRIBE",
	"PUNSUBSCRIBE",
	"SUNSUBSCRIBE",
	// Monitor mode
	"MONITOR",
	// Transaction state (use /multi-exec)
	"MULTI",
	"EXEC",
	"DISCARD",
	"WATCH",
	"UNWATCH",
	// Database switching
	"SELECT",
	// Connection termination/reset
	"QUIT",
	"RESET",
	// Blocking pops — would hold the shared connection
	"BLPOP",
	"BRPOP",
	"BRPOPLPUSH",
	"BLMOVE",
	"BLMPOP",
	"BZPOPMIN",
	"BZPOPMAX",
	"BZMPOP",
	// Replication wait — blocks until N replicas ack
	"WAIT",
	"WAITAOF",
	// Server admin / DoS vectors
	"SHUTDOWN",
	"REPLICAOF",
	"SLAVEOF",
	"FAILOVER",
	"DEBUG",
])

/**
 * CLIENT subcommands that are blocked. CLIENT itself is allowed for read-only
 * introspection (INFO, GETNAME, ID, LIST, GETREDIR).
 *
 * Per-connection mutators (SETNAME, SETINFO, NO-EVICT, NO-TOUCH, REPLY,
 * TRACKING) leak state across all proxy users since the connection is shared.
 * Server-wide controls (KILL, PAUSE, UNPAUSE) affect everyone.
 */
const BLOCKED_CLIENT_SUBCOMMANDS = new Set([
	"KILL",
	"PAUSE",
	"UNPAUSE",
	"REPLY",
	"NO-EVICT",
	"NO-TOUCH",
	"SETNAME",
	"SETINFO",
	"TRACKING",
	"TRACKINGINFO",
])

/**
 * CLUSTER subcommands that are blocked. Read-only introspection (INFO, NODES,
 * MYID, SLOTS, SHARDS, COUNTKEYSINSLOT, GETKEYSINSLOT, KEYSLOT, LINKS, SLAVES,
 * REPLICAS, COUNT-FAILURE-REPORTS) remains available.
 *
 * Topology mutators are blocked because they're equivalent in damage to the
 * single-word admin commands like FAILOVER and SHUTDOWN.
 */
const BLOCKED_CLUSTER_SUBCOMMANDS = new Set([
	"FAILOVER",
	"RESET",
	"MEET",
	"FORGET",
	"REPLICATE",
	"ADDSLOTS",
	"ADDSLOTSRANGE",
	"DELSLOTS",
	"DELSLOTSRANGE",
	"FLUSHSLOTS",
	"SETSLOT",
	"BUMPEPOCH",
])

const TRANSACTION_HINT = "Use POST /multi-exec for transactions"
const PUBSUB_HINT = "Use GET/POST /subscribe/:channel for PubSub"
const BLOCKING_REASON =
	"blocking commands would hold the shared connection and starve other requests"
const ADMIN_REASON =
	"admin/destructive commands are blocked to prevent DoS on the shared connection"

const TRANSACTION_CMDS = new Set(["MULTI", "EXEC", "DISCARD", "WATCH", "UNWATCH"])
const PUBSUB_CMDS = new Set([
	"SUBSCRIBE",
	"PSUBSCRIBE",
	"SSUBSCRIBE",
	"UNSUBSCRIBE",
	"PUNSUBSCRIBE",
	"SUNSUBSCRIBE",
])
const BLOCKING_CMDS = new Set([
	"BLPOP",
	"BRPOP",
	"BRPOPLPUSH",
	"BLMOVE",
	"BLMPOP",
	"BZPOPMIN",
	"BZPOPMAX",
	"BZMPOP",
	"WAIT",
	"WAITAOF",
])
const ADMIN_CMDS = new Set(["SHUTDOWN", "REPLICAOF", "SLAVEOF", "FAILOVER", "DEBUG", "MONITOR"])

/**
 * Dangerous but Upstash-allowed commands, blocked by default. KEYS is O(N) and
 * holds the shared connection across the whole keyspace; FLUSHALL/FLUSHDB are
 * destructive (and their SYNC variants block); SWAPDB mutates databases globally.
 * Operators re-enable them with UPREDIS_ALLOW_DANGEROUS_COMMANDS=true.
 */
const DANGEROUS_COMMANDS = new Set(["KEYS", "FLUSHALL", "FLUSHDB", "SWAPDB"])

export type BlockedCommandOptions = {
	/** Permit the dangerous-by-default commands (KEYS/FLUSHALL/FLUSHDB/SWAPDB). */
	allowDangerous?: boolean
	/** Extra command names to block (uppercased). */
	extraBlocked?: ReadonlySet<string>
}

/**
 * Check if a command (with its arguments, for subcommand-style commands)
 * is blocked on the shared connection.
 *
 * Returns an error message if blocked, or null if allowed. The first argument
 * is inspected for `CLIENT KILL`, `CLUSTER FAILOVER`, etc. — these are blocked
 * even though the parent command (CLIENT GETNAME, CLUSTER INFO) is allowed.
 */
export function checkBlockedCommand(
	command: string,
	argsOrFirstArg?: readonly string[] | string,
	options?: BlockedCommandOptions,
): string | null {
	const upper = command.toUpperCase()
	const args = Array.isArray(argsOrFirstArg)
		? argsOrFirstArg
		: argsOrFirstArg === undefined
			? []
			: [argsOrFirstArg]
	const firstArg = args[0]

	if (BLOCKED_COMMANDS.has(upper)) {
		if (TRANSACTION_CMDS.has(upper)) {
			return `${upper} is not allowed via this endpoint. ${TRANSACTION_HINT}`
		}
		if (PUBSUB_CMDS.has(upper)) {
			return `${upper} is not allowed via this endpoint. ${PUBSUB_HINT}`
		}
		if (BLOCKING_CMDS.has(upper)) {
			return `${upper} is not allowed — ${BLOCKING_REASON}`
		}
		if (ADMIN_CMDS.has(upper)) {
			return `${upper} is not allowed — ${ADMIN_REASON}`
		}
		// SELECT, QUIT, RESET
		return `${upper} is not allowed — it would corrupt the shared Redis connection`
	}

	// CLIENT subcommands: allow read-only ones (CLIENT INFO, CLIENT GETNAME, CLIENT ID, CLIENT LIST),
	// block dangerous ones (CLIENT KILL, CLIENT PAUSE, CLIENT REPLY, CLIENT NO-EVICT, CLIENT SETNAME, CLIENT SETINFO, etc.)
	if (upper === "CLIENT" && firstArg) {
		const sub = firstArg.toUpperCase()
		if (BLOCKED_CLIENT_SUBCOMMANDS.has(sub)) {
			return `CLIENT ${sub} is not allowed — it would affect the shared Redis connection or other clients`
		}
	}

	// CLUSTER subcommands: allow read-only introspection (INFO, NODES, etc.),
	// block topology mutators (FAILOVER, RESET, MEET, FORGET, etc.)
	if (upper === "CLUSTER" && firstArg) {
		const sub = firstArg.toUpperCase()
		if (BLOCKED_CLUSTER_SUBCOMMANDS.has(sub)) {
			return `CLUSTER ${sub} is not allowed — ${ADMIN_REASON}`
		}
	}

	// Upstash REST does not support blocking stream reads. They would also hold the
	// shared proxy connection open until a stream receives data or the client timeout
	// fires. The BLOCK token only carries blocking semantics in the options section:
	// before the STREAMS keyword, and — for XREADGROUP — after the "GROUP <group>
	// <consumer>" header. Scanning the whole arg list would wrongly reject a stream,
	// group, or consumer literally named "BLOCK".
	if (upper === "XREAD" || upper === "XREADGROUP") {
		const streamsIdx = args.findIndex((arg) => arg.toUpperCase() === "STREAMS")
		const optionsEnd = streamsIdx === -1 ? args.length : streamsIdx
		const optionsStart = upper === "XREADGROUP" ? 3 : 0
		const hasBlockOption = args
			.slice(optionsStart, optionsEnd)
			.some((arg) => arg.toUpperCase() === "BLOCK")
		if (hasBlockOption) {
			return `${upper} BLOCK is not allowed — ${BLOCKING_REASON}`
		}
	}

	// Dangerous-but-Upstash-allowed commands: blocked by default (see DANGEROUS_COMMANDS).
	const allowDangerous = options?.allowDangerous ?? config.allowDangerousCommands
	if (!allowDangerous && DANGEROUS_COMMANDS.has(upper)) {
		return `${upper} is not allowed by default — it can block the shared connection or destroy data. Set UPREDIS_ALLOW_DANGEROUS_COMMANDS=true to permit it.`
	}

	// Operator-defined extra blocklist (UPREDIS_BLOCKED_COMMANDS).
	const extraBlocked = options?.extraBlocked ?? config.blockedCommands
	if (extraBlocked.has(upper)) {
		return `${upper} is not allowed — it is in the UPREDIS_BLOCKED_COMMANDS blocklist`
	}

	return null
}

/**
 * Validate and normalize a raw command array (from a JSON request body) into a
 * Redis command name + string arguments.
 *
 * Over the Upstash wire, command arguments arrive as JSON strings or numbers —
 * the SDK pre-stringifies booleans/objects/arrays/null before sending. We accept
 * `string | number` (numbers are coerced, e.g. `EXPIRE key 100`) and reject
 * anything else with a descriptive error rather than silently coercing it:
 * `String({})` would write the literal "[object Object]" into Redis and
 * `String(null)` the literal "null".
 *
 * Throws on invalid input; callers map the error to a 400 response.
 */
export function parseCommandArray(raw: readonly unknown[]): {
	command: string
	args: string[]
} {
	if (raw.length === 0) {
		throw new Error("Command must be a non-empty array")
	}
	if (typeof raw[0] !== "string") {
		throw new Error(`Command name must be a string, got ${describeArgType(raw[0])}`)
	}
	const command = raw[0]
	const args = new Array<string>(raw.length - 1)
	for (let i = 1; i < raw.length; i++) {
		const value = raw[i]
		if (typeof value === "string") {
			args[i - 1] = value
		} else if (typeof value === "number" && Number.isFinite(value)) {
			args[i - 1] = String(value)
		} else {
			throw new Error(
				`Invalid argument at position ${i}: expected a string or number, got ${describeArgType(value)}`,
			)
		}
	}
	return { command, args }
}

function describeArgType(value: unknown): string {
	if (value === null) return "null"
	if (Array.isArray(value)) return "array"
	return typeof value
}
