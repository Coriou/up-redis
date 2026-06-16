import { encodeResult } from "./encoding"
import { normalizeResp3 } from "./response"

export type ExecResultEntry = { result?: unknown; error?: string }

/**
 * Shape a raw EXEC reply into the per-command {result}/{error} array the Upstash
 * SDK expects.
 *
 * Bun.redis returns an array of per-command results for a successful EXEC, with
 * Error objects in the slots of commands that failed at runtime (e.g. WRONGTYPE).
 * A `null` reply means the transaction was aborted (WATCH conflict or a queued
 * syntax error) and must be handled by the caller *before* calling this.
 *
 * Any other shape is unexpected: rather than silently returning an empty array
 * (a misleading "successful empty transaction"), throw so the caller surfaces it
 * as an error.
 */
export function shapeExecResults(execResult: unknown, useBase64: boolean): ExecResultEntry[] {
	if (!Array.isArray(execResult)) {
		throw new Error(
			execResult instanceof Error
				? execResult.message
				: `Unexpected EXEC reply (expected an array): ${execResult === null ? "null" : typeof execResult}`,
		)
	}

	const results: ExecResultEntry[] = []
	for (const raw of execResult) {
		// Bun.redis surfaces per-command runtime failures (e.g. WRONGTYPE) as Error
		// objects — detect them before normalizeResp3 would flatten them.
		if (raw instanceof Error) {
			results.push({ error: raw.message })
			continue
		}
		try {
			let result = normalizeResp3(raw)
			if (useBase64) result = encodeResult(result)
			results.push({ result })
		} catch (err: unknown) {
			results.push({ error: err instanceof Error ? err.message : String(err) })
		}
	}
	return results
}
