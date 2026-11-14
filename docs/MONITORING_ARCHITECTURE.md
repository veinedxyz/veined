# Monitoring architecture (V1.5)

Self-hosted only (no paid monitoring dependency): Prometheus-compatible metrics, Prometheus, Alertmanager and Grafana, all pinned by tag and digest.

```text
app (Next server) ── internal listener :3291 ┐
Data API process  ── internal listener :3292 ├─ bearer token ─► Prometheus ─► Alertmanager (no external receiver)
ops exporter      ── internal listener :3293 ┘                        └────► Grafana (6 provisioned dashboards)
      └── reads aggregate tables with the least-privilege `otherbridge_monitor` role
```

## Exposure rules

- Metrics are **never** served on a public listener. V1.4's `/v1/metrics` route was removed from the public Data API (now `404` for every key); public API keys gain no operational access.
- Each process opens a separate internal listener only when `OTHERBRIDGE_METRICS_PORT` (ops exporter: `OTHERBRIDGE_OPS_METRICS_PORT`) is set. A bearer token of at least 32 URL-safe characters is mandatory (`OTHERBRIDGE_METRICS_TOKEN`, generated into git-ignored files); comparison is constant-time on SHA-256 digests; only `GET /metrics`. Bind address: loopback by default; `0.0.0.0` only inside a container network (staging) — the port is never published.
- A malformed metrics configuration stops the process (Data API exits 1; the app's instrumentation throws at start).

## Registry (`src/data/observability/metrics.ts`)

Counters, gauges and histograms (fixed latency buckets) in Prometheus text format 0.0.4 with `# HELP`/`# TYPE`. Label names and values are validated; wallet or token addresses in labels throw (`ADDRESS_IN_METRIC_LABEL`); other characters are replaced; every metric has a series cap (default 600, ops exporter 2,000) and excess series are dropped and counted in `otherbridge_metrics_series_dropped_total`. Labels come only from bounded sets: chain IDs, admitted endpoint IDs, endpoint groups, HTTP status/status class, consensus/failure enums and bounded error codes. The registry is shared per process through `globalThis`.

## Metric catalogue

| Area | Metrics |
|---|---|
| Data API | `api_requests_total{group,status,status_class}`, `api_latency_ms` histogram, `api_rate_limited_total`, `api_auth_failures_total`, `api_limiter_unavailable_total`, `data_api_db_pool_up`, `data_api_up` |
| App | `app_api_errors_total{code}`, `app_origin_rejections_total`, `portfolio_scans_total{origin,state}`, `portfolio_scan_duration_ms`, `portfolio_chains_{checked,failed,pending}_total`, `portfolio_data_plane_unavailable_total`, `app_up` |
| Security | `security_execution_gate_open` (expect 0), `security_fee_collection_enabled` (0), `security_write_registry_entries` (0), `security_global_kill_enabled` (1), `security_contract_registry_drift` (0), `security_firewall_rejections_total{reason}`, `security_kill_switch_blocks_total{code}`; invariants come from frozen code constants (`src/security/invariants.ts`), no environment variable is read |
| DB-derived (ops exporter) | `db_up`, `schema_version`, `indexer_indexed_head_block`, `indexer_chain_head_block`, `indexer_lag_blocks`, `indexer_historical_from_block`, `indexer_historical_complete`, `indexer_checkpoint_age_seconds`, `indexer_halted`, `indexer_last_error{code}`, `indexer_windows{chain,consensus}`, `witness_records{,_recent}{chain,consensus,failure}`, `indexer_lease_active`/`_held_seconds{chain,lane}`, `rpc_healthy_endpoints`, `rpc_healthy_log_endpoints`, `rpc_witness_operators`, `rpc_endpoint_latency_ms`, `rpc_endpoint_error_rate`, `rpc_endpoint_quarantined{reason}`, `rpc_admission_rejected{reason}`, `rpc_chain_id_mismatch_quarantines`, `rpc_log_mismatch_quarantines`, `tokens{metadata}`, `tokens_suspicious`, `tokens_spam`, `portfolio_scans_recent` and per-chain recent counts (from `portfolio_scan_runs` aggregate columns only — the monitor role has no privilege on `wallet_hash`, `client_id` or `id`), `backup_last_success_timestamp_seconds{kind}`, `backup_last_failure_timestamp_seconds{kind}`, `backup_events`, `ops_exporter_scrape_duration_seconds`, `ops_exporter_errors_total` |

CSP violations are recorded by the browser test harness; no public CSP report endpoint is exposed (a report sink would be a new unauthenticated write surface).

## Alert rules (`infra/monitoring/prometheus/rules/otherbridge.rules.yml`, 21 rules)

| Severity | Alerts |
|---|---|
| critical | ExecutionGateOpen, FeeCollectionEnabled, WriteRegistryPopulated, GlobalKillDisabled, LogWitnessMismatch (any MISMATCH/UNRESOLVED/tiebreak in the last hour), IndexHalted, IndexCanonicalityUnrecoverable (FINALIZED_CONFLICT/REWIND_DEPTH_EXCEEDED/REORG_LOOP and stuck > 15 min), DatabaseDown (1 min), BackupStale (no successful backup in 36 h or none recorded), BackupFailing |
| high | TierARpcAllUnhealthy (5 min), IndexerStalled (checkpoint unchanged > 600 s for 5 min), IndexLagHigh (per-chain finality tolerance), DataApi5xxElevated (> 5 % for 10 min), DurableLimiterUnavailable, ContractRuntimeDrift, MetricsTargetDown (2 min) |
| warning | WitnessDegraded (< 2 independent operators on a chain that has trusted windows), RateLimitSaturation (> 20 % for 10 min), PortfolioPartialFailures (> 10 % for 15 min), BackupAgeWarning (> 26 h) |

Threshold provenance: IndexerStalled/IndexLagHigh reuse the API's own currency rule (`current` requires lag ≤ max(64, 2·finality depth + 16) and an update within 600 s: Arbitrum 496, Avalanche 64, Ink 256, World Chain 256 blocks); BackupStale/AgeWarning follow the documented daily backup policy with 12 h / 2 h grace; PortfolioPartialFailures uses the V1.4 live baseline (4 FAILED of 150 = 2.7 %); DataApi5xx/RateLimitSaturation are conservative local values (no SLA is claimed). No external notification channel is configured.

Validation: `promtool check rules` (21 rules) and `promtool test rules` with a synthetic fire **and** clear scenario for every rule (`infra/monitoring/prometheus/tests/otherbridge.rules.test.yml`, generator `.otherbridge/v15-gen-rule-tests.cjs`) — SUCCESS. Live proof: staging drills fired and cleared DatabaseDown and MetricsTargetDown; Drill A fired LogWitnessMismatch and IndexHalted through the real ops exporter → Prometheus → Alertmanager path.

## Dashboards (`infra/monitoring/grafana/dashboards`, generated by `scripts/monitoring-dashboards.mjs`)

System overview, Data API, RPC health, Indexer and coverage, Security events, Backup and restore — 42 panels, no wallet addresses, Grafana anonymous access disabled, admin password generated.

## Profiles

- `infra/monitoring/compose.yaml`: local developer profile (Prometheus 127.0.0.1:59190, Alertmanager 127.0.0.1:59193) scraping host listeners via the Docker host gateway.
- `infra/staging/compose.yaml`: full stack (Prometheus 127.0.0.1:59090, Alertmanager 127.0.0.1:59093, Grafana 127.0.0.1:53000), scraping containers on the internal backend network.

Structured logs: JSON lines, event names and field names validated, values redacted (wallet addresses, API keys, database URLs, bearer tokens, `token=`/`password=`/`api_key=` pairs), C0/C1 controls, line separators and bidi/zero-width characters removed (no log injection), 300-character cap, request IDs preserved. Retention guidance: stdout is collected by the container runtime; keep at most 14 days locally (`docker` json-file `max-size`/`max-file` or the platform log store) and never ship logs containing request payloads.
