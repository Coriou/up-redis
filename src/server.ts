import type { MiddlewareHandler } from "hono"
import { Hono } from "hono"
import { config } from "./config"
import { authMiddleware } from "./middleware/auth"
import { errorHandler } from "./middleware/error-handler"
import { loggerMiddleware } from "./middleware/logger"
import { timeoutMiddleware } from "./middleware/timeout"
import { commandRoutes } from "./routes/command"
import { healthRoutes } from "./routes/health"
import { multiExecRoutes } from "./routes/multi-exec"
import { pipelineRoutes } from "./routes/pipeline"
import { pubsubRoutes } from "./routes/pubsub"
import { shuttingDown } from "./shutdown"

const app = new Hono()

// Global error handler
app.onError(errorHandler)

// Security response headers
app.use(async (c, next) => {
	await next()
	c.header("X-Content-Type-Options", "nosniff")
	c.header("X-Frame-Options", "DENY")
	c.header("Cache-Control", "no-store")
})

// Logger on all routes
app.use(loggerMiddleware)

// Health check BEFORE auth (no token needed)
app.route("/", healthRoutes)

// Metrics endpoint (before auth, unauthenticated for Prometheus scraping)
if (config.metricsEnabled) {
	const { metricsRoutes } = await import("./routes/metrics")
	app.route("/", metricsRoutes)
}

// Reject non-health requests during graceful shutdown
const shutdownGuard: MiddlewareHandler = async (c, next) => {
	if (shuttingDown()) {
		return c.json({ error: "Service Unavailable" }, 503)
	}
	await next()
}
app.use("/*", shutdownGuard)

// Auth on all remaining routes
app.use("/*", authMiddleware)

// Request timeout on business routes only.
// Skip SSE subscribe routes — streamSSE returns synchronously so the timeout
// would never fire on the stream itself, but bypassing it is cleaner and
// avoids any framework-level interaction.
const timeoutGate: MiddlewareHandler = async (c, next) => {
	if (c.req.path.startsWith("/subscribe/")) {
		return next()
	}
	return timeoutMiddleware(c, next)
}
app.use("/*", timeoutGate)

// Business routes
app.route("/", commandRoutes)
app.route("/", pipelineRoutes)
app.route("/", multiExecRoutes)
app.route("/", pubsubRoutes)

// 404 handler
app.notFound((c) => {
	return c.json({ error: "Not Found" }, 404)
})

export { app }
