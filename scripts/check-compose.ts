import { strict as assert } from "node:assert"

// Configuration-only check: never starts containers or connects to any backend.
process.env.UPREDIS_TOKEN = "compose-check-b87f6076f0d64079"
const { envSchema } = await import("../src/config")
const inherited = Object.fromEntries(
	Object.entries(process.env).filter(([key]) => !key.startsWith("UPREDIS_")),
)
const values: Record<string, string> = {
	UPREDIS_TOKEN: process.env.UPREDIS_TOKEN,
	UPREDIS_REDIS_URL: "redis://external.example.invalid:6380",
	UPREDIS_PORT: "8087",
	UPREDIS_HOST: "127.0.0.1",
	UPREDIS_LOG_LEVEL: "warn",
	UPREDIS_LOG_FORMAT: "text",
	UPREDIS_SHUTDOWN_TIMEOUT: "17000",
	UPREDIS_REQUEST_TIMEOUT: "0",
	UPREDIS_METRICS: "true",
	UPREDIS_MAX_BODY_SIZE: "99999",
	UPREDIS_MAX_PIPELINE_COMMANDS: "17",
	UPREDIS_MAX_SUBSCRIPTIONS: "19",
	UPREDIS_ALLOW_DANGEROUS_COMMANDS: "true",
	UPREDIS_BLOCKED_COMMANDS: "EVAL,FCALL",
	UPREDIS_ALLOW_TOKEN_QUERY_PARAM: "false",
	UPREDIS_ALLOW_PLACEHOLDER_TOKEN: "true",
}
assert.deepEqual(Object.keys(values).sort(), Object.keys(envSchema.shape).sort())

function render(files: string[], env = values) {
	const result = Bun.spawnSync(
		[
			"docker",
			"compose",
			"--env-file",
			"/dev/null",
			...files.flatMap((file) => ["-f", file]),
			"config",
			"--format",
			"json",
		],
		{ env: { ...inherited, ...env } },
	)
	assert.equal(result.exitCode, 0, result.stderr.toString())
	return JSON.parse(result.stdout.toString())
}

for (const files of [
	["docker-compose.yml"],
	["docker-compose.yml", "docker-compose.external.yml"],
]) {
	const config = render(files)
	const environment = config.services["up-redis"].environment
	for (const [key, value] of Object.entries(values)) assert.equal(environment[key], value, key)
	assert.ok(JSON.stringify(config.services["up-redis"].healthcheck).includes(":8087/livez"))
	if (files.length > 1) {
		assert.equal(config.services.redis, undefined)
		assert.equal(config.services["up-redis"].depends_on, undefined)
	}
}
const defaults = render(["docker-compose.yml"], { UPREDIS_TOKEN: values.UPREDIS_TOKEN })
assert.equal(defaults.services.redis.environment.UPREDIS_REDIS_PASSWORD, "")
assert.equal(defaults.services.redis.environment.UPREDIS_REDIS_APPENDONLY, "no")
const aof = render(["docker-compose.yml"], { ...values, UPREDIS_REDIS_APPENDONLY: "yes" })
assert.equal(aof.services.redis.environment.UPREDIS_REDIS_APPENDONLY, "yes")
assert.ok(aof.services.redis.command.join(" ").includes("--appendonly"))
assert.equal(defaults.services["up-redis"].environment.UPREDIS_REDIS_URL, "redis://:@redis:6379")
const dev = render(["docker-compose.yml", "docker-compose.dev.yml"])
for (const name of ["up-redis", "redis"]) {
	assert.equal(dev.services[name].ports[0].host_ip, "127.0.0.1")
}
console.log("Compose settings, external override, default upgrade, and dev bindings passed")
