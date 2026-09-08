# Persistence and recovery

The proxy never owns Redis persistence. The bundled Compose service mounts
`redis-data:/data` and retains the backend's default RDB snapshot policy. A
volume survives container recreation, but snapshots can lose writes made since
the last successful save. A volume is also not an off-host backup.

For records that cannot be reconstructed, use AOF with `appendfsync everysec`
together with RDB snapshots and encrypted off-host backups. This reduces the
usual crash-loss window to approximately one second; it does not guarantee zero
loss or protect against losing the host. See the
[Redis persistence guide](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/).

## Existing data: migrate while Redis is running

Do this through the backend operator console or authenticated Redis connection,
not the HTTP proxy. Its command policy intentionally blocks persistence changes.
Confirm the actual service, mounted data directory, backend version, available
disk space, and startup configuration before proceeding. A shared backend needs
one coordinated plan for every application that writes to it.

1. Record `INFO persistence`, `CONFIG GET save`, `CONFIG GET appendonly`,
   `CONFIG GET appendfsync`, `CONFIG GET dir`, and `CONFIG GET dbfilename`.
   Check persistence errors and disk capacity before creating additional files.
2. Create a fresh RDB snapshot with `BGSAVE`; wait for
   `rdb_bgsave_in_progress:0` and `rdb_last_bgsave_status:ok`. Copy that completed
   snapshot outside the live volume, record a checksum, and restore the copy into
   an isolated backend of the same version. Compare application invariants and
   representative values. Keep credentials and data out of this repository.
3. On the running backend, set `CONFIG SET appendfsync everysec`, then
   `CONFIG SET appendonly yes`. Keep all RDB snapshot settings unchanged. Wait
   until `aof_enabled:1`, `aof_rewrite_in_progress:0`,
   `aof_rewrite_scheduled:0`, `aof_last_bgrewrite_status:ok`, and
   `aof_last_write_status:ok`. Check the AOF files and disk usage.
4. Persist the matching settings in the actual startup configuration. Use
   `CONFIG REWRITE` only when Redis was started with a writable configuration
   file; command-line-only Compose deployments need their `redis-server`
   arguments updated instead. For this Compose stack, set
   `UPREDIS_REDIS_APPENDONLY=yes` only after the running rewrite succeeds; the
   service then retains AOF with every-second fsync on subsequent deployments.
   Record the existing configuration for rollback.
5. Back up and restore the completed AOF set in isolation. Redis 7+ uses a
   manifest plus base/incremental files; copying one live file is insufficient.
   Follow Redis's backup procedure to obtain a coherent set. Verify application
   invariants, then perform any planned restart and verify persistence and data
   again before declaring the migration complete.

Do not first stop an RDB-only instance and merely add `--appendonly yes` to its
startup command. AOF initialization may replace the existing dataset instead of
importing the snapshot. Enabling AOF on the running instance builds it from the
current data before a restart.

For a brand-new empty volume, startup arguments can enable AOF directly:
`redis-server --appendonly yes --appendfsync everysec`, retaining any required
authentication arguments. This repository does not enable that switch by default
because the same Compose file also upgrades existing volumes.

## Rollback

Proxy code rollback should redeploy the previous application image or commit,
without replacing or deleting the Redis volume. Persistence rollback is a
separate operation: preserve the newest data, take a verified snapshot of the
running instance, and reconcile startup configuration before disabling AOF.
Never restore an older snapshot over a live shared backend as a code rollback.
