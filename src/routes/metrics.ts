import { Hono } from "hono"
import { formatMetrics } from "../metrics"

export const metricsRoutes = new Hono()

metricsRoutes.get("/metrics", (c) => {
	return c.text(formatMetrics(), 200, {
		"Content-Type": "text/plain; version=0.0.4; charset=utf-8",
	})
})
