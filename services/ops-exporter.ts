// V1.5 Otherbridge operational metrics exporter (internal-only). Reads aggregate, non-secret
// operational tables with the least-privilege monitor role and exports Prometheus text on a
// token-protected internal listener. Never writes; never exposes wallet data or secrets.
import { connect } from "../src/data/store/postgres";
import { collectOpsMetrics } from "../src/data/observability/ops-metrics";
import {
  metricsListenerConfig,
  startMetricsServer,
} from "../src/data/observability/metrics-server";
import { logEvent } from "../src/data/observability/log";
const config = metricsListenerConfig(
  process.env,
  "OTHERBRIDGE_OPS_METRICS_PORT",
);
if (!config.enabled) {
  console.error(
    `Ops exporter configuration invalid: ${config.errors.join(",") || "OTHERBRIDGE_OPS_METRICS_PORT"}`,
  );
  process.exit(1);
}
const url = process.env.OTHERBRIDGE_DATA_MONITOR_URL;
// Without its datastore the exporter still serves invariants and db_up=0 (alerting needs that).
const sql = url
  ? connect(url, { max: 2, application: "otherbridge-ops-exporter" })
  : null;
const server = startMetricsServer(config, () => collectOpsMetrics(sql));
logEvent("ops-exporter.listening", {
  port: config.port,
  host: config.host,
  datastore: !!sql,
});
const shutdown = () => {
  server.close(
    () =>
      void (sql?.end({ timeout: 5 }) ?? Promise.resolve()).finally(() =>
        process.exit(0),
      ),
  );
  setTimeout(() => process.exit(0), 5000).unref();
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
