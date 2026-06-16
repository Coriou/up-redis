FROM oven/bun:1.3.6-alpine AS builder
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN bun build src/index.ts --target=bun --outdir=dist --minify

FROM oven/bun:1.3.6-alpine
WORKDIR /app
RUN apk add --no-cache curl
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
