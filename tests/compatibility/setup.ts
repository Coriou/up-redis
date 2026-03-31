import { Redis } from "@upstash/redis"

export const TOKEN = process.env.UPREDIS_TOKEN ?? "test-token-123"
export const URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"

export function createRedis(): Redis {
	return new Redis({ url: URL, token: TOKEN })
}

export function randomKey(prefix = "compat"): string {
	return `${prefix}:${Math.random().toString(36).slice(2, 10)}:${Date.now()}`
}
