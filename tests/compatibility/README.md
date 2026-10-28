# SDK Compatibility Tests

These tests use the real `@upstash/redis` SDK pointed at up-redis to verify drop-in compatibility.
The checked-in dependency is kept current with npm latest during maintenance; the suite currently covers `@upstash/redis` 1.40 behavior, including split read/write auto-pipeline batches and `subscribe`/`psubscribe` SSE handling.

## Running

```bash
# Start Redis + up-redis, then:
bun test tests/compatibility
UPREDIS_TEST_ENCODING=base64 bun test tests/compatibility
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPREDIS_TEST_URL` | `http://localhost:8080` | up-redis server URL |
| `UPREDIS_TOKEN` | `test-token-123` | Bearer token |

The default run uses the SDK default encoding (JSON in 1.40). The second run explicitly exercises base64, including legacy literal-"OK" decoding. New SDK helpers such as AR*, VECTOR.*, and search require matching backend capabilities; the suite does not imply support for every SDK helper on Redis 6+.

## Known Exclusions

These are documented differences between Upstash and standard Redis:

- **BOM-prefixed plain strings with base64** — the SDK TextDecoder removes the leading BOM; the proxy preserves its bytes. The SDK default JSON encoding preserves it.
- **RedisJSON commands** — Upstash has custom JSON response formats that differ from Redis Stack
- **Multi-region read-your-writes waiting** — up-redis echoes a stable sync token for SDK compatibility, but does not need cross-region waiting because it talks to one Redis backend
- **UNLINK with 0 keys** — Upstash silently succeeds, Redis returns an error
- **ZRANGE with LIMIT without BYSCORE/BYLEX** — Upstash allows it, Redis requires the flag

## Weekly CI

The `compat.yml` workflow runs against `@upstash/redis@latest` every Monday and auto-creates a GitHub issue if tests fail, catching SDK drift early.
