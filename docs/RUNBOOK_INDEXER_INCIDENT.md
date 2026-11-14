# Runbook — indexer incident

| Symptom | Safe checks | Fail-closed behaviour | Operator action | Recovery condition |
|---|---|---|---|---|
| `OtherbridgeIndexHalted` | `pnpm data:verify-index` (shows `halted`, eligibility blockers); checkpoint `halted_reason` (`LOG_CONSENSUS_UNRESOLVED:<from>-<to>` or `STORED_WINDOW_MISMATCH:<from>-<to>`); dispute evidence | no window is committed for a halted chain (store refuses `CHAIN_HALTED` even with a valid lease); API marks the index not current | investigate the window with independent sources; for a stored-row mismatch keep the database untouched and escalate (possible poisoning or bug); resume only with `pnpm data:indexer:resume --chain <id> --reason '<investigation note>' --yes` | the next run commits only MATCH windows; `verify-index` PASS |
| `OtherbridgeIndexCanonicalityUnrecoverable` (FINALIZED_CONFLICT / REWIND_DEPTH_EXCEEDED / REORG_LOOP) | `last_error`, recent windows, canonical hashes from two operators | finalized history is never rewound; deep conflicts halt instead of rewinding unchecked history | escalate; compare finalized hashes from independent sources; do not delete data | verified canonical agreement |
| `OtherbridgeIndexerStalled` / `IndexLagHigh` | worker process/container status, `WITNESS_UNAVAILABLE` in logs, RPC health | Portfolio reports INDEXING/INDEX_LAGGING; balances stay direct reads | restart the worker; restore witness operators; for chains without an independent witness this is expected under `required` | checkpoint advancing; lag within tolerance |
| Worker crash / restart | `indexer_lease_active`, lease `expires_at` | a window commits atomically with its witness record or not at all; the lease expires after 60 s; a new worker resumes from the contiguous checkpoint | restart (`docker compose start indexer` / `pnpm data:indexer:run`) | `verify-index` PASS, no gap or overlap |
| Fatal misconfiguration | process exit code and first log line | non-zero exit (e.g. invalid `--witness`) before any work | fix configuration | — |

Backfill: `pnpm data:indexer:backfill --chain <id> --max-windows N --range R --witness required` extends history backward under its own lease; it never touches the live head and refuses non-finalized or non-contiguous windows.

Legacy re-verification: `pnpm data:indexer:rewitness --chain <id>` witnesses pre-V1.5 windows; a stored-row mismatch halts (no automatic rewrite).

Evidence to preserve: `verify-index-*.json`, `indexer-log.jsonl`, `witness-*.jsonl`, checkpoint row, Prometheus alerts. Never edit indexer tables by hand.
