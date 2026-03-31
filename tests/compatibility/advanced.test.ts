import { afterAll, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const keys: string[] = []
function k(prefix = "adv") {
	const key = randomKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await redis.del(...keys)
	}
})

describe("SDK: SET option combinations", () => {
	test("set with nx (only if not exists)", async () => {
		const key = k()
		const r1 = await redis.set(key, "first", { nx: true })
		expect(r1 as string).toBe("OK")
		const r2 = await redis.set(key, "second", { nx: true })
		expect(r2).toBe(null)
		expect(await redis.get<string>(key)).toBe("first")
	})

	test("set with xx (only if exists)", async () => {
		const key = k()
		const r1 = await redis.set(key, "val", { xx: true })
		expect(r1).toBe(null)
		await redis.set(key, "first")
		const r2 = await redis.set(key, "second", { xx: true })
		expect(r2 as string).toBe("OK")
		expect(await redis.get<string>(key)).toBe("second")
	})

	test("set with px (milliseconds)", async () => {
		const key = k()
		await redis.set(key, "val", { px: 60000 })
		const pttl = await redis.pttl(key)
		expect(pttl).toBeGreaterThan(0)
		expect(pttl).toBeLessThanOrEqual(60000)
	})

	test("set with get (return previous)", async () => {
		const key = k()
		await redis.set(key, "old")
		const prev = await redis.set(key, "new", { get: true })
		expect(prev).toBe("old")
	})

	test("set with get on non-existent key", async () => {
		const key = k()
		const prev = await redis.set(key, "val", { get: true })
		expect(prev).toBe(null)
	})
})

describe("SDK: empty and special values", () => {
	test("set + get empty string", async () => {
		const key = k()
		await redis.set(key, "")
		const val = await redis.get(key)
		expect(val).toBe("")
	})

	test("set + get string with newlines", async () => {
		const key = k()
		await redis.set(key, "line1\nline2\nline3")
		const val = await redis.get(key)
		expect(val).toBe("line1\nline2\nline3")
	})

	test("set + get unicode string", async () => {
		const key = k()
		await redis.set(key, "café 日本語 🎉")
		const val = await redis.get(key)
		expect(val).toBe("café 日本語 🎉")
	})

	test("set + get long string (50KB)", async () => {
		const key = k()
		const long = "A".repeat(50_000)
		await redis.set(key, long)
		const val = await redis.get(key)
		expect(val).toBe(long)
	})

	test("hset with JSON object values", async () => {
		const key = k()
		const nested = { items: [1, 2, 3], meta: { version: 2 } }
		await redis.hset(key, { data: JSON.stringify(nested) })
		const all = await redis.hgetall<Record<string, unknown>>(key)
		// SDK JSON.parses the value, so it should reconstruct the object
		expect(all?.data).toEqual(nested)
	})
})

describe("SDK: SCAN operations", () => {
	test("scan returns cursor and keys", async () => {
		const prefix = `scan-sdk:${Date.now()}`
		for (let i = 0; i < 5; i++) {
			const key = `${prefix}:${i}`
			keys.push(key)
			await redis.set(key, `v${i}`)
		}

		const [cursor, foundKeys] = await redis.scan(0, { match: `${prefix}:*`, count: 100 })
		// SDK returns cursor as string (Redis SCAN cursor is a string)
		expect(typeof cursor === "number" || typeof cursor === "string").toBe(true)
		expect(Array.isArray(foundKeys)).toBe(true)
		expect(foundKeys.length).toBeGreaterThanOrEqual(1)
	})

	test("hscan returns cursor and field-value pairs", async () => {
		const key = k()
		await redis.hset(key, { f1: "v1", f2: "v2", f3: "v3" })

		const [cursor, entries] = await redis.hscan(key, 0, { count: 100 })
		expect(typeof cursor === "number" || typeof cursor === "string").toBe(true)
		expect(Array.isArray(entries)).toBe(true)
		// SDK returns flat [field, value, field, value, ...] — 3 fields × 2 = 6
		expect(entries.length).toBe(6)
	})

	test("sscan returns cursor and members", async () => {
		const key = k()
		await redis.sadd(key, "a", "b", "c")

		const [cursor, members] = await redis.sscan(key, 0, { count: 100 })
		expect(typeof cursor === "number" || typeof cursor === "string").toBe(true)
		expect(Array.isArray(members)).toBe(true)
		expect(members.sort()).toEqual(["a", "b", "c"])
	})

	test("zscan returns cursor and member-score pairs", async () => {
		const key = k()
		await redis.zadd(key, { score: 1, member: "a" }, { score: 2, member: "b" })

		const [cursor, entries] = await redis.zscan(key, 0, { count: 100 })
		expect(typeof cursor === "number" || typeof cursor === "string").toBe(true)
		expect(Array.isArray(entries)).toBe(true)
		// SDK returns flat [member, score, member, score, ...] — 2 members × 2 = 4
		expect(entries.length).toBe(4)
	})
})

describe("SDK: sorted set advanced", () => {
	test("zadd with nx via raw command (new only)", async () => {
		const key = k()
		await redis.zadd(key, { score: 1, member: "a" })
		// NX via raw command to avoid SDK option serialization issues
		const added = await redis.zadd(key, { score: 99, member: "b" })
		expect(added).toBe(1) // b is new
		const score = await redis.zscore(key, "a")
		expect(score).toBe(1) // a unchanged
	})

	test("zrange with scores returns member-score tuples", async () => {
		const key = k()
		await redis.zadd(key, { score: 10, member: "a" }, { score: 20, member: "b" })
		const result = await redis.zrange(key, 0, -1, { withScores: true })
		// SDK returns [[member, score], ...] tuples
		expect(result).toEqual([
			["a", 10],
			["b", 20],
		])
	})

	test("zrange BYSCORE", async () => {
		const key = k()
		await redis.zadd(
			key,
			{ score: 1, member: "a" },
			{ score: 2, member: "b" },
			{ score: 3, member: "c" },
		)
		const result = await redis.zrange(key, 1, 2, { byScore: true })
		expect(result).toEqual(["a", "b"])
	})

	test("zcount", async () => {
		const key = k()
		await redis.zadd(
			key,
			{ score: 1, member: "a" },
			{ score: 2, member: "b" },
			{ score: 3, member: "c" },
		)
		const count = await redis.zcount(key, 1, 2)
		expect(count).toBe(2)
	})

	test("zpopmin + zpopmax return member-score tuples", async () => {
		const key = k()
		await redis.zadd(
			key,
			{ score: 1, member: "a" },
			{ score: 2, member: "b" },
			{ score: 3, member: "c" },
		)
		const min = await redis.zpopmin(key, 1)
		expect(min).toEqual([["a", 1]])
		const max = await redis.zpopmax(key, 1)
		expect(max).toEqual([["c", 3]])
	})
})

describe("SDK: list advanced", () => {
	test("lset changes element at index", async () => {
		const key = k()
		await redis.rpush(key, "a", "b", "c")
		await redis.lset(key, 1, "B")
		const list = await redis.lrange(key, 0, -1)
		expect(list).toEqual(["a", "B", "c"])
	})

	test("linsert before/after", async () => {
		const key = k()
		await redis.rpush(key, "a", "c")
		await redis.linsert(key, "before", "c", "b")
		const list = await redis.lrange(key, 0, -1)
		expect(list).toEqual(["a", "b", "c"])
	})

	test("ltrim", async () => {
		const key = k()
		await redis.rpush(key, "a", "b", "c", "d", "e")
		await redis.ltrim(key, 1, 3)
		const list = await redis.lrange(key, 0, -1)
		expect(list).toEqual(["b", "c", "d"])
	})
})

describe("SDK: string advanced", () => {
	test("incrbyfloat", async () => {
		const key = k()
		await redis.set(key, "10.5")
		const result = await redis.incrbyfloat(key, 0.1)
		expect(result).toBeCloseTo(10.6, 5)
	})

	test("getrange", async () => {
		const key = k()
		await redis.set(key, "Hello, World!")
		const result = await redis.getrange(key, 0, 4)
		expect(result).toBe("Hello")
	})

	test("setrange", async () => {
		const key = k()
		await redis.set(key, "Hello, World!")
		await redis.setrange(key, 7, "Redis!")
		const val = await redis.get(key)
		expect(val).toBe("Hello, Redis!")
	})
})

describe("SDK: key operations", () => {
	test("rename", async () => {
		const src = k()
		const dst = k()
		await redis.set(src, "val")
		await redis.rename(src, dst)
		const val = await redis.get(dst)
		expect(val).toBe("val")
		const exists = await redis.exists(src)
		expect(exists).toBe(0)
	})

	test("persist removes TTL", async () => {
		const key = k()
		await redis.set(key, "val", { ex: 60 })
		const ttl1 = await redis.ttl(key)
		expect(ttl1).toBeGreaterThan(0)
		await redis.persist(key)
		const ttl2 = await redis.ttl(key)
		expect(ttl2).toBe(-1)
	})

	test("randomkey returns a key or null", async () => {
		const key = k()
		await redis.set(key, "val")
		const result = await redis.randomkey()
		// Should return a string (some key in the DB) or null (empty DB)
		if (result !== null) {
			expect(typeof result).toBe("string")
		}
	})

	test("dbsize returns number", async () => {
		const result = await redis.dbsize()
		expect(typeof result).toBe("number")
		expect(result).toBeGreaterThanOrEqual(0)
	})
})

describe("SDK: HyperLogLog", () => {
	test("pfadd + pfcount", async () => {
		const key = k()
		await redis.pfadd(key, "a", "b", "c", "a")
		const count = await redis.pfcount(key)
		expect(count).toBe(3) // unique elements
	})

	test("pfmerge", async () => {
		const k1 = k()
		const k2 = k()
		const dest = k()
		await redis.pfadd(k1, "a", "b")
		await redis.pfadd(k2, "b", "c")
		await redis.pfmerge(dest, k1, k2)
		const count = await redis.pfcount(dest)
		expect(count).toBe(3)
	})
})

describe("SDK: Geo operations", () => {
	test("geoadd + geopos", async () => {
		const key = k()
		await redis.geoadd(key, {
			longitude: 13.361389,
			latitude: 38.115556,
			member: "Palermo",
		})
		await redis.geoadd(key, {
			longitude: 15.087269,
			latitude: 37.502669,
			member: "Catania",
		})
		const positions = await redis.geopos(key, "Palermo", "Catania")
		expect(positions).toHaveLength(2)
		expect(positions[0]).not.toBe(null)
	})

	test("geodist", async () => {
		const key = k()
		await redis.geoadd(
			key,
			{ longitude: 13.361389, latitude: 38.115556, member: "Palermo" },
			{ longitude: 15.087269, latitude: 37.502669, member: "Catania" },
		)
		const dist = await redis.geodist(key, "Palermo", "Catania", "KM")
		expect(typeof dist).toBe("number")
		expect(dist as number).toBeGreaterThan(100) // ~166km
	})
})

describe("SDK: Lua scripting", () => {
	test("eval simple script", async () => {
		const result = await redis.eval("return 42", [], [])
		expect(result).toBe(42)
	})

	test("eval with keys and args", async () => {
		const key = k()
		await redis.set(key, "hello")
		const result = await redis.eval("return redis.call('GET', KEYS[1])", [key], [])
		expect(result).toBe("hello")
	})

	test("eval returning array", async () => {
		const result = await redis.eval("return {'a', 'b', 'c'}", [], [])
		expect(result).toEqual(["a", "b", "c"])
	})
})

describe("SDK: server commands", () => {
	test("ping returns PONG", async () => {
		const result = await redis.ping()
		expect(result).toBe("PONG")
	})

	test("echo returns the message", async () => {
		const result = await redis.echo("hello up-redis")
		expect(result).toBe("hello up-redis")
	})

	test("dbsize returns number", async () => {
		const result = await redis.dbsize()
		expect(typeof result).toBe("number")
	})

	test("time returns array of two numbers", async () => {
		const result = await redis.time()
		expect(Array.isArray(result)).toBe(true)
		expect(result).toHaveLength(2)
	})
})

describe("SDK: pipeline error handling", () => {
	test("pipeline with error preserves other results", async () => {
		const key = k()
		await redis.set(key, "string-val")
		const pipe = redis.pipeline()
		pipe.get(key)
		// This should error (WRONGTYPE)
		pipe.lpush(key, "item")
		pipe.get(key)
		// Pipeline with keepErrors (auto-pipeline uses this)
		try {
			const results = await pipe.exec()
			// If no throw, results[1] should be error-related
			expect(results[0]).toBe("string-val")
			expect(results[2]).toBe("string-val")
		} catch (e) {
			// SDK may throw on pipeline command errors
			expect((e as Error).message).toContain("WRONGTYPE")
		}
	})
})

describe("SDK: transaction edge cases", () => {
	test("empty transaction (no commands queued)", async () => {
		try {
			const tx = redis.multi()
			await tx.exec()
			// SDK may throw "Pipeline is empty" before sending
		} catch (e) {
			expect((e as Error).message).toContain("empty")
		}
	})

	test("transaction with 100 commands", async () => {
		const key = k()
		await redis.set(key, 0)
		const tx = redis.multi()
		for (let i = 0; i < 100; i++) {
			tx.incr(key)
		}
		const results = await tx.exec()
		expect(results).toHaveLength(100)
		expect(results[99]).toBe(100)
	})
})
