# Runbook — backup and restore

Tooling: `services/backup.ts` via `pnpm data:backup:<cmd>` (`create`, `verify`, `list`, `restore-test`, `corruption-test`, `prune`, `drill-cleanup`). Environment: `OTHERBRIDGE_BACKUP_ENV=local|staging` (selects the source container), `OTHERBRIDGE_BACKUP_DIR` (default `../otherbridge-backups/<env>`; a directory inside the repository is refused), optional `OTHERBRIDGE_BACKUP_ENCRYPTION_KEY_FILE` (32-byte base64 key file outside the repository).

## What a backup is

`pg_dump -Fc -Z 6 --no-owner` run **inside** the database container as the least-privilege `otherbridge_backup` role (member of `pg_read_all_data`, may only insert `ops_backup_events`) over the local socket — no password on any command line. Contents: schema and all tables (chains, RPC registry/health, checkpoints, windows, witness evidence, transfers/discovery, tokens, scan metadata, API clients, API key **verifiers**, usage, limiter state, migrations). Plaintext API keys never exist in the database; `verify` scans every backup for API-key, credential-URL and private-key patterns — both the archive bytes and the **decompressed** SQL rendering (`pg_restore -f -`, streamed), because table data is compressed inside a custom-format dump — and fails on any hit.

Manifest (`manifest.json`, no secret values): id, createdAt, environment, source container/database/host label, PostgreSQL and pg_dump versions, schema version and code migration checksums, format, file, size, SHA-256 (file and plain dump), encryption status, critical-table row counts, structure summary (tables, indexes, constraints, checkpoints, witness consensus, key status counts), duration.

## Daily operation

1. `pnpm data:backup:create` → records a `BACKUP` event (monitoring: `backup_last_success_timestamp_seconds`).
2. `pnpm data:backup:verify --id <id>`: size + SHA-256, decrypt (if encrypted) + dump hash, schema version and every migration checksum equal to the code, full sequential archive read (`pg_restore -f -`, streamed through the secret scanner), table-of-contents check for all critical tables, plaintext-secret scan of archive and rendering. Every restore drill additionally plants a key-shaped value in a probe table on the isolated copy and proves that a raw archive scan cannot see it while the rendered scan does (`checks.secretScanCoversTableData`). Records `VERIFY`.
3. `pnpm data:backup:prune --keep 14` is a **dry run**; deletion needs `--apply --yes` and only removes directories that parse as tool-created backups. This goal never applied a prune.

## Restore drill (never onto an existing database)

`pnpm data:backup:restore-test --id <id> [--keep --port 55481]` verifies first, then creates a **new uniquely named** container `otherbridge-restore-drill-<hex>` with a new volume, loopback-only port and generated password (env file deleted immediately), creates the four service roles with fresh passwords, runs `pg_restore --no-owner --no-privileges --exit-on-error --single-transaction`, re-applies `grants.sql`, and compares schema version, row counts and structure with the manifest (key-order-insensitive: aggregate key order legitimately differs between a source and its restored copy). A target that already exists is refused; the target name must start with `otherbridge-restore-`. `--keep` leaves the instance for service checks; `pnpm data:backup:drill-cleanup --handoff <file>` removes only drill-labelled containers/volumes.

`scripts/v15-restore-drill.mjs` is the full drill: drill API client with one active and one revoked key → backup → verify → isolated restore → Data API booted read-only on the restored copy (active key 200, revoked key 401) → `verify-index` → indexer resumes from the restored checkpoint with `required` witness → fresh balance read (observed block newer than the backup checkpoint) → corruption cases → prune dry run → cleanup → drill key revoked.

Measured locally (2026-10-04, 17.5 MB dump): `pg_restore` 28.5 s, whole drill 35.8 s; staging swap (Drill D) 38.4 s. Local measurements only, **not an SLA**.

## Corruption handling (`backup:corruption-test`)

Byte flip → `BACKUP_HASH_MISMATCH`; truncation → `BACKUP_SIZE_MISMATCH`; truncation with a forged manifest hash → `BACKUP_ARCHIVE_CORRUPT` (full archive read); wrong schema version → `BACKUP_SCHEMA_VERSION_MISMATCH`; migration checksum mismatch → `BACKUP_MIGRATION_CHECKSUM_MISMATCH`. All are refused **before** any restore target exists; the source database is unchanged.

## Staging swap (Drill D)

Stop writers (indexer, rpc-health) → backup → verify → stop services → start PostgreSQL on a **new** volume (`OTHERBRIDGE_STAGING_PG_VOLUME=otherbridge-staging-pgdata-restored-<id>`) → `pg_restore` → `db:migrate` (roles, checksums, grants) → compare with the manifest → start services → `verify-index`, API key, app, indexer resume → new backup. The previous volume is kept.

## Encryption and key custody

Local/staging backups contain synthetic or public-chain data and are unencrypted by default (manifest says so). AES-256-GCM (`src/data/backup/crypto.ts`) is implemented and tested (round trip, tamper, truncation, wrong key). Production requires encrypted backups with keys from a KMS/secret manager under operator custody — **release gate, not approved**. No cloud KMS is assumed.

## Restore semantics

A restore never makes stale balances current: balances and portfolio values are always fresh `balanceOf`/`eth_getBalance` reads; snapshot tables are short-lived caches with retention. The indexer resumes contiguously from the restored checkpoint; witness evidence is preserved; API key verifiers and revocations are preserved.

## Evidence to preserve / no secret disclosure

Manifest, verify result, restore-drill JSON (`evidence/.../backup/`), `ops_backup_events` rows. Never copy `.env*`, drill handoff files or dumps into evidence or review bundles (dumps live outside the repository).
