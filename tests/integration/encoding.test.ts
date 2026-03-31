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
