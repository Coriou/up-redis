import { describe, expect, test } from "bun:test"
import {
	formatMessageEvent,
	formatPatternMessageEvent,
	formatPatternSubscribeEvent,
	formatSubscribeEvent,
} from "../../src/translate/pubsub"

describe("formatSubscribeEvent", () => {
	test("basic channel", () => {
		expect(formatSubscribeEvent("my-channel", 1)).toBe("subscribe,my-channel,1")
	})

	test("count greater than 1", () => {
		expect(formatSubscribeEvent("ch", 3)).toBe("subscribe,ch,3")
	})
})

describe("formatPatternSubscribeEvent", () => {
	test("basic pattern", () => {
		expect(formatPatternSubscribeEvent("news:*", 1)).toBe("psubscribe,news:*,1")
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

describe("formatPatternMessageEvent", () => {
	test("basic pattern message", () => {
		expect(formatPatternMessageEvent("news:*", "news:1", "hello")).toBe(
			'pmessage,news:*,news:1,"hello"',
		)
	})

	test("message with commas", () => {
		expect(formatPatternMessageEvent("news:*", "news:1", "a,b,c")).toBe(
			'pmessage,news:*,news:1,"a,b,c"',
		)
	})

	test("JSON message is preserved", () => {
		const json = JSON.stringify({ key: "value" })
		expect(formatPatternMessageEvent("news:*", "news:1", json)).toBe(
			`pmessage,news:*,news:1,${json}`,
		)
	})
})
