# Security Policy

## Supported versions

Security fixes are provided for the latest released version of up-redis. Upgrade to
the newest release before reporting an issue that may already have been fixed.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability.

Email **hello@benjsmin.com** with:

- the affected version and deployment setup;
- reproduction steps or a proof of concept;
- the expected and observed impact; and
- any suggested mitigation, if known.

You should receive an acknowledgement within seven days. Please allow time for a
fix and coordinated disclosure before publishing details.

## Deployment responsibility

up-redis exposes the authority of its configured Redis user to anyone holding an
up-redis token. Use a strong token, TLS at the public edge, a least-privilege Redis
ACL, network restrictions, and a pinned container release. See the
[README security guidance](./README.md#security).

The built-in command blocks (dangerous commands, admin command families) are an
accident-prevention net, **not a security boundary**: scripting commands
(`EVAL`, `EVALSHA`, `FCALL`) can invoke blocked commands inside Lua, so anyone
holding a token can effectively run arbitrary Redis commands. To restrict that,
block scripting via `UPREDIS_BLOCKED_COMMANDS` and/or enforce a least-privilege
Redis ACL on the backing server (see the
[README security guidance](./README.md#security)).
