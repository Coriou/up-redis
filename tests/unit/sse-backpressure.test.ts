import { describe, expect, test } from "bun:test"
import { createBoundedSseWriter, MAX_OUTSTANDING_SSE_WRITES } from "../../src/routes/pubsub"

/** Fake stream whose writeSSE never resolves — simulates a stalled/slow consumer. */
function stalledStream() {
	let writes = 0
	return {
		get writes() {
			return writes
		},
		writeSSE: () => {
			writes++
			return new Promise<void>(() => {}) // never settles
		},
	}
}

describe("createBoundedSseWriter", () => {
	test("signals onStuck once the outstanding-write backlog is exceeded", () => {
		const stream = stalledStream()
		let stuckCount = 0
		const write = createBoundedSseWriter(stream, () => {
			stuckCount++
		})

		// The first MAX writes are accepted (and stall, never settling).
		for (let i = 0; i < MAX_OUTSTANDING_SSE_WRITES; i++) write("msg")
		expect(stream.writes).toBe(MAX_OUTSTANDING_SSE_WRITES)
		expect(stuckCount).toBe(0)

		// The next write exceeds the bound: onStuck fires and the write is dropped.
		write("overflow")
		expect(stuckCount).toBe(1)
		expect(stream.writes).toBe(MAX_OUTSTANDING_SSE_WRITES)
	})

	test("once stuck, further writes are silently dropped (onStuck fires only once)", () => {
		const stream = stalledStream()
		let stuckCount = 0
		const write = createBoundedSseWriter(stream, () => {
			stuckCount++
		})
		for (let i = 0; i < MAX_OUTSTANDING_SSE_WRITES + 5; i++) write("msg")
		expect(stuckCount).toBe(1)
	})

	test("writes that settle free up capacity (no false stuck)", async () => {
		// Resolving stream: each write settles immediately, so outstanding returns to 0.
		const write = createBoundedSseWriter({ writeSSE: () => Promise.resolve() }, () => {
			throw new Error("should not be stuck")
		})
		for (let i = 0; i < MAX_OUTSTANDING_SSE_WRITES * 3; i++) {
			write("msg")
			// Let the microtask queue drain so the .then() decrements outstanding.
			await Promise.resolve()
		}
	})
})
