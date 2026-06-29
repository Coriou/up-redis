/**
 * Spawn a throwaway up-redis server process with a custom env/config on its own port.
 *
 * The standard integration suite targets a single long-lived server on :8080, but a few
 * behaviors are config-specific (metrics, low limits, command policy, auth toggles) and
 * need a server booted with that config. Each spawned server gets a distinct port and is
 * torn down by the caller (afterAll).
 */
const REDIS_URL = process.env.UPREDIS_REDIS_URL ?? "redis://localhost:6379"

// Distinct port per spawn to avoid collisions with :8080 and with each other.
let nextPort = 8390

export type SpawnedServer = {
	baseUrl: string
	token: string
	proc: Bun.Subprocess
	close: () => void
}

export async function spawnServer(
	env: Record<string, string> = {},
	token = "test-token-123",
): Promise<SpawnedServer> {
	const port = nextPort++
	const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
		cwd: process.cwd(),
		env: {
			...process.env,
			UPREDIS_TOKEN: token,
			UPREDIS_REDIS_URL: REDIS_URL,
			UPREDIS_LOG_LEVEL: "error",
			...env,
			// Force the assigned port last so callers can't accidentally override it.
			UPREDIS_PORT: String(port),
		},
		stdout: "pipe",
		stderr: "pipe",
	})

	const baseUrl = `http://localhost:${port}`
	const close = () => {
		try {
			proc.kill()
		} catch {}
	}

	// The server only starts listening after initRedis() succeeds, so a 200 from the
	// no-auth /livez probe means the process is fully up.
	const deadline = Date.now() + 15_000
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${baseUrl}/livez`)
			if (res.ok) return { baseUrl, token, proc, close }
		} catch {
			// not listening yet
		}
		await Bun.sleep(100)
	}

	close()
	const stderr = await new Response(proc.stderr as ReadableStream).text().catch(() => "")
	throw new Error(`spawned up-redis on :${port} did not become ready in time. stderr:\n${stderr}`)
}
