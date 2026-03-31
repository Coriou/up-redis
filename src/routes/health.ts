import { Hono } from "hono"
import { isRedisHealthy } from "../redis"
import { shuttingDown } from "../shutdown"

export const healthRoutes = new Hono()

// Lightweight probe — backward-compatible with Dockerfile HEALTHCHECK and CI
healthRoutes.get("/", (c) => {
	if (shuttingDown()) {
		return c.text("Shutting Down", 503)
	}
	return c.text("Welcome to up-redis", 200)
})

// Rich health endpoint with dependency status
healthRoutes.get("/health", async (c) => {
	const redisOk = await isRedisHealthy()

	if (shuttingDown()) {
		return c.json({ status: "shutting_down", redis: redisOk ? "connected" : "disconnected" }, 503)
	}

	if (!redisOk) {
		return c.json({ status: "degraded", redis: "disconnected" }, 503)
	}

	return c.json({ status: "ok", redis: "connected" }, 200)
})
