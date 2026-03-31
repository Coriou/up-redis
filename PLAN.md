# up-redis — Implementation Plan

A self-hosted, Upstash Redis-compatible HTTP proxy backed by any standard Redis server. Drop-in replacement for `@upstash/redis` — point the SDK at your own server instead of Upstash's cloud.

Modern rewrite of [SRH](https://github.com/hiett/serverless-redis-http) (serverless-redis-http) using the same architecture and conventions as [up-vector](https://github.com/Coriou/up-vector).

---

## Why rewrite SRH?

SRH is solid but showing its age:

| Aspect | SRH (Elixir) | up-redis (Bun/Hono) |
|--------|-------------|---------------------|
| Language | Elixir — great runtime, small contributor pool | TypeScript — same language as the SDK users |
| Health checks | None (just a welcome message) | Rich `/health` with Redis probe + shutdown state |
| Logging | None | Structured JSON/text logging with levels |
| Metrics | None | Prometheus counters + histograms (opt-in) |
| Graceful shutdown | None | Request draining, configurable timeout, double-signal handling |
| Request timeout | None | Per-request timeout middleware |
| Concurrent MULTI/EXEC | Broken (issue #25 — command interleaving) | Correct by design (dedicated connection per transaction) |
| Edge case crashes | CaseClauseError on edge cases (#34) | Comprehensive error handling |
| Binary data | Works (Elixir is binary-native) | Works (base64 encoding layer) |
| Docker image | ~100MB (Elixir runtime) | ~50MB (Bun Alpine) |
| Test runner | External (@upstash/redis test suite) | Built-in Bun test + SDK compatibility suite |

SRH has ~500 lines of core logic. up-redis will have similar core complexity (~400-600 LOC) but with proper production infrastructure borrowed from up-vector.

---

## Architecture

```
@upstash/redis SDK (your app, Vercel edge, anywhere)
        |
        | HTTP POST (JSON command array)
        |
   ┌────▼─────────────────────────┐
   │          up-redis             │
   │   (Hono on Bun, ~500 LOC)    │
   │                               │
   │   Accepts Upstash Redis REST  │
   │   calls, forwards them to     │
   │   Redis via Bun.redis         │
   └────┬─────────────────────────┘
        |
        | Redis protocol (RESP3 via Bun.redis)
        |
   ┌────▼─────────────────────────┐
   │         Redis Server          │
   │   (any Redis 6+ / Valkey)     │
   │                               │
   │   Standard Redis — no modules │
   │   required (Stack optional)   │
   └──────────────────────────────┘
```

**Key design decisions:**

1. **Generic Redis, not Redis Stack** — Unlike up-vector (which needs RediSearch), up-redis works with any standard Redis 6+ server. Redis Stack is optional and only needed if you want RedisJSON/RediSearch commands forwarded.
2. **Bun.redis speaks RESP3** — Redis 6+ supports RESP3 natively. RESP3 returns richer types (Maps, Sets, Booleans) that we normalize back to RESP2-compatible JSON for SDK compatibility.
3. **Dedicated connections for transactions** — Each MULTI/EXEC request gets its own Bun.redis connection via `duplicate()`. This prevents the command interleaving bug that plagues SRH (#25). The connection is created on demand and closed after EXEC.
4. **Same shell as up-vector** — Config, logging, metrics, shutdown, middleware, Docker, CI — all identical patterns, just with `UPREDIS_` prefix.

---

## Tech Stack

| Layer | Choice | Version | Why |
|-------|--------|---------|-----|
| Runtime | Bun | 1.2+ | Native TS, built-in test runner, native Redis client |
| HTTP | Hono | v4 | Lightweight, fast, great middleware |
| Redis client | Bun.redis | built-in | RESP3, auto-pipelining, `send()` for raw commands, zero deps |
| Validation | Zod | v3 | Request validation, config validation |
| Linting/Format | Biome | v1 | Fast, modern, replaces ESLint+Prettier |
| Testing | Bun test | built-in | Fast, Jest-compatible API |
| Container | Bun Alpine | oven/bun:alpine | Minimal image size (~50MB) |
| Redis backend | Any Redis 6+ | 6.0+ | Standard Redis, Valkey, KeyDB, Redis Stack — all work |

---

## Upstash Redis REST API — What We Implement

### Endpoints

The `@upstash/redis` SDK sends ALL commands as HTTP POST with JSON body. URL-path encoding (`GET /set/key/value`) is an alternative documented by Upstash but never used by the SDK.

| Endpoint | Method | Priority | Purpose |
|----------|--------|----------|---------|
| `POST /` | POST | P0 | Single Redis command (JSON array body) |
| `POST /pipeline` | POST | P0 | Batch commands (2D JSON array body) |
| `POST /multi-exec` | POST | P0 | Transaction (2D JSON array body, wrapped in MULTI/EXEC) |
| `GET /` | GET | P0 | Health check (SRH compat: returns welcome message) |
| `GET /health` | GET | P0 | Rich health check (Redis probe, shutdown state) |
| `GET /metrics` | GET | P1 | Prometheus metrics (opt-in) |
| `GET /{command}/{args...}` | GET | P2 | URL-path command encoding (deferred — SDK doesn't use it) |
| `POST /subscribe/{channel}` | POST | P2 | Pub/Sub SSE streaming (deferred) |
| `POST /monitor` | POST | P2 | MONITOR SSE streaming (deferred) |

### Request Format

**Single command** (`POST /`):
```json
["SET", "mykey", "myvalue", "EX", 100]
```
A flat JSON array. First element is the Redis command, rest are arguments. The SDK serializes all arguments: strings and numbers pass through, objects are `JSON.stringify()`'d.

**Pipeline** (`POST /pipeline`):
```json
[
  ["SET", "key1", "val1"],
  ["GET", "key1"],
  ["DEL", "key2"]
]
```
Array of command arrays. Non-atomic — commands execute in order but can interleave with other clients.

**Transaction** (`POST /multi-exec`):
```json
[
  ["SET", "key1", "val1"],
  ["GET", "key1"]
]
```
Same format as pipeline. The server wraps in MULTI/EXEC automatically. Atomic execution.

### Response Format

**Single command success:**
```json
{"result": "OK"}
{"result": 42}
{"result": null}
{"result": ["val1", "val2"]}
```

**Single command error:**
```json
{"error": "WRONGTYPE Operation against a key holding the wrong kind of value"}
```
HTTP status 400 for Redis command errors. The `error` field is never base64-encoded.

**Pipeline/Transaction success:**
```json
[
  {"result": "OK"},
  {"result": "val1"},
  {"result": 1}
]
```
Array of result objects, one per command. Overall HTTP 200 even if individual commands error.

**Pipeline/Transaction per-command error:**
```json
[
  {"result": "OK"},
  {"error": "WRONGTYPE ..."},
  {"result": 1}
]
```
Individual entries can have `error` instead of `result`.

### Authentication

`Authorization: Bearer <token>` header on every request. Token validated against `UPREDIS_TOKEN` env var.

The SDK also supports `?_token=<token>` query parameter, but we can defer this (SDK always uses the header).

### Base64 Response Encoding

The SDK sends `Upstash-Encoding: base64` header by default. When present, the server must base64-encode string values in responses.

**Encoding rules** (derived from SDK source at `packages/redis/pkg/http.ts`):

| Value type | Encoding behavior |
|-----------|-------------------|
| String | Base64-encode (including `"OK"` and `"QUEUED"` — SDK handles both encoded and literal) |
| Number (integer/double) | Never encode — must be a JSON number |
| Null | Never encode — must be JSON `null` |
| Array | Recursively encode each element |
| Error string | Never encode (lives in `error` field, not `result`) |

**SDK decode behavior:**
- `typeof "number"` → pass through
- `typeof "object"` + `null` → pass through
- `typeof "object"` + `Array` → recursively decode each element
- `typeof "string"` + `=== "OK"` → pass through (short-circuit, no decoding)
- `typeof "string"` + other → `atob()` + `TextDecoder` (with silent fallback on invalid base64)

**Simplest correct implementation:** Base64-encode ALL strings (including `"OK"`). The SDK handles this correctly — SRH does exactly this and passes the SDK test suite.

---

## RESP3-to-JSON Translation Layer

This is the critical translation piece. Bun.redis speaks RESP3, but the SDK expects RESP2-compatible JSON responses.

### RESP3 → JavaScript → JSON mapping

| RESP3 Type | Bun.redis JS Type | SDK Expectation | Translation Needed |
|-----------|-------------------|-----------------|-------------------|
| Simple String (`+`) | `string` | JSON string | None (base64-encode if header set) |
| Bulk String (`$`) | `string` or `null` | JSON string or null | None |
| Integer (`:`) | `number` | JSON number | None |
| Double (`,`) | `number` | JSON number | None |
| Null (`_`) | `null` | JSON null | None |
| Boolean (`#`) | `boolean` | JSON number (0 or 1) | **Convert: `true` → `1`, `false` → `0`** |
| Array (`*`) | `Array` | JSON array | Recursively translate elements |
| Map (`%`) | `Object` (null prototype) | JSON array (flat alternating) | **Flatten: `{k1: v1, k2: v2}` → `[k1, v1, k2, v2]`** |
| Set (`~`) | `Array` | JSON array | None (Bun.redis already converts to Array) |
| Big Number (`(`) | `number` or `string` | JSON number or string | None (Bun.redis handles overflow → string) |
| Verbatim String (`=`) | `string` | JSON string | None (Bun.redis strips format prefix) |
| Error (`-`, `!`) | thrown `Error` | `{"error": "..."}` | Catch → error envelope |

### Critical translations

**1. RESP3 Map → Flat alternating array**

In RESP3, commands like `HGETALL`, `CONFIG GET`, `XRANGE` return Map types. Bun.redis converts these to JS Objects. But the SDK expects flat alternating arrays (RESP2 style).

```
Redis RESP3:  %2\r\n$5\r\nfield\r\n$5\r\nvalue\r\n$4\r\nname\r\n$3\r\nBen\r\n
Bun.redis:    { field: "value", name: "Ben" }
SDK expects:  ["field", "value", "name", "Ben"]
We send:      {"result": ["field", "value", "name", "Ben"]}  (+ base64 encoding)
```

Detection: `typeof val === "object" && val !== null && !Array.isArray(val)`

**2. RESP3 Boolean → Integer**

In RESP3, some internal responses use booleans. The SDK's `decode()` has no `case "boolean"` — booleans fall through to `default` which returns `undefined`.

```
Bun.redis:    true / false
SDK expects:  1 / 0
We send:      {"result": 1} or {"result": 0}
```

**3. Nested structures**

EXEC results, SCAN responses, and stream entries can have deeply nested types. The translation must be recursive.

```typescript
function normalizeResp3(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === "boolean") return value ? 1 : 0
  if (typeof value === "number" || typeof value === "string") return value
  if (Array.isArray(value)) return value.map(normalizeResp3)
  if (typeof value === "object") {
    // RESP3 Map → flat alternating array
    const entries = Object.entries(value as Record<string, unknown>)
    const flat: unknown[] = []
    for (const [k, v] of entries) {
      flat.push(k, normalizeResp3(v))
    }
    return flat
  }
  return String(value) // fallback
}
```

### Commands with special RESP3 behavior

These commands return RESP3 Maps in RESP3 mode but flat arrays in RESP2. Our translation handles all of them uniformly:

| Command | RESP3 Type | RESP2 Equivalent |
|---------|-----------|-----------------|
| `HGETALL` | Map | Flat alternating array |
| `CONFIG GET` | Map | Flat alternating array |
| `XRANGE` / `XREVRANGE` | Array of [id, Map] | Array of [id, flat array] |
| `XREAD` | Map of stream → entries | Flat alternating array |
| `CLIENT INFO` | Map | Flat alternating array |
| `COMMAND INFO` | Map | Flat alternating array |
| `FT.INFO` | Map | Flat alternating array |
| `FT.SEARCH` | Map | Flat alternating array |

The generic `normalizeResp3()` function handles all of these without command-specific logic.

---

## Connection Management

### Regular commands (POST /, POST /pipeline)

Single shared `Bun.redis` connection with auto-pipelining enabled.

- Auto-pipelining multiplexes concurrent commands over one TCP connection
- `redis.send(command, args)` for all command forwarding
- No connection pool needed — auto-pipelining handles high concurrency on a single connection
- `enableAutoPipelining: true` (default) batches concurrent `send()` calls automatically

### Transactions (POST /multi-exec)

**Dedicated connection per transaction** via `redis.duplicate()`.

This is the key design improvement over SRH. SRH's bug #25 happens because concurrent transactions share a connection pool and commands interleave. We avoid this entirely:

```
1. Request arrives at POST /multi-exec
2. Create dedicated connection: const txConn = await mainClient.duplicate()
3. await txConn.send("MULTI", [])
4. For each command: await txConn.send(cmd, args)  // returns "QUEUED"
5. const results = await txConn.send("EXEC", [])   // returns result array
6. txConn.close()
7. Return results as [{result: ...}, {result: ...}, ...]
```

**Cost:** ~1ms TCP connection overhead per transaction. Acceptable for the correctness guarantee. Redis processes commands from a single connection in order, so there's zero risk of interleaving.

**Error handling:**
- If any queued command has a syntax error, EXEC returns `null` (transaction aborted)
- If a queued command fails at execution time, that position in the EXEC result array contains an error, others succeed
- If the connection fails during the transaction, the entire request returns a 500 error
- Always close the dedicated connection in a `finally` block

### Connection lifecycle

```
Startup:
  1. Create main Bun.redis client (auto-pipelining, auto-reconnect)
  2. Ping to verify connectivity
  3. Start HTTP server

Requests:
  - POST /        → main client, redis.send()
  - POST /pipeline → main client, sequential redis.send() calls
  - POST /multi-exec → dedicated connection (duplicate + close)

Shutdown:
  1. Stop accepting new HTTP requests
  2. Drain in-flight requests (configurable timeout)
  3. Close main Redis connection
  4. Exit
```

---

## Project Structure

```
up-redis/
├── src/
│   ├── index.ts              # Entry point — Bun.serve + graceful shutdown
│   ├── server.ts             # Hono app + middleware registration
│   ├── config.ts             # Zod-validated env config (UPREDIS_* prefix)
│   ├── redis.ts              # Bun.redis client singleton + health probe
│   ├── logger.ts             # Structured JSON/text logger
│   ├── metrics.ts            # Prometheus counters + histograms (opt-in)
│   ├── shutdown.ts           # Shutdown state flag (avoids circular dep)
│   ├── types.ts              # Shared types
│   ├── middleware/
│   │   ├── auth.ts           # Bearer token validation (Hono bearerAuth)
│   │   ├── error-handler.ts  # Global error → { error, status } envelope
│   │   ├── logger.ts         # Request logging + request ID propagation
│   │   └── timeout.ts        # Per-request timeout (Promise.race)
│   ├── routes/
│   │   ├── health.ts         # GET / (welcome + health) + GET /health (Redis probe)
│   │   ├── metrics.ts        # GET /metrics (Prometheus format, opt-in)
│   │   ├── command.ts        # POST / (single Redis command)
│   │   ├── pipeline.ts       # POST /pipeline (batch execution)
│   │   └── multi-exec.ts     # POST /multi-exec (transactional execution)
│   └── translate/
│       ├── response.ts       # RESP3 → RESP2-compatible JSON normalization
│       └── encoding.ts       # Base64 response encoding (recursive)
├── tests/
│   ├── unit/
│   │   ├── response.test.ts  # RESP3 normalization (maps, booleans, nested)
│   │   └── encoding.test.ts  # Base64 encoding (strings, numbers, nulls, arrays, recursion)
│   ├── integration/
│   │   ├── setup.ts          # Test helpers (api(), resetAll())
│   │   ├── command.test.ts   # POST / against real Redis
│   │   ├── pipeline.test.ts  # POST /pipeline against real Redis
│   │   ├── multi-exec.test.ts # POST /multi-exec against real Redis
│   │   └── encoding.test.ts  # Base64 roundtrip integration tests
│   └── compatibility/
│       ├── setup.ts          # @upstash/redis SDK configured against up-redis
│       └── README.md         # How to run SDK compatibility tests
├── .github/
│   ├── workflows/
│   │   ├── test.yml          # Push/PR: unit + integration + compat
│   │   └── compat.yml        # Weekly: latest @upstash/redis SDK compat
│   └── dependabot.yml
├── Dockerfile                # Multi-stage oven/bun:alpine build
├── docker-compose.yml        # Production: up-redis + Redis
├── docker-compose.dev.yml    # Dev: watch mode, debug logs, exposed Redis
├── package.json
├── tsconfig.json
├── biome.json
├── bunfig.toml
├── .env.example
├── .gitignore
├── LICENSE
├── README.md
├── CLAUDE.md
└── PLAN.md                   # This file
```

---

## Configuration

### Environment Variables

| Variable | Default | Required | Purpose |
|----------|---------|----------|---------|
| `UPREDIS_TOKEN` | — | **Yes** | Bearer token for API auth |
| `UPREDIS_REDIS_URL` | `redis://localhost:6379` | No | Redis connection URL |
| `UPREDIS_PORT` | `8080` | No | HTTP listen port |
| `UPREDIS_HOST` | `0.0.0.0` | No | HTTP listen host |
| `UPREDIS_LOG_LEVEL` | `info` | No | `debug`, `info`, `warn`, `error` |
| `UPREDIS_LOG_FORMAT` | `json` | No | `json` (structured) or `text` (human-readable) |
| `UPREDIS_SHUTDOWN_TIMEOUT` | `30000` | No | Max ms to wait for request drain on shutdown |
| `UPREDIS_REQUEST_TIMEOUT` | `30000` | No | Per-request timeout in ms (`0` = disabled) |
| `UPREDIS_METRICS` | `false` | No | Enable Prometheus `/metrics` endpoint |

### Zod schema

```typescript
const envSchema = z.object({
  UPREDIS_TOKEN: z.string().min(1, "UPREDIS_TOKEN is required"),
  UPREDIS_REDIS_URL: z.string().default("redis://localhost:6379"),
  UPREDIS_PORT: z.coerce.number().int().positive().default(8080),
  UPREDIS_HOST: z.string().default("0.0.0.0"),
  UPREDIS_LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  UPREDIS_LOG_FORMAT: z.enum(["json", "text"]).default("json"),
  UPREDIS_SHUTDOWN_TIMEOUT: z.coerce.number().int().nonnegative().default(30000),
  UPREDIS_REQUEST_TIMEOUT: z.coerce.number().int().nonnegative().default(30000),
  UPREDIS_METRICS: z.enum(["true", "false"]).default("false"),
})
```

### Multi-token mode (deferred)

Like SRH's file mode, support a JSON config mapping tokens to separate Redis servers. Each token routes to a different backend with its own connection. Not needed for v1 — single-token mode covers 90% of use cases.

---

## Implementation Phases

### Phase 0 — Project Setup (tooling only, no logic)

Set up the project exactly like up-vector: same tooling, same quality controls, same CI structure.

- [ ] `package.json` — scripts, dependencies (hono, zod), devDependencies (biome, typescript, @types/bun, @upstash/redis)
- [ ] `tsconfig.json` — ES2024, bundler resolution, strict, `@/*` path alias
- [ ] `biome.json` — tabs, 100-char width, double quotes, no semicolons, recommended rules
- [ ] `bunfig.toml` — test config
- [ ] `.gitignore` — node_modules, dist, .env*.local, coverage
- [ ] `.env.example` — all env vars with comments
- [ ] `Dockerfile` — multi-stage build (builder + runtime), oven/bun:alpine, healthcheck
- [ ] `docker-compose.yml` — up-redis + Redis 7 (not Redis Stack — plain Redis is enough)
- [ ] `docker-compose.dev.yml` — watch mode, debug logs, exposed Redis port
- [ ] `.github/workflows/test.yml` — unit + integration + compat on push/PR
- [ ] `.github/workflows/compat.yml` — weekly SDK compat with auto-issue on failure
- [ ] `.github/dependabot.yml` — weekly dependency updates
- [ ] `CLAUDE.md` — project context for AI assistants
- [ ] `PLAN.md` — this file
- [ ] `git init` + initial commit

### Phase 1 — Core Infrastructure (direct port from up-vector)

Everything here is a copy-paste-rename from up-vector with `UPVECTOR_` → `UPREDIS_` and minor simplifications (no dimension/metric config).

- [ ] `src/config.ts` — Zod env validation
- [ ] `src/logger.ts` — Structured JSON/text logger
- [ ] `src/shutdown.ts` — Shutdown state flag
- [ ] `src/redis.ts` — Bun.redis client singleton, `initRedis()`, `getClient()`, `isRedisHealthy()`, `closeRedis()`
- [ ] `src/metrics.ts` — Prometheus counters + histograms
- [ ] `src/middleware/auth.ts` — Hono `bearerAuth({ token: config.token })`
- [ ] `src/middleware/error-handler.ts` — ZodError → 400, HTTPException → status, unhandled → 500
- [ ] `src/middleware/logger.ts` — Request ID (X-Request-ID), duration logging, metrics recording
- [ ] `src/middleware/timeout.ts` — Promise.race timeout, 504 on expiry
- [ ] `src/server.ts` — Hono app, middleware order: onError → logger → health → [metrics] → auth → timeout → routes
- [ ] `src/index.ts` — `initRedis()` → `Bun.serve()` → SIGTERM/SIGINT shutdown handlers
- [ ] `src/routes/health.ts` — `GET /` (welcome message, SRH compat) + `GET /health` (Redis probe)
- [ ] `src/routes/metrics.ts` — `GET /metrics` (Prometheus format, guarded by config.metricsEnabled)

### Phase 2 — Single Command Execution (POST /)

The core business logic. Parse a JSON command array, forward to Redis, translate the response, optionally base64-encode, return in envelope.

- [ ] `src/translate/response.ts` — `normalizeResp3(value)`: RESP3 Map → flat array, Boolean → 0/1, recursive
- [ ] `src/translate/encoding.ts` — `encodeResult(value)`: recursive base64 encoding of all strings, skip numbers/null
- [ ] `src/routes/command.ts` — `POST /` handler:
  1. Parse body as JSON array
  2. Validate: must be array, first element must be string (the command)
  3. Call `redis.send(command, args)`
  4. `normalizeResp3()` the result
  5. If `Upstash-Encoding: base64` header → `encodeResult()` the result
  6. Return `{ result }` envelope
  7. Catch Redis errors → `{ error: message }` with 400 status
- [ ] `tests/unit/response.test.ts` — RESP3 normalization tests:
  - Strings, numbers, null pass through
  - Boolean true → 1, false → 0
  - Object `{a: 1, b: 2}` → `["a", 1, "b", 2]`
  - Nested objects/arrays
  - Empty object → empty array
  - Array of mixed types
- [ ] `tests/unit/encoding.test.ts` — Base64 encoding tests:
  - Strings are base64-encoded
  - Numbers pass through
  - Null passes through
  - "OK" is encoded (SRH approach — SDK handles both)
  - Nested arrays recursively encoded
  - Empty string is encoded
  - Mixed type arrays

### Phase 3 — Pipeline + Transactions

- [ ] `src/routes/pipeline.ts` — `POST /pipeline` handler:
  1. Parse body as array of arrays
  2. Execute each command sequentially via `redis.send()`
  3. Collect results (catch per-command errors → `{ error }` entries)
  4. Normalize + encode each result independently
  5. Return array of `{ result }` / `{ error }` objects
- [ ] `src/routes/multi-exec.ts` — `POST /multi-exec` handler:
  1. Parse body as array of arrays
  2. Create dedicated connection: `const tx = await getClient().duplicate()`
  3. `await tx.send("MULTI", [])`
  4. Queue each command: `await tx.send(cmd, args)` (returns "QUEUED")
  5. `const results = await tx.send("EXEC", [])` (returns array of results)
  6. Close connection in `finally` block: `tx.close()`
  7. Normalize + encode each result
  8. Return array of `{ result }` / `{ error }` objects
  9. Handle EXEC returning `null` (transaction aborted) → error response
- [ ] `tests/integration/setup.ts` — Test helpers: `api(method, path, body, headers)`, env-based URL/token
- [ ] `tests/integration/command.test.ts` — Single command tests:
  - SET/GET roundtrip
  - DEL returns integer
  - Non-existent key returns null
  - WRONGTYPE error returns error envelope
  - HGETALL returns flat array (RESP3 Map → array)
  - Base64 encoding with header
  - Without encoding header → raw strings
- [ ] `tests/integration/pipeline.test.ts` — Pipeline tests:
  - Multiple commands in order
  - Per-command errors don't break pipeline
  - Empty pipeline
  - Base64 encoding per result
- [ ] `tests/integration/multi-exec.test.ts` — Transaction tests:
  - Atomic execution
  - Concurrent transactions don't interleave (the SRH bug #25 test)
  - Transaction with failing command
  - Empty transaction

### Phase 4 — SDK Compatibility

Run the actual `@upstash/redis` SDK test suite against up-redis, same approach as SRH.

- [ ] `tests/compatibility/setup.ts` — Create `Redis` instance pointing at up-redis
- [ ] CI job: clone `upstash/redis-js`, install, configure env vars, run `bun test`
- [ ] Identify and document which tests to skip:
  - JSON command tests (3 files — RedisJSON response format differences, same as SRH)
  - `read-your-writes.test.ts` (sync tokens — Upstash-specific feature, not needed for self-hosted)
  - Any Upstash-specific provisioning tests
- [ ] Fix compatibility issues discovered by the test suite
- [ ] `tests/compatibility/README.md` — document the process and known exclusions
- [ ] `.github/workflows/compat.yml` — weekly run against `@upstash/redis@latest`:
  - Clone SDK repo
  - Delete excluded test files
  - Set `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`
  - Run tests
  - Auto-create GitHub issue on failure (if not already open)

### Phase 5 — Production Polish

- [ ] `README.md` — usage, Docker, SDK example, comparison with SRH
- [ ] `LICENSE` — MIT
- [ ] Performance testing: verify throughput under concurrent load
- [ ] Docker image size optimization
- [ ] CI caching optimization (bun install cache)

### Phase 6 — Deferred (only if needed)

- [ ] URL-path command encoding (`GET /set/key/value`) — SDK doesn't use it, but curl users might want it
- [ ] `?_token=<token>` query parameter auth — SDK doesn't use it
- [ ] Pub/Sub SSE streaming (`POST /subscribe/{channel}`, `POST /monitor`)
- [ ] `Upstash-Response-Format: resp2` header (raw RESP2 wire format response)
- [ ] `upstash-sync-token` read-your-writes support (echo token)
- [ ] Multi-token mode (JSON config file mapping tokens → Redis backends, like SRH's file mode)
- [ ] TLS support (currently relies on reverse proxy like Caddy/nginx)
- [ ] Redis Cluster support (command routing, MOVED/ASK redirect following)
- [ ] Redis ACL support (per-token user mapping)

---

## Docker Setup

### docker-compose.yml (production)

```yaml
services:
  up-redis:
    build: .
    ports:
      - "${UPREDIS_PORT:-8080}:8080"
    environment:
      UPREDIS_TOKEN: ${UPREDIS_TOKEN:?Set UPREDIS_TOKEN in .env}
      UPREDIS_REDIS_URL: redis://redis:6379
      UPREDIS_LOG_LEVEL: ${UPREDIS_LOG_LEVEL:-info}
    depends_on:
      redis:
        condition: service_healthy
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/"]
      interval: 10s
      timeout: 5s
      retries: 3

  redis:
    image: redis:7-alpine
    volumes:
      - redis-data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 5s
      timeout: 3s
      retries: 5
    restart: unless-stopped

volumes:
  redis-data:
```

Note: `redis:7-alpine` instead of `redis/redis-stack-server`. Plain Redis is all we need.

### docker-compose.dev.yml (development)

```yaml
services:
  up-redis:
    build:
      context: .
      target: builder
    command: ["bun", "run", "--watch", "src/index.ts"]
    volumes:
      - ./src:/app/src:ro
    environment:
      UPREDIS_LOG_LEVEL: debug
      UPREDIS_LOG_FORMAT: text

  redis:
    ports:
      - "6379:6379"
```

### Dockerfile

```dockerfile
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production=false
COPY tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --target=bun --outdir=dist --minify

FROM oven/bun:1-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/ || exit 1
CMD ["bun", "run", "dist/index.js"]
```

---

## Testing Strategy

### 1. Unit Tests (tests/unit/)

Pure function tests, no Redis needed:

```
response.test.ts:
  - normalizeResp3() with strings, numbers, null             (~5 tests)
  - normalizeResp3() with booleans → 0/1                     (~2 tests)
  - normalizeResp3() with objects → flat arrays               (~5 tests)
  - normalizeResp3() with nested structures                   (~5 tests)
  - normalizeResp3() with empty/edge cases                    (~3 tests)

encoding.test.ts:
  - encodeResult() with strings → base64                     (~3 tests)
  - encodeResult() with numbers → pass through               (~2 tests)
  - encodeResult() with null → pass through                  (~1 test)
  - encodeResult() with arrays → recursive                   (~3 tests)
  - encodeResult() with nested arrays                        (~3 tests)
  - encodeResult() with mixed types                          (~2 tests)
  - encodeResult() with empty string                         (~1 test)
  - encodeResult() with unicode/emoji                        (~2 tests)
```

~35 unit tests total.

### 2. Integration Tests (tests/integration/)

Against a real Redis server (Docker service in CI, local in dev):

```
command.test.ts:
  - SET/GET roundtrip                                        (~3 tests)
  - Integer responses (DEL, INCR, DBSIZE)                    (~3 tests)
  - Null responses (GET nonexistent)                         (~1 test)
  - Array responses (MGET, KEYS)                             (~3 tests)
  - Hash responses (HGETALL → flat array)                    (~2 tests)
  - Error responses (WRONGTYPE)                              (~2 tests)
  - Base64 encoding header behavior                          (~3 tests)
  - Without encoding header                                  (~2 tests)
  - Auth failure (wrong/missing token)                       (~2 tests)
  - Invalid body (not JSON, not array)                       (~3 tests)

pipeline.test.ts:
  - Multiple commands in order                               (~2 tests)
  - Per-command error handling                                (~2 tests)
  - Empty pipeline                                           (~1 test)
  - Large pipeline (100+ commands)                           (~1 test)
  - Base64 encoding                                          (~1 test)

multi-exec.test.ts:
  - Basic transaction                                        (~2 tests)
  - Transaction with error                                   (~1 test)
  - Concurrent transactions (SRH bug #25 regression)         (~1 test)
  - Empty transaction                                        (~1 test)
  - Base64 encoding                                          (~1 test)

encoding.test.ts:
  - Full roundtrip with SDK (set via REST, get via REST)     (~5 tests)
  - Binary data roundtrip                                    (~2 tests)
  - Special characters (emoji, unicode)                      (~2 tests)
```

~40 integration tests total.

### 3. SDK Compatibility Tests (tests/compatibility/)

Run `@upstash/redis` SDK's own test suite against up-redis. This is the ultimate compatibility check.

**Approach (same as SRH):**
1. Clone `upstash/redis-js` in CI
2. Delete known-incompatible test files (JSON commands, sync tokens)
3. Set `UPSTASH_REDIS_REST_URL=http://localhost:8080` + `UPSTASH_REDIS_REST_TOKEN=test-token`
4. Run `bun test packages/redis/pkg --bail --timeout 20000`

**Expected exclusions:**
- `json_get.test.ts`, `json_mget.test.ts`, `json_objlen.test.ts` (RedisJSON format differences)
- `read-your-writes.test.ts` (Upstash-specific sync tokens)
- Possibly more JSON tests if Redis Stack isn't available

**Expected test count:** ~500+ tests from the SDK suite.

### CI Pipeline

```yaml
# .github/workflows/test.yml
jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - checkout, setup-bun, install
      - bun run typecheck
      - bun run lint
      - bun test tests/unit

  integration:
    needs: unit
    services:
      redis:
        image: redis:7-alpine
        ports: [6379:6379]
        options: --health-cmd "redis-cli ping" ...
    steps:
      - checkout, setup-bun, install
      - Start up-redis in background
      - Wait for server readiness (curl loop)
      - bun test tests/integration

  compatibility:
    needs: integration
    services:
      redis:
        image: redis:7-alpine
    steps:
      - checkout, setup-bun, install
      - Start up-redis in background
      - Clone upstash/redis-js
      - Delete excluded tests
      - Run SDK test suite
```

---

## Compatibility Notes

### What works identically to Upstash

- All Redis commands forwarded transparently (the proxy doesn't interpret commands)
- Bearer token authentication
- JSON request/response envelope format
- Base64 response encoding
- Pipeline execution
- Transactional execution (MULTI/EXEC)
- The `@upstash/redis` TypeScript SDK (just swap the URL)
- All data types: strings, integers, arrays, hashes, sets, sorted sets, streams

### Known differences from Upstash

| Aspect | Upstash | up-redis | Impact |
|--------|---------|----------|--------|
| Read-your-writes | Multi-region sync tokens | Not supported (v1) | Single-region only. No impact for self-hosted. |
| URL-path encoding | `GET /set/key/value` | Not supported (v1) | SDK never uses this. Curl users need to use POST. |
| Pub/Sub SSE | `POST /subscribe/{channel}` | Not supported (v1) | Use direct Redis connection for Pub/Sub. |
| RedisJSON | Upstash-specific response format | Standard Redis Stack format | Some JSON commands may behave differently. |
| Read-only tokens | ACL-based restrictions | Not supported (v1) | Single token with full access. |
| Rate limiting | Built-in | Not built-in | Use reverse proxy (nginx, Caddy) if needed. |
| Multi-region | Built-in | Not supported | Self-hosted is single-region by design. |
| MONITOR | SSE streaming | Not supported (v1) | Use `redis-cli monitor` directly. |

### SRH behavioral differences (inherited)

These are documented SRH differences that also apply to up-redis (since they stem from Redis server behavior vs Upstash behavior):

- `UNLINK` with 0 keys: Upstash silently succeeds, Redis throws an error
- `ZRANGE` with `LIMIT`: Upstash doesn't require `BYSCORE`/`BYLEX`, Redis does

---

## Usage (once built)

### Docker Compose

```bash
git clone https://github.com/Coriou/up-redis.git
cd up-redis
cp .env.example .env
# Edit .env: set UPREDIS_TOKEN
docker compose up -d
```

### With @upstash/redis SDK

```typescript
import { Redis } from "@upstash/redis"

const redis = new Redis({
  url: "http://localhost:8080",   // up-redis
  token: "your-token-here",
})

// Works exactly like Upstash
await redis.set("greeting", "Hello, World!")
const value = await redis.get("greeting") // "Hello, World!"

await redis.hset("user:1", { name: "Ben", role: "admin" })
const user = await redis.hgetall("user:1") // { name: "Ben", role: "admin" }
```

### Side-by-side with up-vector

Both services can share the same Redis Stack instance:

```yaml
services:
  redis-stack:
    image: redis/redis-stack-server:latest

  up-redis:
    build: ./up-redis
    environment:
      UPREDIS_TOKEN: ${UPREDIS_TOKEN}
      UPREDIS_REDIS_URL: redis://redis-stack:6379

  up-vector:
    build: ./up-vector
    environment:
      UPVECTOR_TOKEN: ${UPVECTOR_TOKEN}
      UPVECTOR_REDIS_URL: redis://redis-stack:6379
```

---

## References

- [Upstash Redis REST API docs](https://upstash.com/docs/redis/features/restapi)
- [@upstash/redis SDK source](https://github.com/upstash/redis-js)
- [SRH — serverless-redis-http](https://github.com/hiett/serverless-redis-http) (the project we're modernizing)
- [Bun.redis documentation](https://bun.sh/docs/api/redis)
- [RESP3 specification](https://github.com/redis/redis-specifications/blob/master/protocol/RESP3.md)
- [up-vector](https://github.com/Coriou/up-vector) (sibling project, same architecture)
