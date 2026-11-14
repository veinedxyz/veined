import { writeFileSync } from "node:fs";
// Prometheus accepts JSON as YAML. Fixed synthetic fire/clear cases; no receiver is invoked.
const entries = [
  [
    "OtherbridgeSwapProviderOutage",
    'sum by (mode) (increase(otherbridge_swap_outcome_total{status=~"PROVIDER_UNAVAILABLE|HTTP_5XX|PROVIDER_TIMEOUT"}[5m])) > 4',
    "high",
    "swap",
    "Swap provider repeatedly unavailable.",
    'otherbridge_swap_outcome_total{mode="UNISWAP",status="PROVIDER_UNAVAILABLE"}',
    "0+2x10 20+0x15",
    { mode: "UNISWAP" },
  ],
  [
    "OtherbridgeSwapProviderRateLimited",
    'sum by (mode) (increase(otherbridge_swap_outcome_total{status="RATE_LIMITED"}[5m])) > 4',
    "high",
    "swap",
    "Swap provider sustained rate limiting.",
    'otherbridge_swap_outcome_total{mode="JUPITER_META",status="RATE_LIMITED"}',
    "0+2x10 20+0x15",
    { mode: "JUPITER_META" },
  ],
  [
    "OtherbridgeSimulationFailureSpike",
    'sum(increase(otherbridge_swap_outcome_total{phase="simulation",status!="OK"}[5m])) > 4',
    "high",
    "swap",
    "Unsigned simulation failures elevated.",
    'otherbridge_swap_outcome_total{phase="simulation",status="SIMULATION_FAILED"}',
    "0+2x10 20+0x15",
    {},
  ],
  [
    "OtherbridgeFirewallRejectAnomaly",
    'sum(increase(otherbridge_swap_outcome_total{phase="decode",status!="OK"}[5m])) > 4',
    "critical",
    "security",
    "Transaction firewall rejects elevated.",
    'otherbridge_swap_outcome_total{phase="decode",status="REVIEW_REQUIRED"}',
    "0+2x10 20+0x15",
    {},
  ],
  [
    "OtherbridgeProtectedBaselineMismatch",
    "max(otherbridge_security_protected_baseline_mismatch) > 0",
    "critical",
    "security",
    "Protected baseline mismatch; invalidate RC.",
    "otherbridge_security_protected_baseline_mismatch",
    "0 1+0x9 0+0x15",
    {},
  ],
  [
    "OtherbridgeDependencyAuditRegression",
    "max(otherbridge_security_dependency_audit_regression) > 0",
    "critical",
    "security",
    "Production dependency audit failed, missing or stale.",
    "otherbridge_security_dependency_audit_regression",
    "0 1+0x9 0+0x15",
    {},
  ],
  [
    "OtherbridgeExecutionFlagAnomaly",
    "max(otherbridge_security_execution_flag_anomaly) > 0",
    "critical",
    "security",
    "Execution flag unexpectedly requested.",
    "otherbridge_security_execution_flag_anomaly",
    "0 1+0x9 0+0x15",
    {},
  ],
  [
    "OtherbridgeDataApiUnavailable",
    'up{job="otherbridge-data-api"} == 0',
    "high",
    "data-api",
    "Data API metrics target unavailable.",
    'up{job="otherbridge-data-api"}',
    "1 0+0x9 1+0x15",
    { job: "otherbridge-data-api" },
  ],
];
const rules = entries.map(([alert, expr, severity, area, summary]) => ({
  alert,
  expr,
  for: "1m",
  labels: { severity, area },
  annotations: { summary, runbook: "docs/V116_INCIDENT_RESPONSE.md" },
}));
writeFileSync(
  "infra/monitoring/prometheus/rules/v116.rules.yml",
  JSON.stringify({ groups: [{ name: "otherbridge-v116", rules }] }, null, 2) +
    "\n",
);
writeFileSync(
  "infra/monitoring/prometheus/tests/v116.rules.test.yml",
  JSON.stringify(
    {
      rule_files: ["../rules/v116.rules.yml"],
      evaluation_interval: "1m",
      tests: entries.map(
        ([alert, , severity, area, summary, series, values, labels]) => ({
          interval: "1m",
          input_series: [{ series, values }],
          alert_rule_test: [
            { eval_time: "0m", alertname: alert, exp_alerts: [] },
            {
              eval_time: "8m",
              alertname: alert,
              exp_alerts: [
                {
                  exp_labels: { ...labels, severity, area },
                  exp_annotations: {
                    summary,
                    runbook: "docs/V116_INCIDENT_RESPONSE.md",
                  },
                },
              ],
            },
            { eval_time: "20m", alertname: alert, exp_alerts: [] },
          ],
        }),
      ),
    },
    null,
    2,
  ) + "\n",
);
