# Runbook — monitoring

Scope: local developer profile and the staging-equivalent stack. Never paste tokens, passwords or database URLs into tickets, chat or logs.

## Start / stop

- Staging: `node scripts/staging.mjs init` (once) → `node scripts/staging.mjs up` → Prometheus `http://127.0.0.1:59090`, Alertmanager `http://127.0.0.1:59093`, Grafana `http://127.0.0.1:53000` (user `otherbridge-admin`, password in the git-ignored `.env.staging.local`). Stop: `node scripts/staging.mjs down` (volumes kept).
- Local profile: write the token from `.env.data.local` (`OTHERBRIDGE_METRICS_TOKEN`) to the git-ignored `infra/monitoring/secrets/metrics_token`, start listeners with `OTHERBRIDGE_METRICS_PORT=3291` (app), `3292` (Data API) and `pnpm data:ops-exporter` with `OTHERBRIDGE_OPS_METRICS_PORT=3293`, then `docker compose -f infra/monitoring/compose.yaml up -d`.
- Validate rules after any change: `promtool check rules` and `promtool test rules` (commands in `.github/workflows/verify.yml`, job `monitoring-rules`). Regenerate scenarios with `node .otherbridge/v15-gen-rule-tests.cjs`, dashboards with `node scripts/monitoring-dashboards.mjs`.

## Symptom → safe checks → action

| Symptom | Safe checks | Fail-closed action | Recovery condition |
|---|---|---|---|
| `OtherbridgeMetricsTargetDown` | `docker ps`, target page in Prometheus, process health endpoint | none needed for safety (no gate depends on metrics); restart the process | target `up` for 5 min |
| Security invariant alert (gate open, fee enabled, write registry, kill off, drift) | Compare `/metrics` invariant gauges on app and ops exporter; `git diff` of `src/routing/model.ts`, `src/routing/fee-policy.ts`, `src/security/firewall.ts` | **Stop the app and Data API** (`docker compose stop app data-api`); treat as security incident (`SECURITY_INCIDENT_RUNBOOK.md`) | invariants back to 0/0/0/1/0 from a reviewed build |
| Exporter `db_up 0` | `pg_isready` in the DB container; DB logs | Data API returns 503, app APIs refuse via the durable limiter; nothing to do for safety | DB healthy, `db_up 1` |
| `metrics_series_dropped_total` increasing | which metric; recent code change | none (series are dropped, not stored) | fix the label source; never raise caps to fit attacker input |
| Token rejected (401) by a listener | token file vs env (compare hashes, not values) | — | rotate: regenerate token, restart processes and Prometheus |

## Evidence to preserve

Prometheus `/api/v1/alerts` and `/api/v1/query` outputs for the affected window, Alertmanager `/api/v2/alerts`, Grafana dashboard screenshots, `docker logs` of the affected service (already redacted). Do not export Grafana with credentials embedded.

## Rotation

Metrics token: regenerate (`node scripts/staging.mjs init` after removing only the token line, or a new staging env), restart app/data-api/ops-exporter/prometheus. Grafana admin password: change in `.env.staging.local`, recreate Grafana. Production rotation belongs to the future secret manager (`docs/IAM_SECRETS_ARCHITECTURE.md`).
