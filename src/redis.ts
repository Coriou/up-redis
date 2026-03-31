import { RedisClient } from "bun"
import { config } from "./config"
import { log } from "./logger"

let client: RedisClient | null = null
let lastPingOk = true
let lastPingTime = 0
const PING_CACHE_MS = 1000

export function getClient(): RedisClient {
	if (!client) {
		throw new Error("Redis client not initialized. Call initRedis() first.")
	}
	return client
}

export async function initRedis(): Promise<void> {
	client = new RedisClient(config.redisUrl, {
		connectionTimeout: 10_000,
		autoReconnect: true,
		maxRetries: 10,
		enableAutoPipelining: true,
		enableOfflineQueue: true,
	})

	client.onconnect = () => {
		log.info("redis connected")
	}
	client.onclose = (error) => {
		lastPingOk = false
		log.warn("redis disconnected", { error: error.message })
	}

	const pong = await client.ping()
	if (pong !== "PONG") {
		throw new Error(`Redis PING failed: ${pong}`)
	}
}

export async function isRedisHealthy(): Promise<boolean> {
	if (!client) return false

	// Fast path: client reports disconnected
	if (!client.connected) {
		lastPingOk = false
		return false
	}

	// Return cached result within the cache window
	const now = Date.now()
	if (now - lastPingTime < PING_CACHE_MS) return lastPingOk

	// Set time before PING to prevent concurrent callers from stampeding
	lastPingTime = now
	try {
		const pong = await client.ping()
		lastPingOk = pong === "PONG"
	} catch {
		lastPingOk = false
	}
	return lastPingOk
}

export async function closeRedis(): Promise<void> {
	if (client) {
		client.close()
		client = null
	}
}
