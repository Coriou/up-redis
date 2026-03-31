import { afterAll, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const keys: string[] = []
function k(prefix = "sdktx") {
	const key = randomKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await redis.del(...keys)
	}
})

describe("SDK: transactions (multi/exec)", () => {
	test("basic transaction: set + get", async () => {
		const key = k()
		const tx = redis.multi()
		tx.set(key, "transacted")
		tx.get(key)
		const results = await tx.exec()
		expect(results).toEqual(["OK", "transacted"])
	})

	test("transaction with mixed types", async () => {
		const sk = k()
		const hk = k()
		const tx = redis.multi()
		tx.set(sk, "val")
		tx.hset(hk, { f1: "v1" })
		tx.get(sk)
		tx.hgetall(hk)
		const results = await tx.exec()
		expect(results[0]).toBe("OK")
		expect(results[1]).toBe(1) // HSET returns fields added
		expect(results[2]).toBe("val")
		expect(results[3]).toEqual({ f1: "v1" })
	})

	test("transaction atomicity: concurrent INCR", async () => {
		const key = k()
		await redis.set(key, 0)

		// 5 parallel transactions, each incrementing 20 times
		const promises = Array.from({ length: 5 }, () => {
			const tx = redis.multi()
			for (let i = 0; i < 20; i++) {
				tx.incr(key)
			}
			return tx.exec()
		})

		await Promise.all(promises)
		const finalVal = await redis.get<number>(key)
		expect(finalVal).toBe(100) // 5 * 20 = 100
	})
})
