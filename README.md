# up-redis

[![CI](https://github.com/Coriou/up-redis/actions/workflows/test.yml/badge.svg)](https://github.com/Coriou/up-redis/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Bun](https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun)](https://bun.sh)

Self-hosted [Upstash Redis](https://upstash.com/docs/redis/overall/getstarted)-compatible HTTP proxy backed by any standard Redis 6+ server.

Drop-in replacement for `@upstash/redis` — point the SDK at your own server instead of Upstash's cloud. Modern TypeScript rewrite of [SRH](https://github.com/hiett/serverless-redis-http) (serverless-redis-http), sibling project to [up-vector](https://github.com/Coriou/up-vector).

## Quick Start

```bash
git clone https://github.com/Coriou/up-redis.git
cd up-redis
cp .env.example .env
# Edit .env — set UPREDIS_TOKEN to a secret of your choice

# Local development — exposes port 8080 to the host
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

The API is now available at `http://localhost:8080`.

> **Note:** The base `docker-compose.yml` uses Docker `expose` rather than `ports` to keep the service internal-only — this is intentional for deployment behind a reverse proxy (Coolify, Traefik, nginx, etc.). Use the dev overlay above to publish the port to localhost. For a production deployment behind your own reverse proxy, just `docker compose up -d`.

## Usage with @upstash/redis

Just swap the URL and token — everything else stays the same:

```typescript
import { Redis } from "@upstash/redis"

const redis = new Redis({
  url: "http://localhost:8080",  // ← your up-redis instance
  token: "your-token-here",
})

// Works exactly like Upstash
await redis.set("greeting", "Hello, World!")
const value = await redis.get("greeting") // "Hello, World!"

await redis.hset("user:1", { name: "Ben", role: "admin" })
const user = await redis.hgetall("user:1") // { name: "Ben", role: "admin" }

// Pipelines
const pipe = redis.pipeline()
pipe.set("a", 1)
pipe.incr("a")
pipe.get("a")
const results = await pipe.exec() // ["OK", 2, 2]

// Transactions
const tx = redis.multi()
tx.set("counter", 0)
tx.incr("counter")
const txResults = await tx.exec() // ["OK", 1]

// PubSub
const sub = redis.subscribe(["my-channel"])
sub.on("message", ({ channel, message }) => {
  console.log(`${channel}: ${message}`)
})
await redis.publish("my-channel", "hello") // 1 (subscriber count)
await sub.unsubscribe()
```

## REST API

Works with any language — just send HTTP requests:

```bash
# Single command
curl -X POST http://localhost:8080/ \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '["SET", "mykey", "myvalue"]'
# → {"result":"OK"}

# Path-style command
curl http://localhost:8080/set/mykey/myvalue \
  -H "Authorization: Bearer your-token"
# → {"result":"OK"}

# Pipeline (batch)
curl -X POST http://localhost:8080/pipeline \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '[["SET","k1","v1"],["GET","k1"],["DEL","k1"]]'
# → [{"result":"OK"},{"result":"v1"},{"result":1}]

# Transaction (atomic)
curl -X POST http://localhost:8080/multi-exec \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '[["SET","k1","v1"],["INCR","counter"]]'
# → [{"result":"OK"},{"result":1}]

# Subscribe to channel (SSE stream — stays open)
curl -N http://localhost:8080/subscribe/my-channel \
  -H "Authorization: Bearer your-token"
# → data: subscribe,my-channel,1
# → data: message,my-channel,hello    (when someone publishes)

# Pattern subscribe (SSE stream — stays open)
curl -N 'http://localhost:8080/psubscribe/news:*' \
  -H "Authorization: Bearer your-token"
# → data: psubscribe,news:*,1
# → data: pmessage,news:*,news:1,"hello"    (when a matching channel publishes)

# Publish to channel (from another terminal)
curl -X POST http://localhost:8080/publish/my-channel/hello \
  -H "Authorization: Bearer your-token"
# → {"result":1}

# Or publish with a raw Redis command
curl -X POST http://localhost:8080/ \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '["PUBLISH", "my-channel", "hello"]'
# → {"result":1}
```

## API Compatibility

Implements the [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi), validated by 570 tests including 101 using the real `@upstash/redis` SDK.

| Endpoint | Status |
|----------|--------|
| `POST /` | Supported — single command |
| `GET\|POST\|PUT /:command/:arg...` | Supported — path-style REST commands |
| `POST /pipeline` | Supported — batch execution |
| `POST /multi-exec` | Supported — atomic transactions |
| `GET\|POST /subscribe/:channel` | Supported — PubSub over SSE |
| `GET\|POST /psubscribe/:pattern` | Supported — pattern PubSub over SSE |
| `POST /publish/:channel/:message` | Supported — PubSub publish shortcut |
| `GET /` | Supported — health check (welcome message) |
| `GET /health` | Supported — rich health with Redis probe (readiness) |
| `GET /livez` | Supported — liveness probe (does NOT check Redis) |
| `GET /readyz` | Supported — Kubernetes-style readiness alias for /health |
| `GET /metrics` | Supported — Prometheus (opt-in) |

Authentication accepts `Authorization: Bearer <token>` and Upstash's `_token=<token>` query parameter. If both are present, the Authorization header takes precedence. Query-param auth can be disabled with `UPREDIS_ALLOW_TOKEN_QUERY_PARAM=false` to avoid leaking the token into reverse-proxy access logs (see [Security](#security)).

All Redis commands are forwarded transparently. up-redis is a proxy — it doesn't interpret commands, so any command your Redis server supports will work, with these exceptions blocked at the proxy layer to protect the shared connection:

- **Connection-state-changing:** `SUBSCRIBE`/`PSUBSCRIBE`/`SSUBSCRIBE` (use `/subscribe/:channel`), `MONITOR`, `MULTI`/`EXEC`/`DISCARD`/`WATCH`/`UNWATCH` (use `/multi-exec`), `AUTH`, `HELLO`, `READONLY`/`READWRITE`, `ASKING`, `SELECT`, `QUIT`, `RESET`
- **Blocking commands:** `BLPOP`, `BRPOP`, `BRPOPLPUSH`, `BLMOVE`, `BLMPOP`, `BZPOPMIN`, `BZPOPMAX`, `BZMPOP`, `WAIT`, `WAITAOF`, `XREAD BLOCK`, `XREADGROUP BLOCK` — these would hold the shared connection and starve every other request
- **Server admin / DoS vectors:** `SHUTDOWN`, replication/persistence controls (`REPLICAOF`, `FAILOVER`, `MIGRATE`, `SAVE`, `BGSAVE`, etc.), `DEBUG`, `ACL`, `MODULE`, mutating `CONFIG`/`FUNCTION`/`SCRIPT`/`LATENCY`/`MEMORY`/`SLOWLOG` subcommands, mutating `CLIENT` subcommands, and all non-read-only `CLUSTER` subcommands
- **Dangerous by default (configurable):** `KEYS` (O(N) — scans the whole keyspace on the shared connection), `FLUSHALL`, `FLUSHDB`, `SWAPDB` are blocked by default. Set `UPREDIS_ALLOW_DANGEROUS_COMMANDS=true` to permit them. Add your own with `UPREDIS_BLOCKED_COMMANDS`.

Requests are also rejected with `400` if a command argument isn't a string or number (e.g. an object or `null`, which would otherwise be silently coerced to garbage like `"[object Object]"`), or if the `Upstash-Response-Format: resp2` header is sent (up-redis only speaks the JSON envelope).

Read-only `CLIENT`, `CLUSTER`, `CONFIG`, `FUNCTION`, `LATENCY`, `MEMORY`, and `SLOWLOG` subcommands remain available through explicit allowlists. Unknown subcommands in these mixed admin families fail closed after a Redis upgrade. `SCRIPT EXISTS` and `SCRIPT LOAD` remain available for `EVALSHA` compatibility.

### Why not SRH?

| Aspect | SRH (Elixir) | up-redis (Bun/Hono) |
|--------|-------------|---------------------|
| Language | Elixir | TypeScript — same as your app |
| Health checks | None | Rich `/health` with Redis probe + shutdown state |
| Logging | None | Structured JSON/text logging with levels |
| Metrics | None | Prometheus counters + histograms |
| Graceful shutdown | None | Request draining, configurable timeout |
| Request timeout | None | Per-request timeout middleware |
| Concurrent MULTI/EXEC | Broken ([#25](https://github.com/hiett/serverless-redis-http/issues/25)) | Correct — dedicated connection per transaction |
| PubSub (SUBSCRIBE) | Not supported | SSE streaming, Upstash-compatible |
| Tests | External | 570 built-in (unit + integration + SDK compat) |

### Known Differences from Upstash

| Aspect | Upstash | up-redis |
|--------|---------|----------|
| Read-your-writes | Multi-region sync tokens | Stable token echoed; single-region consistency comes from Redis |
| UNLINK with 0 keys | Silently succeeds | Redis returns error |
| ZRANGE LIMIT | Works without BYSCORE/BYLEX | Redis requires BYSCORE/BYLEX |
| RedisJSON | Custom response format | Standard Redis Stack format |
| PUNSUBSCRIBE/UNSUBSCRIBE REST endpoints | Stream command endpoints | SDK `unsubscribe()` aborts the SSE stream; direct endpoints are not exposed |
| MONITOR SSE | `POST /monitor` | Not supported; use `redis-cli monitor` directly |
| RESP2 response format | `Upstash-Response-Format: resp2` | Rejected with `400` — up-redis only speaks the JSON envelope (the SDK's default) |
| Rate limiting | Built-in | Use reverse proxy (nginx, Caddy) |
| Multi-region | Built-in | Single-region by design |
| Binary / non-UTF-8 values | Byte-exact via base64 | `Bun.redis` decodes bulk strings as UTF-8, so values that aren't valid UTF-8 (e.g. raw gzip/protobuf/encrypted bytes written by another client) are **not** byte-exact, even in base64 mode. Store text or base64-encode binary yourself. |
| Integers above 2^53 | Returned as JSON strings (full precision) | Returned as JS numbers — counters beyond `Number.MAX_SAFE_INTEGER` (~9×10¹⁵) lose precision |
| Lua scripting (`EVAL`) | Allowed | Allowed, but runs arbitrary commands (incl. the dangerous-by-default ones) and a tight loop can block the shared connection — lock down via `UPREDIS_BLOCKED_COMMANDS` (see Security) if untrusted clients hold a token |

### Versioning & SDK compatibility

up-redis tracks the current `@upstash/redis` SDK (pinned to `1.38.x` in this repo) and the documented Upstash REST contract. A weekly CI job runs the full SDK compatibility suite against `@upstash/redis@latest` and opens an issue automatically on any drift, so incompatibilities surface quickly. Any standard Redis 6+ server works as the backend; module commands (RedisJSON `JSON.*`, Search `FT.*`) are passed through transparently but only work if your Redis has the corresponding module loaded.

up-redis itself follows [Semantic Versioning](https://semver.org/). Changes are recorded in [CHANGELOG.md](./CHANGELOG.md), and pushing a `v*` git tag builds and publishes the container image to `ghcr.io/coriou/up-redis` (semver + `latest` tags) via the release workflow. Pin a specific tag in production rather than tracking `latest`.

Periodic SOTA maintenance (SDK pin vs `@latest`, in-stack patch bumps, three-tier matrix, docs/count reconcile, patch release only when runtime/deps/CI change) is summarized under each CHANGELOG release’s **Maintenance verification** block — start there for the next refresh.

## When to Use This

**Good fit if you:**
- Want a self-hosted Redis REST proxy with zero vendor lock-in
- Use the `@upstash/redis` SDK and want to develop/test locally
- Need production infrastructure (health checks, logging, metrics, graceful shutdown)
- Want correct MULTI/EXEC under concurrent load (SRH's bug #25)

**Use Upstash Cloud instead if you need:**
- Multi-region replication with read-your-writes consistency
- Built-in rate limiting and access control
- Managed infrastructure with zero ops

## Configuration

All environment variables are prefixed `UPREDIS_`:

| Variable | Default | Description |
|----------|---------|-------------|
| `UPREDIS_TOKEN` | — | **Required.** Bearer token for API authentication |
| `UPREDIS_REDIS_URL` | `redis://localhost:6379` | Redis connection URL — `redis://`, `rediss://` (TLS), `valkey://`, `valkeys://` (any Redis 6+, Valkey, KeyDB) |
| `UPREDIS_PORT` | `8080` | HTTP listen port |
| `UPREDIS_HOST` | `0.0.0.0` | HTTP listen host |
| `UPREDIS_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `UPREDIS_LOG_FORMAT` | `json` | Log format: `json` (structured) or `text` (human-readable) |
| `UPREDIS_SHUTDOWN_TIMEOUT` | `30000` | Max milliseconds to wait for request drain on shutdown (min 1000) |
| `UPREDIS_REQUEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds (`0` = disabled) |
| `UPREDIS_MAX_BODY_SIZE` | `10485760` | Max request body size in bytes (10MB) |
| `UPREDIS_MAX_PIPELINE_COMMANDS` | `1000` | Max commands per `/pipeline` or `/multi-exec` request |
| `UPREDIS_MAX_SUBSCRIPTIONS` | `10000` | Max concurrent SSE `/subscribe/:channel` connections (each holds a dedicated Redis connection) |
| `UPREDIS_METRICS` | `false` | Enable Prometheus metrics at `GET /metrics` |
| `UPREDIS_ALLOW_DANGEROUS_COMMANDS` | `false` | Permit `KEYS`, `FLUSHALL`, `FLUSHDB`, `SWAPDB` (blocked by default — they can block the shared connection or destroy data) |
| `UPREDIS_BLOCKED_COMMANDS` | — | Extra commands to block, comma-separated and case-insensitive (e.g. `DEBUG,KEYS`) |
| `UPREDIS_ALLOW_TOKEN_QUERY_PARAM` | `true` | Allow `?_token=` query-param auth. Set `false` to require the `Authorization` header (avoids leaking the token into proxy logs) |

## Security

up-redis is designed to run behind a reverse proxy (Coolify, Traefik, nginx, Caddy) on a private network:

- **Transport:** up-redis serves plain HTTP. **Terminate TLS at your reverse proxy** — don't expose the port directly to the internet. The production `docker-compose.yml` uses Docker `expose` (network-internal) rather than `ports` for exactly this reason.
- **Authentication:** the bearer token is compared in constant time (SHA-256 + `timingSafeEqual`, which also hides the token length). A startup warning fires if `UPREDIS_TOKEN` is short, low-entropy, or a known placeholder — use a long random secret, e.g. `openssl rand -hex 32`.
- **Token in URLs:** the `?_token=` query parameter (Upstash compat) is convenient but leaks the secret into reverse-proxy/access logs and browser history. Prefer the `Authorization` header, and set `UPREDIS_ALLOW_TOKEN_QUERY_PARAM=false` to reject query-param auth entirely.
- **`/metrics` is unauthenticated** (so Prometheus can scrape it). Only enable it (`UPREDIS_METRICS=true`) when the port is reachable solely by your monitoring stack, or restrict `/metrics` at the reverse proxy.
- **Command surface:** destructive/DoS-prone commands (`KEYS`, `FLUSHALL`, `FLUSHDB`, `SWAPDB`) are blocked by default; harden further with `UPREDIS_BLOCKED_COMMANDS`. These blocks are an accident-prevention net, **not a security boundary** — Lua scripting can invoke blocked commands (see below), so treat anyone holding a token as able to run arbitrary Redis commands. For defense in depth, also restrict commands with [Redis ACLs](https://redis.io/docs/latest/operate/oss_and_stack/management/security/acl/) on the backing server.
- **Lua scripting:** `EVAL`/`EVALSHA`/`FCALL`/`FUNCTION`/`SCRIPT` stay enabled by default for drop-in SDK compatibility (`redis.eval()` is a first-class SDK method). But a script can call any command — including the dangerous-by-default ones — and a tight loop can busy the shared connection. If untrusted clients can obtain a token, block scripting:

  ```bash
  UPREDIS_BLOCKED_COMMANDS=EVAL,EVALSHA,EVAL_RO,EVALSHA_RO,FCALL,FCALL_RO,FUNCTION,SCRIPT
  ```
- **Resource limits:** request body size (`UPREDIS_MAX_BODY_SIZE`), pipeline/transaction length (`UPREDIS_MAX_PIPELINE_COMMANDS`), and concurrent SSE subscriptions (`UPREDIS_MAX_SUBSCRIPTIONS`) are all bounded to limit abuse of the shared connection.

## Health & Monitoring

**Health check** — no auth required:

```bash
# Lightweight probe (used by Docker HEALTHCHECK, SRH-compatible)
curl http://localhost:8080/
# → 200 "Welcome to up-redis" or 503 "Shutting Down"

# Rich readiness endpoint — checks Redis connectivity
curl http://localhost:8080/health
# → {"status":"ok","redis":"connected"}
# → {"status":"degraded","redis":"disconnected"} (503)
# → {"status":"shutting_down","redis":"..."} (503)

# Liveness probe — does NOT check Redis (use this for Kubernetes livenessProbe)
curl http://localhost:8080/livez
# → {"status":"ok"} or {"status":"shutting_down"} (503)

# Kubernetes-style readiness alias for /health
curl http://localhost:8080/readyz
# → {"status":"ready","redis":"connected"} or {"status":"not_ready",...} (503)
```

**Liveness vs readiness:** `/livez` returns 200 as long as the process can respond. `/health` and `/readyz` return 503 when Redis is unreachable. Configure Kubernetes `livenessProbe` against `/livez` and `readinessProbe` against `/health` so a transient Redis outage doesn't cause unnecessary pod restarts:

```yaml
livenessProbe:
  httpGet:
    path: /livez
    port: 8080
  periodSeconds: 10
readinessProbe:
  httpGet:
    path: /health
    port: 8080
  periodSeconds: 10
```

**Prometheus metrics** — enable with `UPREDIS_METRICS=true`:

```bash
curl http://localhost:8080/metrics
```

Exposes `http_requests_total{method,status}`, `http_request_duration_seconds` histogram, and `upredis_info` gauge.

**Structured logging** — JSON by default (set `UPREDIS_LOG_FORMAT=text` for dev). Includes request IDs (`X-Request-ID`), method, path, status, and duration.

## Troubleshooting

**Every command returns `{"error":"Connection has failed"}` (HTTP 400), but `GET /` is `200`.**
The process is up but its Redis connection is down. `GET /` is intentionally Redis-independent (it's the SRH-compatible liveness probe); check `GET /health` — it returns `503` with `{"redis":"disconnected"}` when the backend is unreachable. Verify `UPREDIS_REDIS_URL`, that Redis is actually reachable from the proxy, and (for managed/TLS backends) that you used a `rediss://` URL. Restart the proxy once Redis is back. (This is also why the integration test suite runs a `/health` preflight — a stale dev server in this state otherwise makes every test fail with opaque 400s.)

**`401 Unauthorized` on every request.** The bearer token doesn't match `UPREDIS_TOKEN`. If you rely on `?_token=`, confirm `UPREDIS_ALLOW_TOKEN_QUERY_PARAM` isn't set to `false`. Prefer the `Authorization: Bearer <token>` header.

**`400` with "is not allowed" for `KEYS`/`FLUSHALL`/`FLUSHDB`/`SWAPDB`.** These are blocked by default — set `UPREDIS_ALLOW_DANGEROUS_COMMANDS=true` to permit them, or use a scoped command (e.g. `SCAN` instead of `KEYS`).

**`400` "Unsupported Upstash-Response-Format".** up-redis only speaks the JSON envelope; it rejects the SDK's binary `resp2` wire format. Don't set `Upstash-Response-Format: resp2` (the SDK doesn't by default).

**A sorted-set value read back looks wrong / a stored `"OK"` is mangled.** These were bugs fixed in this release (RESP3 withscores nesting and base64 `"OK"` corruption) — update to the latest build.

## Architecture

```
@upstash/redis SDK ──HTTP POST──▶ up-redis (Hono/Bun) ──RESP3──▶ Redis 6+
```

- **Runtime:** [Bun](https://bun.sh) — native TypeScript, fastest JS runtime
- **HTTP:** [Hono](https://hono.dev) v4 — lightweight, fast
- **Redis:** Bun.redis (native, zero-dep) — RESP3, auto-pipelining
- **Validation:** [Zod](https://zod.dev) v4 — config validation

Key design decisions: single shared connection with auto-pipelining for commands/pipelines, dedicated connection per MULTI/EXEC transaction (prevents interleaving), dedicated connection per PubSub subscription (SSE streaming), RESP3-to-RESP2 translation layer (Maps→flat arrays, Booleans→0/1), recursive base64 encoding with literal `OK` preserved per Upstash REST docs.

See [PLAN.md](./PLAN.md) for full architecture details.

## Development

```bash
bun install              # Install dependencies
bun run dev              # Dev server with --watch
bun run build            # Bundle to dist/index.js
bun run lint             # Biome check
bun run lint:fix         # Biome auto-fix
bun run typecheck        # TypeScript check
```

### Testing

570 tests across three tiers:

| Tier | Tests | Purpose |
|------|-------|---------|
| **Unit** | 290 | RESP3 normalization (incl. ±inf/nan + depth cap), withscores flattening, base64 encoding (incl. depth-aware "OK"), SSE event ordering + backpressure bound, RESP parser (partial reads / malformed / bulk cap), subscription slot limiter, fail-closed admin command policy, arg validation, token strength |
| **Integration** | 179 | Full HTTP roundtrips against real Redis (commands, pipelines, transactions, PubSub, auth, health, blocked commands) plus config-variant servers (metrics, subscription cap → 503, dangerous-command + token-query toggles); Redis 6 skips five hash-field-expiry commands, Redis 7 skips the three Redis-8-only commands |
| **SDK Compatibility** | 101 | Real `@upstash/redis` SDK against up-redis (including `Subscriber` class, sync-token handling, withscores/withvalues shape, literal-"OK" fidelity, and SDK 1.38 auto-pipeline behavior) |

```bash
bun test                       # All tests
bun test tests/unit            # Unit only (no Redis needed)
bun test tests/integration     # Integration (needs Redis + server running)
bun test tests/compatibility   # SDK compat (needs Redis + server running)
```

> Integration and compatibility tests target an already-running server (default
> `http://localhost:8080`). A preflight asserts `GET /health` reports `redis:connected`
> and fails fast with an actionable message otherwise — a stale server whose Redis
> connection has died answers `GET /` with `200` but every command with `400`, which
> otherwise looks like a mass regression.

The compatibility tests use the actual `@upstash/redis` TypeScript SDK, exercising the exact HTTP paths and response formats that production apps use. A weekly CI job also tests against the latest SDK version to catch incompatibilities early.

## Deployment

### Docker Compose (standalone)

```bash
cp .env.example .env     # Set UPREDIS_TOKEN
docker compose up -d     # Starts up-redis + Redis
```

### Side-by-side with up-vector

Both services can share the same Redis Stack instance — up-redis handles standard Redis commands, up-vector handles vector search:

```yaml
services:
  redis-stack:
    image: redis/redis-stack-server:latest

  up-redis:
    image: ghcr.io/coriou/up-redis:latest
    environment:
      UPREDIS_TOKEN: ${UPREDIS_TOKEN}
      UPREDIS_REDIS_URL: redis://redis-stack:6379

  up-vector:
    image: ghcr.io/coriou/up-vector:latest
    environment:
      UPVECTOR_TOKEN: ${UPVECTOR_TOKEN}
      UPVECTOR_REDIS_URL: redis://redis-stack:6379
```

### Backends

up-redis is backend-agnostic: it forwards Redis commands transparently and speaks the
RESP-version-independent JSON envelope, so it runs against any Redis 6+ server, Valkey, or
KeyDB. The bundled backend in `docker-compose.yml` defaults to **`redis:8-alpine`**; select a
different one by setting `UPREDIS_REDIS_IMAGE` (in `.env` locally, or Coolify's env UI).

| `UPREDIS_REDIS_IMAGE`        | Backend          | Notes                                          |
| ---------------------------- | ---------------- | ---------------------------------------------- |
| `redis:8-alpine` (default)   | Redis 8          | Core + Vector Sets only (no JSON/FT/TS/Bloom)  |
| `redis:6-alpine`             | Redis 6          | Minimum supported version; CI floor gate       |
| `redis:7-alpine`             | Redis 7          | Previous default; CI-gated                     |
| `valkey/valkey:9-alpine`     | Valkey 9         | BSD-licensed; no AGPL; no JSON/FT in base      |
| `redis/redis-stack-server`   | Redis + modules  | Debian, large image; JSON/FT/TS/Bloom          |
| `valkey/valkey-bundle`       | Valkey + modules | BSD; JSON/FT etc.                              |

The **minimum supported backend is still Redis 6+** — bumping the default to Redis 8 is a
convenience, not a floor change. Redis 7 remains a first-class, CI-gated option.

CI runs the integration + SDK-compatibility suites against Redis 6, Redis 7, Redis 8, and Valkey 9
(all required to merge). Module backends (`redis/redis-stack-server`, `valkey/valkey-bundle`) are
**not** CI-tested — the core variants stay module-free.

### Upgrade

The default bundled backend moved from `redis:7-alpine` to `redis:8-alpine`. **This changes the
live data path on an existing production deploy**, so upgrade deliberately:

1. **In-place upgrade is safe.** Redis 8 loads Redis 7.x RDB/AOF (forward-compatible), so the
   existing `redis-data` named volume upgrades in place — no dump/restore needed.
2. **Snapshot first anyway.** Take a backup before pulling the new image (e.g. `BGSAVE`, copy the
   RDB file, or snapshot the volume) — standard upgrade hygiene.
3. **It is fully reversible.** To roll back to Redis 7, set `UPREDIS_REDIS_IMAGE=redis:7-alpine`
   in Coolify's env UI (or `.env`) and redeploy. Reversibility holds because Redis 7 → 8 is
   forward-compatible at the persistence layer for ordinary keyspaces; an operator who has begun
   using Redis-8-only features should not expect a clean downgrade.

The **floor is unchanged**: Redis 6+ is still supported.

### Coolify

- `UPREDIS_REDIS_IMAGE` and `UPREDIS_REDIS_URL` are **runtime** (not Build) variables; they
  auto-surface in Coolify's env UI pre-filled with their defaults.
- For URLs containing `$` (e.g. some managed-provider passwords), flag the **"Is Literal?"**
  toggle so Coolify does not interpolate them.
- Compose `profiles` are not usable on Coolify (bug #6395), and multi-`-f` overrides are not
  supported for app deploys. On Coolify, the external-backend path is to set `UPREDIS_REDIS_URL`
  to your managed endpoint in the env UI — **not** to apply `docker-compose.external.yml`.

### Bring your own backend (external / managed)

To point up-redis at an external or managed Redis/Valkey instead of the bundled container, use the
external override locally:

```bash
docker compose -f docker-compose.yml -f docker-compose.external.yml up -d
# or, equivalently:
COMPOSE_FILE=docker-compose.yml:docker-compose.external.yml docker compose up -d
```

and set `UPREDIS_REDIS_URL` to your endpoint (the override requires it and fails fast if unset).

**TLS:** bare `rediss://` / `valkeys://` verifies out of the box against Bun's bundled CAs for
Upstash, ElastiCache, MemoryDB, Azure Cache, Redis Cloud, and current Aiven. up-redis requires
Bun ≥ 1.3.6 and ships 1.3.14. **Known limitation:** **private-CA backends** (e.g. GCP
Memorystore, a self-hosted private CA) are not yet supported — a `UPREDIS_REDIS_CA_FILE` option is
a planned follow-up.

**Managed-provider foot-guns** (the real failure modes):

- **Non-standard ports** (the #1 foot-gun): Azure Cache `6380` (TLS) / `10000`, GCP `6378`, and
  Redis Cloud / Aiven assign per-instance high ports. (GCP uses `6378` only when in-transit
  encryption is on; `6379` otherwise.) The port is part of `UPREDIS_REDIS_URL` —
  get it from the provider console; don't assume `6379`.
- **Cluster endpoints** (MemoryDB, ElastiCache cluster-mode) and **IAM / Entra auth** cannot be
  expressed in a static URL on a non-cluster client — these are unsupported in this configuration.

### License & modules

up-redis is and remains **MIT**. Redis 8 is **AGPLv3**, but **there is no license contamination**:
up-redis is a separate process that talks to Redis as a network client over a socket (per the FSF
GPL FAQ on aggregation / separate programs), so running up-redis against an AGPL Redis does not
make up-redis AGPL. For organizations that blanket-ban AGPL regardless, **Valkey
(`valkey/valkey:9-alpine`, BSD-3-Clause) is the drop-in escape hatch** — set
`UPREDIS_REDIS_IMAGE=valkey/valkey:9-alpine`.

**Modules:** `JSON.*` / `FT.*` / `TS.*` / Bloom commands only work if your backend has the
corresponding module loaded. The official **`redis:8-alpine` bundles only Vector Sets**
(`VADD`/`VSIM`) in core — **not** JSON / Search / TimeSeries / Bloom. For those, use
`redis/redis-stack-server` (Debian, large) or `valkey/valkey-bundle` via `UPREDIS_REDIS_IMAGE`.
Module backends are not CI-tested.

## License

MIT
