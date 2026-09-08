import { Hono } from "hono"
import { checkBlockedCommand, parseCommandArray } from "../commands"
import { config } from "../config"
import { log } from "../logger"
import { createDedicatedConnection } from "../redis"
import { shapeExecResults } from "../translate/transaction"
import { withTimeout } from "../util/timeout"

// Matches the COMMAND_TIMEOUT_MS convention in redis-pattern.ts (not exported
// there). Bounds each MULTI/queued/EXEC round-trip so a silently stalled
// upstream can't park the request handler and its dedicated connection
// forever — the rejection flows into the catch below and the finally closes
// the connection.
const COMMAND_TIMEOUT_MS = 10_000

export const multiExecRoutes = new Hono()

multiExecRoutes.post("/multi-exec", async (c) => {
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400)
	}

	if (!Array.isArray(body)) {
		return c.json({ error: "Request body must be a JSON array of command arrays" }, 400)
	}

	// Short-circuit: empty transaction needs no Redis connection
	if (body.length === 0) {
		return c.json([])
	}

	// Same cap as /pipeline. A million-command transaction would hold the
	// dedicated connection for an unbounded time and burn memory queueing
	// commands on the Redis side.
	if (body.length > config.maxPipelineCommands) {
		return c.json(
			{
				error: `Transaction exceeds maximum of ${config.maxPipelineCommands} commands (got ${body.length})`,
			},
			400,
		)
	}

	// Validate all commands and pre-stringify before opening a dedicated connection.
	// Reject blocked commands eagerly so we never spend a connection on them. Even on
	// a dedicated connection, BLPOP/SHUTDOWN/etc. would either deadlock the request
	// or compromise the Redis server.
	const validated: Array<{ command: string; args: string[] }> = []
	for (const cmd of body) {
		if (!Array.isArray(cmd) || cmd.length === 0) {
			return c.json({ error: "Each transaction command must be a non-empty array" }, 400)
		}
		let parsed: { command: string; args: string[] }
		try {
			parsed = parseCommandArray(cmd)
		} catch (err) {
			return c.json({ error: err instanceof Error ? err.message : String(err) }, 400)
		}
		// MULTI/EXEC/DISCARD/WATCH/UNWATCH are nested transaction state — disallow.
		// Blocking and admin commands disallowed for the same reasons as POST /.
		const blocked = checkBlockedCommand(parsed.command, parsed.args)
		if (blocked) {
			return c.json({ error: blocked }, 400)
		}
		validated.push(parsed)
	}

	const useBase64 = c.req.header("upstash-encoding")?.toLowerCase() === "base64"

	// Dedicated connection per transaction to prevent command interleaving (SRH #25).
	// autoReconnect is disabled (see redis.ts) so a mid-transaction reconnect can't
	// silently corrupt MULTI state.
	const tx = await createDedicatedConnection()

	try {
		await withTimeout(tx.send("MULTI", []), COMMAND_TIMEOUT_MS, "MULTI")

		for (const { command, args } of validated) {
			// returns "QUEUED"
			await withTimeout(tx.send(command, args), COMMAND_TIMEOUT_MS, `QUEUED ${command}`)
		}

		const execResult = await withTimeout(tx.send("EXEC", []), COMMAND_TIMEOUT_MS, "EXEC")

		// EXEC returns null if the transaction was aborted (WATCH conflict or queued syntax error)
		if (execResult === null) {
			return c.json({ error: "EXECABORT Transaction discarded" }, 400)
		}

		// Otherwise EXEC returns an array of per-command results. shapeExecResults
		// throws on any unexpected (non-array) reply so it surfaces as an error
		// rather than a misleading silent empty response.
		return c.json(shapeExecResults(execResult, useBase64, validated))
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err)
		log.error("multi-exec error", {
			requestId: c.get("requestId"),
			error: message,
		})
		return c.json({ error: message }, 400)
	} finally {
		try {
			tx.close()
		} catch {
			// Connection might already be closed by an error path; ignore.
		}
	}
})
