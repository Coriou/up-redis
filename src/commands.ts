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
 * Check if a command (with its first argument, for subcommand-style commands)
 * is blocked on the shared connection.
 *
 * Returns an error message if blocked, or null if allowed. The first argument
 * is inspected for `CLIENT KILL`, `CLUSTER FAILOVER`, etc. — these are blocked
 * even though the parent command (CLIENT GETNAME, CLUSTER INFO) is allowed.
 */
export function checkBlockedCommand(command: string, firstArg?: string): string | null {
	const upper = command.toUpperCase()

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

	return null
}
