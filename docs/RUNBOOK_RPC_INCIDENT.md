# Runbook — RPC incident

Applies to public read-only RPC endpoints admitted into the data-plane registry. Never add an endpoint that embeds a key or credential; never accept a user-supplied RPC URL.

| Symptom (alert / signal) | Safe checks | Fail-closed behaviour already in code | Operator action | Recovery condition |
|---|---|---|---|---|
| `OtherbridgeLogWitnessMismatch` (critical) | `witness-disputes.jsonl` and `indexed_window_witnesses` rows for the chain (consensus, failure, digests, endpoint IDs, key diff); `rpc_endpoint_quarantined` | disputed window never committed; 2-of-3 tiebreak commits only the agreed set and quarantines the outvoted endpoint 1 h; unresolved → chain halted | identify the lying/lagging operator from the diff; remove or deprioritise it in the registry if repeated; keep evidence | consecutive windows MATCH; no new dispute for 1 h |
| `OtherbridgeTierARpcAllUnhealthy` | `rpc_health` rows, `pnpm data:rpc:health --chains <id>` | indexer status `NO_LOG_ENDPOINT`/errors; portfolio marks the chain FAILED/PENDING, never empty | wait for provider recovery; admit an additional vetted endpoint via `pnpm data:rpc:sync --chains <id> --no-public-registry` after provenance review | ≥ 1 healthy log endpoint (≥ 2 independent for trusted indexing) |
| `OtherbridgeWitnessDegraded` | `rpc_witness_operators{chain}` | `required` policy stops committing (`WITNESS_UNAVAILABLE`); nothing untrusted is accepted | restore a second independent operator | ≥ 2 independent operators healthy |
| `rpc_chain_id_mismatch_quarantines` > 0 | endpoint ID, admission record | endpoint quarantined 24 h on CHAIN_MISMATCH | remove the endpoint from the registry; investigate DNS/provider | — |
| Rate limiting / 429 from upstream | `rpc_endpoint_error_rate` | 30 s quarantine, bounded failover; scans report PENDING/FAILED | lower indexer cadence (`--interval`) | error rate back to baseline |
| Suspected DNS hijack of a provider hostname | admission log `UNSAFE_DNS` | non-public answers rejected before connecting (DNS pinning) | treat as security incident; keep the endpoint quarantined | provider confirms; re-admit |

Never "fix" a dispute by deleting witness rows, editing windows or resuming without investigation. `pnpm data:indexer:resume` requires a written reason and is logged.

Evidence to preserve: witness/dispute JSONL, `rpc_health` snapshot, Prometheus alert history, relevant `indexer-log.jsonl` lines. No secrets are involved (public endpoints only).

Terms: an endpoint whose provenance status is `UNKNOWN` or `LEGAL_REVIEW_REQUIRED` is usable only in local/staging profiles; the release profile admits only `APPROVED_FOR_RELEASE` operators with a legal review reference (none today). `PROHIBITED` is never used.
