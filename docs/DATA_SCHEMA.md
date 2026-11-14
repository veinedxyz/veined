# Data schema — migration 0002_v15_hardening (current)

Additive only (new tables, defaulted/nullable columns, indexes).

| Change | Purpose |
|---|---|
| `indexed_window_witnesses` | witness evidence per window attempt: range, mode (`LIVE`/`BACKFILL`/`REVERIFY`), primary/witness/tiebreak endpoint IDs and operators, edge block hashes, counts, digests, consensus, failure, committed, observed_at. CHECK: a committed record cannot be `MISMATCH`/`UNRESOLVED`. Indexes `(chain_id, from_block, to_block)`, `(consensus, observed_at)` |
| `indexed_block_windows.witness_consensus`, `.log_digest`, `.lane` | consensus and digest of the committed log set; `live`/`backfill`; NULL consensus = committed before V1.5 |
| `indexer_checkpoints.halted_reason`, `.halted_at` | trusted-advancement pause (strict reason grammar) |
| `indexer_backfill_leases` | separate lease for the backward lane |
| `ops_backup_events` | BACKUP / VERIFY / RESTORE_DRILL outcomes (id, sha256, size, duration, sanitized detail; no secrets) |

Roles (`grants.sql`): indexer gains SELECT/INSERT (append-only) on witnesses and its backfill lease; api gains SELECT on witnesses; new `otherbridge_monitor` (aggregate operational tables only, token columns `chain_id, metadata_status, suspicious, spam`) and `otherbridge_backup` (`pg_read_all_data`, INSERT on `ops_backup_events`). Local schema: 23 tables, 43 indexes.

---

# Data schema (migration 0001_data_plane)

PostgreSQL 17 (local isolated Docker stack). All identifiers are lowercase hex or validated base58; amounts are `numeric(78,0)` integer base units; block numbers are `bigint` for indexed rows. CHECK constraints reject malformed hashes, addresses, verifiers and request IDs at the database layer as defense in depth. No private keys, seeds, signatures or plaintext API keys are stored.

| Table | Purpose | Key / notable indexes |
|---|---|---|
| `schema_migrations` | Applied version, name, SHA-256 checksum | PK version |
| `chains` | Registry record, finality policy, configured tier, verified Multicall3 | PK chain_id; unique canonical_id |
| `rpc_endpoints` | Admitted/rejected endpoints with provenance, capability and reason | unique (chain_id, url); (chain_id, status) |
| `rpc_health` | Latest health per endpoint (EWMA, quarantine) | PK endpoint_id |
| `indexer_leases` | Worker lease: owner, chain, from/to, acquired, expires | PK chain_id |
| `indexer_checkpoints` | indexed_from/through, anchor hash, head/safe, historical_complete, last_error | PK chain_id |
| `indexed_block_windows` | Committed window with to-block hash, log count, finalized flag | PK (chain_id, from_block); (chain_id, to_block) |
| `erc20_transfers` | Decoded ERC20 Transfer logs | PK (chain_id, tx_hash, log_index); (chain_id, block_number); (from_address, chain_id, block_number); (to_address, chain_id, block_number) |
| `wallet_token_discovery` | wallet↔token aggregate (first/last block, count) | PK (chain_id, wallet, token); (wallet, chain_id) |
| `tokens` | Sanitized metadata, sources, spam/suspicious, price evidence | PK (chain_id, address) |
| `native_balance_snapshots`, `wallet_balance_snapshots` | Short-lived observations keyed by keyed wallet pseudonym | PK (wallet_hash, chain_id[, token]); observed_at |
| `portfolio_scan_runs`, `portfolio_scan_coverage` | Scan metadata (pseudonymized wallet, counts, per-chain state) | PK id / (run_id, chain_id); started_at |
| `api_clients` | Client id, display name, status, plan, scopes | PK id |
| `api_keys` | Public 12-char prefix, SHA-256 verifier, status, last used | PK id; unique prefix; client_id |
| `api_usage_events` | Request id, endpoint group, status, cost units, latency bucket (no wallet) | (client_id, at); at |
| `api_usage_daily` | Aggregated usage per client/day/group | PK (client_id, day, endpoint_group) |
| `rate_limit_buckets` | Atomic fixed-window counters | PK (bucket_key, window_start); window_start |
| `api_concurrency_slots` | Concurrent request slots with expiry | PK request_id; (client_id, expires_at) |

## Roles

`grants.sql` is idempotent and re-applied after every migration run.

| Role | Local implementation | Privileges |
|---|---|---|
| migrator (`otherbridge_owner`) | Container superuser in the local stack only | Owns schema; runs migrations and admin CLI |
| indexer (`otherbridge_indexer`) | LOGIN, no superuser/createdb/createrole | SELECT all; write registry/health/checkpoints/tokens; insert/update/delete leases, windows, transfers, discovery |
| data-api/app (`otherbridge_api`) | LOGIN, no superuser | SELECT public data, keys, clients; write snapshots, usage, rate limits, slots, health, token metadata cache; UPDATE only `api_keys.last_used_at` |

Tests verify that the api role cannot delete transfers, change key status or drop tables, and that the indexer role cannot create API clients. Production must use a non-superuser migrator, TLS, no public DB port and secret-manager credentials (see SECURITY_RELEASE_GATE.md).
