import type { MiddlewareHandler } from "hono"
import { log } from "../logger"
import { recordRequest } from "../metrics"

/**
 * Accept incoming X-Request-ID values that look like a request ID and reject
 * anything else by replacing with a fresh UUID. This prevents log/header
 * pollution from arbitrary client-supplied bytes — Bun's HTTP parser already
 * rejects bare CR/LF in header values, but extra characters (high-bit bytes,
 * tabs, very long strings) could still corrupt structured logs in text mode
 * or look out of place in tracing UIs.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,128}$/
function sanitizeRequestId(provided: string | undefined): string {
	if (provided && REQUEST_ID_RE.test(provided)) return provided
	return crypto.randomUUID()
}

export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
	const requestId = sanitizeRequestId(c.req.header("x-request-id"))
	c.set("requestId", requestId)
	c.header("X-Request-ID", requestId)

	const start = performance.now()
	await next()
	const duration_ms = Math.round((performance.now() - start) * 100) / 100

	log.info("request", {
		requestId,
		method: c.req.method,
		path: c.req.path,
		status: c.res.status,
		duration_ms,
	})

	// Wrap in try/catch so a metrics regression can never break a successful
	// request — this middleware runs after `next()` so the response is already
	// composed; throwing here would only result in a 500 over a 200.
	try {
		recordRequest(c.req.method, c.res.status, duration_ms / 1000)
	} catch (err: unknown) {
		log.error("metrics record failed", {
			requestId,
			error: err instanceof Error ? err.message : String(err),
		})
	}
}
