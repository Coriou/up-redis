import type { RedisClient } from "bun"
import type { Context } from "hono"
import { Hono } from "hono"
import { type SSEStreamingApi, streamSSE } from "hono/streaming"
import { config } from "../config"
import { log } from "../logger"
import { createDedicatedConnection, getClient } from "../redis"
import { createPatternSubscription, type PatternSubscription } from "../redis-pattern"
import { shuttingDown } from "../shutdown"
import {
	createConfirmationOrderedBuffer,
	formatMessageEvent,
	formatPatternMessageEvent,
	formatPatternSubscribeEvent,
	formatSubscribeEvent,
} from "../translate/pubsub"
import { createSlotLimiter } from "../util/slot-limiter"

type ActiveSubscription = {
	target: string
	redis?: RedisClient
	pattern?: PatternSubscription
	stream: SSEStreamingApi
}

const activeSubscriptions = new Set<ActiveSubscription>()

/**
 * Caps concurrent SSE subscriptions. Each holds a dedicated Bun.redis connection, so
 * without a cap an authenticated client could exhaust the proxy's file descriptors.
 * A synchronous counting limiter (rather than checking `activeSubscriptions.size`)
 * closes the TOCTOU window: a slot is reserved in the same tick as the check, before
 * the `await createDedicatedConnection()`, so concurrent bursts can't overshoot.
 */
const subscriptionLimiter = createSlotLimiter(config.maxSubscriptions)

export const pubsubRoutes = new Hono()

const MAX_CHANNEL_NAME_LENGTH = 512
/**
 * SSE keep-alive interval. Many proxies (nginx, CloudFront, Cloudflare) close
 * idle connections after 30–60s. Sending an SSE comment line every 15s keeps
 * the connection warm without polluting the data stream — comments start with
 * `:` and are ignored by the EventSource spec.
 */
const KEEPALIVE_INTERVAL_MS = 15_000

/** Reject null bytes and ASCII control characters (0x00–0x1F, 0x7F) */
function hasControlCharacters(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		if (code <= 0x1f || code === 0x7f) return true
	}
	return false
}

async function handleSubscribe(c: Context) {
	const channel = c.req.param("channel") as string

	if (!isValidSubscriptionTarget(channel)) {
		return c.json({ error: "Invalid channel" }, 400)
	}

	// Reject new subscriptions during shutdown — the shutdownGuard middleware
	// already handles this, but check again here in case of any ordering bug.
	if (shuttingDown()) {
		return c.json({ error: "Service Unavailable" }, 503)
	}

	// Reserve a subscription slot synchronously (before any await) so concurrent
	// bursts cannot overshoot the cap. Released on every exit path below.
	if (!subscriptionLimiter.reserve()) {
		log.warn("subscription limit reached", {
			requestId: c.get("requestId"),
			channel,
			active: subscriptionLimiter.count,
			limit: config.maxSubscriptions,
		})
		return c.json({ error: "Too Many Subscriptions" }, 503)
	}

	return streamSSE(c, async (stream) => {
		let sub: RedisClient
		try {
			// Dedicated connection with autoReconnect disabled — see redis.ts.
			// A reconnect would silently lose the subscription on the Redis side
			// and the SSE stream would sit idle forever.
			sub = await createDedicatedConnection()
		} catch (err) {
			log.error("pubsub dedicated connection failed", {
				requestId: c.get("requestId"),
				channel,
				error: err instanceof Error ? err.message : String(err),
			})
			subscriptionLimiter.release()
			try {
				await stream.close()
			} catch {}
			return
		}

		const entry: ActiveSubscription = { target: channel, redis: sub, stream }
		activeSubscriptions.add(entry)

		// Race: shutdown started between request entry and now. Bail to avoid
		// leaking the dedicated connection past closeAllSubscriptions().
		if (shuttingDown()) {
			activeSubscriptions.delete(entry)
			subscriptionLimiter.release()
			try {
				sub.close()
			} catch {}
			try {
				await stream.close()
			} catch {}
			return
		}

		let keepaliveTimer: ReturnType<typeof setInterval> | null = null

		try {
			// Resolves when client disconnects
			const abortPromise = new Promise<void>((resolve) => {
				stream.onAbort(() => resolve())
			})

			// Resolves when Redis connection drops
			const redisClosePromise = new Promise<void>((resolve) => {
				sub.onclose = () => resolve()
			})

			let disconnected = false
			// Buffer messages until the subscribe confirmation is written, so the SDK
			// always sees the confirmation first even if a publisher races a message
			// in during subscription setup (mirrors the pattern-subscribe path).
			const ordered = createConfirmationOrderedBuffer((data) => {
				stream.writeSSE({ data }).catch(() => {
					// Stop processing further messages — abort handler cleans up
					disconnected = true
				})
			})
			const listener = (message: string, ch: string) => {
				if (disconnected) return
				ordered.push(formatMessageEvent(ch, message))
			}

			let count: number
			try {
				count = await sub.subscribe(channel, listener)
			} catch (err) {
				log.warn("pubsub subscribe failed", {
					requestId: c.get("requestId"),
					channel,
					error: err instanceof Error ? err.message : String(err),
				})
				return
			}

			// Send subscription confirmation (Upstash protocol) BEFORE any message,
			// then release any messages buffered during subscription setup.
			try {
				await stream.writeSSE({ data: formatSubscribeEvent(channel, count) })
			} catch {
				// Client closed before we could send confirmation; cleanup runs in finally
				return
			}
			ordered.release()

			log.debug("pubsub subscribe", { channel })

			// Periodic keep-alive comments to defeat idle-connection timeouts at
			// intermediaries (proxies, CDNs). Per SSE spec, lines starting with `:`
			// are comments and are ignored by EventSource clients and the Upstash
			// SDK reader (which only consumes lines starting with `data: `).
			//
			// Send one immediately so a proxy with a sub-15s idle timeout (and
			// no traffic on this channel) sees activity right away — otherwise
			// the connection could be torn down before the first interval fires.
			stream.write(":keep-alive\n\n").catch(() => {
				disconnected = true
			})
			keepaliveTimer = setInterval(() => {
				if (disconnected) return
				stream.write(":keep-alive\n\n").catch(() => {
					disconnected = true
				})
			}, KEEPALIVE_INTERVAL_MS)

			// Block until client disconnects or Redis drops
			await Promise.race([abortPromise, redisClosePromise])
		} finally {
			if (keepaliveTimer) clearInterval(keepaliveTimer)
			activeSubscriptions.delete(entry)
			subscriptionLimiter.release()
			try {
				await sub.unsubscribe(channel)
			} catch {
				// Connection might already be closed; nothing to do.
			}
			try {
				sub.close()
			} catch {
				// Idempotent; ignore.
			}
			log.debug("pubsub unsubscribe", { channel })
		}
	})
}

async function handlePatternSubscribe(c: Context) {
	const pattern = c.req.param("pattern") as string

	if (!isValidSubscriptionTarget(pattern)) {
		return c.json({ error: "Invalid pattern" }, 400)
	}

	if (shuttingDown()) {
		return c.json({ error: "Service Unavailable" }, 503)
	}

	if (!subscriptionLimiter.reserve()) {
		log.warn("subscription limit reached", {
			requestId: c.get("requestId"),
			pattern,
			active: subscriptionLimiter.count,
			limit: config.maxSubscriptions,
		})
		return c.json({ error: "Too Many Subscriptions" }, 503)
	}

	return streamSSE(c, async (stream) => {
		let disconnected = false
		let ready = false
		const pendingMessages: string[] = []

		const writeData = (data: string) => {
			if (disconnected) return
			stream.writeSSE({ data }).catch(() => {
				disconnected = true
			})
		}

		const abortPromise = new Promise<void>((resolve) => {
			stream.onAbort(() => {
				disconnected = true
				resolve()
			})
		})

		let sub: PatternSubscription
		try {
			sub = await createPatternSubscription(pattern, (matchedPattern, channel, message) => {
				const data = formatPatternMessageEvent(matchedPattern, channel, message)
				if (!ready) {
					pendingMessages.push(data)
					return
				}
				writeData(data)
			})
		} catch (err) {
			log.error("pubsub pattern connection failed", {
				requestId: c.get("requestId"),
				pattern,
				error: err instanceof Error ? err.message : String(err),
			})
			subscriptionLimiter.release()
			try {
				await stream.close()
			} catch {}
			return
		}

		const entry: ActiveSubscription = { target: pattern, pattern: sub, stream }
		activeSubscriptions.add(entry)

		if (disconnected || shuttingDown()) {
			activeSubscriptions.delete(entry)
			subscriptionLimiter.release()
			sub.close()
			try {
				await stream.close()
			} catch {}
			return
		}

		let keepaliveTimer: ReturnType<typeof setInterval> | null = null

		try {
			try {
				await stream.writeSSE({ data: formatPatternSubscribeEvent(pattern, sub.count) })
				ready = true
				for (const data of pendingMessages.splice(0)) {
					writeData(data)
				}
			} catch {
				return
			}

			log.debug("pubsub psubscribe", { pattern })

			stream.write(":keep-alive\n\n").catch(() => {
				disconnected = true
			})
			keepaliveTimer = setInterval(() => {
				if (disconnected) return
				stream.write(":keep-alive\n\n").catch(() => {
					disconnected = true
				})
			}, KEEPALIVE_INTERVAL_MS)

			await Promise.race([abortPromise, sub.closed])
		} finally {
			if (keepaliveTimer) clearInterval(keepaliveTimer)
			activeSubscriptions.delete(entry)
			subscriptionLimiter.release()
			sub.close()
			log.debug("pubsub punsubscribe", { pattern })
		}
	})
}

async function handlePublish(c: Context) {
	const channel = c.req.param("channel") as string
	const message = c.req.param("message") as string

	if (!isValidSubscriptionTarget(channel)) {
		return c.json({ error: "Invalid channel name" }, 400)
	}

	try {
		const result = await getClient().publish(channel, message)
		return c.json({ result })
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err)
		return c.json({ error: errorMessage }, 400)
	}
}

// SDK uses POST, custom clients (like resumable-stream adapter) use GET
pubsubRoutes.post("/subscribe/:channel", handleSubscribe)
pubsubRoutes.get("/subscribe/:channel", handleSubscribe)
pubsubRoutes.post("/psubscribe/:pattern", handlePatternSubscribe)
pubsubRoutes.get("/psubscribe/:pattern", handlePatternSubscribe)
pubsubRoutes.post("/publish/:channel/:message", handlePublish)

/** Close all active subscriptions (called during graceful shutdown) */
export async function closeAllSubscriptions(): Promise<void> {
	const entries = [...activeSubscriptions]
	if (entries.length === 0) return

	log.info("closing active subscriptions", { count: entries.length })

	await Promise.allSettled(
		entries.map(async (entry) => {
			activeSubscriptions.delete(entry)
			try {
				entry.stream.abort()
			} catch {}
			if (entry.redis) {
				try {
					await entry.redis.unsubscribe(entry.target)
				} catch {}
				try {
					entry.redis.close()
				} catch {}
			}
			entry.pattern?.close()
		}),
	)
}

/** Get count of active subscriptions */
export function activeSubscriptionCount(): number {
	return activeSubscriptions.size
}

function isValidSubscriptionTarget(target: string): boolean {
	return Boolean(
		target && target.length <= MAX_CHANNEL_NAME_LENGTH && !hasControlCharacters(target),
	)
}
