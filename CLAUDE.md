# up-redis

Self-hosted, Upstash Redis-compatible HTTP proxy backed by any Redis 6+ server.
Drop-in replacement for `@upstash/redis` — point the SDK at your own server instead of Upstash's cloud.

Modern rewrite of [SRH](https://github.com/hiett/serverless-redis-http), sibling project to [up-vector](https://github.com/Coriou/up-vector).

## Tech Stack

- **Runtime:** Bun 1.2+ (native TypeScript)
- **HTTP:** Hono v4
- **Redis client:** `Bun.redis` (native, RESP3, auto-pipelining, zero-dep)
- **Validation:** Zod v3
- **Linting/Format:** Biome v1
- **Testing:** `bun test` (built-in, Jest-compatible)
- **Container:** Docker (oven/bun:alpine) + Redis 7

**Not a Next.js/Vercel project.** Pure backend service.

## Commands

```bash
bun install              # Install dependencies
bun run dev              # Dev server with --watch
bun run start            # Production start
bun run build            # Bundle to dist/index.js
bun test                 # All tests
bun test tests/unit      # Unit tests only
bun test tests/integration  # Integration tests (needs Redis)
bun run lint             # Biome check
bun run lint:fix         # Biome auto-fix
bun run format           # Biome format
bun run typecheck        # tsc --noEmit
```

### Docker

```bash
docker compose up -d                          # Production (up-redis + Redis)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up  # Dev (watch mode, debug logs)
```

## Code Style

- **Tabs** for indentation (not spaces)
- **Double quotes** for strings
- **No semicolons** (asNeeded)
- **100-char** line width
- Path alias: `@/*` maps to `src/*`
- Biome handles linting + formatting — run `bun run lint:fix` before committing

## Architecture

```
@upstash/redis SDK → HTTP REST → up-redis (Hono/Bun) → Redis protocol (RESP3) → Redis 6+
```

### Key patterns

- **Response envelope:** `{ "result": <data> }` on success, `{ "error": "<msg>" }` on error (HTTP 400)
- **Auth:** Bearer token via `Authorization` header, validated against `UPREDIS_TOKEN` env var
- **Connection model:** Single shared Bun.redis connection with auto-pipelining for commands/pipelines, dedicated connection per transaction (MULTI/EXEC) via `duplicate()` to prevent interleaving, dedicated connection per PubSub subscription via `duplicate()` for long-lived SSE streams
- **RESP3 → RESP2 translation:** Bun.redis speaks RESP3 but the SDK expects RESP2-compatible JSON — normalize Maps to flat arrays, Booleans to 0/1, recursively
- **Base64 encoding:** When `Upstash-Encoding: base64` header present, all string values in responses are base64-encoded (numbers, null pass through)

### Endpoints

| Endpoint                        | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `POST /`                        | Single Redis command (JSON array body)                  |
| `POST /pipeline`                | Batch commands (2D JSON array body)                     |
| `POST /multi-exec`              | Transaction (2D JSON array body, wrapped in MULTI/EXEC) |
| `GET\|POST /subscribe/:channel` | PubSub subscription (SSE stream, Upstash-compatible)    |
| `GET /`                         | Health check (SRH compat: welcome message)              |
| `GET /health`                   | Rich health check (Redis probe + shutdown state)        |
| `GET /metrics`                  | Prometheus metrics (opt-in)                             |

### Blocked Commands (shared connection safety)

`POST /` and `POST /pipeline` reject commands that would corrupt the shared Bun.redis connection:

- **Subscriber mode:** `SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE` (+ `UNSUBSCRIBE` variants)
- **Monitor mode:** `MONITOR`
- **Transaction state:** `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH` (use `/multi-exec`)
- **Database switching:** `SELECT` (would change DB for all concurrent users)
- **Connection termination:** `QUIT`, `RESET`

These return `400` with an error message. Transaction commands include a hint to use `/multi-exec`.

### RESP3 → JSON Translation (critical)

```
RESP3 Boolean  → integer (true → 1, false → 0)
RESP3 Map      → flat alternating array ({a: 1, b: 2} → ["a", 1, "b", 2])
RESP3 Array    → recursively normalize each element
RESP3 Set      → array (Bun.redis already does this)
String/Number/Null → pass through
```

Commands that return Maps in RESP3 (uniform handling via normalizeResp3):
`HGETALL`, `CONFIG GET`, `XRANGE`, `XREVRANGE`, `XREAD`, `CLIENT INFO`, `COMMAND INFO`

### Base64 Encoding Rules

When `Upstash-Encoding: base64` header is present:

- **Strings:** base64-encode (including "OK", "QUEUED" — SDK handles both)
- **Numbers:** never encode (must be JSON number)
- **Null:** never encode (must be JSON null)
- **Arrays:** recursively encode each element
- **Error strings:** never encode (lives in `error` field, not `result`)

### Transaction Design (MULTI/EXEC)

Each transaction gets a dedicated Bun.redis connection via `duplicate()`:

1. `const tx = await mainClient.duplicate()`
2. `await tx.send("MULTI", [])`
3. Queue each command: `await tx.send(cmd, args)` → "QUEUED"
4. `const results = await tx.send("EXEC", [])` → result array
5. `tx.close()` in `finally` block

This prevents the command interleaving bug (SRH issue #25) that occurs when concurrent transactions share a connection.

### PubSub Design (GET/POST /subscribe/:channel)

Each subscription gets a dedicated Bun.redis connection via `duplicate()`:

1. Client sends `GET` or `POST /subscribe/my-channel`
2. Server returns SSE response immediately via Hono's `streamSSE()`
3. Async callback creates dedicated connection: `const sub = await mainClient.duplicate()`
4. `await sub.subscribe(channel, listener)` — listener forwards each message as SSE
5. SSE format: `data: subscribe,{channel},{count}\n\n` then `data: message,{channel},{content}\n\n`
6. Blocks via `Promise.race([clientDisconnect, redisClose])` until stream ends
7. `finally` block: unsubscribe + close dedicated connection (idempotent, safe for shutdown)

Active subscriptions are tracked in a `Set` with exported `closeAllSubscriptions()` for graceful shutdown. The timeout middleware does not interfere — `streamSSE()` returns the Response synchronously, so `next()` resolves immediately.

## Project Structure

```
src/
  index.ts              # Entry point, Bun.serve + graceful shutdown
  server.ts             # Hono app + middleware registration
  config.ts             # Env var config (Zod validation)
  redis.ts              # Bun.redis client singleton, health probe
  logger.ts             # Structured JSON/text logger
  metrics.ts            # Prometheus counters + histograms
  shutdown.ts           # Shutdown state flag (avoids circular dep)
  types.ts              # Shared types
  middleware/
    auth.ts             # Bearer token validation
    error-handler.ts    # Global error → { error, status } envelope
    logger.ts           # Request logging + request ID
    timeout.ts          # Per-request timeout
  routes/
    health.ts           # GET / + GET /health
    metrics.ts          # GET /metrics (Prometheus, opt-in)
    command.ts          # POST / (single Redis command)
    pipeline.ts         # POST /pipeline (batch execution)
    multi-exec.ts       # POST /multi-exec (transactional execution)
    pubsub.ts           # GET/POST /subscribe/:channel (SSE streaming)
  translate/
    response.ts         # normalizeResp3(): Map → flat array, Boolean → 0/1
    encoding.ts         # encodeResult(): recursive base64 encoding
    pubsub.ts           # SSE event formatting (subscribe confirmation, message events)
tests/
  unit/                 # Pure logic tests (response normalization, encoding)
  integration/          # Against real Redis
  compatibility/        # Run @upstash/redis SDK against up-redis
```

## Environment Variables

All prefixed `UPREDIS_`:

| Variable                   | Default                  | Required | Purpose                                        |
| -------------------------- | ------------------------ | -------- | ---------------------------------------------- |
| `UPREDIS_TOKEN`            | -                        | **Yes**  | Bearer token for API auth                      |
| `UPREDIS_REDIS_URL`        | `redis://localhost:6379` | No       | Redis connection                               |
| `UPREDIS_PORT`             | `8080`                   | No       | HTTP listen port                               |
| `UPREDIS_HOST`             | `0.0.0.0`                | No       | HTTP listen host                               |
| `UPREDIS_LOG_LEVEL`        | `info`                   | No       | `debug`, `info`, `warn`, `error`               |
| `UPREDIS_LOG_FORMAT`       | `json`                   | No       | `json` (structured) or `text` (human-readable) |
| `UPREDIS_SHUTDOWN_TIMEOUT` | `30000`                  | No       | Max ms to wait for request drain               |
| `UPREDIS_REQUEST_TIMEOUT`  | `30000`                  | No       | Per-request timeout in ms (`0` = disabled)     |
| `UPREDIS_METRICS`          | `false`                  | No       | Enable Prometheus `/metrics` endpoint          |
| `UPREDIS_MAX_BODY_SIZE`    | `10485760`               | No       | Max request body size in bytes (10MB)          |

## Bun.redis Gotchas

Inherited from up-vector experience — critical for correctness:

- **`Bun.redis` speaks RESP3** — Redis 6+ returns richer types (Map, Boolean, Set) that must be normalized to RESP2-compatible JSON. See `src/translate/response.ts`.
- **`redis.send(command, args)`** is the primary interface — forwards any Redis command as raw strings. This is all we need since we're a proxy.
- **`redis.duplicate()`** creates a new connection — used for MULTI/EXEC (prevents interleaving) and PubSub subscriptions (subscriber mode). Always close in `finally`.
- **`redis.subscribe(channel, listener)`** puts the connection in subscriber mode — only `ping`/`subscribe`/`unsubscribe` allowed. Returns the subscription count. Listener receives `(message: string, channel: string)`.
- **Auto-pipelining** is enabled by default — concurrent `send()` calls are automatically batched over one TCP connection. No connection pool needed.
- **SCAN cursor is a string** — compare with `"0"` not `0`.

## Testing Strategy

232 tests across three tiers:

| Tier                  | Tests | Purpose                                                                                                                                                                           |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**              | 55    | RESP3 normalization, base64 encoding, SSE event formatting                                                                                                                        |
| **Integration**       | 80    | Full HTTP roundtrips against real Redis (commands, pipelines, transactions, PubSub subscribe/publish, stress tests, edge cases, health)                                           |
| **SDK Compatibility** | 97    | Real `@upstash/redis` SDK against up-redis (strings, hashes, lists, sets, sorted sets, SCAN, geo, HyperLogLog, Lua scripting, pipelines, transactions, PubSub `Subscriber` class) |

Weekly CI (`compat.yml`) runs against `@upstash/redis@latest` every Monday 9 AM UTC and auto-creates GitHub issues on drift.

## Key References

- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi) — the API we're replicating
- [@upstash/redis SDK](https://github.com/upstash/redis-js) — client SDK + compatibility test target
- [SRH](https://github.com/hiett/serverless-redis-http) — predecessor (Elixir), same concept
- [up-vector](https://github.com/Coriou/up-vector) — sibling project, same architecture patterns
