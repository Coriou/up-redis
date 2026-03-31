import { afterAll, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const keys: string[] = []
function k(prefix = "sdkpipe") {
	const key = randomKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await redis.del(...keys)
	}
})

describe("SDK: pipeline", () => {
	test("basic pipeline: set + get + del", async () => {
		const key = k()
		const pipe = redis.pipeline()
		pipe.set(key, "pipelined")
		pipe.get(key)
		pipe.del(key)
		const results = await pipe.exec()
		expect(results).toEqual(["OK", "pipelined", 1])
	})

	test("pipeline with mixed types", async () => {
		const sk = k()
		const hk = k()
		const pipe = redis.pipeline()
		pipe.set(sk, "string")
		pipe.hset(hk, { a: "1", b: "2" })
		pipe.get(sk)
		pipe.hgetall(hk)
		const results = await pipe.exec()
		expect(results[0]).toBe("OK")
		expect(results[1]).toBe(2) // HSET returns number of fields added
		expect(results[2]).toBe("string")
		// SDK parses numeric-looking hash values via JSON.parse
		expect(results[3]).toEqual({ a: 1, b: 2 })
	})

	test("pipeline preserves order", async () => {
		const key = k()
		const pipe = redis.pipeline()
		pipe.set(key, "0")
		pipe.incr(key)
		pipe.incr(key)
		pipe.incr(key)
		pipe.get(key)
		const results = await pipe.exec()
		// SDK's GET deserializer JSON.parses the value, so "3" becomes 3
		expect(results).toEqual(["OK", 1, 2, 3, 3])
	})
})
