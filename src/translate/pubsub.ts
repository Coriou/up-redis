/** Format an SSE subscribe confirmation event (Upstash protocol) */
export function formatSubscribeEvent(channel: string, count: number): string {
	return `subscribe,${channel},${count}`
}

/** Format an SSE message event (Upstash protocol) */
export function formatMessageEvent(channel: string, message: string): string {
	return `message,${channel},${message}`
}
