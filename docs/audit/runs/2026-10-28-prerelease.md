# Adversarial pre-release audit — 2026-10-28

Recipe 1 of `docs/workflowz.md`, requested before publishing 1.1.0. Finder:
Astra (`gpt-6-astra`), all five prompts executed sequentially in one independent
read-only review. Each medium finding was then assessed by three separate
read-only Astra refuters starting from REFUTED=true. Fixes were implemented by
the parent after all three completed; no reviewer edited the candidate.

## Snapshot and scope

- Audited HEAD: `65f6dfa7840eae404974f60c38abc38970d25875`.
- Integrated upstream: `8075ab010e00558123189433bfe1bc03713bc983` (September sweep).
- Branch: `maintenance/2026-10-release`; clean at start of each review.
- Runtime: Bun 1.4.4; Hono 4.13.14; Zod 4.6.7; SDK 1.40.0.
- Fix commit: `d68758d` (code, regressions, rollback documentation).
- Existing accepted/deferred risks retain their documented dispositions. In
  particular, scripting remains an intentional bypass of the direct-command
  accident-prevention gate; query-token, unauthenticated readiness, opt-in
  metrics and deployment sizing are not silently changed by this release.

## Findings and independent refutation

Locations below refer to the audited commit, before the fixes.

| Finding | Severity | Refuter 1 | Refuter 2 | Refuter 3 | Disposition |
| --- | --- | --- | --- | --- | --- |
| GATE-7: publish shortcut bypasses operator blocklist | medium | real | real | real | fixed `d68758d` |
| FIDELITY-6: comma-bearing PubSub names corrupt SDK framing | medium | real | real | real | fixed `d68758d` |
| CONC-8: pattern parser rejection leaks its transport | medium | real | real | real | fixed `d68758d` |
| DEPLOY-10: image-only Redis 8-to-7 rollback claim is false | medium | real | real | real | fixed `d68758d` |

No new finding was refuted this run. Every finding received three independent
REFUTED=false verdicts; none was accepted solely on the finder report.

### GATE-7

`src/routes/pubsub.ts:380` directly calls `getClient().publish` without the gate;
the shortcut is registered before the generic command route. Independent probes
with `UPREDIS_BLOCKED_COMMANDS=PUBLISH` returned:

```text
POST / ["PUBLISH","audit","hello"] -> 400 {"error":"PUBLISH is not allowed — it is in the UPREDIS_BLOCKED_COMMANDS blocklist"}
POST /publish/audit/hello -> 200 {"result":0}
```

Fix: run `checkBlockedCommand("PUBLISH", [channel, message])` before publishing.
The config-variant regression requires identical rejection on both entry points.

### FIDELITY-6

`src/translate/pubsub.ts:13,22` interpolates names into unescaped comma-delimited
fields; `src/routes/pubsub.ts:423–426` previously permitted commas. The installed
SDK (`nodejs.js:3784–3809`) finds those delimiters positionally. Each verifier
confirmed exact-channel corruption or pattern parse failure; real SDK examples:

```text
subscribe("audit,comma"), publish("audit,comma","hello")
-> {"channel":"audit","message":"comma,\"hello\""}
psubscribe("audit*"), channel "audit,comma"
-> Failed to parse message: Unexpected identifier "comma"
```

Fix: reject incompatible subscription/publish-shortcut targets with HTTP 400.
A broad pattern can still receive arbitrary Redis names from external clients
or generic commands, so the pattern callback also validates the actual channel.
It emits a delimiter-safe `error,,"Channel cannot be represented in the PubSub SSE format"`
event and closes the subscription, without forwarding a corrupted message.
The SDK's error listener receives a string `message`. This is a documented
transport limitation, not an attempt to rename Redis channels. Regressions use
the installed SDK to verify both initial rejection and a broad pattern receiving
one valid message followed by an incompatible channel.

### CONC-8

`src/redis-pattern.ts:288–290` invokes `handleClose` after parser failure;
`:316–324` formerly marked the connection closed without closing the socket,
then `close()` at `:238` returned early. All three verifiers inspected and ran
the isolated oversized-bulk-header probe:

```text
open upstream sockets after parser rejection + close(): 1
```

After the fix, the same probe reports **0**. `handleClose` now clears and
terminates the transport before its idempotent logical-close guard. Dedicated
subscription cleanup needs no PUNSUBSCRIBE round trip. A real-socket regression
waits for PSUBSCRIBE confirmation, triggers the parser's existing bulk cap,
then requires clean child-process exit and zero upstream sockets after repeated
cleanup. It passes on Bun 1.4.4 and 1.3.6.

### DEPLOY-10

`README.md:431–434` promised an image-only downgrade for ordinary keyspaces.
Independent disposable Redis 8.8.0 snapshots containing one ordinary string
were rejected by Redis 7.4.12:

```text
RDB header b'REDIS0014'
[offset 9] Can't handle RDB format version 14
```

Fix: remove the reversibility promise. Require preservation of current data,
a verified compatible backup or tested logical migration into a separate
volume, reconciliation of writes since the backup, and a paused-writer cutover.
Forward persistence compatibility does not establish backward compatibility.
No user backend, volume or data was changed by these probes or fixes.

## Areas checked without new findings

- Auth/config: hashed constant-time comparison (`src/middleware/auth.ts:50–54`),
  placeholder refusal (`src/config.ts:71–85`) and whitespace timeout handling
  (`:18–20`). Anonymous probes/metrics match existing documented dispositions.
- Gate call graph: single/path commands, pipeline and transactions invoke the
  gate. Fixed-PING health checks accept no client command. Dedicated subscribe
  routes intentionally use dedicated connections rather than the shared gate.
  GATE-2 original and reordered GROUP cases and GATE-3..5 unsafe commands were
  verified rejected across the three generic entry points.
- Fidelity: default JSON and explicit base64 decoding, literal OK depth parity,
  SDK sync-token behavior, and existing LMPOP/ZMPOP refutations were reviewed.
- Concurrency: synchronous reservation (`src/util/slot-limiter.ts:22–25`),
  bounded transaction waits/finally cleanup (`src/routes/multi-exec.ts:79–106`),
  immediate subscriber close and shutdown deadline were inspected. CONC-6 quiet
  SSE probe delivered two keepalives over 15,009 ms and exited 0 on shutdown.
- Deployment: non-root Docker user and immutable digest-only build, per-platform
  scans, promotion depending on the complete scan matrix, then GitHub Release.
  Action SHA pins were verified against release commits, including annotated
  tag peeling for CodeQL and the release action.

## Validation and publication gate

Final validation of the fixes (Bun 1.4.4, SDK 1.40.0):

| Backend | Integration | SDK default JSON | SDK base64 |
| --- | --- | --- | --- |
| Redis 6 | 207 pass, 6 feature skips | 109 pass | 109 pass |
| Redis 7 | 210 pass, 3 feature skips | 109 pass | 109 pass |
| Redis 8 | 213 pass | 109 pass | 109 pass |
| Valkey 9 | 213 pass | 109 pass | 109 pass |

- Bun 1.3.6 floor, Redis 8: 213 integration, 109 default JSON and 109 base64 SDK
  tests pass. Unit suites pass all 332 tests on both Bun versions.
- Frozen installs on both runtimes, typecheck, lint, build, Compose configuration
  checks, actionlint and diff-whitespace checks pass. `bun audit` reports no known
  vulnerabilities in the resolved dependency tree.
- Final local linux/amd64 image:
  `sha256:99834bed93497bb07ac5d7e8698e066ec5c189252c0e6936eee93ed088db3491`.
  Build, non-root container readiness and authenticated PING smoke pass.
- Trivy 0.76.1 scan of that image passes the CI policy: no HIGH/CRITICAL findings
  with `--ignore-unfixed`. This does not assert absence of other vulnerabilities.
- Remote PR checks must pass before tagging. The release workflow independently
  verifies source/tests, builds an immutable amd64/arm64 manifest, scans both
  architectures, and only then promotes public tags and creates the release.

Finder/refuter probes used disposable Redis 8.8.0; the parent final matrix uses
current Redis/Valkey images, including pinned-default Redis 8.10.3. No live
operator data is part of this audit. Full-history secret scanning and CodeQL
are remote CI gates; the local image scan covers amd64 only.

VERDICT: PASS — all four medium findings fixed with passing regressions; no open high findings. Publication remains conditional on remote CI and both release-image scans.
