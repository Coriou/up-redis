import { describe, expect, test } from "bun:test"
import { withTimeout } from "../../src/util/timeout"

describe("withTimeout", () => {
	test("resolves with the value when the promise wins the race", async () => {
		expect(await withTimeout(Promise.resolve("ok"), 1000)).toBe("ok")
	})

	test("rejects with a labeled error when the timeout wins", async () => {
		const slow = new Promise<string>((resolve) => setTimeout(() => resolve("late"), 200))
		await expect(withTimeout(slow, 20, "PING")).rejects.toThrow(/PING timed out after 20ms/)
	})
})
