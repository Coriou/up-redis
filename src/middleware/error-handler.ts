import type { ErrorHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { ZodError } from "zod"
import { log } from "../logger"

/**
 * Global error handler. Returns Upstash-compatible `{error: ...}` envelopes.
 * - HTTPException → respect its status (typically 401)
 * - ZodError → 400 with concatenated issue messages
 * - Anything else → 500 with a generic message; the real error is logged
 *   server-side with the request ID for correlation
 */
export const errorHandler: ErrorHandler = (err, c) => {
	if (err instanceof HTTPException) {
		const message = err.message || "Unauthorized"
		return c.json({ error: message }, err.status)
	}

	if (err instanceof ZodError) {
		const message = err.issues.map((i) => i.message).join(", ")
		return c.json({ error: message }, 400)
	}

	log.error("unhandled error", {
		requestId: c.get("requestId"),
		method: c.req.method,
		path: c.req.path,
		error: err.message,
		stack: err.stack,
	})
	return c.json({ error: "Internal Server Error" }, 500)
}
