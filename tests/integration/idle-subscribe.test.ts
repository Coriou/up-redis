import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { type SpawnedServer, spawnServer } from "./spawn-server"

const TOKEN = "test-token-123"

/**
 * Regression (CONC-6): Bun.serve ran with the default idleTimeout (10s), which
 * tore down quiet SSE subscriptions before the 15s keep-alive interval could
 * fire (verified stderr: "[Bun.serve]: request timed out after 10 seconds").
 * Every idle-channel subscriber lost subscriber state after ~8-10s and any
 * messages published during the reconnect gap were dropped. The server now
 * sets idleTimeout: 255 (Bun's max) so SSE keep-alives reset the timer.
 *
 * This test legitimately takes ~16s: on a quiet channel the only traffic after
 * the subscribe confirmation is the 15s keep-alive comment, so surviving past
 * the old ~10s kill window is only observable by waiting it out.
 */
describe("idle SSE subscription survives the server idle window", () => {
	let server: SpawnedServer
	beforeAll(async () => {
		server = await spawnServer({})
	}, 30_000)
	afterAll(() => server?.close())

	test("stream stays open past 11s and delivers interval keep-alives", async () => {
		const channel = `idle-sub:${Date.now()}`
		const res = await fetch(`${server.baseUrl}/subscribe/${encodeURIComponent(channel)}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${TOKEN}` },
		})
		expect(res.ok).toBe(true)
		expect(res.body).not.toBeNull()

		const body = res.body
		if (!body) throw new Error("no response body")
		const reader = body.getReader()
		const decoder = new TextDecoder()
		const openedAt = Date.now()

		// Accumulate SSE text and classify complete lines (comments start with
		// `:`; the confirmation is the first `data: ` line).
		let buffer = ""
		let confirmed = false
		let keepAlives = 0
		const consume = (chunk: string) => {
			buffer += chunk
			const lines = buffer.split("\n")
			buffer = lines.pop() ?? ""
			for (const line of lines) {
				if (line.startsWith("data: ")) confirmed = true
				if (line.startsWith(":")) keepAlives++
			}
		}

		// Read until the subscribe confirmation arrives.
		while (!confirmed) {
			const { done, value } = await reader.read()
			if (done) throw new Error("SSE stream closed before subscribe confirmation")
			consume(decoder.decode(value, { stream: true }))
		}

		// The immediate keep-alive at setup plus the ~15s interval fire prove the
		// stream was alive continuously past the old ~8.4-9.6s kill window: a
		// subscription reaped by the 10s default idleTimeout can never deliver the
		// 15s keep-alive. Read until the second keep-alive arrives — do NOT bound
		// this by wall clock, because a read started just before a keep-alive
		// blocks until the NEXT one (~15s later) and would blow the test timeout.
		while (keepAlives < 2) {
			const { done, value } = await reader.read()
			if (done) {
				throw new Error(
					`SSE stream closed at t≈${Date.now() - openedAt}ms ` +
						"(idleTimeout regression: quiet subscription was reaped)",
				)
			}
			consume(decoder.decode(value, { stream: true }))
		}

		expect(keepAlives).toBeGreaterThanOrEqual(2)
	}, 30_000)
})
