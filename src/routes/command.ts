import { Hono } from "hono"
import { checkBlockedCommand } from "../commands"
import { log } from "../logger"
import { getClient } from "../redis"
import { encodeResult } from "../translate/encoding"
import { normalizeResp3 } from "../translate/response"

export const commandRoutes = new Hono()

commandRoutes.post("/", async (c) => {
	let body: unknown
	try {
		body = await c.req.json()
	} catch {
		return c.json({ error: "Invalid JSON body" }, 400)
	}

	if (!Array.isArray(body) || body.length === 0) {
		return c.json({ error: "Request body must be a non-empty JSON array" }, 400)
	}

	const command = String(body[0])
	const args = body.slice(1).map(String)

	const blocked = checkBlockedCommand(command, args[0])
	if (blocked) {
		return c.json({ error: blocked }, 400)
	}

	try {
		const raw = await getClient().send(command, args)
		let result = normalizeResp3(raw)
		if (c.req.header("upstash-encoding")?.toLowerCase() === "base64") {
			result = encodeResult(result)
		}
		return c.json({ result })
	} catch (err: unknown) {
		const message = err instanceof Error ? err.message : String(err)
		log.debug("command error", {
			requestId: c.get("requestId"),
			command,
			error: message,
		})
		return c.json({ error: message }, 400)
	}
})
