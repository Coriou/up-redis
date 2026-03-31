import { describe, expect, test } from "bun:test"
import { formatMessageEvent, formatSubscribeEvent } from "../../src/translate/pubsub"

describe("formatSubscribeEvent", () => {
	test("basic channel", () => {
		expect(formatSubscribeEvent("my-channel", 1)).toBe("subscribe,my-channel,1")
	})

	test("count greater than 1", () => {
		expect(formatSubscribeEvent("ch", 3)).toBe("subscribe,ch,3")
	})
})

describe("formatMessageEvent", () => {
	test("basic message", () => {
		expect(formatMessageEvent("my-channel", "hello")).toBe("message,my-channel,hello")
	})

	test("message with commas", () => {
		expect(formatMessageEvent("ch", "a,b,c")).toBe("message,ch,a,b,c")
	})

	test("empty message", () => {
		expect(formatMessageEvent("ch", "")).toBe("message,ch,")
	})

	test("message with JSON", () => {
		const json = JSON.stringify({ key: "value" })
		expect(formatMessageEvent("ch", json)).toBe(`message,ch,${json}`)
	})

	test("message with unicode", () => {
		expect(formatMessageEvent("ch", "hello world")).toBe("message,ch,hello world")
	})
})
