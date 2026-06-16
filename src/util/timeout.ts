/**
 * Race a promise against a timeout. Rejects with a labeled error if `ms` elapses
 * before the promise settles. The original promise's rejection is suppressed if
 * the timeout wins, so a late failure never surfaces as an unhandled rejection.
 */
export async function withTimeout<T>(
	promise: Promise<T>,
	ms: number,
	label = "operation",
): Promise<T> {
	promise.catch(() => {})
	let timer: ReturnType<typeof setTimeout> | undefined
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
	})
	try {
		return await Promise.race([promise, timeout])
	} finally {
		if (timer) clearTimeout(timer)
	}
}
