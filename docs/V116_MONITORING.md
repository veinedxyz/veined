# V1.16 observability and operational evidence

Dedicated authenticated metrics listeners are internal only. Prometheus scrapes every 15 seconds; local Alertmanager uses the null receiver. No email, Slack or external notification is sent. Production on-call receivers and SLOs require owner configuration. All emitted labels are bounded enums, chain IDs or existing bounded families, never addresses, tokens, credentials or raw upstream responses.

| Area | Signals | Evidence |
|---|---|---|
| App | Prometheus up, API HTTP duration/status, app_request_errors_total | authenticated TLS staging / metrics targets / request-error hook |
| Portfolio | scan duration, failure/partial state, budget/cache and endpoint health | existing scanner/DB and production smoke |
| DeFi | defi_coverage_state plus adapter duration/failure/cache/budgets | deterministic scanner tests and 24-locale production checks |
| Swap | swap_first_quote_ms, per-phase latency histogram, swap_outcome_total including timeout/rate/schema/firewall/simulation | durable hourly SQLite aggregates (48h), current stream and unit/integration tests |
| Bridge/G7 | readonly health, global kill, execution gate, write registry, contract drift | protected safety scans and mock-only G7 E2E |
| DB/API | DB reachability, indexer checkpoint age, log-window witness, limiter, API status/duration | 38 DB tests, actual restore, actual staging outage drills |
| Security | security_protected_baseline_mismatch, security_dependency_audit_regression, security_execution_flag_anomaly | exact accepted baseline hash; raw audits + lock bindings; hostile mutations |
| Kills | swap_provider_killed per mode, swap_build_killed, swap_review_killed | all nine modes and dispatch/late-response race tests |

29 alert rules (21 existing, eight V1.16) are validated with promtool firing and clearing cases. Alerts cover RPC/provider down, 429, simulation/firewall spikes, baseline mismatch, audit regression, execution anomaly, DB/API outage and existing indexer/invariant conditions. A local staging rehearsal checks scrape auth, all rule groups, TLS, headers, target health and actual DB/API stop/recovery. Receipts under operations are authoritative; synthetic rule tests are explicitly separate from live service drills.

No unconfigured hosted provider is declared healthy. Browser memory/request budgets and timeout/cancel behavior are exercised by existing Swap/DeFi tests and the responsive production UI run. Public production uptime and paid provider SLA are not asserted.

