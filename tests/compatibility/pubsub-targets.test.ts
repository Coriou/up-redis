import { describe, expect, test } from "bun:test"
import { withTimeout } from "../../src/util/timeout"
import { createRedis, randomKey } from "./setup"

const redis = createRedis()

describe("SDK PubSub delimiter safety", () => {
	for (const mode of ["subscribe", "psubscribe"] as const) {
		test(`${mode} reports an error for comma-containing targets`, async () => {
			const sub = redis[mode]([`${randomKey("delimiter")},comma`])
			const error = Promise.withResolvers<Error>()
			sub.on("error", error.resolve)
			try {
				expect((await withTimeout(error.promise, 3000, "invalid target")).message).toContain(
					"Invalid",
				)
			} finally {
				await sub.unsubscribe()
			}
		})
	}

	test("a broad pattern reports an unsupported external channel without corrupting messages", async () => {
		const prefix = randomKey("pattern-delimiter")
		const sub = redis.psubscribe([`${prefix}*`])
		const ready = Promise.withResolvers<void>()
		const message = Promise.withResolvers<{ channel: string; message: unknown }>()
		const error = Promise.withResolvers<Error>()
		const received: unknown[] = []
		sub.on("psubscribe", () => ready.resolve())
		sub.on("pmessage", (data) => {
			received.push(data)
			message.resolve(data)
		})
		sub.on("error", error.resolve)
		try {
			await withTimeout(ready.promise, 3000, "pattern confirmation")
			await redis.publish(`${prefix}:valid`, "hello")
			expect(await withTimeout(message.promise, 3000, "valid message")).toMatchObject({
				channel: `${prefix}:valid`,
				message: "hello",
			})
			// Generic commands and external Redis publishers can use any Redis channel.
			await redis.publish(`${prefix},comma`, "must not be delivered under a different name")
			expect((await withTimeout(error.promise, 3000, "unsupported channel")).message).toContain(
				"Channel cannot be represented",
			)
			expect(received).toHaveLength(1)
		} finally {
			await sub.unsubscribe()
		}
	})
})
