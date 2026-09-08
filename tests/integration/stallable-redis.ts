import * as net from "node:net"
import { RespParser } from "../../src/redis-pattern"

/** A disposable relay that can stop replies after a real Redis handshake. */
export async function startStallableRedisProxy() {
	const target = new URL(process.env.UPREDIS_REDIS_URL ?? "redis://localhost:6379")
	const clients = new Set<net.Socket>()
	const upstreams = new Set<net.Socket>()
	let stalled = false
	let stopAt: string | undefined
	const server = net.createServer((client) => {
		clients.add(client)
		const upstream = net.connect(Number(target.port) || 6379, target.hostname)
		upstreams.add(upstream)
		const parser = new RespParser()
		client.on("close", () => {
			clients.delete(client)
			upstream.destroy()
		})
		upstream.on("close", () => {
			upstreams.delete(upstream)
			client.destroy()
		})
		client.on("error", () => upstream.destroy())
		upstream.on("error", () => client.destroy())
		upstream.on("data", (chunk) => {
			if (!stalled) client.write(chunk)
		})
		client.on("data", (chunk) => {
			for (const command of parser.push(Buffer.from(chunk))) {
				if (Array.isArray(command) && String(command[0]).toUpperCase() === stopAt) {
					stalled = true
				}
			}
			if (!stalled) upstream.write(chunk)
		})
	})
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	return {
		port: (server.address() as net.AddressInfo).port,
		get clientCount() {
			return clients.size
		},
		stall: () => {
			stalled = true
		},
		stallOnCommand: (command: string) => {
			stopAt = command.toUpperCase()
		},
		thaw: () => {
			stalled = false
			stopAt = undefined
		},
		close: () => {
			for (const socket of [...clients, ...upstreams]) socket.destroy()
			server.close()
		},
	}
}

export type StallableRedisProxy = Awaited<ReturnType<typeof startStallableRedisProxy>>
