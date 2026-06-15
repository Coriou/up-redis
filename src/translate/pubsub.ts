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
