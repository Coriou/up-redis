import type { RedisClient } from "bun"
import type { Context } from "hono"
import { Hono } from "hono"
import { type SSEStreamingApi, streamSSE } from "hono/streaming"
import { log } from "../logger"
import { getClient } from "../redis"
import { formatMessageEvent, formatSubscribeEvent } from "../translate/pubsub"

type ActiveSubscription = {
	channel: string
	redis: RedisClient
	stream: SSEStreamingApi
}

const activeSubscriptions = new Set<ActiveSubscription>()

export const pubsubRoutes = new Hono()

async function handleSubscribe(c: Context) {
	const channel = c.req.param("channel") as string

	return streamSSE(c, async (stream) => {
		const sub = await getClient().duplicate()
		const entry: ActiveSubscription = { channel, redis: sub, stream }
		activeSubscriptions.add(entry)

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

			const count = await sub.subscribe(channel, listener)

			// Send subscription confirmation (Upstash protocol)
			await stream.writeSSE({ data: formatSubscribeEvent(channel, count) })

			log.debug("pubsub subscribe", { channel })

			// Block until client disconnects or Redis drops
			await Promise.race([abortPromise, redisClosePromise])
		} finally {
			activeSubscriptions.delete(entry)
			try {
				await sub.unsubscribe(channel)
			} catch {}
			sub.close()
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

	for (const entry of entries) {
		activeSubscriptions.delete(entry)
		try {
			entry.stream.abort()
		} catch {}
		try {
			await entry.redis.unsubscribe(entry.channel)
		} catch {}
		entry.redis.close()
	}
}

/** Get count of active subscriptions */
export function activeSubscriptionCount(): number {
	return activeSubscriptions.size
}
