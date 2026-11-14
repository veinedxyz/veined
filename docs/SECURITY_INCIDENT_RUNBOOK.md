# Incident response — V1.5 additions (current)

Detection now exists locally: Prometheus alerts for security invariants (gate open, fee enabled, write registry populated, kill disabled, registry drift), RPC log-witness mismatches, halted/stalled indexers, DB down, durable limiter outages, Data API 5xx, backup staleness/failure and target-down (`docs/MONITORING_ARCHITECTURE.md`). Specific runbooks: `RUNBOOK_RPC_INCIDENT.md`, `RUNBOOK_INDEXER_INCIDENT.md`, `RUNBOOK_DATA_API_INCIDENT.md`, `RUNBOOK_BACKUP_RESTORE.md`, `RUNBOOK_MONITORING.md`, `RUNBOOK_STAGING.md`. Drills A–D were run locally (`INCIDENT_DRILL_REPORT.md`); they are not an external incident-response audit. A security-invariant alert means: stop app and Data API, keep global execution kill ON, preserve evidence, treat as INCIDENT. A witness dispute means: never delete or edit indexed data; resume only after investigation with a written reason. No production alert routing, on-call rotation or disclosure channel exists yet (release gate).

---

# Incident response

States: WARN → DEGRADED → EXECUTION_PAUSED → INCIDENT. Global execution is already paused for this delivery. Read-only asset visibility should survive an execution incident whenever evidence is trustworthy.

Monitor future contract implementation/runtime changes, protocol pause/outage, quote deviation, fee anomalies, API error rate, CSP violations and rejected transaction payload metrics. These are specified controls and registry/rejection interfaces; no production monitoring/alert service is claimed deployed.

On suspected compromise: keep global execution kill ON, scope chain/provider/protocol/token/spender blocks, stop serving affected quotes, preserve redacted timestamped request hashes and registry versions, compare the last trusted code/artifact/contract hash, and assign an incident owner. Never ask users for keys/seed phrases or initiate consolidation. Do not present stale successful observations as current route safety.

Triage data-only availability separately from wrong-spender/contract/recipient or credential exposure. The latter is INCIDENT. Rotate affected server credentials through the future secret manager; use least-privilege separated development/staging/production roles and hardware-backed administrative access. Preserve audit logs without full wallet identifiers.

Recovery requires independent validation, exact release artifacts, simulation/firewall regressions, restore/rollback drill and owner approval. Registry revalidation is mandatory after an implementation change. Communication must state verified impact and uncertainty without promising recovery. Financial/admin control requires multisig; future upgrade authority requires timelock. Do not reopen mainnet from a healthy read-only dashboard.
