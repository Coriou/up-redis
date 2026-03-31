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
- **Connection model:** Single shared Bun.redis connection with auto-pipelining for commands/pipelines, dedicated connection per transaction (MULTI/EXEC) via `duplicate()` to prevent interleaving
- **RESP3 → RESP2 translation:** Bun.redis speaks RESP3 but the SDK expects RESP2-compatible JSON — normalize Maps to flat arrays, Booleans to 0/1, recursively
- **Base64 encoding:** When `Upstash-Encoding: base64` header present, all string values in responses are base64-encoded (numbers, null pass through)

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `POST /` | Single Redis command (JSON array body) |
| `POST /pipeline` | Batch commands (2D JSON array body) |
| `POST /multi-exec` | Transaction (2D JSON array body, wrapped in MULTI/EXEC) |
| `GET /` | Health check (SRH compat: welcome message) |
| `GET /health` | Rich health check (Redis probe + shutdown state) |
| `GET /metrics` | Prometheus metrics (opt-in) |

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
  translate/
    response.ts         # normalizeResp3(): Map → flat array, Boolean → 0/1
    encoding.ts         # encodeResult(): recursive base64 encoding
tests/
  unit/                 # Pure logic tests (response normalization, encoding)
  integration/          # Against real Redis
  compatibility/        # Run @upstash/redis SDK against up-redis
```

## Environment Variables

All prefixed `UPREDIS_`:

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `UPREDIS_TOKEN` | - | **Yes** | Bearer token for API auth |
| `UPREDIS_REDIS_URL` | `redis://localhost:6379` | No | Redis connection |
| `UPREDIS_PORT` | `8080` | No | HTTP listen port |
| `UPREDIS_HOST` | `0.0.0.0` | No | HTTP listen host |
| `UPREDIS_LOG_LEVEL` | `info` | No | `debug`, `info`, `warn`, `error` |
| `UPREDIS_LOG_FORMAT` | `json` | No | `json` (structured) or `text` (human-readable) |
| `UPREDIS_SHUTDOWN_TIMEOUT` | `30000` | No | Max ms to wait for request drain |
| `UPREDIS_REQUEST_TIMEOUT` | `30000` | No | Per-request timeout in ms (`0` = disabled) |
| `UPREDIS_METRICS` | `false` | No | Enable Prometheus `/metrics` endpoint |

## Bun.redis Gotchas

Inherited from up-vector experience — critical for correctness:

- **`Bun.redis` speaks RESP3** — Redis 6+ returns richer types (Map, Boolean, Set) that must be normalized to RESP2-compatible JSON. See `src/translate/response.ts`.
- **`redis.send(command, args)`** is the primary interface — forwards any Redis command as raw strings. This is all we need since we're a proxy.
- **`redis.duplicate()`** creates a new connection — used for MULTI/EXEC to prevent interleaving. Always close in `finally`.
- **Auto-pipelining** is enabled by default — concurrent `send()` calls are automatically batched over one TCP connection. No connection pool needed.
- **SCAN cursor is a string** — compare with `"0"` not `0`.

## Testing Strategy

Three tiers:
1. **Unit** (`tests/unit/`): Pure function tests for RESP3 normalization and base64 encoding
2. **Integration** (`tests/integration/`): Full HTTP roundtrips against real Redis
3. **SDK Compatibility** (`tests/compatibility/`): Actual `@upstash/redis` SDK pointed at up-redis

Weekly CI (`compat.yml`) runs SDK tests against `@upstash/redis@latest` and auto-creates GitHub issues on drift.

## Key References

- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi) — the API we're replicating
- [@upstash/redis SDK](https://github.com/upstash/redis-js) — client SDK + compatibility test target
- [SRH](https://github.com/hiett/serverless-redis-http) — predecessor (Elixir), same concept
- [up-vector](https://github.com/Coriou/up-vector) — sibling project, same architecture patterns
