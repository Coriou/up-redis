import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { api, cmd, testKey } from "./setup"
import { type SpawnedServer, spawnServer } from "./spawn-server"
import { type StallableRedisProxy, startStallableRedisProxy } from "./stallable-redis"

const keys: string[] = []
function k(prefix = "tx") {
	const key = testKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await api("POST", "/", ["DEL", ...keys])
	}
})

describe("POST /multi-exec", () => {
	test("basic transaction: SET + GET", async () => {
		const key = k()
		const { data, status } = await api("POST", "/multi-exec", [
			["SET", key, "hello"],
			["GET", key],
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results).toHaveLength(2)
		expect(results[0].result).toBe("OK")
		expect(results[1].result).toBe("hello")
	})

	test("response is a bare array", async () => {
		const key = k()
		const { data } = await api("POST", "/multi-exec", [["SET", key, "v"]])
		expect(Array.isArray(data)).toBe(true)
	})

	test("empty transaction returns empty array", async () => {
		const { data, status } = await api("POST", "/multi-exec", [])
		expect(status).toBe(200)
		expect(data).toEqual([])
	})

	test("transaction with base64 encoding", async () => {
		const key = k()
		const { data } = await api(
			"POST",
			"/multi-exec",
			[
				["SET", key, "world"],
				["GET", key],
			],
			{ "Upstash-Encoding": "base64" },
		)
		const results = data as Array<{ result?: unknown }>
		expect(results[0].result).toBe("OK")
		expect(results[1].result).toBe(Buffer.from("world").toString("base64"))
	})

	test("concurrent transactions do not interleave (SRH #25 regression)", async () => {
		// Fire 10 parallel transactions, each incrementing its own key 50 times
		const concurrency = 10
		const iterations = 50

		const transactionKeys = Array.from({ length: concurrency }, (_, i) => {
			const key = k(`concurrent-${i}`)
			return key
		})

		// Initialize all keys to 0
		await api(
			"POST",
			"/pipeline",
			transactionKeys.map((key) => ["SET", key, "0"]),
		)

		// Each transaction increments its own key `iterations` times
		const promises = transactionKeys.map((key) => {
			const commands = Array.from({ length: iterations }, () => ["INCR", key])
			return api("POST", "/multi-exec", commands)
		})

		const responses = await Promise.all(promises)

		// Verify all transactions succeeded
		for (const { status, data } of responses) {
			expect(status).toBe(200)
			const results = data as Array<{ result?: unknown }>
			expect(results).toHaveLength(iterations)
			// The last INCR should return the total count
			expect(results[iterations - 1].result).toBe(iterations)
		}

		// Double-check: GET each key — should equal iterations
		for (const key of transactionKeys) {
			const val = await cmd("GET", key)
			expect(Number(val)).toBe(iterations)
		}
	})

	test("per-command runtime error returns error for that command", async () => {
		const key = k()
		// Set key as string type
		await api("POST", "/", ["SET", key, "string-value"])

		const { data, status } = await api("POST", "/multi-exec", [
			["SET", key, "ok-value"],
			["LPUSH", key, "item"], // WRONGTYPE: key is still a string from SET above
			["GET", key],
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results).toHaveLength(3)
		expect(results[0].result).toBe("OK")
		// The LPUSH should have an error (WRONGTYPE)
		expect(results[1].error).toContain("WRONGTYPE")
		// GET should succeed with the value set by the first command
		expect(results[2].result).toBe("ok-value")
	})
})

describe("POST /multi-exec against a stalled upstream (CONC-4)", () => {
	let proxy: StallableRedisProxy
	let server: SpawnedServer

	beforeAll(async () => {
		proxy = await startStallableRedisProxy()
		server = await spawnServer({
			UPREDIS_REDIS_URL: `redis://127.0.0.1:${proxy.port}`,
		})
	}, 30_000)

	afterAll(() => {
		server?.close()
		proxy?.close()
	})

	async function postMultiExec(key: string): Promise<{ status: number; body: unknown }> {
		const res = await fetch(`${server.baseUrl}/multi-exec`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${server.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify([["SET", key, "v"]]),
		})
		return { status: res.status, body: await res.json() }
	}

	test("stalled MULTI fails with an error envelope in ~10s instead of hanging forever", async () => {
		// Sanity barrier: through the live relay the same request succeeds.
		const healthy = await postMultiExec(k("stall-ok"))
		expect(healthy.status).toBe(200)

		proxy.stallOnCommand("MULTI")
		const started = Date.now()
		const { status, body } = await postMultiExec(k("stall-hang"))
		const elapsed = Date.now() - started

		// The relay completes HELLO before black-holing MULTI. This proves the
		// post-handshake command deadline, not the existing connect timeout.
		expect(status).toBe(400)
		expect(body).toEqual({ error: "MULTI timed out after 10000ms" })
		const cleanupDeadline = Date.now() + 1000
		while (proxy.clientCount > 1 && Date.now() < cleanupDeadline) await Bun.sleep(10)
		expect(proxy.clientCount).toBe(1) // only the shared connection remains

		expect(elapsed).toBeLessThan(15_000)
	}, 20_000)

	test("proxy still serves requests against a healthy Redis after the stall", async () => {
		proxy.thaw()
		// The bounded failure released the suspended handler and its finally
		// closed the dedicated connection, so a fresh transaction works again.
		const { status, body } = await postMultiExec(k("stall-recovered"))
		expect(status).toBe(200)
		if (!Array.isArray(body)) throw new Error(`unexpected body: ${JSON.stringify(body)}`)
		expect(body[0].result).toBe("OK")

		const live = await fetch(`${server.baseUrl}/livez`)
		expect(live.status).toBe(200)
	}, 20_000)
})
