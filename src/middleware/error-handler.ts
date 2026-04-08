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
		// Don't hardcode "Unauthorized" — HTTPException can have any 4xx/5xx status.
		// Fall back to a generic placeholder so a future HTTPException(403) doesn't
		// surface as "Unauthorized".
		return c.json({ error: err.message || "Error" }, err.status)
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
