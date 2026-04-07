import { Hono } from "hono"
import { isRedisHealthy } from "../redis"
import { shuttingDown } from "../shutdown"

export const healthRoutes = new Hono()

// Lightweight probe — backward-compatible with Dockerfile HEALTHCHECK and CI.
// Returns 503 only when shutting down. This is the SRH-compatible welcome.
healthRoutes.get("/", (c) => {
	if (shuttingDown()) {
		return c.text("Shutting Down", 503)
	}
	return c.text("Welcome to up-redis", 200)
})

/**
 * Rich health endpoint with dependency status.
 *
 * Acts as a readiness probe: returns 503 if Redis is unreachable so a load
 * balancer or Kubernetes Service stops sending traffic. The process itself
 * may still be healthy — see /livez for liveness.
 */
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

/**
 * Liveness probe — returns 200 as long as the process is alive and can respond.
 *
 * Does NOT check Redis. A transient Redis outage should cause Kubernetes to
 * mark the pod NotReady (via /health) but should NOT trigger a pod restart
 * (via /livez), because restarting won't fix Redis being down.
 */
healthRoutes.get("/livez", (c) => {
	if (shuttingDown()) {
		return c.json({ status: "shutting_down" }, 503)
	}
	return c.json({ status: "ok" }, 200)
})

/** Alias for /health that follows Kubernetes naming convention. */
healthRoutes.get("/readyz", async (c) => {
	const redisOk = await isRedisHealthy()
	if (shuttingDown() || !redisOk) {
		return c.json({ status: "not_ready", redis: redisOk ? "connected" : "disconnected" }, 503)
	}
	return c.json({ status: "ready", redis: "connected" }, 200)
})
