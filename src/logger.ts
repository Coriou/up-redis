import { config } from "./config"

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const
type LogLevel = keyof typeof LOG_LEVELS

const currentLevel = LOG_LEVELS[config.logLevel]
const isJson = config.logFormat === "json"

function formatText(level: string, msg: string, ctx?: Record<string, unknown>): string {
	const ts = new Date().toISOString()
	const tag = `[${level.toUpperCase()}]`
	const pairs = ctx
		? ` ${Object.entries(ctx)
				.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
				.join(" ")}`
		: ""
	return `${tag} ${ts} ${msg}${pairs}\n`
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
