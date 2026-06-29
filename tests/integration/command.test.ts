import { afterAll, describe, expect, test } from "bun:test"
import { AUTH, api, cmd, cmdBase64, testKey } from "./setup"

const BASE_URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"
const TOKEN = process.env.UPREDIS_TOKEN ?? "test-token-123"

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

// Runtime capability probe for the newer hash-field read/write-with-expiry commands
// (HSETEX / HGETEX / HGETDEL). These exist on Redis 8+ and Valkey 9+ but NOT on
// redis:7-alpine or Valkey 8. Probe once at module load — before any test
// registers — so that test.skipIf() sees the resolved value. SKIP, never fail, on
// backends that legitimately lack the command. Detection: the server replies with an
// error whose message contains "unknown command".
// Probe key is never written to; nothing to clean up.
const { data: _probeData } = await api("POST", "/", [
	"HGETEX",
	testKey("cmd:probe"),
	"EX",
	"1",
	"FIELDS",
	"1",
	"f",
])
const _probeErr = (_probeData as { error?: string }).error ?? ""
const supportsHashExpireGet = !(_probeErr && /unknown command/i.test(_probeErr))

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

	// Regression: Bun.redis hands back JS Infinity for an infinite score, which
	// JSON.stringify would turn into null. The proxy must emit the Redis string
	// forms "inf"/"-inf" instead (see translate/response.ts).
	test("ZSCORE of an infinite score returns the string inf, not null", async () => {
		const key = k()
		await cmd("ZADD", key, "inf", "member")
		const result = await cmd("ZSCORE", key, "member")
		expect(result).toBe("inf")
	})

	test("ZADD INCR to -inf returns the string -inf, not null", async () => {
		const key = k()
		await cmd("ZADD", key, "5", "m")
		const result = await cmd("ZADD", key, "INCR", "-inf", "m")
		expect(result).toBe("-inf")
	})

	// Input validation: non-(string|number) args must be rejected with 400, not
	// silently coerced (String({}) → "[object Object]", String(null) → "null").
	test("rejects an object argument with 400", async () => {
		const { status, data } = await api("POST", "/", ["SET", k(), { a: 1 }])
		expect(status).toBe(400)
		expect(data).toHaveProperty("error")
	})

	test("rejects a null argument with 400", async () => {
		const { status } = await api("POST", "/", ["SET", k(), null])
		expect(status).toBe(400)
	})

	test("rejects a boolean argument with 400", async () => {
		const { status } = await api("POST", "/", ["SET", k(), true])
		expect(status).toBe(400)
	})

	test("accepts a numeric argument, coercing it to a string", async () => {
		const key = k()
		await cmd("SET", key, "1")
		const result = await cmd("EXPIRE", key, 100)
		expect(result).toBe(1)
	})

	// Path-style: a "/" inside a value must be percent-encoded (%2F); it then
	// round-trips correctly. An unencoded "/" is a path separator, like every
	// URL-path API — that's a documented requirement, not silent corruption.
	test("path-style round-trips a %2F-encoded slash in a value", async () => {
		const key = k()
		const headers = { Authorization: `Bearer ${TOKEN}` }
		const setRes = await fetch(`${BASE_URL}/set/${encodeURIComponent(key)}/a%2Fb`, { headers })
		expect(setRes.status).toBe(200)
		const getRes = await fetch(`${BASE_URL}/get/${encodeURIComponent(key)}`, { headers })
		const data = (await getRes.json()) as { result: unknown }
		expect(data.result).toBe("a/b")
	})

	// Upstash-Response-Format: resp2 asks for binary RESP2; up-redis only speaks the
	// JSON envelope. Fail loud rather than silently returning JSON the SDK's binary
	// parser would choke on.
	test("rejects Upstash-Response-Format: resp2 with 400", async () => {
		const { status, data } = await api("POST", "/", ["PING"], {
			"Upstash-Response-Format": "resp2",
		})
		expect(status).toBe(400)
		expect(data).toHaveProperty("error")
	})

	test("allows Upstash-Response-Format: json", async () => {
		const { status } = await api("POST", "/", ["PING"], { "Upstash-Response-Format": "json" })
		expect(status).toBe(200)
	})

	// KEYS is O(N) and would hold the shared connection across the whole keyspace,
	// so it's blocked by default (configurable via UPREDIS_ALLOW_DANGEROUS_COMMANDS).
	test("blocks KEYS by default with 400", async () => {
		const { status, data } = await api("POST", "/", ["KEYS", "*"])
		expect(status).toBe(400)
		expect((data as { error?: string }).error).toContain("UPREDIS_ALLOW_DANGEROUS_COMMANDS")
	})

	test("blocks FLUSHALL by default with 400", async () => {
		const { status } = await api("POST", "/", ["FLUSHALL"])
		expect(status).toBe(400)
	})

	// _token query-param auth (Upstash compat) is enabled by default.
	test("authenticates via the _token query param by default", async () => {
		const res = await fetch(`${BASE_URL}/?_token=${encodeURIComponent(TOKEN)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(200)
	})

	// The SDK defaults readYourWrites:true and echoes the upstash-sync-token we emit
	// ("0") back as a REQUEST header on subsequent calls. The proxy must accept it.
	test("tolerates an echoed upstash-sync-token request header", async () => {
		const { status } = await api("POST", "/", ["PING"], { "upstash-sync-token": "0" })
		expect(status).toBe(200)
	})

	test("emits the upstash-sync-token response header", async () => {
		const { headers } = await api("POST", "/", ["PING"])
		expect(headers.get("upstash-sync-token")).toBe("0")
	})

	// Newer hash-field-TTL commands (Redis 7.4+) return integer arrays that must
	// pass through normalizeResp3 unchanged (generic pass-through on the proxy).
	test("HEXPIRE returns an integer array", async () => {
		const key = k()
		await cmd("HSET", key, "f1", "v1")
		const result = await cmd("HEXPIRE", key, "100", "FIELDS", "1", "f1")
		expect(result).toEqual([1])
	})

	test("HTTL returns an integer array with the remaining TTL", async () => {
		const key = k()
		await cmd("HSET", key, "f1", "v1")
		await cmd("HEXPIRE", key, "100", "FIELDS", "1", "f1")
		const result = (await cmd("HTTL", key, "FIELDS", "1", "f1")) as number[]
		expect(Array.isArray(result)).toBe(true)
		expect(result[0]).toBeGreaterThan(0)
		expect(result[0]).toBeLessThanOrEqual(100)
	})

	// HSETEX / HGETEX / HGETDEL exist on Redis 8+ and Valkey 9+ but not on
	// redis:7-alpine or Valkey 8, so they are guarded by the runtime probe above:
	// they RUN where supported and report as SKIPPED elsewhere — never a hard failure.
	// Argument grammar (verified against redis:8-alpine): the expiry/action option
	// (EX/PX/EXAT/PXAT/KEEPTTL/PERSIST) precedes the FIELDS block.
	test.skipIf(!supportsHashExpireGet)("HSETEX sets a field with an expiry", async () => {
		const key = k()
		const result = await cmd("HSETEX", key, "EX", "100", "FIELDS", "1", "f1", "v1")
		expect(result).toBe(1)
		expect(await cmd("HGET", key, "f1")).toBe("v1")
		const ttl = (await cmd("HTTL", key, "FIELDS", "1", "f1")) as number[]
		expect(ttl[0]).toBeGreaterThan(0)
		expect(ttl[0]).toBeLessThanOrEqual(100)
	})

	test.skipIf(!supportsHashExpireGet)(
		"HGETEX reads a field and round-trips the value",
		async () => {
			const key = k()
			await cmd("HSET", key, "f1", "v1")
			const result = await cmd("HGETEX", key, "EX", "200", "FIELDS", "1", "f1")
			expect(result).toEqual(["v1"])
			const ttl = (await cmd("HTTL", key, "FIELDS", "1", "f1")) as number[]
			expect(ttl[0]).toBeGreaterThan(0)
			expect(ttl[0]).toBeLessThanOrEqual(200)
		},
	)

	test.skipIf(!supportsHashExpireGet)(
		"HGETDEL returns the value and deletes the field",
		async () => {
			const key = k()
			await cmd("HSET", key, "f1", "v1")
			const result = await cmd("HGETDEL", key, "FIELDS", "1", "f1")
			expect(result).toEqual(["v1"])
			expect(await cmd("HGET", key, "f1")).toBe(null)
		},
	)

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
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("wrong auth returns 401", async () => {
		const res = await fetch(`${BASE_URL}/`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: "Bearer wrong-token",
			},
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(401)
	})

	test("_token query auth is accepted", async () => {
		const res = await fetch(`${BASE_URL}/?_token=${encodeURIComponent(TOKEN)}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(["PING"]),
		})
		expect(res.status).toBe(200)
		const data = await res.json()
		expect(data).toEqual({ result: "PONG" })
	})

	test("invalid Authorization header is not bypassed by valid _token query auth", async () => {
		const res = await fetch(`${BASE_URL}/?_token=${encodeURIComponent(TOKEN)}`, {
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

describe("Path-style REST commands", () => {
	test("GET /set/:key/:value and GET /get/:key execute commands", async () => {
		const key = k("path")
		const set = await fetch(
			`${BASE_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent("hello world")}`,
			{ headers: AUTH },
		)
		expect(set.status).toBe(200)
		expect(await set.json()).toEqual({ result: "OK" })

		const get = await fetch(`${BASE_URL}/get/${encodeURIComponent(key)}`, { headers: AUTH })
		expect(get.status).toBe(200)
		expect(await get.json()).toEqual({ result: "hello world" })
	})

	test("path command supports _token query auth without forwarding _token to Redis", async () => {
		const key = k("path-token")
		const res = await fetch(
			`${BASE_URL}/set/${encodeURIComponent(key)}/value?_token=${encodeURIComponent(TOKEN)}&EX=60`,
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: "OK" })

		const ttl = await cmd("TTL", key)
		expect(ttl as number).toBeGreaterThan(0)
	})

	test("POST path command appends raw body before query arguments", async () => {
		const key = k("path-post")
		const res = await fetch(`${BASE_URL}/set/${encodeURIComponent(key)}?EX=60`, {
			method: "POST",
			headers: { ...AUTH, "Content-Type": "text/plain" },
			body: "posted value",
		})
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ result: "OK" })

		expect(await cmd("GET", key)).toBe("posted value")
		const ttl = await cmd("TTL", key)
		expect(ttl as number).toBeGreaterThan(0)
	})

	test("path command honors base64 response encoding", async () => {
		const key = k("path-b64")
		await cmd("SET", key, "encoded")

		const res = await fetch(`${BASE_URL}/get/${encodeURIComponent(key)}`, {
			headers: { ...AUTH, "Upstash-Encoding": "base64" },
		})
		expect(res.status).toBe(200)
		const data = (await res.json()) as { result: unknown }
		expect(data.result).toBe(Buffer.from("encoded").toString("base64"))
	})

	test("the blocked-command gate also applies to the path-style entry point", async () => {
		// Same checkBlockedCommand path as POST /, but reached via the GET catch-all route.
		// Connection-state command (SUBSCRIBE) must be rejected here too.
		const subscribe = await fetch(`${BASE_URL}/SUBSCRIBE/chan`, { headers: AUTH })
		expect(subscribe.status).toBe(400)
		expect((await subscribe.json()) as { error: string }).toHaveProperty("error")

		// Dangerous-by-default command (KEYS) via path-style is blocked too.
		const keys = await fetch(`${BASE_URL}/KEYS/*`, { headers: AUTH })
		expect(keys.status).toBe(400)
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

	test("XREAD BLOCK is blocked", async () => {
		const { status, data } = await api("POST", "/", ["XREAD", "BLOCK", "0", "STREAMS", "s", "$"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("XREAD BLOCK")
	})

	test("XREADGROUP BLOCK is blocked", async () => {
		const { status, data } = await api("POST", "/", [
			"XREADGROUP",
			"GROUP",
			"g",
			"c",
			"BLOCK",
			"0",
			"STREAMS",
			"s",
			">",
		])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("XREADGROUP BLOCK")
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

	test("CLIENT SETINFO is blocked (would leak across users on shared connection)", async () => {
		const { status, data } = await api("POST", "/", ["CLIENT", "SETINFO", "lib-name", "evil"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("CLIENT SETINFO")
	})

	test("CLIENT NO-TOUCH is blocked (per-connection state on shared connection)", async () => {
		const { status, data } = await api("POST", "/", ["CLIENT", "NO-TOUCH", "ON"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("CLIENT NO-TOUCH")
	})

	test("CLUSTER FAILOVER is blocked", async () => {
		const { status, data } = await api("POST", "/", ["CLUSTER", "FAILOVER"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("CLUSTER FAILOVER")
	})

	test("CLUSTER RESET is blocked", async () => {
		const { status, data } = await api("POST", "/", ["CLUSTER", "RESET"])
		expect(status).toBe(400)
		expect((data as { error: string }).error).toContain("CLUSTER RESET")
	})

	test("CLUSTER INFO is allowed by the proxy (Redis may still error if cluster mode is off)", async () => {
		// On a non-cluster Redis, CLUSTER INFO returns "ERR This instance has cluster
		// support disabled". The point of the test is that the proxy itself does NOT
		// block CLUSTER INFO — the error must come from Redis, not us.
		const { status, data } = await api("POST", "/", ["CLUSTER", "INFO"])
		if (status === 200) {
			// Cluster mode enabled — got info back
			expect((data as { result: string }).result).toBeDefined()
		} else {
			// Cluster mode disabled — Redis returns error, but not the proxy's block message
			expect((data as { error: string }).error).not.toContain("not allowed")
		}
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
