import { config } from "./config"

type RedisRespValue = string | number | boolean | null | RedisRespValue[] | Error

type ParsedValue = {
	value: RedisRespValue
	offset: number
}

type PendingCommand = {
	resolve: (value: RedisRespValue) => void
	reject: (error: Error) => void
	timer: ReturnType<typeof setTimeout>
}

type RedisConnectionInfo = {
	hostname: string
	port: number
	tls: boolean
	username: string
	password: string
	db: number
}

export type PatternSubscription = {
	count: number
	closed: Promise<void>
	close: () => void
}

const COMMAND_TIMEOUT_MS = 10_000
// Pattern-subscribe replies (psubscribe confirmation, pmessage) are always shallow
// arrays. Cap recursion depth defensively so a malformed or hostile reply can't
// blow the stack.
const MAX_RESP_DEPTH = 64

export class RespParser {
	private buffer: Buffer = Buffer.alloc(0)

	push(chunk: Buffer): RedisRespValue[] {
		this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])

		const values: RedisRespValue[] = []
		let offset = 0

		while (offset < this.buffer.length) {
			const parsed = this.parseAt(offset)
			if (parsed === undefined) break
			values.push(parsed.value)
			offset = parsed.offset
		}

		if (offset > 0) {
			this.buffer = this.buffer.subarray(offset)
		}

		return values
	}

	private parseAt(offset: number, depth = 0): ParsedValue | undefined {
		if (offset >= this.buffer.length) return undefined
		if (depth > MAX_RESP_DEPTH) {
			throw new Error(`Redis RESP nesting exceeds maximum depth of ${MAX_RESP_DEPTH}`)
		}

		const prefix = this.buffer[offset]
		const line = this.readLine(offset + 1)
		if (line === undefined) return undefined

		switch (prefix) {
			case 43: // +
				return { value: line.text, offset: line.offset }
			case 45: // -
				return { value: new Error(line.text), offset: line.offset }
			case 58: // :
				return { value: Number(line.text), offset: line.offset }
			case 44: // ,
				return { value: Number(line.text), offset: line.offset }
			case 35: // #
				return { value: line.text === "t", offset: line.offset }
			case 95: // _
				return { value: null, offset: line.offset }
			case 36: // $
				return this.parseBulkString(line)
			case 42: // *
				return this.parseArray(line, depth)
			default:
				throw new Error(`Invalid Redis RESP prefix: ${String.fromCharCode(prefix)}`)
		}
	}

	private readLine(offset: number): { text: string; offset: number } | undefined {
		const end = this.buffer.indexOf("\r\n", offset)
		if (end === -1) return undefined
		return {
			text: this.buffer.subarray(offset, end).toString("utf-8"),
			offset: end + 2,
		}
	}

	private parseBulkString(line: { text: string; offset: number }): ParsedValue | undefined {
		const length = Number(line.text)
		if (length === -1) return { value: null, offset: line.offset }
		if (!Number.isInteger(length) || length < 0) {
			throw new Error(`Invalid Redis bulk string length: ${line.text}`)
		}

		const end = line.offset + length
		const next = end + 2
		if (this.buffer.length < next) return undefined
		if (this.buffer[end] !== 13 || this.buffer[end + 1] !== 10) {
			throw new Error("Invalid Redis bulk string terminator")
		}

		return {
			value: this.buffer.subarray(line.offset, end).toString("utf-8"),
			offset: next,
		}
	}

	private parseArray(
		line: { text: string; offset: number },
		depth: number,
	): ParsedValue | undefined {
		const length = Number(line.text)
		if (length === -1) return { value: null, offset: line.offset }
		if (!Number.isInteger(length) || length < 0) {
			throw new Error(`Invalid Redis array length: ${line.text}`)
		}

		const values: RedisRespValue[] = []
		let offset = line.offset
		for (let i = 0; i < length; i++) {
			const parsed = this.parseAt(offset, depth + 1)
			if (parsed === undefined) return undefined
			values.push(parsed.value)
			offset = parsed.offset
		}

		return { value: values, offset }
	}
}

class RawPatternConnection {
	private readonly parser = new RespParser()
	private readonly pending: PendingCommand[] = []
	private readonly onMessage: (pattern: string, channel: string, message: string) => void
	private socket: Bun.Socket | null = null
	private closed = false
	private resolveClosed!: () => void

	readonly closedPromise = new Promise<void>((resolve) => {
		this.resolveClosed = resolve
	})

	constructor(onMessage: (pattern: string, channel: string, message: string) => void) {
		this.onMessage = onMessage
	}

	async connect(info: RedisConnectionInfo): Promise<void> {
		let timedOut = false
		const socketPromise = Bun.connect({
			hostname: info.hostname,
			port: info.port,
			tls: info.tls,
			socket: {
				binaryType: "buffer",
				data: (_socket, data) => {
					this.handleData(data)
				},
				close: (_socket, error) => {
					this.handleClose(error)
				},
				error: (_socket, error) => {
					this.handleClose(error)
				},
			},
		})
		socketPromise.catch(() => {})
		socketPromise
			.then((socket) => {
				if (timedOut) socket.close()
			})
			.catch(() => {})

		let timer: ReturnType<typeof setTimeout> | undefined
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true
				reject(new Error(`Redis connection timed out after ${COMMAND_TIMEOUT_MS}ms`))
			}, COMMAND_TIMEOUT_MS)
		})

		try {
			this.socket = await Promise.race([socketPromise, timeoutPromise])
		} finally {
			if (timer) clearTimeout(timer)
		}

		if (info.password) {
			const auth =
				info.username && info.username !== "default"
					? await this.sendCommand(["AUTH", info.username, info.password])
					: await this.sendCommand(["AUTH", info.password])
			if (auth !== "OK") {
				throw new Error(`Redis AUTH failed: ${String(auth)}`)
			}
		}

		if (info.db > 0) {
			const selected = await this.sendCommand(["SELECT", String(info.db)])
			if (selected !== "OK") {
				throw new Error(`Redis SELECT failed: ${String(selected)}`)
			}
		}
	}

	async psubscribe(pattern: string): Promise<number> {
		const response = await this.sendCommand(["PSUBSCRIBE", pattern])
		if (!Array.isArray(response) || response[0] !== "psubscribe") {
			throw new Error("Unexpected PSUBSCRIBE response")
		}
		const count = Number(response[2])
		if (!Number.isInteger(count) || count < 1) {
			throw new Error("Invalid PSUBSCRIBE subscription count")
		}
		return count
	}

	close(): void {
		if (this.closed) return
		try {
			this.socket?.write(encodeRespCommand(["PUNSUBSCRIBE"]))
		} catch {}
		try {
			this.socket?.close()
		} catch {}
		this.handleClose()
	}

	private sendCommand(parts: string[]): Promise<RedisRespValue> {
		if (!this.socket || this.closed) {
			return Promise.reject(new Error("Redis pattern connection is closed"))
		}

		return new Promise<RedisRespValue>((resolve, reject) => {
			const pending: PendingCommand = {
				resolve,
				reject,
				timer: setTimeout(() => {
					const index = this.pending.indexOf(pending)
					if (index !== -1) this.pending.splice(index, 1)
					reject(new Error(`Redis command timed out after ${COMMAND_TIMEOUT_MS}ms`))
				}, COMMAND_TIMEOUT_MS),
			}

			this.pending.push(pending)
			const written = this.socket?.write(encodeRespCommand(parts)) ?? -1
			if (written === -1) {
				this.resolvePending(pending, new Error("Failed to write Redis command"))
			}
		})
	}

	private handleData(data: Buffer): void {
		try {
			for (const value of this.parser.push(data)) {
				// Command replies and pubsub pushes share this RESP2 stream (no RESP3
				// push framing). Routing a reply to the oldest pending command is safe
				// because commands here are strictly single-flight during setup
				// (AUTH/SELECT/PSUBSCRIBE) and Redis never delivers a pmessage before
				// the PSUBSCRIBE confirmation — so a pending reply is never a push.
				if (this.pending.length > 0) {
					const pending = this.pending.shift()
					if (pending) this.resolvePending(pending, value)
					continue
				}
				this.handlePushMessage(value)
			}
		} catch (err) {
			this.handleClose(err instanceof Error ? err : new Error(String(err)))
		}
	}

	private handlePushMessage(value: RedisRespValue): void {
		if (value instanceof Error) {
			this.handleClose(value)
			return
		}

		if (!Array.isArray(value) || value[0] !== "pmessage") return
		const [, pattern, channel, message] = value
		if (typeof pattern !== "string" || typeof channel !== "string") return
		this.onMessage(pattern, channel, message === null ? "" : String(message))
	}

	private resolvePending(pending: PendingCommand, value: RedisRespValue | Error): void {
		clearTimeout(pending.timer)
		const index = this.pending.indexOf(pending)
		if (index !== -1) this.pending.splice(index, 1)
		if (value instanceof Error) {
			pending.reject(value)
		} else {
			pending.resolve(value)
		}
	}

	private handleClose(error?: Error): void {
		if (this.closed) return
		this.closed = true
		const pending = this.pending.splice(0)
		for (const command of pending) {
			clearTimeout(command.timer)
			command.reject(error ?? new Error("Redis pattern connection closed"))
		}
		this.resolveClosed()
	}
}

export async function createPatternSubscription(
	pattern: string,
	onMessage: (pattern: string, channel: string, message: string) => void,
): Promise<PatternSubscription> {
	const connection = new RawPatternConnection(onMessage)
	await connection.connect(parseRedisUrl(config.redisUrl))

	try {
		const count = await connection.psubscribe(pattern)
		return {
			count,
			closed: connection.closedPromise,
			close: () => connection.close(),
		}
	} catch (err) {
		connection.close()
		throw err
	}
}

function encodeRespCommand(parts: string[]): string {
	let command = `*${parts.length}\r\n`
	for (const part of parts) {
		command += `$${Buffer.byteLength(part, "utf-8")}\r\n${part}\r\n`
	}
	return command
}

function parseRedisUrl(rawUrl: string): RedisConnectionInfo {
	const url = new URL(rawUrl)
	const protocol = url.protocol.toLowerCase()
	const tls = protocol === "rediss:" || protocol === "valkeys:"
	if (!["redis:", "rediss:", "valkey:", "valkeys:"].includes(protocol)) {
		throw new Error(`Unsupported Redis URL protocol: ${url.protocol}`)
	}

	return {
		hostname: url.hostname || "localhost",
		port: url.port ? Number(url.port) : 6379,
		tls,
		username: safeDecode(url.username),
		password: safeDecode(url.password),
		db: parseDb(url.pathname),
	}
}

function parseDb(pathname: string): number {
	const trimmed = pathname.replace(/^\/+/, "")
	if (!trimmed) return 0
	const firstSegment = trimmed.split("/")[0]
	const db = Number(firstSegment)
	if (!Number.isInteger(db) || db < 0) {
		throw new Error(`Invalid Redis database in URL path: ${pathname}`)
	}
	return db
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}
