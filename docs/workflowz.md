# Maintenance Workflowz

Repeatable multi-agent audit workflows for this repository. They complement the
deterministic CI backbone (`.github/workflows/`) with judgment work CI cannot do:
reasoning about exploitability, upstream behavior drift, and policy gaps. CI
answers "did anything break?"; workflowz answer "what are we missing?"

Run them from the coding harness by asking for the recipe by name ("run the
pre-release audit"). Every recipe is read-only with respect to the repo; findings
come back as a report for a human to act on.

## Division of labor

| Concern           | Deterministic (always runs)                                                                  | Workflowz (judgment, on demand)                             |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Regression safety | `test.yml`: unit / integration matrix (Redis 6–8, Valkey 9) / SDK compat / Bun 1.3.6 floor    | —                                                            |
| Known vulns       | `security.yml`: CodeQL + dependency-review + gitleaks; `test.yml` Trivy; Dependabot            | Exploitability triage of individual alerts                   |
| SDK drift         | `compat.yml`: weekly `@upstash/redis@latest` + auto-issue                                      | Reading upstream SDK source diffs for undocumented changes    |
| Dependency impact | Dependabot PRs (bun / actions / docker / compose)                                              | Release-notes review for Bun.redis / Hono / Zod behavior      |
| Deep audit        | —                                                                                              | Pre-release audit (below)                                     |

## Recipes

### 1. Pre-release audit — run before tagging any release

Five read-only finder agents over HEAD, one per dimension:

1. **auth-config** — token handling, config schema holes, log/metrics leakage,
   unauthenticated surface
2. **gate-bypass** — `checkBlockedCommand` escapes: EVAL/Lua, subcommand
   allowlists, path parsing, transaction queueing
3. **fidelity** — response shapes vs the real `@upstash/redis` contract (read the
   installed SDK source, not docs): error envelopes, base64 depth rules, pair
   flattening, EXEC error slots
4. **concurrency** — dedicated-connection lifecycles, slot-limiter paths, RESP
   parser bounds, shutdown races, unbounded memory
5. **deploy** — Dockerfile/compose posture, `.env.example` ↔ `config.ts` drift,
   repo hygiene, README claim spot-checks

Every finding must cite `file:line` the finder actually read plus a concrete
repro. Then dedupe and adversarially verify: 3 independent refuters for
high/medium findings, 1 for low; refuters default to `refuted=true` and may run
empirical checks (throwaway servers, `bun -e` probes). A finding survives only on
majority-non-refuted. Ship gate: zero open high+ findings.

**Baseline run 2026-08-22 (HEAD `6b702ae`):** 18 findings verified → 16
confirmed, 2 refuted; 12 further areas verified clean with citations.

Confirmed:

| Sev    | Finding                                                                                                                        | Location                        |
| ------ | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| high   | `EVAL`/`EVALSHA`/`FCALL` ungated — Lua `redis.call()` bypasses the blocked/dangerous-command policy (policy decision pending)   | `src/commands.ts`               |
| medium | Empty `UPREDIS_REQUEST_TIMEOUT=` coerces to `0` and silently disables the per-request timeout                                   | `src/config.ts`                 |
| low    | `?_token=` auth on by default → bearer token persists in fronting proxies' access logs                                          | `src/config.ts`                 |
| low    | Weak-token warning misses long dictionary tokens; `.env.example` overstates coverage                                            | `src/config.ts`                 |
| low    | `/health` + `/readyz` disclose Redis connectivity state to anonymous clients                                                    | `src/routes/health.ts`          |
| low    | `/metrics` fully unauthenticated when enabled (aggregate traffic patterns public)                                               | `src/server.ts`                 |
| low    | No upper bounds on `MAX_BODY_SIZE` / `MAX_PIPELINE_COMMANDS` / `SHUTDOWN_TIMEOUT` / `MAX_SUBSCRIPTIONS`                          | `src/config.ts`                 |
| low    | `UPREDIS_BLOCKED_COMMANDS` entries with subcommand names (`"CONFIG SET"`) silently never match                                  | `src/config.ts`                 |
| low    | `ZMPOP` pair list returned nested instead of Upstash's flat RESP2 form                                                          | `src/translate/score-pairs.ts`  |
| low    | `RespParser` buffers unboundedly on a never-terminating upstream stream (hostile/compromised Redis only)                        | `src/redis-pattern.ts`          |
| low    | `KEYS` (when allowed) stalls all traffic on the shared connection and flips `/health` via the same-client ping                  | `src/redis.ts`                  |
| low    | `dump.rdb` containing real third-party user data sits in repo root (untracked; delete or move it out)                           | repo root                       |
| low    | Compose defines no memory/CPU limits on either service                                                                          | `docker-compose.yml`            |
| low    | Dev overlay publishes unauthenticated Redis on all host interfaces                                                              | `docker-compose.dev.yml`        |
| low    | Bundled backend uses default RDB snapshotting despite durability-implying named volume                                          | `docker-compose.yml`            |
| low    | `.env.example` ships an active placeholder token that passes validation (`cp .env.example .env` + skipped edit = no effective auth) | `.env.example`               |

Refuted during verification (do not re-flag without new evidence): `LMPOP` nested
shape — the SDK's own types declare `[key, values[]]`; multi-exec connect-failure
socket leak — `Bun.RedisClient` self-closes on rejected `connect()` (verified
empirically).

### 2. Monthly ecosystem sweep

Watch items CI cannot judge:

- **Bun release notes** since the pinned version: any `Bun.redis` behavior change.
  The runtime floor is 1.3.6 while CI/Docker pin 1.3.14 — a floor bump is a
  breaking change for users and needs engines + changelog + docs updates.
- **Hono / Zod release notes**: behavior changes affecting request parsing or
  validation semantics.
- **Redis 8.x / Valkey release notes**: new commands must be classified into the
  blocked/allowlist policy in `src/commands.ts`. The allowlist families fail
  closed, but brand-new top-level commands default to **allowed**.
- **`@upstash/redis` source diff** since the last sweep: undocumented contract
  changes in its deserializers that the weekly compat suite may not cover.

### 3. Advisory triage — on every Dependabot / CodeQL / Trivy / gitleaks alert

For each alert: read the affected code path in _this_ repo, decide reachable /
not-reachable with evidence (this proxy's exposure is unusual — untrusted HTTP
front, trusted Redis back), then fix or record an explicit accept-risk note.
Never auto-merge security PRs without this pass.
