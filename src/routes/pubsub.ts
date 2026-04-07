import type { RedisClient } from "bun"
import type { Context } from "hono"
import { Hono } from "hono"
import { type SSEStreamingApi, streamSSE } from "hono/streaming"
import { log } from "../logger"
import { getClient } from "../redis"
import { shuttingDown } from "../shutdown"
import { formatMessageEvent, formatSubscribeEvent } from "../translate/pubsub"

type ActiveSubscription = {
	channel: string
	redis: RedisClient
	stream: SSEStreamingApi
}

const activeSubscriptions = new Set<ActiveSubscription>()

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

	if (!channel || channel.length > MAX_CHANNEL_NAME_LENGTH || hasControlCharacters(channel)) {
		return c.json({ error: "Invalid channel name" }, 400)
	}

	// Reject new subscriptions during shutdown — the shutdownGuard middleware
	// already handles this, but check again here in case of any ordering bug.
	if (shuttingDown()) {
		return c.json({ error: "Service Unavailable" }, 503)
	}

	return streamSSE(c, async (stream) => {
		let sub: RedisClient
		try {
			sub = await getClient().duplicate()
		} catch (err) {
			log.error("pubsub duplicate failed", {
				requestId: c.get("requestId"),
				channel,
				error: err instanceof Error ? err.message : String(err),
			})
			try {
				await stream.close()
			} catch {}
			return
		}

		const entry: ActiveSubscription = { channel, redis: sub, stream }
		activeSubscriptions.add(entry)

		// Race: shutdown started between request entry and now. Bail to avoid
		// leaking the dedicated connection past closeAllSubscriptions().
		if (shuttingDown()) {
			activeSubscriptions.delete(entry)
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
			const listener = (message: string, ch: string) => {
				if (disconnected) return
				stream.writeSSE({ data: formatMessageEvent(ch, message) }).catch(() => {
					// Stop processing further messages — abort handler cleans up
					disconnected = true
				})
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

			// Send subscription confirmation (Upstash protocol)
			try {
				await stream.writeSSE({ data: formatSubscribeEvent(channel, count) })
			} catch {
				// Client closed before we could send confirmation; cleanup runs in finally
				return
			}

			log.debug("pubsub subscribe", { channel })

			// Periodic keep-alive comments to defeat idle-connection timeouts at
			// intermediaries (proxies, CDNs). Per SSE spec, lines starting with `:`
			// are comments and are ignored by EventSource clients and the Upstash
			// SDK reader (which only consumes lines starting with `data: `).
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

// SDK uses POST, custom clients (like resumable-stream adapter) use GET
pubsubRoutes.post("/subscribe/:channel", handleSubscribe)
pubsubRoutes.get("/subscribe/:channel", handleSubscribe)

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
			try {
				await entry.redis.unsubscribe(entry.channel)
			} catch {}
			try {
				entry.redis.close()
			} catch {}
		}),
	)
}

/** Get count of active subscriptions */
export function activeSubscriptionCount(): number {
	return activeSubscriptions.size
}
