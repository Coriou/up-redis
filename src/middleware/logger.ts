import type { MiddlewareHandler } from "hono"
import { log } from "../logger"
import { recordRequest } from "../metrics"

export const loggerMiddleware: MiddlewareHandler = async (c, next) => {
	const requestId = c.req.header("x-request-id") ?? crypto.randomUUID()
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

	recordRequest(c.req.method, c.res.status, duration_ms / 1000)
}
