/**
 * Commands that must NOT be sent through the shared connection.
 *
 * These commands modify connection state in ways that would affect all
 * other clients sharing the same Bun.redis connection:
 *
 * - Subscriber mode: SUBSCRIBE, PSUBSCRIBE, SSUBSCRIBE (+ UNSUBSCRIBE variants)
 *   → puts connection in subscriber mode, only PING/SUBSCRIBE/UNSUBSCRIBE allowed
 * - Monitor mode: MONITOR → streams all commands, blocks normal use
 * - Transaction state: MULTI/EXEC/DISCARD/WATCH/UNWATCH → use /multi-exec endpoint
 * - Database switching: SELECT → changes DB for all concurrent users
 * - Connection termination: QUIT, RESET → kills or resets the shared connection
 */
const BLOCKED_COMMANDS = new Set([
  // Subscriber mode
  "SUBSCRIBE",
  "PSUBSCRIBE",
  "SSUBSCRIBE",
  "UNSUBSCRIBE",
  "PUNSUBSCRIBE",
  "SUNSUBSCRIBE",
  // Monitor mode
  "MONITOR",
  // Transaction state (use /multi-exec endpoint)
  "MULTI",
  "EXEC",
  "DISCARD",
  "WATCH",
  "UNWATCH",
  // Database switching (shared connection)
  "SELECT",
  // Connection termination/reset
  "QUIT",
  "RESET",
]);

/**
 * Check if a command is blocked on the shared connection.
 * Returns an error message if blocked, or null if allowed.
 */
export function checkBlockedCommand(command: string): string | null {
  const upper = command.toUpperCase();
  if (BLOCKED_COMMANDS.has(upper)) {
    if (upper === "MULTI" || upper === "EXEC" || upper === "DISCARD") {
      return `${upper} is not allowed via this endpoint. Use POST /multi-exec for transactions`;
    }
    if (
      upper === "SUBSCRIBE" ||
      upper === "PSUBSCRIBE" ||
      upper === "SSUBSCRIBE"
    ) {
      return `${upper} is not allowed via this endpoint. Use GET/POST /subscribe/:channel for PubSub`;
    }
    return `${upper} is not allowed — it would corrupt the shared Redis connection`;
  }
  return null;
}
