FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --target=bun --outdir=dist --minify

FROM oven/bun:1.4.2-alpine@sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f
WORKDIR /app
# CI injects a unique value per run so this security-refresh layer never
# resolves from cache: a frozen layer once shipped Alpine packages that Trivy's
# updated DB flagged (CVE-2026-14456) even though fixes were already published,
# turning the vulnerability gate permanently red. The RUN consumes the value so
# it keys the layer cache explicitly instead of relying on builder-version
# quirks; costs one short apk roundtrip per build; heavy builder layers stay
# cached.
ARG CI_RUN_STAMP=
RUN echo "apk refresh: $CI_RUN_STAMP" && apk upgrade --no-cache && apk add --no-cache curl
# The bundle is self-contained (only node:crypto, a Bun built-in, stays external),
# so no node_modules are needed at runtime — smaller image, less attack surface.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/package.json ./
USER bun
EXPOSE 8080
# Probe /livez (liveness): it doesn't depend on Redis, so a transient Redis blip
# won't trip the restart policy; it only reports unhealthy during graceful shutdown.
HEALTHCHECK --interval=10s --timeout=5s --retries=3 \
  CMD curl -f http://localhost:8080/livez || exit 1
CMD ["bun", "run", "dist/index.js"]
