# SDK Compatibility Tests

These tests use the real `@upstash/redis` SDK pointed at up-redis to verify drop-in compatibility.
The checked-in dependency is kept current with npm latest during maintenance; the suite currently covers `@upstash/redis` 1.38 behavior, including split read/write auto-pipeline batches.

## Running

```bash
# Start Redis + up-redis, then:
bun test tests/compatibility
```

## Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `UPREDIS_TEST_URL` | `http://localhost:8080` | up-redis server URL |
| `UPREDIS_TOKEN` | `test-token-123` | Bearer token |

## Known Exclusions

These are documented differences between Upstash and standard Redis:

- **RedisJSON commands** — Upstash has custom JSON response formats that differ from Redis Stack
- **Multi-region read-your-writes waiting** — up-redis echoes a stable sync token for SDK compatibility, but does not need cross-region waiting because it talks to one Redis backend
- **UNLINK with 0 keys** — Upstash silently succeeds, Redis returns an error
- **ZRANGE with LIMIT without BYSCORE/BYLEX** — Upstash allows it, Redis requires the flag

## Weekly CI

The `compat.yml` workflow runs against `@upstash/redis@latest` every Monday and auto-creates a GitHub issue if tests fail, catching SDK drift early.
