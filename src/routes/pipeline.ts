import { Hono } from "hono"
import { checkBlockedCommand, parseCommandArray } from "../commands"
import { config } from "../config"
import { getClient } from "../redis"
import { encodeResult } from "../translate/encoding"
import { normalizeResp3 } from "../translate/response"
import { flattenScorePairs } from "../translate/score-pairs"

export const pipelineRoutes = new Hono()

pipelineRoutes.post("/pipeline", async (c) => {
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400)
	}

	if (!Array.isArray(body)) {
		return c.json({ error: "Request body must be a JSON array of command arrays" }, 400)
	}

	// Short-circuit: empty pipeline needs no Redis call
	if (body.length === 0) {
		return c.json([])
	}

	// Cap the number of commands per request. Even with the body size limit,
	// a tiny-command body could queue an enormous number of operations on the
	// shared connection.
	if (body.length > config.maxPipelineCommands) {
		return c.json(
			{
				error: `Pipeline exceeds maximum of ${config.maxPipelineCommands} commands (got ${body.length})`,
			},
			400,
		)
	}

	const useBase64 = c.req.header("upstash-encoding")?.toLowerCase() === "base64"
	const redis = getClient()

	// Fire all commands concurrently to leverage Bun.redis auto-pipelining.
	// Invalid entries become instantly-rejected promises (no Redis call).
	// Redis executes pipelined commands in FIFO order on a single connection.
	// `parsedCommands` is built in lockstep with `promises` so the result mapping can
	// apply command-aware withscores flattening to each fulfilled reply.
	const parsedCommands: Array<{ command: string; args: string[] } | null> = []
	const promises = body.map((cmd) => {
		if (!Array.isArray(cmd) || cmd.length === 0) {
			parsedCommands.push(null)
			return Promise.reject(new Error("Each pipeline command must be a non-empty array"))
		}
		let parsed: { command: string; args: string[] }
		try {
			parsed = parseCommandArray(cmd)
		} catch (err) {
			parsedCommands.push(null)
			return Promise.reject(err instanceof Error ? err : new Error(String(err)))
		}
		parsedCommands.push(parsed)
		const blocked = checkBlockedCommand(parsed.command, parsed.args)
		if (blocked) {
			return Promise.reject(new Error(blocked))
		}
		return redis.send(parsed.command, parsed.args)
	})

	const settled = await Promise.allSettled(promises)

	const results = settled.map((s, i) => {
		if (s.status === "fulfilled") {
			const parsed = parsedCommands[i]
			let result = normalizeResp3(s.value)
			if (parsed) result = flattenScorePairs(parsed.command, parsed.args, result)
			if (useBase64) result = encodeResult(result)
			return { result }
		}
		const message = s.reason instanceof Error ? s.reason.message : String(s.reason)
		return { error: message }
	})

	return c.json(results)
})
