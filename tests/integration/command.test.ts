import { afterAll, describe, expect, test } from "bun:test"
import { api, cmd, cmdBase64, testKey } from "./setup"

const keys: string[] = []
function k(prefix = "cmd") {
	const key = testKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await api("POST", "/", ["DEL", ...keys])
	}
})

describe("POST / (single command)", () => {
	// Basic operations
	test("SET returns OK", async () => {
		const { data, status } = await api("POST", "/", ["SET", k(), "value"])
		expect(status).toBe(200)
		expect(data).toEqual({ result: "OK" })
	})

	test("SET + GET roundtrip", async () => {
		const key = k()
		await cmd("SET", key, "hello")
		const result = await cmd("GET", key)
		expect(result).toBe("hello")
	})

	test("GET nonexistent key returns null", async () => {
		const result = await cmd("GET", testKey("nonexistent"))
		expect(result).toBe(null)
	})

	test("DEL returns integer", async () => {
		const key = k()
		await cmd("SET", key, "val")
		const result = await cmd("DEL", key)
		expect(result).toBe(1)
	})

	test("INCR returns integer", async () => {
		const key = k()
		await cmd("SET", key, "10")
		const result = await cmd("INCR", key)
		expect(result).toBe(11)
	})

	// Array responses
	test("MGET returns array with values and nulls", async () => {
		const k1 = k()
		const k2 = k()
		await cmd("SET", k1, "a")
		await cmd("SET", k2, "b")
		const result = await cmd("MGET", k1, testKey("missing"), k2)
		expect(result).toEqual(["a", null, "b"])
	})

	// Hash — RESP3 Map translation
	test("HSET + HGETALL returns flat alternating array", async () => {
		const key = k()
		await cmd("HSET", key, "name", "Ben", "role", "admin")
		const result = await cmd("HGETALL", key)
		// RESP3 Map → flat array
		expect(Array.isArray(result)).toBe(true)
		const arr = result as string[]
		// Should contain all key-value pairs (order may vary)
		const obj: Record<string, string> = {}
		for (let i = 0; i < arr.length; i += 2) {
			obj[arr[i]] = arr[i + 1]
		}
		expect(obj).toEqual({ name: "Ben", role: "admin" })
	})

	// Error responses
	test("WRONGTYPE error returns error envelope with 400", async () => {
		const key = k()
		await cmd("SET", key, "string-value")
		const { data, status } = await api("POST", "/", ["LPUSH", key, "item"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("WRONGTYPE")
	})

	// Invalid requests
	test("non-array body returns 400", async () => {
		const { status, data } = await api("POST", "/", { cmd: "SET" })
		expect(status).toBe(400)
		expect((data as { error: string }).error).toBeDefined()
	})

	test("empty array body returns 400", async () => {
		const { status, data } = await api("POST", "/", [])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toBeDefined()
	})

	// Auth
	test("missing auth returns 401", async () => {
		const res = await fetch("http://localhost:8080/", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("wrong auth returns 401", async () => {
		const res = await fetch("http://localhost:8080/", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	// Base64 encoding
	test("with base64 header: string values are base64-encoded", async () => {
		const key = k()
		await cmd("SET", key, "hello")
		const result = await cmdBase64("GET", key)
		expect(result).toBe(Buffer.from("hello").toString("base64"))
	})

	test("with base64 header: integer results stay as numbers", async () => {
		const key = k()
		await cmd("SET", key, "5")
		const result = await cmdBase64("INCR", key)
		expect(result).toBe(6)
		expect(typeof result).toBe("number")
	})

	test("with base64 header: null stays as null", async () => {
		const result = await cmdBase64("GET", testKey("nonexistent"))
		expect(result).toBe(null)
	})

	test("without base64 header: strings returned as-is", async () => {
		const key = k()
		await cmd("SET", key, "hello")
		const result = await cmd("GET", key)
		expect(result).toBe("hello")
	})

	// Numeric arguments
	test("SET with EX (numeric arg)", async () => {
		const key = k()
		await cmd("SET", key, "val", "EX", 60)
		const ttl = await cmd("TTL", key)
		expect(typeof ttl).toBe("number")
		expect(ttl as number).toBeGreaterThan(0)
	})
})

describe("POST / (blocked commands)", () => {
	test("SUBSCRIBE is blocked", async () => {
		const { status, data } = await api("POST", "/", ["SUBSCRIBE", "my-channel"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("SUBSCRIBE")
	})

	test("PSUBSCRIBE is blocked", async () => {
		const { status, data } = await api("POST", "/", ["PSUBSCRIBE", "my-*"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("PSUBSCRIBE")
	})

	test("MONITOR is blocked", async () => {
		const { status, data } = await api("POST", "/", ["MONITOR"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("MONITOR")
	})

	test("MULTI is blocked with helpful message", async () => {
		const { status, data } = await api("POST", "/", ["MULTI"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("/multi-exec")
	})

	test("SELECT is blocked", async () => {
		const { status, data } = await api("POST", "/", ["SELECT", "1"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("SELECT")
	})

	test("QUIT is blocked", async () => {
		const { status, data } = await api("POST", "/", ["QUIT"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("QUIT")
	})

	test("BLPOP is blocked (would freeze the shared connection)", async () => {
		const { status, data } = await api("POST", "/", ["BLPOP", "k", "0"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("BLPOP")
	})

	test("BRPOP is blocked", async () => {
		const { status, data } = await api("POST", "/", ["BRPOP", "k", "0"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("BRPOP")
	})

	test("WAIT is blocked", async () => {
		const { status, data } = await api("POST", "/", ["WAIT", "0", "0"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("WAIT")
	})

	test("SHUTDOWN is blocked (would kill the Redis server)", async () => {
		const { status, data } = await api("POST", "/", ["SHUTDOWN"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("SHUTDOWN")
	})

	test("DEBUG SLEEP is blocked", async () => {
		const { status, data } = await api("POST", "/", ["DEBUG", "SLEEP", "1"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("DEBUG")
	})

	test("CLIENT KILL is blocked", async () => {
		const { status, data } = await api("POST", "/", ["CLIENT", "KILL", "ID", "1"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("CLIENT KILL")
	})

	test("CLIENT PAUSE is blocked", async () => {
		const { status, data } = await api("POST", "/", ["CLIENT", "PAUSE", "1000"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("CLIENT PAUSE")
	})

	test("CLIENT INFO is allowed (read-only subcommand)", async () => {
		const { status } = await api("POST", "/", ["CLIENT", "INFO"])
		expect(status).toBe(200)
	})

	test("blocked commands are case-insensitive", async () => {
		const { status } = await api("POST", "/", ["subscribe", "ch"])
		expect(status).toBe(400)
	})

	test("blocked commands inside pipeline use per-command error", async () => {
		const key = k()
		const { status, data } = await api("POST", "/pipeline", [
			["SET", key, "v"],
			["BLPOP", key, "0"],
			["GET", key],
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results[0].result).toBe("OK")
		expect(results[1].error).toContain("BLPOP")
		expect(results[2].result).toBe("v")
	})

	test("blocked commands inside multi-exec return 400 (whole tx rejected)", async () => {
		const key = k()
		const { status, data } = await api("POST", "/multi-exec", [
			["SET", key, "v"],
			["BLPOP", key, "0"],
		])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("BLPOP")
	})

	test("regular commands still work", async () => {
		const { status, data } = await api("POST", "/", ["PING"])
		expect(status).toBe(200)
		expect((data as { result: string }).result).toBe("PONG")
	})
})
