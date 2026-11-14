# Data migrations — V1.5 (current)

`0002_v15_hardening.sql` applied on the local data plane (after a pre-migration safety dump outside the repository, SHA-256 `78283d99…b48b9`), on fresh ephemeral DB-suite databases, in staging and in every restore drill. The destructive-statement guard and checksum pinning are unchanged; restore verification now also requires every migration checksum in a backup manifest to equal the code.

---

# Data migrations

Runner: `src/data/store/migrate.ts`; command `pnpm data:db:migrate` (uses the git-ignored local migrator URL).

- Files: `src/data/store/migrations/NNNN_name.sql`, contiguous versions starting at 0001. A gap aborts.
- Up-only. There are no automatic down migrations in any environment.
- Destructive statements are rejected before execution: `DROP TABLE/SCHEMA/DATABASE/COLUMN/INDEX/VIEW/TYPE/FUNCTION/ROLE/OWNED`, `TRUNCATE`, `DELETE FROM`, `ALTER TABLE … DROP`, `ALTER … RENAME`, `REASSIGN OWNED`. A data-drop change needs a separately approved, manual operator procedure.
- `schema_migrations` stores version, name and SHA-256 checksum (CRLF-normalized). An applied file whose checksum changed → `MIGRATION_CHECKSUM_MISMATCH`; a database newer than the code → `SCHEMA_AHEAD_OF_CODE`.
- A session advisory lock serializes concurrent runners; each migration runs in its own transaction with its version row.
- Repeat runs are safe (`alreadyApplied`). `grants.sql` (not a migration) is re-applied idempotently afterwards; local roles are created/updated from git-ignored secrets.

Evidence: `evidence/otherbridge-v1-4/<run>/data/migrate-*.json` (first apply and repeat run, tables and indexes) and the PostgreSQL suite (`pnpm test:db`) which migrates a fresh ephemeral database, re-runs, detects tampering and refuses schema-ahead.
