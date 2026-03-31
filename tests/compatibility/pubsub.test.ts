import { afterEach, describe, expect, test } from "bun:test"
import { createRedis, randomKey, TOKEN, URL } from "./setup"

const redis = createRedis()

function ch(prefix = "compat-ps"): string {
	return randomKey(prefix)
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

/** Parse SSE data lines from a raw fetch response (simulates resumable-stream adapter) */
async function readSSEMessages(
	channel: string,
	opts?: { method?: "GET" | "POST"; signal?: AbortSignal },
): Promise<{ events: string[]; waitForEvents: (n: number) => Promise<void> }> {
	const events: string[] = []

	const res = await fetch(`${URL}/subscribe/${channel}`, {
		method: opts?.method ?? "POST",
		headers: {
			Authorization: `Bearer ${TOKEN}`,
			Accept: "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		},
		signal: opts?.signal,
	})

	if (!res.ok || !res.body) throw new Error(`Subscribe failed: ${res.status}`)

	const reader = res.body.getReader()
	const decoder = new TextDecoder()
	let buffer = ""

	// Background reader
	;(async () => {
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
			// AbortError — expected on cleanup
		}
	})()

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

	return { events, waitForEvents }
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

describe("SDK Subscriber class", () => {
	test("subscribe() returns Subscriber and receives messages", async () => {
		const channel = ch()
		const received: Array<{ channel: string; message: unknown }> = []

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		sub.on("message", (data) => {
			received.push(data)
		})

		// Wait for subscription to be established
		await new Promise<void>((resolve) => {
			sub.on("subscribe", () => resolve())
		})

		// Publish via SDK
		await redis.publish(channel, "hello-from-sdk")

		// Wait for message delivery
		const start = Date.now()
		while (received.length < 1 && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 20))
		}

		expect(received.length).toBe(1)
		expect(received[0].channel).toBe(channel)
		expect(received[0].message).toBe("hello-from-sdk")

		await sub.unsubscribe()
	})

	test("subscribe() receives multiple messages in order", async () => {
		const channel = ch()
		const received: string[] = []

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		sub.on("message", (data) => {
			received.push(data.message as string)
		})

		await new Promise<void>((resolve) => {
			sub.on("subscribe", () => resolve())
		})

		for (let i = 0; i < 5; i++) {
			await redis.publish(channel, `msg-${i}`)
		}

		const start = Date.now()
		while (received.length < 5 && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 20))
		}

		expect(received).toEqual(["msg-0", "msg-1", "msg-2", "msg-3", "msg-4"])

		await sub.unsubscribe()
	})

	test("subscribe() receives JSON objects", async () => {
		const channel = ch()
		const received: unknown[] = []

		const sub = redis.subscribe([channel])
		subscribers.push(sub)

		sub.on("message", (data) => {
			received.push(data.message)
		})

		await new Promise<void>((resolve) => {
			sub.on("subscribe", () => resolve())
		})

		const payload = { type: "stream-chunk", index: 42, data: [1, 2, 3] }
		await redis.publish(channel, payload)

		const start = Date.now()
		while (received.length < 1 && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 20))
		}

		expect(received[0]).toEqual(payload)

		await sub.unsubscribe()
	})

	test("unsubscribe() stops message delivery", async () => {
		const channel = ch()
		const received: string[] = []

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		sub.on("message", (data) => {
			received.push(data.message as string)
		})

		await new Promise<void>((resolve) => {
			sub.on("subscribe", () => resolve())
		})

		await redis.publish(channel, "before")

		const start = Date.now()
		while (received.length < 1 && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 20))
		}
		expect(received).toEqual(["before"])

		await sub.unsubscribe()

		// Give server time to clean up
		await new Promise((r) => setTimeout(r, 200))

		const count = await redis.publish(channel, "after")
		expect(count).toBe(0)
	})

	test("getSubscribedChannels() returns active channels", async () => {
		const channel = ch()

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		await new Promise<void>((resolve) => {
			sub.on("subscribe", () => resolve())
		})

		expect(sub.getSubscribedChannels()).toEqual([channel])

		await sub.unsubscribe()
		expect(sub.getSubscribedChannels()).toEqual([])
	})

	test("channel-specific listener (message:channel)", async () => {
		const channel = ch()
		const specific: string[] = []

		const sub = redis.subscribe<string>([channel])
		subscribers.push(sub)

		sub.on(`message:${channel}`, (data) => {
			specific.push(data.message as string)
		})

		await new Promise<void>((resolve) => {
			sub.on("subscribe", () => resolve())
		})

		await redis.publish(channel, "targeted")

		const start = Date.now()
		while (specific.length < 1 && Date.now() - start < 3000) {
			await new Promise((r) => setTimeout(r, 20))
		}

		expect(specific).toEqual(["targeted"])

		await sub.unsubscribe()
	})
})

describe("SDK compatibility: PubSub (raw SSE)", () => {
	test("PUBLISH via SDK, subscribe via SSE", async () => {
		const channel = ch()
		const controller = new AbortController()
		controllers.push(controller)

		const { events, waitForEvents } = await readSSEMessages(channel, {
			signal: controller.signal,
		})

		await waitForEvents(1) // subscribe confirmation

		// Publish via SDK
		const count = await redis.publish(channel, "from-sdk")
		expect(count).toBe(1)

		await waitForEvents(2) // subscribe + message

		// Parse the message event
		const msgEvent = events[1]
		expect(msgEvent).toStartWith("message,")
		const content = msgEvent.slice(msgEvent.indexOf(",", msgEvent.indexOf(",") + 1) + 1)
		// SDK sends string values as-is (no JSON wrapping)
		expect(content).toBe("from-sdk")

		controller.abort()
	})

	test("PUBLISH via SDK with JSON object", async () => {
		const channel = ch()
		const controller = new AbortController()
		controllers.push(controller)

		const { events, waitForEvents } = await readSSEMessages(channel, {
			signal: controller.signal,
		})

		await waitForEvents(1)

		const payload = { action: "stream-chunk", index: 3 }
		await redis.publish(channel, payload)

		await waitForEvents(2)

		const msgEvent = events[1]
		const content = msgEvent.slice(msgEvent.indexOf(",", msgEvent.indexOf(",") + 1) + 1)
		// SDK JSON-serializes objects
		expect(JSON.parse(content)).toEqual(payload)

		controller.abort()
	})

	test("resumable-stream subscriber pattern: message extraction", async () => {
		// Simulates exactly how resumable-stream's subscriber adapter would work:
		// subscribe via SSE, extract just the message content from each event
		const channel = ch()
		const controller = new AbortController()
		controllers.push(controller)

		const receivedMessages: string[] = []
		const { events, waitForEvents } = await readSSEMessages(channel, {
			signal: controller.signal,
		})

		await waitForEvents(1) // subscribe confirmation

		// Publish raw string messages (like resumable-stream does)
		await redis.publish(channel, "chunk-1")
		await redis.publish(channel, "chunk-2")
		await redis.publish(channel, "chunk-3")

		await waitForEvents(4) // subscribe + 3 messages

		// Extract message content (everything after second comma) — this is
		// what a resumable-stream adapter would do
		for (let i = 1; i < events.length; i++) {
			const event = events[i]
			const firstComma = event.indexOf(",")
			const secondComma = event.indexOf(",", firstComma + 1)
			const rawContent = event.slice(secondComma + 1)
			// SDK sends strings as-is (no JSON wrapping)
			receivedMessages.push(rawContent)
		}

		expect(receivedMessages).toEqual(["chunk-1", "chunk-2", "chunk-3"])

		controller.abort()
	})

	test("multiple subscribe + unsubscribe lifecycle", async () => {
		const channel = ch()
		const controller = new AbortController()
		controllers.push(controller)

		const { waitForEvents } = await readSSEMessages(channel, {
			signal: controller.signal,
		})

		await waitForEvents(1)

		// Publish, verify arrival
		await redis.publish(channel, "msg-1")
		await waitForEvents(2)

		// Abort (unsubscribe)
		controller.abort()

		// Give server time to clean up
		await new Promise((r) => setTimeout(r, 200))

		// Publish again — should reach 0 subscribers
		const count = await redis.publish(channel, "msg-2")
		expect(count).toBe(0)
	})
})
