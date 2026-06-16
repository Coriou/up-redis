/** Format an SSE subscribe confirmation event (Upstash protocol) */
export function formatSubscribeEvent(channel: string, count: number): string {
	return `subscribe,${channel},${count}`
}

/** Format an SSE pattern-subscribe confirmation event (Upstash protocol) */
export function formatPatternSubscribeEvent(pattern: string, count: number): string {
	return `psubscribe,${pattern},${count}`
}

/** Format an SSE message event (Upstash protocol) */
export function formatMessageEvent(channel: string, message: string): string {
	return `message,${channel},${message}`
}

/** Format an SSE pattern message event (Upstash protocol) */
export function formatPatternMessageEvent(
	pattern: string,
	channel: string,
	message: string,
): string {
	return `pmessage,${pattern},${channel},${formatPatternMessagePayload(message)}`
}

function formatPatternMessagePayload(message: string): string {
	try {
		JSON.parse(message)
		return message
	} catch {
		return JSON.stringify(message)
	}
}

/**
 * Ordering buffer for an SSE subscription.
 *
 * Redis can deliver a message the instant a subscription is established — before
 * the subscribe/psubscribe confirmation has been written to the stream. The
 * Upstash SDK expects the confirmation to be the FIRST event, so data pushed
 * before `release()` is queued and then emitted, in order, once the confirmation
 * has been sent. After release, data is emitted immediately.
 *
 * `emit` is injected so this stays pure and unit-testable.
 */
export function createConfirmationOrderedBuffer(emit: (data: string) => void): {
	push: (data: string) => void
	release: () => void
} {
	let released = false
	const pending: string[] = []
	return {
		push(data: string) {
			if (released) {
				emit(data)
				return
			}
			pending.push(data)
		},
		release() {
			released = true
			for (const data of pending.splice(0)) {
				emit(data)
			}
		},
	}
}
