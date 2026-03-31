import { Hono } from "hono"
import { getClient } from "../redis"
import { encodeResult } from "../translate/encoding"
import { normalizeResp3 } from "../translate/response"

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

	const useBase64 = c.req.header("upstash-encoding") === "base64"
	const redis = getClient()
	const results: Array<{ result?: unknown; error?: string }> = []

	for (const cmd of body) {
		if (!Array.isArray(cmd) || cmd.length === 0) {
			results.push({ error: "Each pipeline command must be a non-empty array" })
			continue
		}

		const command = String(cmd[0])
		const args = cmd.slice(1).map(String)

		try {
			const raw = await redis.send(command, args)
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

	return c.json(results)
})
