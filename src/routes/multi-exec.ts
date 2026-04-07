import { Hono } from "hono"
import { checkBlockedCommand } from "../commands"
import { log } from "../logger"
import { getClient } from "../redis"
import { encodeResult } from "../translate/encoding"
import { normalizeResp3 } from "../translate/response"

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

	// Validate all commands and pre-stringify before opening a dedicated connection.
	// Reject blocked commands eagerly so we never spend a connection on them. Even on
	// a dedicated connection, BLPOP/SHUTDOWN/etc. would either deadlock the request
	// or compromise the Redis server.
	const validated: Array<{ command: string; args: string[] }> = []
	for (const cmd of body) {
		if (!Array.isArray(cmd) || cmd.length === 0) {
			return c.json({ error: "Each transaction command must be a non-empty array" }, 400)
		}
		const command = String(cmd[0])
		const args = cmd.slice(1).map(String)
		// MULTI/EXEC/DISCARD/WATCH/UNWATCH are nested transaction state — disallow.
		// Blocking and admin commands disallowed for the same reasons as POST /.
		const blocked = checkBlockedCommand(command, args[0])
		if (blocked) {
			return c.json({ error: blocked }, 400)
		}
		validated.push({ command, args })
	}

	const useBase64 = c.req.header("upstash-encoding") === "base64"

	// Dedicated connection per transaction to prevent command interleaving (SRH #25)
	const tx = await getClient().duplicate()

	try {
		await tx.send("MULTI", [])

		for (const { command, args } of validated) {
			await tx.send(command, args) // returns "QUEUED"
		}

		const execResult = await tx.send("EXEC", [])

		// EXEC returns null if the transaction was aborted (WATCH conflict or queued syntax error)
		if (execResult === null) {
			return c.json({ error: "EXECABORT Transaction discarded" }, 400)
		}

		// EXEC returns an array of results, one per queued command
		const results: Array<{ result?: unknown; error?: string }> = []

		if (Array.isArray(execResult)) {
			for (const raw of execResult) {
				// Bun.redis returns Error objects for per-command runtime failures
				// (e.g., WRONGTYPE) — detect before normalizeResp3 flattens them
				if (raw instanceof Error) {
					results.push({ error: raw.message })
					continue
				}
				try {
					let result = normalizeResp3(raw)
					if (useBase64) {
						result = encodeResult(result)
					}
					results.push({ result })
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err)
					results.push({ error: message })
				}
			}
		}

		return c.json(results)
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
