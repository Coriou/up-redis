import { afterAll, describe, expect, test } from "bun:test"
import { api, cmd, cmdBase64, testKey } from "./setup"

const keys: string[] = []
function k(prefix = "enc") {
	const key = testKey(prefix)
	keys.push(key)
	return key
}

afterAll(async () => {
	if (keys.length > 0) {
		await api("POST", "/", ["DEL", ...keys])
	}
})

describe("Base64 encoding roundtrip", () => {
	test("string roundtrip with base64", async () => {
		const key = k()
		await cmd("SET", key, "hello world")
		const encoded = await cmdBase64("GET", key)
		expect(typeof encoded).toBe("string")
		const decoded = Buffer.from(encoded as string, "base64").toString("utf-8")
		expect(decoded).toBe("hello world")
	})

	test("Upstash-Encoding header is case-insensitive (BASE64)", async () => {
		const key = k()
		await cmd("SET", key, "hello")
		const { data } = await api("POST", "/", ["GET", key], { "Upstash-Encoding": "BASE64" })
		const result = (data as { result: unknown }).result
		expect(result).toBe(Buffer.from("hello").toString("base64"))
	})

	test("Upstash-Encoding header is case-insensitive (Base64)", async () => {
		const key = k()
		await cmd("SET", key, "world")
		const { data } = await api("POST", "/", ["GET", key], { "Upstash-Encoding": "Base64" })
		const result = (data as { result: unknown }).result
		expect(result).toBe(Buffer.from("world").toString("base64"))
	})

	test("Upstash-Encoding header on pipeline is case-insensitive", async () => {
		const key = k()
		await cmd("SET", key, "pipe")
		const { data } = await api("POST", "/pipeline", [["GET", key]], {
			"Upstash-Encoding": "BASE64",
		})
		const results = data as Array<{ result?: unknown }>
		expect(results[0].result).toBe(Buffer.from("pipe").toString("base64"))
	})

	test("Upstash-Encoding header on multi-exec is case-insensitive", async () => {
		const key = k()
		const { data } = await api(
			"POST",
			"/multi-exec",
			[
				["SET", key, "tx"],
				["GET", key],
			],
			{ "Upstash-Encoding": "BASE64" },
		)
		const results = data as Array<{ result?: unknown }>
		expect(results[0].result).toBe(Buffer.from("OK").toString("base64"))
		expect(results[1].result).toBe(Buffer.from("tx").toString("base64"))
	})

	test("unicode roundtrip with base64", async () => {
		const key = k()
		await cmd("SET", key, "café")
		const encoded = await cmdBase64("GET", key)
		const decoded = Buffer.from(encoded as string, "base64").toString("utf-8")
		expect(decoded).toBe("café")
	})

	test("emoji roundtrip with base64", async () => {
		const key = k()
		await cmd("SET", key, "hello 😀🎉")
		const encoded = await cmdBase64("GET", key)
		const decoded = Buffer.from(encoded as string, "base64").toString("utf-8")
		expect(decoded).toBe("hello 😀🎉")
	})

	test("pipeline with base64 encoding", async () => {
		const k1 = k()
		const k2 = k()
		await cmd("SET", k1, "alpha")
		await cmd("SET", k2, "42")

		const { data } = await api(
			"POST",
			"/pipeline",
			[
				["GET", k1],
				["INCR", k2],
			],
			{ "Upstash-Encoding": "base64" },
		)
		const results = data as Array<{ result?: unknown }>
		// GET → base64 string
		const decoded = Buffer.from(results[0].result as string, "base64").toString("utf-8")
		expect(decoded).toBe("alpha")
		// INCR → number
		expect(results[1].result).toBe(43)
	})
})
