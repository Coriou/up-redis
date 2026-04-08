import { config } from "./config"

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LOG_LEVELS

const currentLevel = LOG_LEVELS[config.logLevel]
const isJson = config.logFormat === "json"

/**
 * Escape control characters in text-mode log values to prevent log injection.
 * Strings reaching the logger may contain Redis error messages, request paths,
 * or other content with `\n`, `\r`, or other control bytes that would otherwise
 * forge fake log lines or terminal escape sequences. JSON mode is unaffected
 * because JSON.stringify already escapes these.
 *
 * Exported for unit testing only.
 */
export function escapeControlChars(str: string): string {
	// Walk char-by-char rather than using a literal control-char regex (which
	// Biome rejects). Replace any code point in 0x00–0x1F or 0x7F with a short
	// escape — the common newline/CR/tab get the friendly form, others go to
	// \xHH so they remain unambiguously literal in text logs.
	let out = ""
	let runStart = 0
	for (let i = 0; i < str.length; i++) {
		const code = str.charCodeAt(i)
		if (code > 0x1f && code !== 0x7f) continue
		if (i > runStart) out += str.slice(runStart, i)
		if (code === 0x0a) out += "\\n"
		else if (code === 0x0d) out += "\\r"
		else if (code === 0x09) out += "\\t"
		else out += `\\x${code.toString(16).padStart(2, "0")}`
		runStart = i + 1
	}
	if (runStart === 0) return str
	if (runStart < str.length) out += str.slice(runStart)
	return out
}

function formatText(level: string, msg: string, ctx?: Record<string, unknown>): string {
	const ts = new Date().toISOString()
	const tag = `[${level.toUpperCase()}]`
	const safeMsg = escapeControlChars(msg)
	const pairs = ctx
		? ` ${Object.entries(ctx)
				.map(
					([k, v]) => `${k}=${typeof v === "string" ? escapeControlChars(v) : JSON.stringify(v)}`,
				)
				.join(" ")}`
		: ""
	return `${tag} ${ts} ${safeMsg}${pairs}\n`
}

function formatJson(level: string, msg: string, ctx?: Record<string, unknown>): string {
	const entry: Record<string, unknown> = {
		level,
		msg,
		ts: new Date().toISOString(),
		...ctx,
	}
	return `${JSON.stringify(entry)}\n`
}

const format = isJson ? formatJson : formatText

function write(level: LogLevel, msg: string, ctx?: Record<string, unknown>): void {
	if (LOG_LEVELS[level] < currentLevel) return
	const line = format(level, msg, ctx)
	if (level === "warn" || level === "error") {
		process.stderr.write(line)
	} else {
		process.stdout.write(line)
	}
}

export const log = {
	debug(msg: string, ctx?: Record<string, unknown>): void {
		write("debug", msg, ctx)
	},
	info(msg: string, ctx?: Record<string, unknown>): void {
		write("info", msg, ctx)
	},
	warn(msg: string, ctx?: Record<string, unknown>): void {
		write("warn", msg, ctx)
	},
	error(msg: string, ctx?: Record<string, unknown>): void {
		write("error", msg, ctx)
	},
}
