import { afterAll, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const keys: string[] = []
function k(prefix = "hash") {
	const key = randomKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await redis.del(...keys)
	}
})

describe("SDK: hash operations", () => {
	test("hset + hgetall", async () => {
		const key = k()
		await redis.hset(key, { name: "Ben", role: "admin", score: 100 })
		const all = await redis.hgetall<Record<string, string | number>>(key)
		expect(all).toEqual({ name: "Ben", role: "admin", score: 100 })
	})

	test("hset + hget single field", async () => {
		const key = k()
		await redis.hset(key, { field1: "value1", field2: "value2" })
		const val = await redis.hget(key, "field1")
		expect(val).toBe("value1")
	})

	test("hget nonexistent field returns null", async () => {
		const key = k()
		await redis.hset(key, { a: "b" })
		const val = await redis.hget(key, "nonexistent")
		expect(val).toBe(null)
	})

	test("hdel + hexists", async () => {
		const key = k()
		await redis.hset(key, { a: "1", b: "2" })
		const deleted = await redis.hdel(key, "a")
		expect(deleted).toBe(1)
		const exists = await redis.hexists(key, "a")
		expect(exists).toBe(0)
		const exists2 = await redis.hexists(key, "b")
		expect(exists2).toBe(1)
	})

	test("hincrby", async () => {
		const key = k()
		await redis.hset(key, { counter: 10 })
		const val = await redis.hincrby(key, "counter", 5)
		expect(val).toBe(15)
	})

	test("hlen", async () => {
		const key = k()
		await redis.hset(key, { a: "1", b: "2", c: "3" })
		const len = await redis.hlen(key)
		expect(len).toBe(3)
	})

	test("hkeys + hvals", async () => {
		const key = k()
		await redis.hset(key, { x: "1", y: "2" })
		const hkeys = await redis.hkeys(key)
		expect(hkeys.sort()).toEqual(["x", "y"])
		const hvals = await redis.hvals(key)
		// SDK parses numeric strings as numbers via JSON.parse
		expect(hvals.sort()).toEqual([1, 2])
	})

	test("hmget", async () => {
		const key = k()
		await redis.hset(key, { a: "1", b: "2", c: "3" })
		const vals = await redis.hmget<Record<string, number | null>>(key, "a", "c", "missing")
		// SDK parses numeric strings as numbers via JSON.parse
		expect(vals).toEqual({ a: 1, c: 3, missing: null })
	})

	test("hgetall empty hash returns null", async () => {
		const all = await redis.hgetall(randomKey("nonexistent-hash"))
		expect(all).toBe(null)
	})
})
