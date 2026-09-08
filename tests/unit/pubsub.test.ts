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
	/** Strip the `message,<channel>,` prefix and JSON-decode the payload back to the original */
	function payloadOf(event: string): string {
		const body = event.slice(event.indexOf(",") + 1)
		return JSON.parse(body.slice(body.indexOf(",") + 1)) as string
	}

	test("plain message is JSON-stringified and round-trips", () => {
		const event = formatMessageEvent("my-channel", "hello")
		expect(event).toBe('message,my-channel,"hello"')
		expect(payloadOf(event)).toBe("hello")
	})

	test("message with embedded newline is a single line with escaped payload", () => {
		const event = formatMessageEvent("ch", "line1\nline2")
		expect(event).toBe('message,ch,"line1\\nline2"')
		expect(event.includes("\n")).toBe(false)
		expect(payloadOf(event)).toBe("line1\nline2")
	})

	test("message with carriage return is escaped too", () => {
		const event = formatMessageEvent("ch", "a\r\nb")
		expect(event).toBe('message,ch,"a\\r\\nb"')
		expect(event.includes("\r")).toBe(false)
		expect(payloadOf(event)).toBe("a\r\nb")
	})

	test("message with commas", () => {
		const event = formatMessageEvent("ch", "a,b,c")
		expect(event).toBe('message,ch,"a,b,c"')
		expect(payloadOf(event)).toBe("a,b,c")
	})

	test("empty message", () => {
		expect(formatMessageEvent("ch", "")).toBe('message,ch,""')
	})

	test("message that is already valid JSON stays raw", () => {
		const json = JSON.stringify({ key: "value" })
		expect(formatMessageEvent("ch", json)).toBe(`message,ch,${json}`)
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

	test("message with embedded newline is a single line", () => {
		const event = formatPatternMessageEvent("news:*", "news:1", "line1\nline2")
		expect(event).toBe('pmessage,news:*,news:1,"line1\\nline2"')
		expect(event.includes("\n")).toBe(false)
	})
})

for (const payload of ['{\n"n":9007199254740993,\r\n"s":"a\\nb"\n}', "\ntrue\r\n", "[\n1,\n2\n]"]) {
	test(`multiline JSON remains one SSE line: ${JSON.stringify(payload)}`, () => {
		const compact = payload.replace(/[\r\n]/g, "")
		expect(formatMessageEvent("ch", payload)).toBe(`message,ch,${compact}`)
		expect(formatPatternMessageEvent("c*", "ch", payload)).toBe(`pmessage,c*,ch,${compact}`)
	})
}
