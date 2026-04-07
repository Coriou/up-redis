/** Upstash Redis REST API response envelope */
export type UpstashResult<T = unknown> = { result: T }
export type UpstashError = { error: string }
export type UpstashResponse<T = unknown> = UpstashResult<T> | UpstashError

/** A single Redis command as sent by the SDK: ["SET", "key", "value", ...] */
export type RedisCommand = [string, ...string[]]

/** Pipeline/transaction body: array of commands */
export type RedisPipeline = RedisCommand[]

/**
 * Hono Context.Variables augmentation: typed context values set by middleware.
 * `requestId` is set by loggerMiddleware on every request.
 */
declare module "hono" {
	interface ContextVariableMap {
		requestId: string
	}
}
