import { createHash, timingSafeEqual } from "node:crypto"
import type { MiddlewareHandler } from "hono"
import { HTTPException } from "hono/http-exception"
import { config } from "../config"

// Pre-compute expected token hash at startup to avoid repeated hashing
const expectedHash = createHash("sha256").update(config.token).digest()

/**
 * Bearer token authentication.
 *
 * - Scheme parsing is case-insensitive per RFC 7235 ("Bearer", "bearer", "BEARER" all valid)
 * - Token comparison uses SHA-256 + timingSafeEqual to avoid leaking token length
 *   or content via timing differences.
 */
export const authMiddleware: MiddlewareHandler = async (c, next) => {
	const raw = c.req.header("authorization")
	if (!raw) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}

	// RFC 9110 §5.5 allows OWS around header field values; parsers usually
	// strip it but we trim defensively. RFC 7235 §2.1: scheme is case-insensitive.
	// Use indexOf for the first space rather than slice(7) so an extra space
	// after "Bearer " doesn't bleed into the token.
	const authorization = raw.trim()
	const spaceIdx = authorization.indexOf(" ")
	if (spaceIdx === -1) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}
	const scheme = authorization.slice(0, spaceIdx).toLowerCase()
	if (scheme !== "bearer") {
		throw new HTTPException(401, { message: "Unauthorized" })
	}
	const token = authorization.slice(spaceIdx + 1).trim()
	if (!token) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}

	// Constant-time comparison via SHA-256 hashing (also prevents length leakage)
	const providedHash = createHash("sha256").update(token).digest()
	if (!timingSafeEqual(expectedHash, providedHash)) {
		throw new HTTPException(401, { message: "Unauthorized" })
	}

	await next()
}
