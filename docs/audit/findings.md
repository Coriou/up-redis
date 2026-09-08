<!-- Recovery reconciliation: 2026-09-08. Current statuses below supersede
historical fix proposals; see runs/2026-09-08-recovery.md for validation. -->

# Findings Ledger

Single source of truth for audit findings across all workflowz runs
(`docs/workflowz.md`). One entry per distinct finding, permanent IDs, newest
status at the bottom of each entry. When a run re-encounters an existing
finding, update that entry — never create a duplicate.

Status vocabulary: `open` · `fixed (<sha or PR>)` · `refuted (<date>, reason)`
· `accepted-risk (<note>)`.

Runs:

- **Baseline** — pre-release audit of 2026-08-22 (`6b702ae`), 18 verified
  findings → 16 confirmed, 2 refuted. Report predates the `runs/` directory;
  details were summarized in `docs/workflowz.md` before this ledger existed.
- **2026-09-06** — pre-release audit of `1066418`; report:
  `docs/audit/runs/2026-09-06-prerelease.md`. AUTH-1 fix verified; AUTH-2..7,
  DEPLOY-1..4 re-confirmed open; FIDELITY-2 / CONC-3 refutations stand; 12 new
  findings (GATE-2, CONC-4..7, FIDELITY-3..4, DEPLOY-6..9, AUTH-9); AUTH-8
  severity raised low → medium (folded DEPLOY-5).

---

## GATE-1 — Scripting bypasses the blocked-command gate (policy decision pending)

- Found: 2026-08-22 · Sev: high · Location: `src/commands.ts`
- Status: accepted-risk (README §Security documents the bypass and the operator
  mitigation — `UPREDIS_BLOCKED_COMMANDS` scripting entries. The 2026-09-06
  verdict counted only GATE-2/CONC-6 as blocking highs. Revisit if a policy
  decision to enforce lands.)
- Resolution: documented in README §Security; gate is an accident-prevention
  net, not a security boundary. Operator mitigation: add scripting commands to
  `UPREDIS_BLOCKED_COMMANDS`. Awaiting explicit policy decision (enforce vs
  document).

## GATE-2 — XREADGROUP BLOCK detection blinded by a group/consumer named "STREAMS"; real BLOCK option reaches Redis and wedges the shared connection

- Found: 2026-09-06 · Sev: high · Location: `src/commands.ts:286-296`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: `checkBlockedCommand` parses XREAD/XREADGROUP positionally like Redis:
  opaque GROUP header values and COUNT values are skipped at every option
  position, including repeated/reordered GROUP headers accepted by Redis.
  The first-STREAMS-token heuristic is gone, so a
  group/consumer named `STREAMS` can no longer blind the BLOCK scan. Unit +
  integration regression tests cover the original repro.
- Resolution: the gate takes the FIRST `STREAMS` token as the options boundary,
  but Redis parses `GROUP <group> <consumer>` positionally with no
  reserved-word check. A group or consumer literally named `STREAMS` makes
  `optionsEnd <= optionsStart`, the slice is empty, and a real `BLOCK 0` at
  args[3]/[4] is never scanned — the command executes and blocks the shared
  auto-pipelined connection indefinitely (the 504 does not cancel the
  in-flight handler). Verified empirically (gate allows the repro args; a
  bystander PING on the same connection stays pending until an external XADD).
  Affects `POST /`, `/pipeline`, `/multi-exec` (shared gate). Fix direction:
  scan all args except the LAST `STREAMS` boundary (or reject BLOCK whenever
  any token after the header equals `STREAMS` before the final keyword).

## AUTH-1 — Empty `UPREDIS_REQUEST_TIMEOUT=` silently disables the per-request timeout

- Found: 2026-08-22 · Sev: medium · Location: `src/config.ts`
- Status: fixed (bb69d68)
- Resolution: empty value now falls back to the default request timeout.
  Fix verified empirically 2026-09-06; residual whitespace-only variant
  tracked as AUTH-9.

## AUTH-2 — `?_token=` auth on by default; bearer token persists in proxies' access logs

- Found: 2026-08-22 · Sev: low · Location: `src/config.ts`
- Status: accepted-risk (SDK compatibility)
- Resolution: README recommends bearer headers and documents UPREDIS_ALLOW_TOKEN_QUERY_PARAM=false. Changing the default would break existing SDK query-token clients.

## AUTH-3 — Weak-token warning misses long dictionary tokens; `.env.example` overstates coverage

- Found: 2026-08-22 · Sev: low · Location: `src/config.ts`
- Status: deferred (heuristic hardening)
- Resolution: Placeholder refusal and corrected example guidance are implemented. No entropy estimator can establish that an operator-chosen token is random; long dictionary detection remains heuristic and is outside this maintenance candidate.

## AUTH-4 — `/health` + `/readyz` disclose Redis connectivity state to anonymous clients

- Found: 2026-08-22 · Sev: low · Location: `src/routes/health.ts`
- Status: accepted-risk (documented health probe contract)
- Resolution: These unauthenticated endpoints deliberately expose readiness, without key names or values. Operators can restrict them at their reverse proxy.

## AUTH-5 — `/metrics` fully unauthenticated when enabled (aggregate traffic patterns public)

- Found: 2026-08-22 · Sev: low · Location: `src/server.ts`
- Status: accepted-risk (opt-in metrics)
- Resolution: Metrics remain disabled by default. README requires restricting access when enabled; changing scrape authentication is a separate compatibility decision.

## AUTH-6 — No upper bounds on `MAX_BODY_SIZE` / `MAX_PIPELINE_COMMANDS` / `SHUTDOWN_TIMEOUT` / `MAX_SUBSCRIPTIONS`

- Found: 2026-08-22 · Sev: low · Location: `src/config.ts`
- Status: deferred (operator-controlled resource configuration)
- Resolution: Positive integer validation and operational defaults remain. Platform-specific upper bounds and timer overflow handling merit a separate focused change; all settings are trusted deployment inputs.

## AUTH-7 — `UPREDIS_BLOCKED_COMMANDS` entries with subcommand names (`"CONFIG SET"`) silently never match

- Found: 2026-08-22 · Sev: low · Location: `src/config.ts`
- Status: deferred (configuration validation)
- Resolution: The documented format is comma-separated whole command names. Subcommand syntax validation should fail clearly in a separate config change; no subcommand matching is promised.

## AUTH-8 — `.env.example` ships an active placeholder token that passes validation

- Found: 2026-08-22 · Sev: medium (raised from low 2026-09-06) · Location:
  `.env.example:4`, `src/config.ts:4,75-76,86-91`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: startup refuses well-known placeholder tokens unless
  `UPREDIS_ALLOW_PLACEHOLDER_TOKEN=true` (gate lives in `src/config.ts` module
  load, exit with an actionable message). `.env.example` default now fails
  fast instead of booting with a public credential.
- Resolution: `UPREDIS_TOKEN=your-secret-token-here` is the one uncommented
  value; it passes the min(1) check and the placeholder gate is warn-only by
  design. Severity raised because the token string is published in the public
  repo and README documents `cp .env.example .env; docker compose up -d` as
  the standalone deployment — the default outcome is a working credential
  readable by anyone. Fix direction: refuse startup (or require explicit
  `UPREDIS_ALLOW_PLACEHOLDER_TOKEN=true`) on placeholder tokens.

## AUTH-9 — Whitespace-only `UPREDIS_REQUEST_TIMEOUT` bypasses the empty-string guard and silently disables the timeout (AUTH-1 residual)

- Found: 2026-09-06 · Sev: low · Location: `src/config.ts:18-20`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: the preprocess trims whitespace-only values to `undefined` (space, tab,
  NBSP all fall through to the default); explicit `0` still disables.
- Resolution: the preprocess guard is exact-match `v === ""`; `Number(" ") ===
  0` (ECMA-262 whitespace stripping), so `" "` coerces to 0 and
  `src/middleware/timeout.ts` skips the gate. Verified empirically (space,
  tab, NBSP all parse to 0). Fix direction: trim in the preprocess guard.

## FIDELITY-1 — ZMPOP pair-list flattening was incorrectly proposed

- Found: 2026-08-22 · Sev: low · Location: `src/translate/score-pairs.ts`
- Status: refuted (2026-09-08, direct Redis 8 RESP2 probe and Redis command reference)
- Resolution: Redis RESP2 and RESP3 both return `[key, [[member, score], ...]]`.
  The proposed flattening would corrupt that contract and was removed during
  recovery. Unit and HTTP command/pipeline/transaction regressions preserve nesting.
  Evidence: [Redis ZMPOP](https://redis.io/docs/latest/commands/zmpop/) and
  `redis-cli -2 --json ZMPOP` against disposable Redis. The installed SDK has no
  ZMPOP deserializer that would justify flattening.

## FIDELITY-2 — `LMPOP` nested shape

- Found: 2026-08-22 · Sev: low · Location: `src/translate/score-pairs.ts`
- Status: refuted (2026-08-22, the SDK's own types declare `[key, values[]]`)
- Resolution: do not re-flag without new evidence. 2026-09-06 re-check: BZMPOP
  shares the nested shape but is unreachable with SDK mangling (blocked
  command; no SDK deserializer exists for it).

## FIDELITY-3 — Boolean command arguments rejected with 400 although the SDK sends raw JSON booleans

- Found: 2026-09-06 · Sev: medium · Location: `src/commands.ts:342-347`
  (premise comment `src/commands.ts:317-318`)
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: `parseCommandArray` accepts JSON booleans and coerces to
  `"true"`/`"false"` — matching `@upstash/redis` `defaultSerializer`
  (nodejs.js:570-577), which passes booleans through raw. Objects/arrays/null
  still rejected.
- Resolution: the comment claims the SDK pre-stringifies booleans, but
  `@upstash/redis` 1.38.2 `defaultSerializer` passes booleans through raw
  (`nodejs.js:570-577`); `set(key, true)`, `hset(k, {f: true})`,
  `mset({k: true})` all 400 against up-redis (verified with the real SDK) and
  succeed against Upstash per the SDK's `TData` round-trip contract. Fix
  direction: accept booleans and coerce to `"true"`/`"false"` (or document +
  test the divergence).

## FIDELITY-4 — Newline in a PubSub message splits the SSE data field; SDK Subscriber silently truncates

- Found: 2026-09-06 · Sev: medium · Location: `src/translate/pubsub.ts:12-14`
  via `src/routes/pubsub.ts:190`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: `formatMessageEvent` routes payloads through a shared
  `normalizeMessagePayload` (valid JSON has physical CR/LF whitespace removed;
  everything else is
  JSON-stringified), mirroring the pattern path and the SDK's
  `parseWithTryCatch` — every message event is a single SSE line and the SDK
  round-trips the exact original string.
- Resolution: `formatMessageEvent` emits the payload raw; Hono's writeSSE
  splits on newlines and the SDK reader dispatches each `data:` line as an
  independent message, so `line1\nline2` delivers as `line1` and drops `line2`
  with no error (verified end-to-end with the SDK Subscriber). The pmessage
  path already JSON-stringifies payloads — the exact-subscribe path needs the
  same defense (mirror `formatPatternMessagePayload`).

## CONC-1 — `RespParser` buffers unboundedly on a never-terminating upstream stream

- Found: 2026-08-22 · Sev: low · Location: `src/redis-pattern.ts`
- Status: deferred (trusted-backend parser bound)
- Resolution: The existing 64 MiB bulk cap remains. A total-buffer cap for malformed unterminated responses is additional defense against a compromised Redis backend.

## CONC-2 — `KEYS` (when allowed) stalls all traffic on the shared connection and flips `/health`

- Found: 2026-08-22 · Sev: low · Location: `src/redis.ts`
- Status: accepted-risk (explicit dangerous-command opt-in)
- Resolution: KEYS is blocked by default. Enabling dangerous commands permits the documented shared-connection blocking behavior; use SCAN instead.

## CONC-3 — Multi-exec connect-failure socket leak

- Found: 2026-08-22 · Sev: low · Location: `src/routes/multi-exec.ts`
- Status: refuted (2026-08-22, `Bun.RedisClient` self-closes on rejected
  `connect()` — verified empirically)
- Resolution: do not re-flag without new evidence.

## CONC-4 — `/multi-exec` has no post-handshake command timeout; stalled upstream leaks a dedicated connection and a suspended handler per request

- Found: 2026-09-06 · Sev: medium · Location: `src/routes/multi-exec.ts:71-77`
  (cleanup `finally` at 95-101 never reached)
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: the MULTI / queued / EXEC awaits are bounded by
  `withTimeout(…, COMMAND_TIMEOUT_MS)` (10s, matching the pattern client); a
  timeout rejects into the route's 400 path and the `finally` closes the
  dedicated connection, releasing the fd. Integration relay completes HELLO, then stalls MULTI; the test requires the
  exact 400 MULTI timeout, socket release, and continued service afterwards.
- Resolution: MULTI/queued/EXEC awaits are unbounded; `connectionTimeout`
  bounds only establishment and `idleTimeout` defaults to 0. Verified
  empirically: 504 at 1.5s while the transaction connection stayed ESTABLISHED
  past 10s+ with no error log. Impact nuance (from verification): busy-script
  stalls fail fast (400 BUSY) and do not accumulate; silent stalls (wedged
  backend, partition) leak one fd + one suspended handler per request. Fix
  direction: wrap the transaction awaits in `withTimeout` (or set
  `idleTimeout` on dedicated connections).

## CONC-5 — Subscriber disconnect cleanup waits indefinitely for stalled UNSUBSCRIBE

- Found: 2026-09-06 · Sev: medium · Location: `src/routes/pubsub.ts`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Resolution: close the dedicated connection immediately. Redis removes all
  subscriptions on connection close, so teardown needs no UNSUBSCRIBE round trip.
  A regression stalls Redis after confirmation, disconnects HTTP, and verifies
  that only the shared connection remains within two seconds.

## CONC-6 — SSE keep-alive (15s) exceeds Bun.serve's default idleTimeout (10s) — Bun kills every message-free subscription after ~8-10s

- Found: 2026-09-06 · Sev: high · Location: `src/routes/pubsub.ts:46`,
  `src/index.ts:34-39`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: `Bun.serve` now sets `idleTimeout: 255` (Bun's max) — SSE keep-alives
  (15s) reset the timer, quiet subscriptions are no longer reaped, and plain
  HTTP keep-alive sockets still get idle reaping. Regression test keeps an
  idle subscription open through the old ~10s kill window.
- Resolution: `Bun.serve` is configured without `idleTimeout` (default 10s
  applies to streaming responses per Bun docs) and the keep-alive interval is
  15s — it can never rescue a quiet channel. Verified repeatedly (~8.4-9.6s
  teardown, stderr `[Bun.serve]: request timed out after 10 seconds`; fed
  channels survive). Severity high because idle-channel subscriptions are torn
  down continuously: the SDK consumer loses subscriber state, and messages
  published during the reconnect gap are lost (PubSub is fire-and-forget).
  Fix direction: set `idleTimeout: 0` (or a value > 15s) on `Bun.serve` and/or
  drop the keep-alive below 10s.

## CONC-7 — Graceful shutdown waits indefinitely on stalled subscription cleanup

- Found: 2026-09-06 · Sev: medium · Location: `src/routes/pubsub.ts`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Resolution: abort SSE and close the dedicated connection without awaiting
  Redis. The stalled-upstream SIGTERM regression exits with code 0 within the
  shutdown budget. SUBSCRIBE setup itself also has a 10-second deadline, with
  a separate regression that stalls only after HELLO completes.

## DEPLOY-1 — Ignored local Redis snapshot in repository directory

- Found: 2026-08-22 · Sev: low · Location: repository root
- Status: fixed locally (2026-09-08)
- Resolution: preserved outside the repository in owner-only storage, verified
  the SHA-256 copy, then removed the original from the repository directory.
  No snapshot contents were inspected or published; ignore rules remain.

## DEPLOY-2 — Compose defines no memory/CPU limits on either service

- Found: 2026-08-22 · Sev: low · Location: `docker-compose.yml`
- Status: deferred (deployment-specific sizing)
- Resolution: Backend memory, maxmemory eviction policy, and CPU limits need workload-specific values. Arbitrary global defaults could evict durable records or trigger OOM in established deployments.

## DEPLOY-3 — Development overlay exposes backend on every host interface

- Found: 2026-08-22 · Sev: low · Location: `docker-compose.dev.yml`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Resolution: both development HTTP and Redis published ports bind to 127.0.0.1.
  `bun run check:compose` validates the rendered bindings.

## DEPLOY-4 — Named volume does not guarantee durability of every write

- Found: 2026-08-22 · Sev: low · Location: `docker-compose.yml`
- Status: documented; live durability work requires verified backend access
- Resolution: preserve default RDB policy during upgrades. `docs/persistence.md`
  distinguishes volume persistence, snapshot loss windows, AOF, and off-host
  backups, and describes a running-instance migration with backup/restore gates.
  A disposable RDB restore and live AOF conversion/restart were verified locally.
  This candidate does not change any live persistence settings.

## DEPLOY-6 — Compose fails to forward documented application settings

- Found: 2026-09-06 · Sev: medium · Location: Compose manifests
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Resolution: explicitly forward all app settings from `.env` or shell/orchestrator
  variables. This supersedes the initial env_file-only patch, which missed host
  variables and forwarded unrelated secrets. A schema-key coverage check validates
  non-default settings, external overrides, custom ports, and default upgrade config.

## DEPLOY-7 — Release images bypass complete architecture-specific vulnerability gates

- Found: 2026-09-06 · Sev: medium · Location: `.github/workflows/release.yml`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Resolution: build/push an untagged immutable digest, scan that exact digest with
  explicit amd64 and arm64 selection and a pinned Trivy version, then publish
  version/latest tags only after both scans pass. GitHub Release follows promotion.
  This also fixes the proposed scan's nonexistent v-prefixed image reference.
  Actionlint passes. A tagged publication is intentionally not performed during
  recovery; registry promotion will be exercised by the next real version release.

## DEPLOY-8 — Bundled backend image `redis:8-alpine` is a mutable tag, not digest-pinned

- Found: 2026-09-06 · Sev: low · Location: `docker-compose.yml:21`
- Status: fixed (2026-09-08 recovery candidate; independent review pending)
- Fix: the compose default is digest-pinned
  `redis:8-alpine@sha256:becdda6c7f4b3fb42e42fd7f120bbf5c54c4caaaf16f26da24e4563d2c1f0576`
  (fetched 2026-09-07); `UPREDIS_REDIS_IMAGE` remains the documented override.
- Resolution: the app base is digest-pinned (Dockerfile:1); the data-plane
  image that owns `redis-data` floats. Fix direction: default to a
  `@sha256:`-pinned image, keep the plain tag as a documented override value.

## DEPLOY-9 — Bundled Redis has no authentication unless configured

- Found: 2026-09-06 · Sev: low · Location: `docker-compose.yml`
- Status: mitigated, opt-in (2026-09-08); unauthenticated default remains for upgrades
- Resolution: `UPREDIS_REDIS_PASSWORD` enables requirepass and credentials in the
  default app URL. A generated hex password is recommended for new deployments.
  Requiring a new variable during an automatic upgrade would break existing
  production stacks; an unset value therefore preserves the previous behavior.
  Actual bundled Compose smoke tests verify both no-password and authenticated
  boot, HTTP PING, and the expected Redis NOAUTH behavior. External URLs need
  their own credentials; this option does not configure managed backends.
