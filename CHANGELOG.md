# Changelog

All notable changes to up-redis are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Tagging a `v*` release publishes the container image to `ghcr.io/coriou/up-redis`
(see `.github/workflows/release.yml`).

## [Unreleased]

## [1.0.1] - 2026-07-17

### Changed

- Bumped `hono` to 4.12.30 and `@biomejs/biome` to 2.5.4 (patch maintenance within the frozen stack).
- Aligned `biome.json` `$schema` with the Biome 2.5.4 CLI.

### Maintenance verification (2026-07-17)

- `@upstash/redis` pin verified against npm latest: **1.38.0** (matches; weekly `compat.yml` last five runs success; no open SDK-compat issues).
- Deps after refresh: hono 4.12.30, zod 4.4.3, `@biomejs/biome` 2.5.4, typescript 6.0.3 (TS 7 available on npm — intentionally not jumped).
- Live test counts: **550** (272 unit · 177 integration · 101 SDK compat) — unchanged and re-confirmed green against redis:8.
- Bun pin: **1.3.6** (unchanged across Dockerfile + CI).
- Result: **1.0.1** tagged for lockfile/dep refresh; no proxy behavior changes; Bun.redis hard limits remain documented only.

## [1.0.0] - 2026-06-29

### Fixed

- **SDK compatibility (sorted sets / hashes):** `ZRANGE`/`ZREVRANGE`/`ZRANGEBYSCORE`
  `WITHSCORES`, `ZPOPMIN`/`ZPOPMAX` (with count), `ZRANDMEMBER`/`ZUNION`/`ZINTER`/`ZDIFF`
  `WITHSCORES`, and `HRANDFIELD WITHVALUES` returned RESP3-nested `[[member, score], …]`
  tuples. The `@upstash/redis` SDK and the Upstash REST API expect a single flat
  `[member, score, …]` array, so these calls were silently broken. They are now
  flattened (command-aware; `GEOPOS`/`XRANGE`-style nesting is preserved).
- **base64 data corruption:** the literal string value `"OK"` inside an array (e.g. read
  back via `LRANGE`/`MGET`/`SMEMBERS`) was left unencoded in the default base64 mode, so
  the SDK decoded it to garbage (`"8"`). Encoding is now depth-aware, matching the SDK's
  `decode()` exactly.

### Security

- **Subscription cap TOCTOU:** the `UPREDIS_MAX_SUBSCRIPTIONS` check now reserves a slot
  synchronously, so concurrent `/subscribe`/`/psubscribe` bursts can no longer overshoot
  the dedicated-connection cap.
- **RESP bulk-string cap:** pattern-subscribe now rejects a bulk string larger than 64MB
  instead of buffering it unbounded (DoS guard).
- **Recursion depth cap:** `normalizeResp3` caps nesting at 64 so a pathologically nested
  reply (e.g. from `EVAL`) throws instead of overflowing the stack.
- **SSE backpressure bound:** a slow/stalled subscriber is torn down past a bounded number
  of outstanding writes instead of growing memory unbounded.
- **Process safety nets:** added `uncaughtException` (log + exit) and `unhandledRejection`
  (log) handlers.
- Documented a lock-down recipe for Lua scripting (`EVAL`/`FCALL`/`FUNCTION`/`SCRIPT`),
  which stays enabled by default for drop-in compatibility but can reach dangerous
  commands.
- Fixed a pattern-subscribe socket leak on `AUTH`/`SELECT` handshake failure.

### Changed

- Bumped `hono` to 4.12.27 and `@biomejs/biome` to 2.5.1.

### CI / Tests

- Test suite expanded to 550 (272 unit · 177 integration · 101 SDK compatibility),
  including the previously-untested RESP parser, `parseRedisUrl`, metrics, subscription
  cap (503), and the dangerous-command / token-query-param toggles.
- CI readiness now gates on `/health` (Redis-aware), fails loudly with logs if the server
  dies during startup, and runs unit tests with advisory coverage.
- Added a release workflow that builds and pushes the container image on a `v*` tag.

### Known limitations (documented)

- Non-UTF-8 / binary values are not byte-exact (Bun.redis decodes bulk strings as UTF-8).
- Integers above 2^53 lose precision (returned as JS numbers).
- Module commands (`JSON.*`, `FT.*`) require a module-enabled backend.
