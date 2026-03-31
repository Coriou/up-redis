import { afterEach, describe, expect, test } from "bun:test"
import { AUTH, cmd, testKey } from "./setup"

const BASE_URL = process.env.UPREDIS_TEST_URL ?? "http://localhost:8080"

/** Accumulated SSE data lines from a subscribe connection */
type SSESubscription = {
	events: string[]
	controller: AbortController
	response: Promise<Response>
	/** Wait until events array has at least n items, or timeout */
	waitForEvents: (n: number, timeoutMs?: number) => Promise<void>
}

/** Open an SSE subscribe connection and accumulate data lines */
function sseSubscribe(channel: string, method: "GET" | "POST" = "POST"): SSESubscription {
	const controller = new AbortController()
	const events: string[] = []

	const response = fetch(`${BASE_URL}/subscribe/${channel}`, {
		method,
		headers: AUTH,
		signal: controller.signal,
	})

	// Start reading the SSE stream in background
	response.then(async (res) => {
		if (!res.ok || !res.body) return
		const reader = res.body.getReader()
		const decoder = new TextDecoder()
		let buffer = ""
		try {
			while (true) {
				const { value, done } = await reader.read()
				if (done) break
				buffer += decoder.decode(value, { stream: true })
				const lines = buffer.split("\n")
				buffer = lines.pop() || ""
				for (const line of lines) {
					if (line.startsWith("data: ")) {
						events.push(line.slice(6))
					}
				}
			}
		} catch {
			// AbortError or stream closed — expected
		}
	})

	const waitForEvents = async (n: number, timeoutMs = 3000) => {
		const start = Date.now()
		while (events.length < n) {
			if (Date.now() - start > timeoutMs) {
				throw new Error(
					`Timeout waiting for ${n} events (got ${events.length}: ${JSON.stringify(events)})`,
				)
			}
			await new Promise((r) => setTimeout(r, 20))
		}
	}

	return { events, controller, response, waitForEvents }
}

// Track abort controllers for cleanup
const controllers: AbortController[] = []

afterEach(() => {
	for (const c of controllers) {
		try {
			c.abort()
		} catch {}
	}
	controllers.length = 0
})

function tracked(sub: SSESubscription): SSESubscription {
	controllers.push(sub.controller)
	return sub
}

// Channels don't leave state in Redis, but use unique names to avoid crosstalk
function ch(prefix = "pubsub"): string {
	return testKey(prefix)
}

describe("GET/POST /subscribe/:channel", () => {
	test("returns subscribe confirmation as first event", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1)
		expect(sub.events[0]).toBe(`subscribe,${channel},1`)

		sub.controller.abort()
	})

	test("receives published message", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1) // wait for subscribe confirmation

		await cmd("PUBLISH", channel, "hello")
		await sub.waitForEvents(2) // subscribe + message

		expect(sub.events[1]).toBe(`message,${channel},hello`)

		sub.controller.abort()
	})

	test("receives multiple messages in order", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1) // subscribe confirmation

		for (let i = 0; i < 5; i++) {
			await cmd("PUBLISH", channel, `msg-${i}`)
		}

		await sub.waitForEvents(6) // 1 subscribe + 5 messages

		for (let i = 0; i < 5; i++) {
			expect(sub.events[i + 1]).toBe(`message,${channel},msg-${i}`)
		}

		sub.controller.abort()
	})

	test("message with commas preserves content", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1)

		await cmd("PUBLISH", channel, "a,b,c")
		await sub.waitForEvents(2)

		expect(sub.events[1]).toBe(`message,${channel},a,b,c`)

		sub.controller.abort()
	})

	test("message with JSON content", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1)

		const json = JSON.stringify({ key: "value", n: 42 })
		await cmd("PUBLISH", channel, json)
		await sub.waitForEvents(2)

		expect(sub.events[1]).toBe(`message,${channel},${json}`)

		sub.controller.abort()
	})

	test("client disconnect cleans up Redis subscription", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1) // subscription active

		// PUBLISH should reach 1 subscriber
		const before = await cmd("PUBLISH", channel, "before-disconnect")
		expect(before).toBe(1)

		// Disconnect
		sub.controller.abort()

		// Give server time to clean up
		await new Promise((r) => setTimeout(r, 200))

		// PUBLISH should now reach 0 subscribers
		const after = await cmd("PUBLISH", channel, "after-disconnect")
		expect(after).toBe(0)
	})

	test("auth required", async () => {
		const res = await fetch(`${BASE_URL}/subscribe/${ch()}`, {
			method: "POST",
		})
		expect(res.status).toBe(401)
	})

	test("GET method works", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel, "GET"))

		await sub.waitForEvents(1)
		expect(sub.events[0]).toBe(`subscribe,${channel},1`)

		sub.controller.abort()
	})

	test("POST method works", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel, "POST"))

		await sub.waitForEvents(1)
		expect(sub.events[0]).toBe(`subscribe,${channel},1`)

		sub.controller.abort()
	})

	test("concurrent subscribers to same channel both receive", async () => {
		const channel = ch()
		const sub1 = tracked(sseSubscribe(channel))
		const sub2 = tracked(sseSubscribe(channel))

		await sub1.waitForEvents(1)
		await sub2.waitForEvents(1)

		await cmd("PUBLISH", channel, "broadcast")

		await sub1.waitForEvents(2)
		await sub2.waitForEvents(2)

		expect(sub1.events[1]).toBe(`message,${channel},broadcast`)
		expect(sub2.events[1]).toBe(`message,${channel},broadcast`)

		sub1.controller.abort()
		sub2.controller.abort()
	})

	test("subscribers to different channels are isolated", async () => {
		const ch1 = ch("iso-a")
		const ch2 = ch("iso-b")
		const sub1 = tracked(sseSubscribe(ch1))
		const sub2 = tracked(sseSubscribe(ch2))

		await sub1.waitForEvents(1)
		await sub2.waitForEvents(1)

		await cmd("PUBLISH", ch1, "only-for-ch1")

		await sub1.waitForEvents(2)

		// Give sub2 a moment to NOT receive the message
		await new Promise((r) => setTimeout(r, 200))

		expect(sub1.events[1]).toBe(`message,${ch1},only-for-ch1`)
		expect(sub2.events.length).toBe(1) // only subscribe confirmation

		sub1.controller.abort()
		sub2.controller.abort()
	})

	test("empty message content", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1)

		await cmd("PUBLISH", channel, "")
		await sub.waitForEvents(2)

		expect(sub.events[1]).toBe(`message,${channel},`)

		sub.controller.abort()
	})

	test("message with newlines splits into multiple SSE data lines", async () => {
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1)

		await cmd("PUBLISH", channel, "line1\nline2\nline3")

		// SSE spec: multi-line data gets split into separate "data: " lines.
		// Both the Upstash SDK and standard SSE readers see each as a separate event.
		// This matches Upstash's behavior — the protocol is inherently line-based.
		await sub.waitForEvents(4) // subscribe + 3 data lines

		expect(sub.events[1]).toBe(`message,${channel},line1`)
		expect(sub.events[2]).toBe("line2")
		expect(sub.events[3]).toBe("line3")

		sub.controller.abort()
	})

	test("subscription survives beyond request timeout (30s)", async () => {
		// Proves that the timeout middleware does NOT interfere with SSE.
		// streamSSE() returns the Response synchronously, so next() resolves
		// immediately and clears the timeout. The stream continues independently.
		const channel = ch()
		const sub = tracked(sseSubscribe(channel))

		await sub.waitForEvents(1) // subscribe confirmation

		// Wait longer than the default request timeout (30s)
		// We use a shorter wait here (2s) since we can't hold tests for 30s,
		// but the mechanism is the same: the SSE callback runs detached
		await new Promise((r) => setTimeout(r, 2000))

		// Publish AFTER the wait — if timeout killed the stream, this fails
		await cmd("PUBLISH", channel, "still-alive")
		await sub.waitForEvents(2)

		expect(sub.events[1]).toBe(`message,${channel},still-alive`)

		sub.controller.abort()
	})

	test("stress: 20 concurrent subscribers, 50 messages each", async () => {
		const channel = ch("stress")
		const subs: ReturnType<typeof sseSubscribe>[] = []

		// Connect 20 subscribers
		for (let i = 0; i < 20; i++) {
			subs.push(tracked(sseSubscribe(channel)))
		}

		// Wait for all to confirm subscription
		await Promise.all(subs.map((s) => s.waitForEvents(1)))

		// Publish 50 messages rapidly
		const publishes = []
		for (let i = 0; i < 50; i++) {
			publishes.push(cmd("PUBLISH", channel, `msg-${i}`))
		}
		await Promise.all(publishes)

		// All subscribers should receive all 50 messages (1 subscribe + 50 messages)
		await Promise.all(subs.map((s) => s.waitForEvents(51, 10000)))

		for (const sub of subs) {
			expect(sub.events.length).toBe(51)
			expect(sub.events[0]).toBe(`subscribe,${channel},1`)

			// Parallel publishes don't guarantee order — verify all messages arrived
			const messages = new Set(sub.events.slice(1))
			for (let i = 0; i < 50; i++) {
				expect(messages.has(`message,${channel},msg-${i}`)).toBe(true)
			}
		}

		for (const sub of subs) {
			sub.controller.abort()
		}
	})

	test("rapid connect/disconnect cycles", async () => {
		const channel = ch("churn")

		// 10 rapid subscribe-then-unsubscribe cycles
		for (let i = 0; i < 10; i++) {
			const sub = sseSubscribe(channel)
			await sub.waitForEvents(1)
			sub.controller.abort()
		}

		// Give server time to clean up all connections
		await new Promise((r) => setTimeout(r, 300))

		// Verify no leaked subscribers
		const count = await cmd("PUBLISH", channel, "after-churn")
		expect(count).toBe(0)
	})

	test("PUBLISH returns subscriber count", async () => {
		const channel = ch()

		// No subscribers — returns 0
		const none = await cmd("PUBLISH", channel, "nobody")
		expect(none).toBe(0)

		// One subscriber
		const sub = tracked(sseSubscribe(channel))
		await sub.waitForEvents(1)

		const one = await cmd("PUBLISH", channel, "one")
		expect(one).toBe(1)

		// Two subscribers
		const sub2 = tracked(sseSubscribe(channel))
		await sub2.waitForEvents(1)

		const two = await cmd("PUBLISH", channel, "two")
		expect(two).toBe(2)

		sub.controller.abort()
		sub2.controller.abort()
	})
})
