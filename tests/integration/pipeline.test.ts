import { afterAll, describe, expect, test } from "bun:test"
import { api, testKey } from "./setup"

const keys: string[] = []
function k(prefix = "pipe") {
	const key = testKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await api("POST", "/", ["DEL", ...keys])
	}
})

describe("POST /pipeline", () => {
	test("basic pipeline: SET + GET + DEL", async () => {
		const key = k()
		const { data, status } = await api("POST", "/pipeline", [
			["SET", key, "hello"],
			["GET", key],
			["DEL", key],
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results).toHaveLength(3)
		expect(results[0].result).toBe("OK")
		expect(results[1].result).toBe("hello")
		expect(results[2].result).toBe(1)
	})

	test("response is a bare array (not wrapped in {result})", async () => {
		const key = k()
		const { data } = await api("POST", "/pipeline", [["SET", key, "v"]])
		expect(Array.isArray(data)).toBe(true)
	})

	test("per-command error does not abort pipeline", async () => {
		const key = k()
		await api("POST", "/", ["SET", key, "string-value"])
		const { data, status } = await api("POST", "/pipeline", [
			["LPUSH", key, "item"], // WRONGTYPE error
			["GET", key], // should still succeed
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results).toHaveLength(2)
		expect(results[0].error).toContain("WRONGTYPE")
		expect(results[1].result).toBe("string-value")
	})

	test("empty pipeline returns empty array", async () => {
		const { data, status } = await api("POST", "/pipeline", [])
		expect(status).toBe(200)
		expect(data).toEqual([])
	})

	test("large pipeline (100 commands)", async () => {
		const commands = Array.from({ length: 100 }, (_, i) => {
			const key = k(`large-${i}`)
			return ["SET", key, `val-${i}`]
		})
		const { data, status } = await api("POST", "/pipeline", commands)
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown }>
		expect(results).toHaveLength(100)
		for (const r of results) {
			expect(r.result).toBe("OK")
		}
	})

	test("pipeline with base64 encoding", async () => {
		const key = k()
		const { data } = await api(
			"POST",
			"/pipeline",
			[
				["SET", key, "hello"],
				["GET", key],
				["INCR", testKey("counter")],
			],
			{ "Upstash-Encoding": "base64" },
		)
		const results = data as Array<{ result?: unknown }>
		// SET → base64("OK")
		expect(results[0].result).toBe(Buffer.from("OK").toString("base64"))
		// GET → base64("hello")
		expect(results[1].result).toBe(Buffer.from("hello").toString("base64"))
		// INCR → number (not encoded)
		expect(typeof results[2].result).toBe("number")
	})

	test("blocked command in pipeline returns per-command error", async () => {
		const key = k()
		const { data, status } = await api("POST", "/pipeline", [
			["SET", key, "val"],
			["SUBSCRIBE", "some-channel"],
			["GET", key],
		])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results).toHaveLength(3)
		expect(results[0].result).toBe("OK")
		expect(results[1].error).toContain("SUBSCRIBE")
		expect(results[2].result).toBe("val")
	})

	test("MULTI in pipeline returns error", async () => {
		const { data, status } = await api("POST", "/pipeline", [["MULTI"], ["SET", "k", "v"]])
		expect(status).toBe(200)
		const results = data as Array<{ result?: unknown; error?: string }>
		expect(results[0].error).toContain("/multi-exec")
	})
})
