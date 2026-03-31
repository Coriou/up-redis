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

docker compose up -d
```

The API is now available at `http://localhost:8080`.

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

# Publish to channel (from another terminal)
curl -X POST http://localhost:8080/ \
  -H "Authorization: Bearer your-token" \
  -H "Content-Type: application/json" \
  -d '["PUBLISH", "my-channel", "hello"]'
# → {"result":1}
```

## API Compatibility

Implements the [Upstash Redis REST API](https://upstash.com/docs/redis/features/restapi), validated by 232 tests including 97 using the real `@upstash/redis` SDK.

| Endpoint | Status |
|----------|--------|
| `POST /` | Supported — single command |
| `POST /pipeline` | Supported — batch execution |
| `POST /multi-exec` | Supported — atomic transactions |
| `GET\|POST /subscribe/:channel` | Supported — PubSub over SSE |
| `GET /` | Supported — health check |
| `GET /health` | Supported — rich health with Redis probe |
| `GET /metrics` | Supported — Prometheus (opt-in) |

All Redis commands are forwarded transparently. up-redis is a proxy — it doesn't interpret commands, so any command your Redis server supports will work.

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
| Docker image | ~100MB | ~50MB (Bun Alpine) |
| Tests | External | 232 built-in (unit + integration + SDK compat) |

### Known Differences from Upstash

| Aspect | Upstash | up-redis |
|--------|---------|----------|
| Read-your-writes | Multi-region sync tokens | Not needed (single-region) |
| UNLINK with 0 keys | Silently succeeds | Redis returns error |
| ZRANGE LIMIT | Works without BYSCORE/BYLEX | Redis requires BYSCORE/BYLEX |
| RedisJSON | Custom response format | Standard Redis Stack format |
| Pub/Sub SSE | `POST /subscribe/{channel}` | Supported — SSE streaming (`GET` or `POST`) |
| Rate limiting | Built-in | Use reverse proxy (nginx, Caddy) |
| Multi-region | Built-in | Single-region by design |

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
- Managed infrastructure with zero ops (truly)

## Configuration

All environment variables are prefixed `UPREDIS_`:

| Variable | Default | Description |
|----------|---------|-------------|
| `UPREDIS_TOKEN` | — | **Required.** Bearer token for API authentication |
| `UPREDIS_REDIS_URL` | `redis://localhost:6379` | Redis connection URL (any Redis 6+, Valkey, KeyDB) |
| `UPREDIS_PORT` | `8080` | HTTP listen port |
| `UPREDIS_HOST` | `0.0.0.0` | HTTP listen host |
| `UPREDIS_LOG_LEVEL` | `info` | Log level: `debug`, `info`, `warn`, `error` |
| `UPREDIS_LOG_FORMAT` | `json` | Log format: `json` (structured) or `text` (human-readable) |
| `UPREDIS_SHUTDOWN_TIMEOUT` | `30000` | Max milliseconds to wait for request drain on shutdown |
| `UPREDIS_REQUEST_TIMEOUT` | `30000` | Per-request timeout in milliseconds (`0` = disabled) |
| `UPREDIS_METRICS` | `false` | Enable Prometheus metrics at `GET /metrics` |

## Health & Monitoring

**Health check** — no auth required:

```bash
# Lightweight probe (used by Docker HEALTHCHECK)
curl http://localhost:8080/
# → 200 "Welcome to up-redis" or 503 "Shutting Down"

# Rich health endpoint with dependency status
curl http://localhost:8080/health
# → {"status":"ok","redis":"connected"}
# → {"status":"degraded","redis":"disconnected"} (503)
# → {"status":"shutting_down","redis":"..."} (503)
```

**Prometheus metrics** — enable with `UPREDIS_METRICS=true`:

```bash
curl http://localhost:8080/metrics
```

Exposes `http_requests_total{method,status}`, `http_request_duration_seconds` histogram, and `upredis_info` gauge.

**Structured logging** — JSON by default (set `UPREDIS_LOG_FORMAT=text` for dev). Includes request IDs (`X-Request-ID`), method, path, status, and duration.

## Architecture

```
@upstash/redis SDK ──HTTP POST──▶ up-redis (Hono/Bun) ──RESP3──▶ Redis 6+
```

- **Runtime:** [Bun](https://bun.sh) — native TypeScript, fastest JS runtime
- **HTTP:** [Hono](https://hono.dev) v4 — lightweight, fast
- **Redis:** Bun.redis (native, zero-dep) — RESP3, auto-pipelining
- **Validation:** [Zod](https://zod.dev) v3 — config validation

Key design decisions: single shared connection with auto-pipelining for commands/pipelines, dedicated connection per MULTI/EXEC transaction (prevents interleaving), dedicated connection per PubSub subscription (SSE streaming), RESP3-to-RESP2 translation layer (Maps→flat arrays, Booleans→0/1), recursive base64 encoding.

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

232 tests across three tiers:

| Tier | Tests | Purpose |
|------|-------|---------|
| **Unit** | 55 | RESP3 normalization, base64 encoding, SSE event formatting |
| **Integration** | 80 | Full HTTP roundtrips against real Redis (commands, pipelines, transactions, PubSub) |
| **SDK Compatibility** | 97 | Real `@upstash/redis` SDK against up-redis (including `Subscriber` class) |

```bash
bun test                       # All tests
bun test tests/unit            # Unit only (no Redis needed)
bun test tests/integration     # Integration (needs Redis + server running)
bun test tests/compatibility   # SDK compat (needs Redis + server running)
```

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

## License

MIT
