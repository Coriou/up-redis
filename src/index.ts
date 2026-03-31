import { config } from "./config"
import { log } from "./logger"
import { closeRedis, initRedis } from "./redis"
import { app } from "./server"
import { setShuttingDown } from "./shutdown"

async function main(): Promise<void> {
	await initRedis()
	log.info("connected to redis", { url: config.redisUrl })

	const server = Bun.serve({
		fetch: app.fetch,
		port: config.port,
		hostname: config.host,
	})

	log.info("server started", {
		host: server.hostname,
		port: server.port,
		metricsEnabled: config.metricsEnabled,
	})

	let shuttingDownInProgress = false

	const shutdown = async (signal: string) => {
		if (shuttingDownInProgress) {
			log.warn("forced exit on second signal", { signal })
			process.exit(1)
		}
		shuttingDownInProgress = true
		setShuttingDown()
		log.info("shutdown signal received", { signal })

		// Force exit if drain takes too long
		const forceTimer = setTimeout(() => {
			log.warn("shutdown timeout exceeded, forcing exit", {
				timeout_ms: config.shutdownTimeout,
			})
			process.exit(1)
		}, config.shutdownTimeout)

		try {
			// Wait for in-flight requests to complete
			await server.stop()
			log.info("requests drained")

			await closeRedis()
			log.info("shutdown complete")

			clearTimeout(forceTimer)
			process.exit(0)
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err)
			log.error("shutdown error, forcing exit", { error: msg })
			process.exit(1)
		}
	}

	process.on("SIGTERM", () => shutdown("SIGTERM"))
	process.on("SIGINT", () => shutdown("SIGINT"))
}

main().catch((err) => {
	log.error("failed to start", { error: err.message, stack: err.stack })
	process.exit(1)
})
