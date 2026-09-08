# Pre-Release Audit — 2026-09-06

Recipe: `docs/workflowz.md` Recipe 1. Executed end-to-end (5 finders →
adversarial verification → reconciliation). This run also validated the
runbook's harness-agnostic protocol (finder/refuter prompts used verbatim).

## Snapshot

| Field            | Value                                                        |
| ---------------- | ------------------------------------------------------------ |
| Date             | 2026-09-06                                                    |
| HEAD             | `1066418`                                                     |
| bun              | 1.3.14                                                        |
| hono             | 4.13.3                                                        |
| zod              | 4.4.3                                                         |
| @upstash/redis   | 1.38.2                                                        |
| Finders          | 5 (auth-config, gate-bypass, fidelity, concurrency, deploy)   |
| Refutations      | 12 findings × 3 refuters (high/med) + 3 × 1 refuter (low); refuters default `refuted=true`; ~half ran live probes (throwaway Redis + proxy instances outside the repo) |

## Verdicts

| ID        | Sev    | Finding (abbreviated)                                                                 | Refuter verdict            |
| --------- | ------ | ------------------------------------------------------------------------------------- | -------------------------- |
| GATE-2    | high   | XREADGROUP group/consumer named "STREAMS" blinds BLOCK scan → shared connection wedged | 6/6 real (2 empirical)    |
| CONC-6    | high   | Bun idleTimeout (10s) < SSE keep-alive (15s) → idle subscriptions killed every ~10s    | 6/6 real (4 empirical)    |
| FIDELITY-3| medium | SDK sends raw JSON booleans; `set(k, true)`/`hset`/`mset` rejected 400                  | 6/6 real (4 empirical)    |
| FIDELITY-4| medium | Newline in PubSub payload splits SSE data field → SDK Subscriber silently truncates     | 6/6 real (4 empirical)    |
| CONC-4    | medium | `/multi-exec` unbounded post-handshake awaits → fd + handler leak per stalled request   | 6/6 real (4 empirical)    |
| CONC-5    | medium | `/subscribe` cleanup awaits UNSUBSCRIBE unbounded → fd leak on disconnect-during-stall  | 6/6 real (4 empirical)    |
| CONC-7    | medium | Shutdown hangs on unbounded UNSUBSCRIBE → forced exit(1) after full timeout             | 6/6 real (3 empirical)    |
| DEPLOY-6  | medium | Compose forwards 3/15 env vars; README hardening knobs silently no-op                   | 6/6 real (4 empirical)    |
| DEPLOY-7  | medium | GHCR release images never vulnerability-scanned (arm64 never scanned anywhere)          | 3 real / 3 refuted → **split verdict**: no-scan gap confirmed by all six; the bundled apk cache-freeze mechanism REFUTED (GHA cache ref-isolation — `apk upgrade` does run per tag). Ledger keeps the confirmed half only. |
| DEPLOY-8  | low    | `redis:8-alpine` mutable tag, not digest-pinned                                         | 2/2 real                  |
| DEPLOY-9  | low    | Bundled Redis unauthenticated on the compose network                                    | 2/2 real (1 empirical)    |
| AUTH-9    | low    | Whitespace-only `UPREDIS_REQUEST_TIMEOUT` silently disables the timeout (AUTH-1 residual)| 2/2 real (1 empirical)   |

## Ledger reconciliation

- **AUTH-1** — fix (bb69d68) verified real this run; whitespace residual filed
  as AUTH-9.
- **AUTH-8** — DEPLOY-5 (deploy finder) is the same finding; folded. Severity
  raised low → medium (token string is public; README documents
  `cp .env.example .env` as the standalone deployment).
- **AUTH-2..7, DEPLOY-1..4** — re-confirmed present and unchanged at HEAD;
  statuses unchanged.
- **FIDELITY-2, CONC-3** — prior refutations stand; finders given the
  exclusions upfront and did not re-flag.
- All new findings recorded in `docs/audit/findings.md`.

## Areas verified clean this run

- **auth-config**: token never logged/metricated/enveloped; SHA-256 +
  `timingSafeEqual` comparison; `_token` excluded from path-style args and
  query string excluded from request logs; error envelopes carry only
  `err.message`; Redis URL password redacted in logs; X-Request-ID sanitized;
  text logger escapes control chars; no runtime Zod on the request path;
  `.env.example`/README/`config.ts` defaults in sync (except AUTH-8/9).
- **gate-bypass**: full route map confirmed gated — `POST /`, path-style,
  `/pipeline` (per-command), `/multi-exec` (per-command), `/publish`
  (PUBLISH by design), `/subscribe`+`/psubscribe` (dedicated connections,
  fixed commands, binary-safe length-prefixed encoding, pattern pre-validated
  ≤512 chars / no control chars); `parseCommandArray` rejects wire-corrupting
  shapes; blocked list case-safe; admin families fail closed.
- **fidelity**: family check over pair-flattening coverage — BLMPOP/BZMPOP
  unreachable with SDK mangling (blocked; no SDK deserializers); GEOPOS/XRANGE
  nesting is legitimately nested per SDK.
- **concurrency**: pattern client bounds every command at 10s
  (COMMAND_TIMEOUT_MS) — cited as the model the Bun.redis paths lack.
- **deploy**: compose files carry no secrets; actions digest-pinned; base
  image digest-pinned.

## Refuted this run (do not re-flag without new evidence)

- **apk layer cache-freeze on the release path** (part of DEPLOY-7) — GHA
  cache is ref-isolated ("workflow runs cannot restore caches created for
  different tag names") and the empty-stamp apk layer key can never match
  test.yml's stamped keys, so `apk upgrade --no-cache` executes on every
  release build.
- Two refuter sessions crashed mid-probe (FIDELITY-3#3, CONC-7#2) and were
  re-run to completion by the pool; verdicts above reflect completed runs.

VERDICT: FAIL — 2 open high findings (GATE-2, CONC-6). Do not tag a release
until both are fixed (or explicitly accepted with rationale in the ledger).
