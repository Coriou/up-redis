import { bearerAuth } from "hono/bearer-auth"
import { config } from "../config"

export const authMiddleware = bearerAuth({ token: config.token })
