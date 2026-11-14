# IAM and secrets architecture (V1.5) — architecture only

No cloud provider, KMS or IAM system is assumed or configured. Cloud IAM is **not complete**; this is the target design plus what is proven locally.

## Roles (future production → local proof)

| Role | Purpose | Database privileges | Local/staging proof |
|---|---|---|---|
| Deploy / read-only operator | deploy approved images, read logs/metrics | none on data; no secret read except deploy-time injection | — (no deploy performed) |
| Migration role | run up-only, checksum-pinned migrations | schema owner; used only by the migrate job/CLI | `otherbridge_owner` in local/staging only (container superuser; production must use a non-superuser owner) |
| App DB role | app server: portfolio, limiter, scan metadata | `otherbridge_api` grants (`src/data/store/grants.sql`) | DB tests: cannot delete transfers, change key status, write witnesses |
| Indexer DB role | workers | `otherbridge_indexer`: data-plane tables, append-only witnesses, own leases; no API keys/usage/backup events | DB tests |
| Data API role | developer API | `otherbridge_api` (shared with the app today; a split is a release item) | — |
| Monitoring reader | ops exporter | `otherbridge_monitor`: aggregates only; no keys, clients, usage, snapshots, transfers, token text, scan-run wallet pseudonyms or client ids (column grants) | DB tests |
| Backup role | pg_dump + its own events | `otherbridge_backup`: `pg_read_all_data` + insert `ops_backup_events`; no data writes | DB tests, restore drills |

## Secrets

- Separate secrets per environment (dev/local `.env.data.local`, staging `.env.staging.local` + `infra/staging/secrets/`), all generated locally, git-ignored, never printed (`scripts/data-db-init.mjs`, `scripts/staging.mjs init`), excluded from Docker contexts, reproduction copies and review bundles.
- Never in the browser: no `NEXT_PUBLIC_*`; the build-artifact scan finds no driver, data env names or key patterns in browser chunks.
- Database passwords are sent to PostgreSQL only as client-computed SCRAM verifiers; API keys exist only as SHA-256 verifiers; the one-time key display refuses redirected stdout unless `--stdout-json`.
- Rotation-capable: all service credentials are environment-injected; role passwords re-applied by `db:migrate`; metrics token and Grafana password replaceable by re-init; API keys revocable immediately.
- Production requirement (release gate): a secret manager/KMS with per-environment scoping, audited access, rotation, and backup-encryption key custody; managed PostgreSQL with TLS (`dataConfig` already refuses a non-private database host without `sslmode=require|verify-*` and weak passwords in public mode).

## Pseudonymization key (`OTHERBRIDGE_DATA_PSEUDONYM_KEY`)

- Required (≥ 32 characters) in public production; `dataConfig` fails closed without it; no default production key exists. Without a configured key (development only) a random per-process key is used.
- Used only for keyed HMAC wallet pseudonyms in scan metadata and short-lived snapshot caches; never in metrics.
- Rotation plan: introduce the new key, accept that pseudonyms change (scan-run linkage across the rotation boundary is lost by design), keep old data until its normal retention (snapshots 24 h, scan runs 7 days) expires, no re-hashing of raw addresses (they are not stored). Usage aggregates contain no wallet data and are unaffected. No production data exists, so no rotation was performed.
