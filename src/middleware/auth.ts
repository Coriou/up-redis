import { createHash, timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { config } from "../config"

// Pre-compute expected token hash at startup to avoid repeated hashing
const expectedHash = createHash("sha256").update(config.token).digest()

export const authMiddleware: MiddlewareHandler = async (c, next) => {
	const authorization = c.req.header("authorization")
	if (!authorization) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}

	if (!authorization.startsWith("Bearer ")) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}

	const token = authorization.slice(7)

	// Constant-time comparison via SHA-256 hashing (also prevents length leakage)
	const providedHash = createHash("sha256").update(token).digest()
	if (!timingSafeEqual(expectedHash, providedHash)) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}

	await next()
}
