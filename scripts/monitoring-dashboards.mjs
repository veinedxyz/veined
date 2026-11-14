// Generates the version-controlled Grafana dashboards (infra/monitoring/grafana/dashboards/*.json)
// from one reviewed query set. No wallet addresses, no secrets; queries use bounded labels only.
import { writeFileSync, mkdirSync } from "node:fs";
const ds = { type: "prometheus", uid: "otherbridge-prometheus" };
let id = 0;
const panel = (
  title,
  expr,
  kind = "timeseries",
  w = 12,
  unit = "short",
  legend = "",
) => ({
  id: ++id,
  title,
  type: kind,
  datasource: ds,
  gridPos: { h: 8, w, x: 0, y: 0 },
  fieldConfig: { defaults: { unit }, overrides: [] },
  options:
    kind === "stat"
      ? { reduceOptions: { calcs: ["lastNotNull"] }, colorMode: "value" }
      : {},
  targets: [{ refId: "A", expr, legendFormat: legend, datasource: ds }],
});
const layout = (panels) => {
  let x = 0,
    y = 0;
  for (const p of panels) {
    if (x + p.gridPos.w > 24) {
      x = 0;
      y += 8;
    }
    p.gridPos.x = x;
    p.gridPos.y = y;
    x += p.gridPos.w;
  }
  return panels;
};
const dashboard = (uid, title, panels) => ({
  uid,
  title,
  tags: ["otherbridge", "v1.5"],
  timezone: "utc",
  schemaVersion: 39,
  version: 1,
  editable: false,
  refresh: "30s",
  time: { from: "now-6h", to: "now" },
  panels: layout(panels),
});
const boards = [
  dashboard("ob-overview", "Otherbridge — System overview", [
    panel(
      "Targets up",
      'up{job=~"otherbridge-.*"}',
      "stat",
      6,
      "short",
      "{{job}}",
    ),
    panel("Database up", "max(otherbridge_db_up)", "stat", 6),
    panel("Schema version", "max(otherbridge_schema_version)", "stat", 6),
    panel(
      "Firing alerts",
      'count(ALERTS{alertstate="firing"}) or vector(0)',
      "stat",
      6,
    ),
    panel(
      "Execution gate open (expect 0)",
      "max(otherbridge_security_execution_gate_open)",
      "stat",
      6,
    ),
    panel(
      "Fee collection (expect 0)",
      "max(otherbridge_security_fee_collection_enabled)",
      "stat",
      6,
    ),
    panel(
      "Write registry entries (expect 0)",
      "max(otherbridge_security_write_registry_entries)",
      "stat",
      6,
    ),
    panel(
      "Global kill (expect 1)",
      "min(otherbridge_security_global_kill_enabled)",
      "stat",
      6,
    ),
    panel(
      "Indexer lag (blocks)",
      "otherbridge_indexer_lag_blocks",
      "timeseries",
      12,
      "short",
      "{{chain}}",
    ),
    panel(
      "Data API requests/s by class",
      "sum by (status_class) (rate(otherbridge_api_requests_total[5m]))",
      "timeseries",
      12,
      "reqps",
      "{{status_class}}",
    ),
  ]),
  dashboard("ob-data-api", "Otherbridge — Data API", [
    panel(
      "Requests/s by group",
      "sum by (group) (rate(otherbridge_api_requests_total[5m]))",
      "timeseries",
      12,
      "reqps",
      "{{group}}",
    ),
    panel(
      "p95 latency (ms)",
      "histogram_quantile(0.95, sum by (le, group) (rate(otherbridge_api_latency_ms_bucket[5m])))",
      "timeseries",
      12,
      "ms",
      "{{group}}",
    ),
    panel(
      "4xx / 5xx ratio",
      'sum by (status_class) (rate(otherbridge_api_requests_total{status_class=~"4xx|5xx"}[5m])) / ignoring(status_class) group_left sum(rate(otherbridge_api_requests_total[5m]))',
      "timeseries",
      12,
      "percentunit",
      "{{status_class}}",
    ),
    panel(
      "429 rate-limited/s",
      "sum by (group) (rate(otherbridge_api_rate_limited_total[5m]))",
      "timeseries",
      12,
      "reqps",
      "{{group}}",
    ),
    panel(
      "Auth failures/s",
      "sum by (group) (rate(otherbridge_api_auth_failures_total[5m]))",
      "timeseries",
      12,
      "reqps",
      "{{group}}",
    ),
    panel(
      "Durable limiter unavailable",
      "sum(increase(otherbridge_api_limiter_unavailable_total[15m]))",
      "stat",
      6,
    ),
    panel(
      "Datastore pool up",
      "max(otherbridge_data_api_db_pool_up)",
      "stat",
      6,
    ),
  ]),
  dashboard("ob-rpc", "Otherbridge — RPC health", [
    panel(
      "Healthy endpoints per chain",
      "otherbridge_rpc_healthy_endpoints",
      "timeseries",
      12,
      "short",
      "{{chain}}",
    ),
    panel(
      "Independent witness operators per chain",
      "otherbridge_rpc_witness_operators",
      "timeseries",
      12,
      "short",
      "{{chain}}",
    ),
    panel(
      "Endpoint latency (ms)",
      'otherbridge_rpc_endpoint_latency_ms{chain=~"42161|43114|57073|480"}',
      "timeseries",
      12,
      "ms",
      "{{endpoint}}",
    ),
    panel(
      "Endpoint error rate",
      'otherbridge_rpc_endpoint_error_rate{chain=~"42161|43114|57073|480"}',
      "timeseries",
      12,
      "percentunit",
      "{{endpoint}}",
    ),
    panel(
      "Quarantined endpoints",
      "sum by (reason) (otherbridge_rpc_endpoint_quarantined)",
      "timeseries",
      12,
      "short",
      "{{reason}}",
    ),
    panel(
      "Chain-ID / log mismatch quarantines",
      "otherbridge_rpc_chain_id_mismatch_quarantines + otherbridge_rpc_log_mismatch_quarantines",
      "stat",
      6,
    ),
    panel(
      "Admission rejections by reason",
      "otherbridge_rpc_admission_rejected",
      "timeseries",
      12,
      "short",
      "{{reason}}",
    ),
  ]),
  dashboard("ob-indexer", "Otherbridge — Indexer and coverage", [
    panel(
      "Indexed head",
      "otherbridge_indexer_indexed_head_block",
      "timeseries",
      12,
      "short",
      "{{chain}}",
    ),
    panel(
      "Checkpoint age (s)",
      "otherbridge_indexer_checkpoint_age_seconds",
      "timeseries",
      12,
      "s",
      "{{chain}}",
    ),
    panel(
      "Windows by witness consensus",
      "otherbridge_indexer_windows",
      "timeseries",
      12,
      "short",
      "{{chain}} {{consensus}}",
    ),
    panel(
      "Witness records (last hour)",
      "otherbridge_witness_records_recent",
      "timeseries",
      12,
      "short",
      "{{chain}} {{consensus}} {{failure}}",
    ),
    panel(
      "Halted chains",
      "otherbridge_indexer_halted",
      "timeseries",
      12,
      "short",
      "{{chain}}",
    ),
    panel(
      "Historical lane: oldest indexed block",
      "otherbridge_indexer_historical_from_block",
      "timeseries",
      12,
      "short",
      "{{chain}}",
    ),
    panel(
      "Active leases",
      "otherbridge_indexer_lease_active",
      "timeseries",
      12,
      "short",
      "{{chain}} {{lane}}",
    ),
  ]),
  dashboard("ob-security", "Otherbridge — Security events", [
    panel(
      "Security invariants",
      '{__name__=~"otherbridge_security_.*"}',
      "timeseries",
      24,
      "short",
      "{{__name__}}",
    ),
    panel(
      "Firewall rejections by reason",
      "sum by (reason) (increase(otherbridge_security_firewall_rejections_total[1h]))",
      "timeseries",
      12,
      "short",
      "{{reason}}",
    ),
    panel(
      "Kill-switch blocks",
      "sum by (code) (increase(otherbridge_security_kill_switch_blocks_total[1h]))",
      "timeseries",
      12,
      "short",
      "{{code}}",
    ),
    panel(
      "Origin rejections",
      "sum(increase(otherbridge_app_origin_rejections_total[1h]))",
      "timeseries",
      12,
    ),
    panel(
      "App API errors by code",
      "sum by (code) (increase(otherbridge_app_api_errors_total[1h]))",
      "timeseries",
      12,
      "short",
      "{{code}}",
    ),
    panel(
      "Suspicious / spam tokens",
      "sum(otherbridge_tokens_suspicious) or vector(0)",
      "stat",
      6,
    ),
    panel(
      "RPC admission rejections (SSRF/DNS/URL)",
      "sum(otherbridge_rpc_admission_rejected)",
      "stat",
      6,
    ),
  ]),
  dashboard("ob-backup", "Otherbridge — Backup and restore", [
    panel(
      "Hours since last successful backup",
      'clamp_min((time() - max(otherbridge_backup_last_success_timestamp_seconds{kind="BACKUP"})) / 3600, 0)',
      "stat",
      8,
      "h",
    ),
    panel(
      "Hours since last restore drill",
      'clamp_min((time() - max(otherbridge_backup_last_success_timestamp_seconds{kind="RESTORE_DRILL"})) / 3600, 0)',
      "stat",
      8,
      "h",
    ),
    panel(
      "Last backup failure (unix)",
      'max(otherbridge_backup_last_failure_timestamp_seconds{kind="BACKUP"}) or vector(0)',
      "stat",
      8,
    ),
    panel(
      "Backup events",
      "otherbridge_backup_events",
      "timeseries",
      24,
      "short",
      "{{kind}} ok={{ok}}",
    ),
  ]),
];
mkdirSync("infra/monitoring/grafana/dashboards", { recursive: true });
for (const b of boards)
  writeFileSync(
    `infra/monitoring/grafana/dashboards/${b.uid}.json`,
    JSON.stringify(b, null, 2) + "\n",
  );
console.log(
  JSON.stringify({ dashboards: boards.map((b) => b.uid), panels: id }),
);
