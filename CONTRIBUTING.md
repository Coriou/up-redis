# Contributing

Thanks for helping improve up-redis.

## Before opening a change

- Use an issue for significant behavior changes so the approach can be discussed.
- Report vulnerabilities privately according to [SECURITY.md](./SECURITY.md).
- Keep changes focused and preserve compatibility with the documented Redis and
  Bun support matrix.

## Local setup

You need Bun 1.3.6 or newer and a Redis-compatible backend.

```bash
bun install --frozen-lockfile
cp .env.example .env
docker compose up -d redis
bun run dev
```

Use a separate terminal for the integration suites:

```bash
bun run typecheck
bun run lint
bun run build
bun run test:unit
bun run test:integration
bun run test:compat
```

## Pull requests

- Add or update tests for observable behavior changes.
- Update README.md and CHANGELOG.md when support, configuration, security policy,
  or compatibility changes.
- Do not weaken frozen-lockfile installs or bypass failing checks.
- Keep commits free of generated build output, credentials, and unrelated changes.

By contributing, you agree that your contribution is licensed under the
[MIT License](./LICENSE).
