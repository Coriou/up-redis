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
}
