import { afterAll, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const keys: string[] = []
function k(prefix = "ds") {
	const key = randomKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await redis.del(...keys)
	}
})

describe("SDK: list operations", () => {
	test("lpush + lrange", async () => {
		const key = k()
		await redis.lpush(key, "c", "b", "a")
		const list = await redis.lrange(key, 0, -1)
		expect(list).toEqual(["a", "b", "c"])
	})

	test("rpush + llen + lpop + rpop", async () => {
		const key = k()
		await redis.rpush(key, "a", "b", "c")
		const len = await redis.llen(key)
		expect(len).toBe(3)
		const left = await redis.lpop(key)
		expect(left).toBe("a")
		const right = await redis.rpop(key)
		expect(right).toBe("c")
	})

	test("lindex", async () => {
		const key = k()
		await redis.rpush(key, "a", "b", "c")
		const val = await redis.lindex(key, 1)
		expect(val).toBe("b")
	})
})

describe("SDK: set operations", () => {
	test("sadd + smembers", async () => {
		const key = k()
		await redis.sadd(key, "a", "b", "c")
		const members = await redis.smembers(key)
		expect(members.sort()).toEqual(["a", "b", "c"])
	})

	test("scard + sismember", async () => {
		const key = k()
		await redis.sadd(key, "x", "y")
		const card = await redis.scard(key)
		expect(card).toBe(2)
		const is1 = await redis.sismember(key, "x")
		expect(is1).toBe(1)
		const is2 = await redis.sismember(key, "z")
		expect(is2).toBe(0)
	})

	test("srem", async () => {
		const key = k()
		await redis.sadd(key, "a", "b", "c")
		const removed = await redis.srem(key, "b")
		expect(removed).toBe(1)
		const members = await redis.smembers(key)
		expect(members.sort()).toEqual(["a", "c"])
	})
})

describe("SDK: sorted set operations", () => {
	test("zadd + zrange", async () => {
		const key = k()
		await redis.zadd(
			key,
			{ score: 1, member: "a" },
			{ score: 2, member: "b" },
			{ score: 3, member: "c" },
		)
		const members = await redis.zrange(key, 0, -1)
		expect(members).toEqual(["a", "b", "c"])
	})

	test("zcard + zscore", async () => {
		const key = k()
		await redis.zadd(key, { score: 10, member: "x" }, { score: 20, member: "y" })
		const card = await redis.zcard(key)
		expect(card).toBe(2)
		const score = await redis.zscore(key, "y")
		expect(score).toBe(20)
	})

	test("zincrby", async () => {
		const key = k()
		await redis.zadd(key, { score: 5, member: "m" })
		const newScore = await redis.zincrby(key, 3, "m")
		expect(newScore).toBe(8)
	})

	test("zrank", async () => {
		const key = k()
		await redis.zadd(
			key,
			{ score: 1, member: "a" },
			{ score: 2, member: "b" },
			{ score: 3, member: "c" },
		)
		const rank = await redis.zrank(key, "b")
		expect(rank).toBe(1)
	})

	test("zrem", async () => {
		const key = k()
		await redis.zadd(key, { score: 1, member: "a" }, { score: 2, member: "b" })
		const removed = await redis.zrem(key, "a")
		expect(removed).toBe(1)
		const card = await redis.zcard(key)
		expect(card).toBe(1)
	})
})
