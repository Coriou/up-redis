/**
 * A tiny synchronous counting limiter.
 *
 * `reserve()` claims a slot and returns true, or returns false when full. The check
 * and the increment happen together in the calling synchronous tick — with no `await`
 * between them — so concurrent async callers cannot all observe an under-limit count
 * before any of them registers. That closes the time-of-check/time-of-use gap that a
 * "read size, then `await`, then add" pattern leaves open.
 *
 * Each successful `reserve()` must be paired with exactly one `release()` (typically in
 * a `finally`) once the slot is no longer held.
 */
export type SlotLimiter = {
	reserve(): boolean
	release(): void
	readonly count: number
}

export function createSlotLimiter(max: number): SlotLimiter {
	let used = 0
	return {
		reserve(): boolean {
			if (used >= max) return false
			used++
			return true
		},
		release(): void {
			if (used > 0) used--
		},
		get count(): number {
			return used
		},
	}
}
