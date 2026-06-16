import { z } from "zod"

const envSchema = z.object({
	UPREDIS_TOKEN: z.string().min(1, "UPREDIS_TOKEN is required"),
	UPREDIS_REDIS_URL: z.string().default("redis://localhost:6379"),
	UPREDIS_PORT: z.coerce.number().int().positive().max(65535).default(8080),
	UPREDIS_HOST: z.string().default("0.0.0.0"),
	UPREDIS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
	UPREDIS_LOG_FORMAT: z.enum(["json", "text"]).default("json"),
	// 1s minimum so that `shutdown` always has time to drain. A 0/sub-second
	// value would cause setTimeout to fire on the same tick as `server.stop()`,
	// forcing exit before any in-flight request could complete.
	UPREDIS_SHUTDOWN_TIMEOUT: z.coerce.number().int().min(1000).default(30000),
	UPREDIS_REQUEST_TIMEOUT: z.coerce.number().int().nonnegative().default(30000),
	UPREDIS_METRICS: z.enum(["true", "false"]).default("false"),
	UPREDIS_MAX_BODY_SIZE: z.coerce.number().int().positive().default(10_485_760),
	// Bound pipeline / multi-exec batch size. Even with the body-size cap, a
	// 10MB body of tiny commands could queue ~1M requests on the shared
	// connection — this gives an explicit, predictable limit.
	UPREDIS_MAX_PIPELINE_COMMANDS: z.coerce.number().int().positive().default(1000),
	// Bound concurrent SSE subscriptions. Each subscription holds a dedicated
	// Redis connection — without a cap, a malicious authenticated client could
	// exhaust connections / file descriptors. Generous default; tune lower
	// behind a known-trusted reverse proxy.
	UPREDIS_MAX_SUBSCRIPTIONS: z.coerce.number().int().positive().default(10_000),
	// Dangerous-but-Upstash-allowed commands (KEYS, FLUSHALL, FLUSHDB, SWAPDB) are
	// blocked by default; set to "true" to permit them on the shared connection.
	UPREDIS_ALLOW_DANGEROUS_COMMANDS: z.enum(["true", "false"]).default("false"),
	// Extra commands to block, comma-separated and case-insensitive (e.g. "DEBUG,KEYS").
	// Lets operators harden the proxy without code changes.
	UPREDIS_BLOCKED_COMMANDS: z.string().default(""),
	// Allow the `_token` query parameter for auth (Upstash compat). It leaks the
	// secret into reverse-proxy/access logs, so operators can disable it and require
	// the Authorization header instead.
	UPREDIS_ALLOW_TOKEN_QUERY_PARAM: z.enum(["true", "false"]).default("true"),
})

const parsed = envSchema.parse(process.env)

export const config = {
	token: parsed.UPREDIS_TOKEN,
	redisUrl: parsed.UPREDIS_REDIS_URL,
	port: parsed.UPREDIS_PORT,
	host: parsed.UPREDIS_HOST,
	logLevel: parsed.UPREDIS_LOG_LEVEL,
	logFormat: parsed.UPREDIS_LOG_FORMAT,
	shutdownTimeout: parsed.UPREDIS_SHUTDOWN_TIMEOUT,
	requestTimeout: parsed.UPREDIS_REQUEST_TIMEOUT,
	metricsEnabled: parsed.UPREDIS_METRICS === "true",
	maxBodySize: parsed.UPREDIS_MAX_BODY_SIZE,
	maxPipelineCommands: parsed.UPREDIS_MAX_PIPELINE_COMMANDS,
	maxSubscriptions: parsed.UPREDIS_MAX_SUBSCRIPTIONS,
	allowDangerousCommands: parsed.UPREDIS_ALLOW_DANGEROUS_COMMANDS === "true",
	blockedCommands: parseCommandList(parsed.UPREDIS_BLOCKED_COMMANDS),
	allowTokenQueryParam: parsed.UPREDIS_ALLOW_TOKEN_QUERY_PARAM === "true",
}

/** Parse a comma-separated command list into an uppercased Set. */
function parseCommandList(value: string): ReadonlySet<string> {
	return new Set(
		value
			.split(",")
			.map((entry) => entry.trim().toUpperCase())
			.filter((entry) => entry.length > 0),
	)
}

const PLACEHOLDER_TOKENS = new Set([
	"your-secret-token-here",
	"changeme",
	"change-me",
	"secret",
	"password",
	"token",
	"test",
])

/**
 * Assess UPREDIS_TOKEN strength for a startup warning. Returns a human-readable
 * reason if the token looks weak, or null if it looks acceptable. This only warns
 * — it never blocks startup, to avoid breaking existing deployments on upgrade.
 */
export function assessTokenStrength(token: string): string | null {
	if (PLACEHOLDER_TOKENS.has(token.toLowerCase())) {
		return "it matches a well-known placeholder/example value"
	}
	if (token.length < 16) {
		return `it is only ${token.length} character(s) long — use at least 16 random characters`
	}
	if (new Set(token).size < 5) {
		return "it has very low character diversity (looks low-entropy)"
	}
	return null
}
