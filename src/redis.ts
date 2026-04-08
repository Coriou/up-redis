import { RedisClient } from "bun"
import { config } from "./config"
import { log } from "./logger"

let client: RedisClient | null = null
let lastPingOk = true
let lastPingTime = 0
const PING_CACHE_MS = 1000
const STARTUP_PING_TIMEOUT_MS = 10_000

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
		lastPingOk = true
		log.info("redis connected")
	}
	client.onclose = (error?: Error) => {
		// On a clean `client.close()` Bun does not always pass an Error.
		// Defensive against undefined to avoid TypeError on shutdown.
		lastPingOk = false
		log.warn("redis disconnected", { error: error?.message ?? "connection closed" })
	}

	// Bound startup so a hung Redis doesn't wedge the entire process forever.
	// connectionTimeout above bounds the TCP handshake; this bounds PING reply.
	let pingTimer: ReturnType<typeof setTimeout> | undefined
	const ping = client.ping()
	// Suppress unhandled rejection on the original ping if the timeout wins.
	ping.catch(() => {})
	const timeout = new Promise<string>((_, reject) => {
		pingTimer = setTimeout(
			() => reject(new Error(`Redis PING timed out after ${STARTUP_PING_TIMEOUT_MS}ms`)),
			STARTUP_PING_TIMEOUT_MS,
		)
	})
	try {
		const pong = await Promise.race([ping, timeout])
		if (pong !== "PONG") {
			throw new Error(`Redis PING failed: ${pong}`)
		}
	} finally {
		if (pingTimer) clearTimeout(pingTimer)
	}
}

/**
 * Create a dedicated Redis connection for use cases that need an isolated
 * connection: MULTI/EXEC transactions and PubSub subscriptions.
 *
 * Both autoReconnect and enableOfflineQueue are disabled because:
 *
 * - Subscriber state is per-connection on the Redis server. If the connection
 *   silently reconnects, the server forgets the subscription and the SSE
 *   stream sits idle waiting for messages that never arrive.
 * - MULTI state is per-connection. A reconnect mid-transaction would either
 *   send queued commands without MULTI context (corrupting state) or run them
 *   on a fresh connection (silent transaction abort).
 *
 * Disabling auto-reconnect makes the failure mode loud: any drop surfaces as
 * an error and `onclose` fires so cleanup paths can run.
 *
 * Auto-pipelining is disabled because dedicated connections handle
 * single-flight command sequences (subscribe, then wait; or MULTI → cmds → EXEC),
 * not concurrent traffic, so batching has nothing to batch.
 */
export async function createDedicatedConnection(): Promise<RedisClient> {
	const conn = new RedisClient(config.redisUrl, {
		connectionTimeout: 10_000,
		autoReconnect: false,
		maxRetries: 0,
		enableAutoPipelining: false,
		enableOfflineQueue: false,
	})
	await conn.connect()
	return conn
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
		try {
			client.close()
		} catch {
			// Already closed or in a bad state — nothing to do.
		}
		client = null
	}
}
