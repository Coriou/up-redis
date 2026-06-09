import type { Context } from "hono"
import { Hono } from "hono"
import { checkBlockedCommand } from "../commands"
import { log } from "../logger"
import { getClient } from "../redis"
import { encodeResult } from "../translate/encoding"
import { normalizeResp3 } from "../translate/response"

export const commandRoutes = new Hono()

async function executeCommand(c: Context, command: string, args: string[]) {
	const blocked = checkBlockedCommand(command, args)
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
}

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

	return executeCommand(c, command, args)
})

async function handlePathCommand(c: Context) {
	let command: string
	let args: string[]
	try {
		const parsed = parsePathCommand(c)
		command = parsed.command
		args = parsed.args
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json({ error: message }, 400)
	}

	return executeCommand(c, command, args)
}

async function handlePathCommandWithBody(c: Context) {
	let command: string
	let args: string[]
	try {
		const parsed = parsePathCommand(c)
		command = parsed.command
		args = parsed.args

		// Upstash path-style POST/PUT appends the raw request body as the value
		// argument, then appends query parameters after it.
		if (c.req.raw.body !== null) {
			args.splice(parsed.queryStartIndex, 0, await c.req.text())
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err)
		return c.json({ error: message }, 400)
	}

	return executeCommand(c, command, args)
}

function parsePathCommand(c: Context): {
	command: string
	args: string[]
	queryStartIndex: number
} {
	const url = new URL(c.req.url)
	const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent)
	if (segments.length === 0) {
		throw new Error("Command path must include a Redis command")
	}

	const [command, ...pathArgs] = segments
	const args = [...pathArgs]
	const queryStartIndex = args.length

	for (const [key, value] of url.searchParams) {
		if (key === "_token") continue
		args.push(key)
		if (value !== "") args.push(value)
	}

	return { command, args, queryStartIndex }
}

// Path-style Upstash REST commands: /COMMAND/arg1/arg2...
commandRoutes.get("/*", handlePathCommand)
commandRoutes.post("/*", handlePathCommandWithBody)
commandRoutes.put("/*", handlePathCommandWithBody)
