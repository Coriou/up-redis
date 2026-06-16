import { describe, expect, test } from "bun:test"
import { createConfirmationOrderedBuffer } from "../../src/translate/pubsub"

describe("createConfirmationOrderedBuffer", () => {
	test("buffers messages pushed before release (nothing emitted yet)", () => {
		const out: string[] = []
		const buf = createConfirmationOrderedBuffer((d) => out.push(d))
		buf.push("m1")
		buf.push("m2")
		expect(out).toEqual([])
	})

	test("flushes buffered messages in order on release", () => {
		const out: string[] = []
		const buf = createConfirmationOrderedBuffer((d) => out.push(d))
		buf.push("m1")
		buf.push("m2")
		buf.release()
		expect(out).toEqual(["m1", "m2"])
	})

	test("emits immediately once released", () => {
		const out: string[] = []
		const buf = createConfirmationOrderedBuffer((d) => out.push(d))
		buf.release()
		buf.push("m1")
		expect(out).toEqual(["m1"])
	})

	test("preserves order across buffered and post-release messages", () => {
		const out: string[] = []
		const buf = createConfirmationOrderedBuffer((d) => out.push(d))
		buf.push("before")
		buf.release()
		buf.push("after")
		expect(out).toEqual(["before", "after"])
	})
})
