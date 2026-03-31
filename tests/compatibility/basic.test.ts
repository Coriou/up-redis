import { afterAll, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const keys: string[] = []
function k(prefix = "basic") {
	const key = randomKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await redis.del(...keys)
	}
})

describe("SDK: basic operations", () => {
	test("set + get string", async () => {
		const key = k()
		await redis.set(key, "hello")
		const val = await redis.get(key)
		expect(val).toBe("hello")
	})

	test("set + get number", async () => {
		const key = k()
		await redis.set(key, 42)
		const val = await redis.get<number>(key)
		expect(val).toBe(42)
	})

	test("set + get JSON object", async () => {
		const key = k()
		const obj = { name: "Ben", score: 100, tags: ["a", "b"] }
		await redis.set(key, obj)
		const val = await redis.get<typeof obj>(key)
		expect(val).toEqual(obj)
	})

	test("set with EX", async () => {
		const key = k()
		await redis.set(key, "expiring", { ex: 10 })
		const val = await redis.get(key)
		expect(val).toBe("expiring")
		const ttl = await redis.ttl(key)
		expect(ttl).toBeGreaterThan(0)
		expect(ttl).toBeLessThanOrEqual(10)
	})

	test("get nonexistent key returns null", async () => {
		const val = await redis.get(randomKey("nonexistent"))
		expect(val).toBe(null)
	})

	test("del returns number of deleted keys", async () => {
		const key = k()
		await redis.set(key, "val")
		const deleted = await redis.del(key)
		expect(deleted).toBe(1)
	})

	test("incr + decr", async () => {
		const key = k()
		await redis.set(key, 0)
		const val1 = await redis.incr(key)
		expect(val1).toBe(1)
		const val2 = await redis.incr(key)
		expect(val2).toBe(2)
		const val3 = await redis.decr(key)
		expect(val3).toBe(1)
	})

	test("incrby", async () => {
		const key = k()
		await redis.set(key, 10)
		const val = await redis.incrby(key, 5)
		expect(val).toBe(15)
	})

	test("mset + mget", async () => {
		const k1 = k()
		const k2 = k()
		const k3 = k()
		await redis.mset({ [k1]: "a", [k2]: "b", [k3]: "c" })
		const vals = await redis.mget<string[]>(k1, k2, k3)
		expect(vals).toEqual(["a", "b", "c"])
	})

	test("exists", async () => {
		const key = k()
		await redis.set(key, "val")
		const e1 = await redis.exists(key)
		expect(e1).toBe(1)
		const e2 = await redis.exists(randomKey("nonexistent"))
		expect(e2).toBe(0)
	})

	test("expire + ttl", async () => {
		const key = k()
		await redis.set(key, "val")
		await redis.expire(key, 60)
		const ttl = await redis.ttl(key)
		expect(ttl).toBeGreaterThan(0)
		expect(ttl).toBeLessThanOrEqual(60)
	})

	test("type", async () => {
		const key = k()
		await redis.set(key, "val")
		const t = await redis.type(key)
		expect(t).toBe("string")
	})

	test("append + strlen", async () => {
		const key = k()
		await redis.set(key, "hello")
		await redis.append(key, " world")
		const val = await redis.get(key)
		expect(val).toBe("hello world")
		const len = await redis.strlen(key)
		expect(len).toBe(11)
	})

	test("setnx only sets if not exists", async () => {
		const key = k()
		const r1 = await redis.setnx(key, "first")
		expect(r1).toBe(1)
		const r2 = await redis.setnx(key, "second")
		expect(r2).toBe(0)
		const val = await redis.get(key)
		expect(val).toBe("first")
	})
})
