import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { config } from "./config";
import { authMiddleware } from "./middleware/auth";
import { errorHandler } from "./middleware/error-handler";
import { loggerMiddleware } from "./middleware/logger";
import { timeoutMiddleware } from "./middleware/timeout";
import { commandRoutes } from "./routes/command";
import { healthRoutes } from "./routes/health";
import { multiExecRoutes } from "./routes/multi-exec";
import { pipelineRoutes } from "./routes/pipeline";
import { pubsubRoutes } from "./routes/pubsub";
import { shuttingDown } from "./shutdown";

const app = new Hono();

// Global error handler
app.onError(errorHandler);

// Security response headers
app.use(async (c, next) => {
  await next();
  c.header("X-Content-Type-Options", "nosniff");
});

// Logger on all routes
app.use(loggerMiddleware);

// Health check BEFORE auth (no token needed)
app.route("/", healthRoutes);

// Metrics endpoint (before auth, unauthenticated for Prometheus scraping)
if (config.metricsEnabled) {
  const { metricsRoutes } = await import("./routes/metrics");
  app.route("/", metricsRoutes);
}

// Reject non-health requests during graceful shutdown
const shutdownGuard: MiddlewareHandler = async (c, next) => {
  if (shuttingDown()) {
    return c.json({ error: "Service Unavailable", status: 503 }, 503);
  }
  await next();
};
app.use("/*", shutdownGuard);

// Auth on all remaining routes
app.use("/*", authMiddleware);

// Request timeout on business routes only
app.use("/*", timeoutMiddleware);

// Business routes
app.route("/", commandRoutes);
app.route("/", pipelineRoutes);
app.route("/", multiExecRoutes);
app.route("/", pubsubRoutes);

// 404 handler
app.notFound((c) => {
  return c.json({ error: "Not Found", status: 404 }, 404);
});

export { app };
