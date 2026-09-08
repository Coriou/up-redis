import { afterEach, describe, expect, test } from "bun:test"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()
const publisher = createRedis()

function ch(prefix = "compat-ps-newline"): string {
	return randomKey(prefix)
}

// Track SDK subscribers for cleanup
const subscribers: Array<{ unsubscribe: () => Promise<void> }> = []

afterEach(async () => {
	for (const sub of subscribers) {
		try {
			await sub.unsubscribe()
		} catch {}
	}
	subscribers.length = 0
})

/**
 * Wait until the listener has collected `n` messages.
 *
 * Real-timer exception: messages arrive over SSE from a live Redis through a
 * live HTTP server — there is no promise exposed per message and fake timers
 * cannot drive network I/O, so we poll the collected array. Matches the
 * pollUntil convention in tests/compatibility/pubsub.test.ts.
 */
async function waitForMessages(received: unknown[], n: number, timeoutMs = 3000): Promise<void> {
	const start = Date.now()
	while (received.length < n) {
		if (Date.now() - start > timeoutMs) {
			throw new Error(
				`Timeout waiting for ${n} messages (got ${received.length}: ${JSON.stringify(received)})`,
			)
		}
		await new Promise((r) => setTimeout(r, 20))
	}
}

/**
 * FIDELITY-4: a payload containing an embedded newline used to be emitted raw
 * into the SSE stream, so Hono's `data:` framing split it and the SDK
 * dispatched each line as an independent message (silently truncating the
 * payload). The server now JSON-stringifies non-JSON payloads before writing
 * them, so every message event is a single line and the SDK's
 * `parseWithTryCatch` (chunk-K7RP6Y36.mjs:4315) restores the exact original
 * string. These tests prove that round-trip with the real SDK Subscriber.
 */
describe("SDK Subscriber class: payload fidelity", () => {
	test("messages with embedded newlines round-trip without truncation", async () => {
		const channel = ch()
		const received: Array<{ channel: string; message: unknown }> = []

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		sub.on("message", (data) => {
			received.push(data)
		})

		// Subscribe confirmation must arrive before any message event
		const { promise: subscribed, resolve: onSubscribed } = Promise.withResolvers<void>()
		sub.on("subscribe", (_count: number) => {
			onSubscribed()
		})
		await subscribed

		const messages = [
			"line1\nline2\nline3",
			"hello-from-publisher",
			JSON.stringify({ type: "newline-check", n: 42 }, null, 2),
		]
		for (const message of messages) {
			await publisher.publish(channel, message)
		}

		await waitForMessages(received, messages.length)

		expect(received[0]).toEqual({ channel, message: "line1\nline2\nline3" })
		expect(received[1]).toEqual({ channel, message: "hello-from-publisher" })
		expect(received[2]).toEqual({
			channel,
			message: { type: "newline-check", n: 42 },
		})

		await sub.unsubscribe()
	})

	test("multi-message stream stays ordered across newline and plain payloads", async () => {
		const channel = ch()
		const received: string[] = []

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		sub.on("message", (data) => {
			received.push(data.message as string)
		})

		const { promise: subscribed, resolve: onSubscribed } = Promise.withResolvers<void>()
		sub.on("subscribe", (_count: number) => {
			onSubscribed()
		})
		await subscribed

		for (let i = 0; i < 5; i++) {
			await publisher.publish(channel, `a\nb-${i}`)
		}
		await publisher.publish(channel, "plain-5")

		await waitForMessages(received, 6)

		expect(received).toEqual(["a\nb-0", "a\nb-1", "a\nb-2", "a\nb-3", "a\nb-4", "plain-5"])

		await sub.unsubscribe()
	})
})
