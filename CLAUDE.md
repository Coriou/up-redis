# up-redis

Self-hosted, Upstash Redis-compatible HTTP proxy backed by any Redis 6+ server.
Drop-in replacement for `@upstash/redis` — point the SDK at your own server instead of Upstash's cloud.

Modern rewrite of [SRH](https://github.com/hiett/serverless-redis-http), sibling project to [up-vector](https://github.com/Coriou/up-vector).

## Tech Stack

- **Runtime:** Bun 1.3.6+ floor (native TypeScript); CI and the Docker image pin 1.3.14
- **HTTP:** Hono v4
- **Redis client:** `Bun.redis` (native, RESP3, auto-pipelining, zero-dep)
- **Validation:** Zod v4
- **Linting/Format:** Biome v2
- **Testing:** `bun test` (built-in, Jest-compatible)
- **Container:** Docker (oven/bun:alpine) + selectable backend (default `redis:8-alpine`, via `UPREDIS_REDIS_IMAGE`; Redis 6+ floor unchanged)

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

- **Response envelope:** `{ "result": <data> }` on success, `{ "error": "<msg>" }` on error (HTTP 400). `Upstash-Response-Format: resp2` (the SDK's binary RESP2 wire format) is rejected with `400` — up-redis only speaks the JSON envelope.
- **Auth:** Bearer token via `Authorization` header, validated against `UPREDIS_TOKEN` env var. The `?_token=` query-param form is also accepted unless `UPREDIS_ALLOW_TOKEN_QUERY_PARAM=false`. A startup warning fires for weak/placeholder token values.
- **Command argument types:** `parseCommandArray` requires every argument to be a `string` or `number` — objects, `null`, and booleans are rejected with `400` rather than coerced to garbage like `"[object Object]"`.
- **Connection model:** Single shared Bun.redis connection with auto-pipelining for commands/pipelines, dedicated connection per transaction (MULTI/EXEC) and per PubSub subscription via `createDedicatedConnection()` (`new RedisClient` with `autoReconnect: false`) to prevent interleaving and to make connection drops loud rather than silent (a reconnect would lose subscriber/transaction state)
- **RESP3 → RESP2 translation:** Bun.redis speaks RESP3 but the SDK expects RESP2-compatible JSON — normalize Maps to flat arrays, Booleans to 0/1, recursively
- **Base64 encoding:** When `Upstash-Encoding: base64` header present, all string values in responses are base64-encoded (numbers, null pass through)

### Endpoints

| Endpoint                        | Purpose                                                 |
| ------------------------------- | ------------------------------------------------------- |
| `POST /`                        | Single Redis command (JSON array body)                  |
| `GET\|POST\|PUT /:command/:arg...` | Path-style command (args from path, body appended)   |
| `POST /pipeline`                | Batch commands (2D JSON array body)                     |
| `POST /multi-exec`              | Transaction (2D JSON array body, wrapped in MULTI/EXEC) |
| `GET\|POST /subscribe/:channel` | PubSub subscription (SSE stream, Upstash-compatible)    |
| `GET\|POST /psubscribe/:pattern` | Pattern PubSub subscription (SSE stream)               |
| `POST /publish/:channel/:message` | PubSub publish shortcut                               |
| `GET /`                         | Health check (SRH compat: welcome message)              |
| `GET /health`                   | Rich health check (Redis probe + shutdown state)        |
| `GET /livez`                    | Liveness probe — does NOT check Redis (no auth)         |
| `GET /readyz`                   | Kubernetes-style readiness alias for `/health`          |
| `GET /metrics`                  | Prometheus metrics (opt-in)                             |

### Blocked Commands (shared connection safety)

`POST /`, `POST /pipeline`, and `POST /multi-exec` reject commands that would corrupt the shared Bun.redis connection or DoS the proxy. The check lives in `src/commands.ts:checkBlockedCommand(command, args?, options?)` — the `options` arg threads the config (dangerous-command allowance + extra blocked commands) into the gate.

**Connection-state corruption:**
- Subscriber mode: `SUBSCRIBE`, `PSUBSCRIBE`, `SSUBSCRIBE` (+ `UNSUBSCRIBE` variants) — use `/subscribe/:channel`
- Monitor mode: `MONITOR`
- Transaction state: `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH` — use `/multi-exec`
- Database switching: `SELECT`
- Authentication/protocol/routing state: `AUTH`, `HELLO`, `READONLY`, `READWRITE`, `ASKING`
- Connection termination: `QUIT`, `RESET`

**Blocking commands** (would hold the shared connection and starve other requests):
- List/zset blocking pops: `BLPOP`, `BRPOP`, `BRPOPLPUSH`, `BLMOVE`, `BLMPOP`, `BZPOPMIN`, `BZPOPMAX`, `BZMPOP`
- Blocking stream reads: `XREAD BLOCK`, `XREADGROUP BLOCK` (detection only inspects the options section before `STREAMS`, so a stream/group/consumer named `BLOCK` is allowed)
- Replication wait: `WAIT`, `WAITAOF`

**Server admin / DoS vectors:**
- `SHUTDOWN` — terminates Redis
- `REPLICAOF` / `SLAVEOF` — reconfigures replication
- `FAILOVER` — manual failover
- `DEBUG` — DEBUG SLEEP blocks the connection, DEBUG SEGFAULT crashes Redis
- `CLIENT KILL` — could kill the proxy's own shared connection
- `CLIENT PAUSE` / `CLIENT UNPAUSE` — server-wide pause
- `CLIENT REPLY` — corrupts protocol on shared connection
- `ACL`, `MODULE`, persistence/replication controls, and mutating `CONFIG` / `FUNCTION` / `SCRIPT` / `LATENCY` / `MEMORY` / `SLOWLOG` operations
- Mutating `CLIENT` operations and all non-read-only `CLUSTER` subcommands

**Dangerous by default (configurable):**
- `KEYS` — O(N), blocks the shared connection while it scans the whole keyspace
- `FLUSHALL` / `FLUSHDB` — wipe the keyspace
- `SWAPDB` — swaps two databases

These are blocked by default but re-enabled by setting `UPREDIS_ALLOW_DANGEROUS_COMMANDS=true`. Additional commands can be blocked via the comma-separated, case-insensitive `UPREDIS_BLOCKED_COMMANDS` (e.g. `DEBUG,KEYS`).

Mixed admin command families use explicit read-only allowlists, so unknown subcommands fail closed after a Redis upgrade. `SCRIPT EXISTS` and `SCRIPT LOAD` remain available for `EVALSHA` compatibility. All blocked commands return `400` with an explanatory error message; transaction and pubsub commands include a hint pointing at the correct endpoint.

**Scripting bypasses this gate (by design):** `EVAL`/`EVALSHA`/`FCALL` can invoke
blocked commands (e.g. `FLUSHALL`, `KEYS`) inside Lua via `redis.call()`. The
gate is an accident-prevention net for direct commands, not a security boundary —
a token holder can reach blocked functionality through scripting unless the
operator adds scripting commands to `UPREDIS_BLOCKED_COMMANDS` (README §Security
documents this and the mitigation).

### RESP3 → JSON Translation (critical)

```
RESP3 Boolean  → integer (true → 1, false → 0)
RESP3 Map      → flat alternating array ({a: 1, b: 2} → ["a", 1, "b", 2])
RESP3 Array    → recursively normalize each element
RESP3 Set      → array (Bun.redis already does this)
Non-finite Number → Redis string form (Infinity → "inf", -Infinity → "-inf", NaN → "nan")
String/Number/Null → pass through
```

Non-finite handling matters because Bun.redis returns JS `Infinity` for e.g. `ZSCORE` of an infinite score, and `JSON.stringify(Infinity)` would otherwise silently become `null`. `normalizeResp3` emits the Redis string forms (`"inf"`/`"-inf"`/`"nan"`) that real Redis and Upstash return.

The enumerated map-returning command list below is illustrative — `normalizeResp3` is generic and handles any object, so commands like `HGETALL`, `CONFIG GET`, `XRANGE`, `XREVRANGE`, `XREAD`, `CLIENT INFO`, `COMMAND INFO`, and hash-field-TTL commands (`HEXPIRE`, `HTTL`) are all normalized uniformly without command-specific logic. `normalizeResp3` also caps recursion depth (64) so a pathologically nested reply (e.g. from `EVAL`) throws instead of overflowing the stack.

**WITHSCORES/WITHVALUES flattening (`src/translate/score-pairs.ts`):** RESP3 returns `ZRANGE … WITHSCORES`, `ZPOPMIN/MAX` (with count), `ZRANDMEMBER/ZUNION/ZINTER/ZDIFF … WITHSCORES`, and `HRANDFIELD … WITHVALUES` as an array of `[member, score]` 2-tuples, but the SDK and Upstash REST expect a single flat `[member, score, …]` array (their deserializers step through the reply in twos). `normalizeResp3` can't tell pair-lists from legitimately-nested replies (`GEOPOS` → `[[lon,lat]]`, `XRANGE` → `[[id,[f,v]]]`), so `flattenScorePairs(command, args, value)` flattens **only** for that specific command+option set. It runs after `normalizeResp3` on the single-command, pipeline, and multi-exec paths.

### Base64 Encoding Rules

When `Upstash-Encoding: base64` header is present:

- **Strings:** base64-encode (including "QUEUED")
- **Literal "OK":** depth-aware. The SDK's `decode()` passes "OK" through unencoded only at EVEN nesting depths (top-level scalar + elements reached via its recursive `decode()`); at ODD depths (direct array children) it base64-decodes unconditionally. So `encodeResult(value, depth)` leaves "OK" literal only at even depths and encodes it at odd depths — otherwise a stored "OK" read back via `LRANGE`/`MGET`/etc. decodes to garbage ("8").
- **Numbers:** never encode (must be JSON number)
- **Null:** never encode (must be JSON null)
- **Arrays:** recursively encode each element (incrementing depth)
- **Error strings:** never encode (lives in `error` field, not `result`)

### Transaction Design (MULTI/EXEC)

Each transaction gets a dedicated Bun.redis connection via `createDedicatedConnection()`:

1. `const tx = await createDedicatedConnection()` — `new RedisClient` with `autoReconnect: false`
2. `await tx.send("MULTI", [])`
3. Queue each command: `await tx.send(cmd, args)` → "QUEUED"
4. `const results = await tx.send("EXEC", [])` → result array
5. `tx.close()` in `finally` block

This prevents the command interleaving bug (SRH issue #25) that occurs when concurrent transactions share a connection. `autoReconnect` is disabled because a silent reconnect mid-transaction would either run queued commands without `MULTI` context (corrupting state) or send them on a fresh connection (silent transaction abort).

### PubSub Design (GET/POST /subscribe/:channel)

Each subscription gets a dedicated Bun.redis connection via `createDedicatedConnection()` (`autoReconnect: false`):

1. Client sends `GET` or `POST /subscribe/my-channel`
2. Server returns SSE response immediately via Hono's `streamSSE()`
3. Async callback creates dedicated connection: `const sub = await createDedicatedConnection()`
4. `await sub.subscribe(channel, listener)` — listener forwards each message as SSE
5. SSE format: `data: subscribe,{channel},{count}\n\n` then `data: message,{channel},{content}\n\n`
6. Blocks via `Promise.race([clientDisconnect, redisClose])` until stream ends
7. `finally` block: unsubscribe + close dedicated connection (idempotent, safe for shutdown)

Active subscriptions are tracked in a `Set` with exported `closeAllSubscriptions()` for graceful shutdown. The timeout middleware does not interfere — `streamSSE()` returns the Response synchronously, so `next()` resolves immediately.

Exact-subscribe buffers any messages that arrive during subscription setup until the subscribe confirmation has been written, so the SDK always receives the `subscribe` confirmation first (via `createConfirmationOrderedBuffer` in `src/translate/pubsub.ts`).

**Pattern subscribe (`GET|POST /psubscribe/:pattern`):** Bun.redis doesn't support `PSUBSCRIBE`, so pattern subscriptions are backed by a hand-rolled RESP client in `src/redis-pattern.ts` (`RawPatternConnection` / `createPatternSubscription`). The SSE streaming, tracking, and graceful-shutdown behavior otherwise mirror exact subscribe.

**Publish shortcut (`POST /publish/:channel/:message`):** publishes `:message` to `:channel` and returns the receiver count, without requiring a command-array body.

## Project Structure

```
src/
  index.ts              # Entry point, Bun.serve + graceful shutdown
  server.ts             # Hono app + middleware registration
  config.ts             # Env var config (Zod validation)
  redis.ts              # Bun.redis client singleton, health probe
  redis-pattern.ts      # Hand-rolled RESP client for PSUBSCRIBE (pattern subscribe)
  commands.ts           # Blocked-command gate (checkBlockedCommand) + parseCommandArray
  logger.ts             # Structured JSON/text logger
  metrics.ts            # Prometheus counters + histograms
  shutdown.ts           # Shutdown state flag (avoids circular dep)
  types.ts              # Shared types
  util/
    timeout.ts          # withTimeout() helper (bounds health/runtime PING)
    slot-limiter.ts     # createSlotLimiter(): synchronous counting cap (subscription TOCTOU-safe)
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
    response.ts         # normalizeResp3(): Map → flat array, Boolean → 0/1 (depth-capped)
    score-pairs.ts      # flattenScorePairs(): RESP3 WITHSCORES/WITHVALUES pairs → RESP2-flat
    encoding.ts         # encodeResult(): recursive, depth-aware base64 encoding
    transaction.ts      # EXEC result shaping (MULTI/EXEC)
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
| `UPREDIS_REDIS_URL`        | `redis://localhost:6379` | No       | Redis connection (any Redis 6+ / Valkey / KeyDB) |
| `UPREDIS_REDIS_IMAGE`      | `redis:8-alpine`         | No       | Bundled backend image for `docker-compose.yml` — compose-only, NOT read by the app (e.g. `redis:7-alpine`, `valkey/valkey:9-alpine`) |
| `UPREDIS_PORT`             | `8080`                   | No       | HTTP listen port                               |
| `UPREDIS_HOST`             | `0.0.0.0`                | No       | HTTP listen host                               |
| `UPREDIS_LOG_LEVEL`        | `info`                   | No       | `debug`, `info`, `warn`, `error`               |
| `UPREDIS_LOG_FORMAT`       | `json`                   | No       | `json` (structured) or `text` (human-readable) |
| `UPREDIS_SHUTDOWN_TIMEOUT` | `30000`                  | No       | Max ms to wait for request drain (min 1000)    |
| `UPREDIS_REQUEST_TIMEOUT`  | `30000`                  | No       | Per-request timeout in ms (`0` = disabled)     |
| `UPREDIS_METRICS`          | `false`                  | No       | Enable Prometheus `/metrics` endpoint          |
| `UPREDIS_MAX_BODY_SIZE`    | `10485760`               | No       | Max request body size in bytes (10MB)          |
| `UPREDIS_MAX_PIPELINE_COMMANDS` | `1000`              | No       | Max commands per `/pipeline` or `/multi-exec` request |
| `UPREDIS_MAX_SUBSCRIPTIONS` | `10000`                 | No       | Max concurrent SSE `/subscribe/:channel` connections  |
| `UPREDIS_ALLOW_DANGEROUS_COMMANDS` | `false`          | No       | Permit `KEYS`, `FLUSHALL`, `FLUSHDB`, `SWAPDB` (blocked by default) |
| `UPREDIS_BLOCKED_COMMANDS` | (empty)                  | No       | Extra commands to block (comma-separated, case-insensitive)        |
| `UPREDIS_ALLOW_TOKEN_QUERY_PARAM` | `true`            | No       | Accept `?_token=` query-param auth (set `false` to require header) |

## Bun.redis Gotchas

Inherited from up-vector experience — critical for correctness:

- **`Bun.redis` speaks RESP3** — Redis 6+ returns richer types (Map, Boolean, Set) that must be normalized to RESP2-compatible JSON. See `src/translate/response.ts`.
- **`redis.send(command, args)`** is the primary interface — forwards any Redis command as raw strings. This is all we need since we're a proxy.
- **`createDedicatedConnection()`** creates a new connection (`new RedisClient(..., { autoReconnect: false })`) — used for MULTI/EXEC (prevents interleaving) and PubSub subscriptions (subscriber mode). `autoReconnect` is off so connection drops are loud rather than silently losing subscriber/transaction state. Always close in `finally`.
- **`redis.subscribe(channel, listener)`** puts the connection in subscriber mode — only `ping`/`subscribe`/`unsubscribe` allowed. Returns the subscription count. Listener receives `(message: string, channel: string)`.
- **Auto-pipelining** is enabled by default — concurrent `send()` calls are automatically batched over one TCP connection. No connection pool needed.
- **SCAN cursor is a string** — compare with `"0"` not `0`.

## Testing Strategy

570 tests across three tiers:

| Tier                  | Tests | Purpose                                                                                                                                                                           |
| --------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Unit**              | 290   | RESP3 normalization (incl. ±inf/nan + depth cap), withscores/withvalues flattening, base64 encoding (incl. depth-aware "OK"), SSE ordering + backpressure bound, RESP parser (partial reads / malformed / bulk cap), `parseRedisUrl`, subscription slot limiter, arg validation, fail-closed admin command policy, token-strength |
| **Integration**       | 179   | Full HTTP roundtrips against real Redis (commands, pipelines, transactions, PubSub subscribe/publish, stress, edge cases, health, auth, blocked commands) + spawned config-variant servers. Redis 6 skips five hash-field-expiry commands; Redis 7 skips the three Redis-8-only commands. A `/health` preflight in setup.ts fails fast on a stale/disconnected server |
| **SDK Compatibility** | 101   | Real `@upstash/redis` SDK against up-redis (strings, hashes, lists, sets, sorted sets, SCAN, geo, HyperLogLog, Lua scripting, pipelines, transactions, PubSub `Subscriber` class, withscores/withvalues shape, literal-"OK" fidelity) |

Weekly CI (`compat.yml`) runs against `@upstash/redis@latest` every Monday 9 AM UTC and auto-creates GitHub issues on drift.

## Key References

- [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi) — the API we're replicating
- [@upstash/redis SDK](https://github.com/upstash/redis-js) — client SDK + compatibility test target
- [SRH](https://github.com/hiett/serverless-redis-http) — predecessor (Elixir), same concept
- [up-vector](https://github.com/Coriou/up-vector) — sibling project, same architecture patterns

## Maintenance Workflowz

Repeatable multi-agent audit workflows live in [docs/workflowz.md](docs/workflowz.md):
pre-release audit, monthly ecosystem sweep, and advisory triage. CI
(`.github/workflows/`) stays the deterministic backbone — run a workflowz when
judgment work is needed (pre-tag audits, upstream drift review, alert triage).
