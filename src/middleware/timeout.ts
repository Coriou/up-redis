import type { MiddlewareHandler } from "hono"
import { config } from "../config"
import { log } from "../logger"

const TIMEOUT_SENTINEL = Symbol("timeout")

/**
 * Per-request timeout. Returns 504 if `next()` doesn't resolve within
 * `UPREDIS_REQUEST_TIMEOUT` ms. The in-flight handler isn't cancelled — Bun
 * has no Promise cancellation primitive — but the response is sent so the
 * client doesn't wait.
 *
 * Note: this middleware is bypassed for `/subscribe/:channel` SSE routes by
 * the gate in server.ts, since SSE streams legitimately stay open indefinitely.
 */
export const timeoutMiddleware: MiddlewareHandler = async (c, next) => {
	if (config.requestTimeout === 0) {
		await next()
		return
	}

	let timeoutId: Timer | undefined
	const timeoutPromise = new Promise<symbol>((resolve) => {
		timeoutId = setTimeout(() => resolve(TIMEOUT_SENTINEL), config.requestTimeout)
	})

	const result = await Promise.race([
		next().finally(() => {
			if (timeoutId !== undefined) clearTimeout(timeoutId)
		}),
		timeoutPromise,
	])

	if (result === TIMEOUT_SENTINEL) {
		log.warn("request timeout", {
			requestId: c.get("requestId"),
			method: c.req.method,
			path: c.req.path,
			timeout_ms: config.requestTimeout,
		})
		return c.json({ error: "Request Timeout" }, 504)
	}
}
