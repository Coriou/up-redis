import { describe, expect, test } from "bun:test"
import { createSlotLimiter } from "../../src/util/slot-limiter"

describe("createSlotLimiter", () => {
	test("reserves up to the max, then refuses", () => {
		const limiter = createSlotLimiter(2)
		expect(limiter.reserve()).toBe(true)
		expect(limiter.reserve()).toBe(true)
		expect(limiter.reserve()).toBe(false)
		expect(limiter.count).toBe(2)
	})

	test("releasing frees a slot for reuse", () => {
		const limiter = createSlotLimiter(1)
		expect(limiter.reserve()).toBe(true)
		expect(limiter.reserve()).toBe(false)
		limiter.release()
		expect(limiter.count).toBe(0)
		expect(limiter.reserve()).toBe(true)
	})

	test("release never drops below zero", () => {
		const limiter = createSlotLimiter(1)
		limiter.release()
		limiter.release()
		expect(limiter.count).toBe(0)
	})

	test("concurrent reservations cannot overshoot the cap (no TOCTOU)", () => {
		// The whole point: reserve() is synchronous and atomic. Simulate a burst of
		// would-be-concurrent callers all reserving in one tick — at most `max` succeed.
		const max = 5
		const limiter = createSlotLimiter(max)
		const granted = Array.from({ length: 100 }, () => limiter.reserve()).filter(Boolean)
		expect(granted.length).toBe(max)
		expect(limiter.count).toBe(max)
	})

	test("a max of 0 refuses everything", () => {
		const limiter = createSlotLimiter(0)
		expect(limiter.reserve()).toBe(false)
	})
})
