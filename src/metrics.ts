import { config } from "./config"

// Standard Prometheus histogram buckets (seconds)
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]

// Counter: http_requests_total{method,status}
const requestCounts = new Map<string, number>()

// Histogram: http_request_duration_seconds{method}
type HistogramData = {
	buckets: number[] // count per bucket
	sum: number
	count: number
}
const durationHistograms = new Map<string, HistogramData>()

function getHistogram(method: string): HistogramData {
	let h = durationHistograms.get(method)
	if (!h) {
		h = { buckets: new Array(DURATION_BUCKETS.length).fill(0), sum: 0, count: 0 }
		durationHistograms.set(method, h)
	}
	return h
}

export function recordRequest(method: string, status: number, durationSec: number): void {
	if (!config.metricsEnabled) return

	// Increment request counter
	const counterKey = `${method}:${status}`
	requestCounts.set(counterKey, (requestCounts.get(counterKey) ?? 0) + 1)

	// Update histogram — store in the first (smallest) matching bucket.
	// formatMetrics() computes cumulative sums for Prometheus exposition.
	const h = getHistogram(method)
	h.sum += durationSec
	h.count += 1
	for (let i = 0; i < DURATION_BUCKETS.length; i++) {
		if (durationSec <= DURATION_BUCKETS[i]) {
			h.buckets[i] += 1
			break
		}
	}
}

export function formatMetrics(): string {
	const lines: string[] = []

	// Info gauge
	lines.push("# HELP upredis_info up-redis instance info")
	lines.push("# TYPE upredis_info gauge")
	lines.push("upredis_info 1")

	// Request counter
	lines.push("# HELP http_requests_total Total HTTP requests")
	lines.push("# TYPE http_requests_total counter")
	for (const [key, count] of requestCounts) {
		const [method, status] = key.split(":")
		lines.push(`http_requests_total{method="${method}",status="${status}"} ${count}`)
	}

	// Duration histogram
	lines.push("# HELP http_request_duration_seconds HTTP request duration in seconds")
	lines.push("# TYPE http_request_duration_seconds histogram")
	for (const [method, h] of durationHistograms) {
		let cumulative = 0
		for (let i = 0; i < DURATION_BUCKETS.length; i++) {
			cumulative += h.buckets[i]
			lines.push(
				`http_request_duration_seconds_bucket{method="${method}",le="${DURATION_BUCKETS[i]}"} ${cumulative}`,
			)
		}
		lines.push(`http_request_duration_seconds_bucket{method="${method}",le="+Inf"} ${h.count}`)
		lines.push(`http_request_duration_seconds_sum{method="${method}"} ${h.sum}`)
		lines.push(`http_request_duration_seconds_count{method="${method}"} ${h.count}`)
	}

	return `${lines.join("\n")}\n`
}
