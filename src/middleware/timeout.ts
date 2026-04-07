import type { MiddlewareHandler } from "hono"
import { config } from "../config"
import { log } from "../logger"

const TIMEOUT_SENTINEL = Symbol("timeout")

export const timeoutMiddleware: MiddlewareHandler = async (c, next) => {
	if (config.requestTimeout === 0) {
		await next()
		return
	}

	let timeoutId: Timer
	const timeoutPromise = new Promise<symbol>((resolve) => {
		timeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), config.requestTimeout)
	})

	const result = await Promise.race([next().finally(() => clearTimeout(timeoutId)), timeoutPromise])

	if (result === TIMEOUT_SENTINEL) {
		log.warn("request timeout", {
			method: c.req.method,
			path: c.req.path,
			timeout_ms: config.requestTimeout,
		})
		return c.json({ error: "Request Timeout", status: 504 }, 504)
	}
}
