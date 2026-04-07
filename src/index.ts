import { config } from "./config";
import { log } from "./logger";
import { closeRedis, initRedis } from "./redis";
import { closeAllSubscriptions } from "./routes/pubsub";
import { app } from "./server";
import { setShuttingDown } from "./shutdown";

async function main(): Promise<void> {
  await initRedis();
  log.info("connected to redis", { url: redactUrl(config.redisUrl) });

  const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
    hostname: config.host,
    maxRequestBodySize: config.maxBodySize,
  });

  log.info("server started", {
    host: server.hostname,
    port: server.port,
    metricsEnabled: config.metricsEnabled,
  });

  let shuttingDownInProgress = false;

  const shutdown = async (signal: string) => {
    if (shuttingDownInProgress) {
      log.warn("forced exit on second signal", { signal });
      process.exit(1);
    }
    shuttingDownInProgress = true;
    setShuttingDown();
    log.info("shutdown signal received", { signal });

    // Force exit if drain takes too long
    const forceTimer = setTimeout(() => {
      log.warn("shutdown timeout exceeded, forcing exit", {
        timeout_ms: config.shutdownTimeout,
      });
      process.exit(1);
    }, config.shutdownTimeout);

    try {
      // Close SSE subscriptions so server.stop() can drain
      await closeAllSubscriptions();
      log.info("subscriptions closed");

      // Wait for in-flight requests to complete
      await server.stop();
      log.info("requests drained");

      await closeRedis();
      log.info("shutdown complete");

      clearTimeout(forceTimer);
      process.exit(0);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error("shutdown error, forcing exit", { error: msg });
      process.exit(1);
    }
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

/** Redact password from Redis URL for safe logging */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return parsed.toString();
  } catch {
    return "[invalid-url]";
  }
}

main().catch((err) => {
  log.error("failed to start", { error: err.message, stack: err.stack });
  process.exit(1);
});
