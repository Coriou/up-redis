import { expect, test } from "bun:test"
import { createServer, type Socket } from "node:net"
import { RespParser } from "../../src/redis-pattern"
import { withTimeout } from "../../src/util/timeout"

test("pattern parser rejection closes its transport and repeated cleanup is safe", async () => {
	const sockets = new Set<Socket>()
	const fake = createServer((socket) => {
		sockets.add(socket)
		socket.on("close", () => sockets.delete(socket))
		socket.on("error", () => {})
		const parser = new RespParser()
		socket.on("data", (chunk) => {
			for (const command of parser.push(Buffer.from(chunk))) {
				if (Array.isArray(command) && command[0] === "PSUBSCRIBE") {
					socket.write("*3\r\n$10\r\npsubscribe\r\n$7\r\naudit:*\r\n:1\r\n")
				}
			}
		})
	})
	await new Promise<void>((resolve) => fake.listen(0, "127.0.0.1", resolve))
	const address = fake.address()
	if (!address || typeof address === "string") throw new Error("No listener port")
	const modulePath = `${process.cwd()}/src/redis-pattern.ts`
	const proc = Bun.spawn(
		[
			"bun",
			"-e",
			`
			const { createPatternSubscription } = await import(${JSON.stringify(modulePath)});
			const sub = await createPatternSubscription("audit:*", () => {});
			console.log("ready");
			await sub.closed;
			sub.close(); sub.close();
		`,
		],
		{
			env: { ...process.env, UPREDIS_REDIS_URL: `redis://127.0.0.1:${address.port}` },
			stdout: "pipe",
			stderr: "pipe",
		},
	)
	try {
		const reader = proc.stdout.getReader()
		const first = await withTimeout(reader.read(), 3000, "pattern setup")
		expect(new TextDecoder().decode(first.value)).toContain("ready")
		reader.releaseLock()
		for (const socket of sockets) {
			// The existing bulk-length cap must close the socket, not just its promise.
			socket.write("*4\r\n$8\r\npmessage\r\n$7\r\naudit:*\r\n$7\r\naudit:1\r\n$67108865\r\n")
		}
		expect(await withTimeout(proc.exited, 3000, "parser-error teardown")).toBe(0)
		const deadline = Date.now() + 1000
		while (sockets.size > 0 && Date.now() < deadline) await Bun.sleep(10)
		expect(sockets.size).toBe(0)
	} finally {
		proc.kill()
		for (const socket of sockets) socket.destroy()
		await new Promise<void>((resolve) => fake.close(() => resolve()))
	}
}, 10_000)
