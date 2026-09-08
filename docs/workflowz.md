# Maintenance Workflowz

Repeatable audit runbooks for this repository. They complement the deterministic
CI backbone (`.github/workflows/`) with judgment work CI cannot do: reasoning
about exploitability, upstream behavior drift, and policy gaps. CI answers "did
anything break?"; workflowz answer "what are we missing?"

Recipes are **pure instructions**. They assume nothing about the executing
agent, model, or harness: no special tools, no repo-external context. An
external orchestrator (human or agent) runs a recipe top to bottom.

## Division of labor

| Concern           | Deterministic (always runs)                                                                  | Workflowz (judgment, on demand)                             |
| ----------------- | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Regression safety | `test.yml`: unit / integration matrix (Redis 6–8, Valkey 9) / SDK compat / Bun 1.3.6 floor    | —                                                            |
| Known vulns       | `security.yml`: CodeQL + dependency-review + gitleaks; `test.yml` Trivy; Dependabot            | Exploitability triage of individual alerts                   |
| SDK drift         | `compat.yml`: weekly `@upstash/redis@latest` + auto-issue                                      | Reading upstream SDK source diffs for undocumented changes    |
| Dependency impact | Dependabot PRs (bun / actions / docker / compose)                                              | Release-notes review for Bun.redis / Hono / Zod behavior      |
| Deep audit        | —                                                                                              | Pre-release audit (Recipe 1)                                  |

## Operating rules (every recipe)

1. **Read-only code.** Recipes never modify `src/`, `tests/`, CI, or docs other
   than the two outputs below. Fixes happen in normal PRs after a human reads
   the report.
2. **Two writable outputs only:**
   - `docs/audit/runs/<date>-<recipe>.md` — one report per execution
   - `docs/audit/findings.md` — the live findings ledger (single source of truth)
3. **Parallelism is optional.** If the executing harness supports parallel
   subagents, dispatch each finder/refuter prompt concurrently; otherwise run
   them sequentially. The protocol and results are identical either way. Never
   let a finder or refuter edit repository files.
4. **Evidence bar.** Every finding must cite `file:line` the agent actually read
   in this repo plus a concrete reproduction (command, request, or scenario).
   Findings without both are discarded.
5. **Ledger discipline.** At the end of a recipe: append new findings, update
   statuses of existing ones, and record the run in `runs/`. Refuted findings
   stay in the ledger with their refutation so future runs do not re-flag them
   without new evidence.
6. **Verdict line.** Every run report ends with
   `VERDICT: PASS|FAIL — <one-line reason>`. Recipe 1's gate: FAIL while any
   ledger finding with severity `high` has status `open`.

**Severity rubric** (used by finders and refuters):

- `high` — exploitable by an unauthenticated client, corrupts shared-connection
  or subscriber state, loses/damages data, or breaks the documented auth model.
- `medium` — silently violates documented behavior (wrong response shape,
  silently disabled safety feature) with security or reliability impact.
- `low` — defense-in-depth, hygiene, aggregate information disclosure, missing
  hardening limits.

**Threat model** (context every finder gets): untrusted HTTP clients with a
bearer token reach a trusted Redis backend through one shared auto-pipelined
connection; transactions and PubSub use dedicated connections. The token holder
can run arbitrary Redis commands by design — the blocked-command gate is an
accident-prevention net, not a security boundary. Unauthenticated surface:
`GET /`, `/livez`, `/health`(+`/readyz`), `/metrics` when enabled.

---

## Recipe 1 — Pre-release audit (run before tagging any release)

**Trigger:** a release candidate exists on `main` (or manually, any time).
**Inputs:** none (audits `HEAD`).
**Outcome:** verdict PASS/FAIL for the ship gate, ledger reconciled.

### Step 1 — Snapshot

Record in the report: date, `HEAD` sha, `bun --version`, and
`bun pm ls | grep -E "hono|zod|@upstash/redis"`.

### Step 2 — Find

Run the five finder prompts below over `HEAD`. Dispatch them in parallel when
the harness allows; each is fully self-contained. Collect one FINDING block per
issue, per the format inside each prompt.

```
FINDER — auth-config
You are auditing "up-redis", a self-hosted Upstash-Redis-compatible HTTP proxy
(Bun + Hono; Bun.redis client; Zod-validated env config). Read-only: do not
edit any file.

Scope: src/config.ts, src/middleware/auth.ts, src/middleware/*, src/server.ts,
src/routes/health.ts, src/routes/metrics.ts, src/logger.ts, src/metrics.ts,
.env.example, README (auth/env sections).

Hunt for: token validation flaws (comparison timing, empty/weak-token handling,
query-param auth toggle), config parsing that silently disables a safety
feature, unauthenticated endpoints disclosing sensitive state, secrets or
tokens leaking into logs/metrics/error envelopes, config schema holes (missing
bounds, wrong coercion, NaN/empty-string traps), drift between .env.example,
README claims, and src/config.ts.

For each issue output exactly one block:
FINDING
ID: AUTH-<next free number you assign>
SEV: high|medium|low
AREA: auth-config
TITLE: <one line>
LOCATION: <path>:<line>
EVIDENCE: <quote the lines you read>
REPRO: <concrete command/request/scenario>

Rules: cite only lines you actually read; a finding needs both LOCATION and
REPRO; no speculative findings. End with "DONE — <N> findings".
```

```
FINDER — gate-bypass
You are auditing "up-redis", a self-hosted Upstash-Redis-compatible HTTP proxy
(Bun + Hono; Bun.redis client). Read-only: do not edit any file.

Scope: src/commands.ts (checkBlockedCommand, parseCommandArray) and every
callsite: src/routes/command.ts, src/routes/pipeline.ts, src/routes/multi-exec.ts,
src/routes/pubsub.ts, src/server.ts path-style routing. Read the actual call
graph; list every route that reaches Redis and confirm the gate runs on it.

Hunt for: commands that reach Redis without passing checkBlockedCommand;
case/parsing tricks that slip past the blocked list (subcommand vs top-level
confusion, whitespace, path-style arg injection into the command slot); gaps in
the SCRIPT/EVAL story that the README does not document; blocked-list families
whose unknown subcommands fail open instead of closed; parseCommandArray
accepting argument shapes that corrupt the RESP wire (deep arrays, huge
numbers, embedded newlines); endpoints where body args are appended after path
args in surprising order.

Known-refuted (do not re-flag without NEW evidence): none in this area.

For each issue output exactly one block:
FINDING
ID: GATE-<next free number you assign>
SEV: high|medium|low
AREA: gate-bypass
TITLE: <one line>
LOCATION: <path>:<line>
EVIDENCE: <quote the lines you read>
REPRO: <concrete command/request/scenario>

Rules: cite only lines you actually read; a finding needs both LOCATION and
REPRO; no speculative findings. End with "DONE — <N> findings".
```

```
FINDER — fidelity
You are auditing "up-redis", a self-hosted drop-in replacement for the Upstash
Redis REST API (the contract of the @upstash/redis SDK). Read-only: do not
edit any file.

Scope: src/translate/response.ts, src/translate/score-pairs.ts,
src/translate/encoding.ts, src/translate/transaction.ts, src/translate/pubsub.ts,
src/middleware/error-handler.ts, src/routes/*.ts. Also read the INSTALLED SDK
source (node_modules/@upstash/redis) — its decoders define the contract, not
docs.

Hunt for: response shapes the SDK deserializer would mangle (nested pair lists
where flat is expected, Map vs array, Boolean vs 0/1, non-finite numbers);
base64 encode/decode mismatches (depth rules, "OK" literal handling, error
envelopes, numbers/null encoded when they must not be); error envelope shape
vs the SDK's error handling ({ error } at HTTP 400, what the SDK does with
non-400); EXEC result shaping (QUEUED stripping, error slots, empty EXEC);
SSE event format vs what the SDK Subscriber parses; command argument
serialization the SDK side sends but we mishandle (objects in JSON bodies,
base64 request bodies).

Known-refuted (do not re-flag without NEW evidence): LMPOP/ZMPOP-class pair
shape where the SDK's own types declare [key, values[]].

For each issue output exactly one block:
FINDING
ID: FIDELITY-<next free number you assign>
SEV: high|medium|low
AREA: fidelity
TITLE: <one line>
LOCATION: <path>:<line>
EVIDENCE: <quote the lines you read, including the SDK source line>
REPRO: <concrete command/request/scenario>

Rules: cite only lines you actually read; a finding needs both LOCATION and
REPRO; no speculative findings. End with "DONE — <N> findings".
```

```
FINDER — concurrency
You are auditing "up-redis", a self-hosted Upstash-Redis-compatible HTTP proxy
(Bun + Hono; one shared auto-pipelined Bun.redis connection; dedicated
connections for MULTI/EXEC and PubSub). Read-only: do not edit any file.

Scope: src/redis.ts, src/redis-pattern.ts, src/util/timeout.ts,
src/util/slot-limiter.ts, src/routes/multi-exec.ts, src/routes/pubsub.ts,
src/index.ts (shutdown), src/shutdown.ts, src/middleware/timeout.ts.

Hunt for: interleaving of commands on the shared connection (blocking calls,
long-running commands, ping probes during a stalled command); dedicated
connections leaking on error paths (missing close in finally, early throws);
subscription slot-limiter TOCTOU (check-then-use races, double-release, leak
on client disconnect); RESP parser memory bounds (unbounded buffering on a
hostile or stuck upstream, partial-read bugs, malformed frame handling);
shutdown races (requests accepted after drain starts, subscriptions not
closed, hangs past the timeout); unbounded per-request memory (pipeline
accumulation, SSE queue growth).

Known-refuted (do not re-flag without NEW evidence): multi-exec connect-failure
socket leak — Bun.RedisClient self-closes when connect() rejects (verified
empirically 2026-08-22).

For each issue output exactly one block:
FINDING
ID: CONC-<next free number you assign>
SEV: high|medium|low
AREA: concurrency
TITLE: <one line>
LOCATION: <path>:<line>
EVIDENCE: <quote the lines you read>
REPRO: <concrete command/request/scenario>

Rules: cite only lines you actually read; a finding needs both LOCATION and
REPRO; no speculative findings. End with "DONE — <N> findings".
```

```
FINDER — deploy
You are auditing "up-redis", a self-hosted Upstash-Redis-compatible HTTP proxy
shipped as a Docker image. Read-only: do not edit any file.

Scope: Dockerfile, .dockerignore, docker-compose.yml, docker-compose.dev.yml,
.github/workflows/*.yml, .env.example, README (deploy/security/env sections),
CHANGELOG.md hygiene, repo root (stray artifacts).

Hunt for: image posture (runs as root, unpinned base, secrets in layers);
compose posture (published ports beyond loopback in prod file, missing
resource limits, durability-implying volumes with durability-hostile backend
config); CI gaps (workflows that can run with excessive permissions, cache
poisoning surfaces, unpinned actions); drift between README claims and actual
config/defaults; .env.example values that pass validation unchanged; stray
files in the repo containing real data.

For each issue output exactly one block:
FINDING
ID: DEPLOY-<next free number you assign>
SEV: high|medium|low
AREA: deploy
TITLE: <one line>
LOCATION: <path>:<line>
EVIDENCE: <quote the lines you read>
REPRO: <concrete command/request/scenario>

Rules: cite only lines you actually read; a finding needs both LOCATION and
REPRO; no speculative findings. End with "DONE — <N> findings".
```

### Step 3 — Adversarially verify

For every finding: refuters are independent agents that start from
`refuted=true` and flip only on evidence. They may run empirical probes
(`bun -e`, a throwaway server against a local Redis, raw HTTP requests) but
must not modify repository files.

- `high`/`medium`: 3 refuters; finding survives only if ≥2 say real.
- `low`: 1 refuter; survives unless refuted.

```
REFUTER
You are a skeptical verifier for the up-redis repo. Below is one audit finding.
Your default position: the finding is REFUTED (not real, not reachable, or
already mitigated). Flip to real ONLY with concrete evidence: a code path you
read (cite file:line) or an empirical probe you ran (show the command and raw
output). Do not modify repository files; throwaway probes outside the repo are
fine.

FINDING
<paste the finding block>

Output exactly:
REFUTED: true|false
REASONING: <2-4 sentences>
EVIDENCE: <file:line citations and/or probe command + output>
```

### Step 4 — Reconcile and report

1. Merge surviving findings into `docs/audit/findings.md` (new rows; update
   existing rows whose state changed — e.g. previously `open` findings you can
   now prove fixed get `fixed (<sha>)`).
2. Write `docs/audit/runs/<date>-prerelease.md`: snapshot from step 1, table of
   all findings with verdicts, list of areas verified clean (with citations),
   refuted-this-run items, then the verdict line.
3. Verdict: `FAIL` while any ledger row with `SEV: high` has status `open`;
   otherwise `PASS`.

**Gate:** do not tag a release off a `FAIL` report.

---

## Recipe 2 — Monthly ecosystem sweep (upstream drift review)

**Trigger:** monthly (or before any dependency-bump batch merges).
**Inputs:** date of the previous sweep report (read the newest
`docs/audit/runs/*-sweep.md`).
**Outcome:** drift classified; ledger updated when drift implies a defect.

Check each item against its upstream source since the previous sweep. For each,
record in the report: upstream versions reviewed, relevant changes, and the
disposition (no action / docs update / issue filed / ledger row).

1. **Bun runtime** — release notes from the pinned CI/Docker version
   (`oven-sh/setup-bun` in `test.yml`, `FROM` in `Dockerfile`) to current.
   Any change to `Bun.redis` behavior (RESP parsing, auto-pipelining,
   subscribe, reconnect semantics) is a candidate finding (AREA `CONC` or
   `FIDELITY`). A floor bump (currently 1.3.6) is a breaking change: it needs
   `engines`, README, CHANGELOG updates — flag it even if behavior is fine.
2. **Hono** (`github.com/honojs/hono/releases`) — request parsing, routing,
   streaming (`streamSSE`), middleware ordering changes.
3. **Zod** (`github.com/colinhacks/zod/releases`) — validation semantics that
   could change config parsing or request-body parsing results.
4. **Redis 8.x and Valkey** (`redis/redis`, `valkey-io/valkey` releases) —
   brand-new top-level commands default to **allowed** by the proxy (the gate
   blocks enumerated commands; allowlist families fail closed). For each new
   command: decide whether it belongs in a blocked family in `src/commands.ts`
   (admin, connection-state, blocking) and file a ledger row (AREA `GATE`) if
   yes. Hash-field TTL and new data-type commands usually need no action but
   must be listed.
5. **@upstash/redis source diff** — clone `upstash/redis`, diff since the sha
   recorded in the last sweep report, focus on `src/` deserializers, error
   handling, pipeline/multi-exec handling. Undocumented contract changes are
   ledger rows (AREA `FIDELITY`) even if the weekly compat suite still passes.

**Verdict:** `PASS` unless a sweep item produced an untriaged ledger row or
requires an urgent release; state dispositions in the reason.

---

## Recipe 3 — Advisory triage (on every Dependabot / CodeQL / Trivy / gitleaks alert)

**Trigger:** a new alert or security PR appears (Dependabot, CodeQL, Trivy,
gitleaks).
**Inputs:** the alert (tool, package/CVE or rule, affected version/path).
**Outcome:** every alert ends fixed or explicitly accepted. Security PRs are
**never** auto-merged.

Per alert:

1. Read the affected code path **in this repo**. Generic CVE severity does not
   transfer; this proxy's exposure is unusual — untrusted HTTP front, trusted
   Redis back, one shared connection, dedicated connections for transactions
   and PubSub, no shell-outs, no dynamic code loading beyond Lua sent to Redis.
2. Decide `reachable` / `not reachable` with a citation (file:line) plus, where
   cheap, an empirical probe.
3. Disposition:
   - reachable → normal PR (fix or bump); reference the alert; ledger row
     (AREA `ADVISORY`, status `open` until the fix merges).
   - not reachable → append `accepted-risk` ledger row (AREA `ADVISORY`) with
     the reasoning; no code change.
4. Record the decision in `docs/audit/runs/<date>-advisory.md` (one section per
   alert).

**Verdict:** `PASS` when every alert in the run has a disposition; `FAIL` if
any reachable alert lacks an open fix.

---

## Orchestration entry points

| Event                          | Run                |
| ------------------------------ | ------------------ |
| Release candidate on `main`    | Recipe 1           |
| Calendar month tick            | Recipe 2 (+ ledger review) |
| New alert / security PR        | Recipe 3           |

The orchestrator is any agent or human that can: read this repo, dispatch the
prompt templates above (sequentially or in parallel), run `bun`/`curl` probes
in a scratch directory, and write the two outputs. No other capability is
required.
