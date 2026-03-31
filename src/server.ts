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

const app = new Hono()

// Global error handler
app.onError(errorHandler)

// Logger on all routes
app.use(loggerMiddleware)

// Health check BEFORE auth (no token needed)
app.route("/", healthRoutes)

// Metrics endpoint (before auth, unauthenticated for Prometheus scraping)
if (config.metricsEnabled) {
	const { metricsRoutes } = await import("./routes/metrics")
	app.route("/", metricsRoutes)
}

// Auth on all remaining routes
app.use("/*", authMiddleware)

// Request timeout on business routes only
app.use("/*", timeoutMiddleware)

// Business routes
app.route("/", commandRoutes)
app.route("/", pipelineRoutes)
app.route("/", multiExecRoutes)

// 404 handler
app.notFound((c) => {
	return c.json({ error: "Not Found", status: 404 }, 404)
})

export { app }
