// V1.5 internal-only app metrics listener (Node runtime). Enabled only when OTHERBRIDGE_METRICS_PORT
// is configured; a malformed metrics configuration stops the server instead of exposing metrics.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertReleaseStartup } = await import("./release/startup");
  assertReleaseStartup();
  // V1.14.1: opt-in DeFi metadata prewarm (static deployment facts only, never wallet state), in the background so the
  // server never waits for it and a failure only leaves those facts to be proven by the first scan.
  if (process.env.OTHERBRIDGE_DEFI_PREWARM === "1")
    void (async () => {
      const [{ getDataPlane }, { prewarmDefiMetadata }] = await Promise.all([
        import("./data/plane"),
        import("./defi/prewarm"),
      ]);
      await prewarmDefiMetadata(await getDataPlane(), { deadlineMs: 60000 });
    })().catch(() => {});
  if (!process.env.OTHERBRIDGE_METRICS_PORT) return;
  const { metricsListenerConfig, startMetricsServer } =
    await import("./data/observability/metrics-server");
  const { registry } = await import("./data/observability/metrics");
  const { securityInvariants } = await import("./security/invariants");
  const { releaseMetrics } = await import("./release/monitor");
  const config = metricsListenerConfig();
  if (!config.enabled)
    throw Error(`METRICS_CONFIG_INVALID:${config.errors.join(",")}`);
  startMetricsServer(config, () => {
    releaseMetrics();
    for (const [k, v] of Object.entries(securityInvariants()))
      registry().set(`security_${k}`, {}, v, `Frozen security invariant ${k}.`);
    registry().set("app_up", {}, 1, "App server process is serving.");
    return registry().render();
  });
}

export async function onRequestError() {
  const { registry } = await import("./data/observability/metrics");
  registry().inc("app_request_errors_total");
}
