// V1.16 local staging-equivalent smoke (production security semantics) through the TLS ingress.
// Read-only: no wallet, no signature, no write. Public burn address only for portfolio reads.
import { request } from "node:https";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";
const root = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/v15"}/staging`;
await mkdir(`${root}/screenshots`, { recursive: true });
const APP = "app.otherbridge.localhost",
  API = "api.otherbridge.localhost",
  ORIGIN = `https://${APP}:8443`;
const PUBLIC_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const env = Object.fromEntries(
  (await readFile(".env.staging.local", "utf8"))
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
);
const sh = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, {
    encoding: "utf8",
    timeout: opts.timeout ?? 600000,
    input: opts.input,
  });
  return {
    code: r.status,
    out: (r.stdout ?? "").trim(),
    err: (r.stderr ?? "").trim(),
  };
};
const compose = [
  "compose",
  "--env-file",
  ".env.staging.local",
  "-f",
  "infra/staging/compose.yaml",
];
const ca = sh("docker", [
  "exec",
  "otherbridge-staging-proxy",
  "cat",
  "/data/caddy/pki/authorities/local/root.crt",
]).out;
assert.match(ca, /BEGIN CERTIFICATE/);
const https = (host, path, { method = "GET", headers = {}, body } = {}) =>
  new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port: 8443,
        servername: host,
        ca,
        method,
        path,
        headers: { host: `${host}:8443`, ...headers },
        timeout: 60000,
      },
      (res) => {
        let data = "";
        res.on("data", (d) => (data += d));
        res.on("end", () => {
          let json = null;
          try {
            json = JSON.parse(data);
          } catch {}
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: data,
            json,
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(Error("TIMEOUT")));
    if (body) req.end(typeof body === "string" ? body : JSON.stringify(body));
    else req.end();
  });
const prom = async (q) =>
  (
    await (
      await fetch(
        `http://127.0.0.1:59090/api/v1/query?query=${encodeURIComponent(q)}`,
      )
    ).json()
  ).data.result;
const alerts = async () =>
  (await (await fetch("http://127.0.0.1:59093/api/v2/alerts")).json()).map(
    (a) => ({
      name: a.labels.alertname,
      chain: a.labels.chain ?? null,
      state: a.status.state,
    }),
  );
const waitFor = async (fn, ms, step = 5000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) return null;
    await new Promise((r) => setTimeout(r, step));
  }
};
const out = { startedAt: new Date().toISOString(), checks: {}, drills: {} };
const check = (name, ok, detail) => {
  out.checks[name] = { ok: !!ok, detail };
  if (!ok)
    console.error(
      `CHECK FAILED ${name}: ${JSON.stringify(detail).slice(0, 400)}`,
    );
};
const dataCli = (args) =>
  sh("docker", [
    ...compose,
    "run",
    "--rm",
    "--no-deps",
    "-T",
    "migrate",
    "node",
    "scripts/data.mjs",
    ...args,
  ]);
try {
  // Topology: DB unpublished on an internal network; only loopback publications exist.
  const ports = sh("docker", [
    "ps",
    "--filter",
    "name=otherbridge-staging",
    "--format",
    "{{.Names}}|{{.Ports}}",
  ]).out.split("\n");
  const published = ports.flatMap((l) =>
    [...l.matchAll(/(\d+\.\d+\.\d+\.\d+|\[::\]):(\d+)->/g)].map(
      (m) => `${l.split("|")[0]} ${m[1]}:${m[2]}`,
    ),
  );
  const backendInternal = sh("docker", [
    "network",
    "inspect",
    "otherbridge-staging-backend",
    "--format",
    "{{.Internal}}",
  ]).out;
  check(
    "topology.loopback-only",
    published.every((p) => p.includes(" 127.0.0.1:")),
    published,
  );
  check(
    "topology.db-unpublished",
    sh("docker", ["port", "otherbridge-staging-postgres"]).out === "",
    "no host port",
  );
  check(
    "topology.backend-internal",
    backendInternal === "true",
    backendInternal,
  );
  const hardening = JSON.parse(
    sh("docker", [
      "inspect",
      "otherbridge-staging-app",
      "otherbridge-staging-data-api",
      "otherbridge-staging-indexer",
      "otherbridge-staging-postgres",
      "otherbridge-staging-ops-exporter",
    ]).out,
  ).map((c) => ({
    name: c.Name,
    user: c.Config.User,
    readOnly: c.HostConfig.ReadonlyRootfs,
    capDrop: c.HostConfig.CapDrop,
    noNewPriv: (c.HostConfig.SecurityOpt ?? []).includes(
      "no-new-privileges:true",
    ),
    memory: c.HostConfig.Memory,
  }));
  check(
    "hardening.containers",
    hardening.every(
      (h) =>
        h.readOnly &&
        h.noNewPriv &&
        (h.capDrop ?? []).includes("ALL") &&
        h.user &&
        h.user !== "root" &&
        h.user !== "0" &&
        h.memory > 0,
    ),
    hardening,
  );
  // App pages over TLS with strict production CSP.
  const home = await https(APP, "/");
  const csp = home.headers["content-security-policy"] ?? "";
  check("app.home", home.status === 200, home.status);
  check(
    "app.csp",
    !/unsafe-inline|unsafe-eval/.test(csp) &&
      /style-src-attr 'none'/.test(csp) &&
      /'strict-dynamic'/.test(csp),
    csp.replace(/'nonce-[^']+'/g, "'nonce-*'"),
  );
  check(
    "app.hsts",
    /max-age=31536000/.test(home.headers["strict-transport-security"] ?? ""),
    home.headers["strict-transport-security"],
  );
  for (const p of [
    "/swap",
    "/portfolio",
    "/networks",
    "/activity",
    "/settings",
    "/help",
  ])
    check(`app.page${p}`, (await https(APP, p)).status === 200, p);
  // 24 locales boot with correct lang/dir.
  const locales = [
    "tr",
    "en",
    "es",
    "pt-BR",
    "fr",
    "de",
    "it",
    "nl",
    "pl",
    "ru",
    "uk",
    "ar",
    "fa",
    "he",
    "ur",
    "zh-CN",
    "zh-TW",
    "ja",
    "ko",
    "hi",
    "bn",
    "id",
    "vi",
    "th",
  ];
  const localeRows = [];
  for (const l of locales) {
    const r = await https(APP, "/", {
      headers: { cookie: `otherbridge.locale=${l}` },
    });
    const lang = /<html lang="([^"]+)" dir="([^"]+)"/.exec(r.text);
    localeRows.push({ l, status: r.status, lang: lang?.[1], dir: lang?.[2] });
  }
  check(
    "locales.24",
    localeRows.every(
      (x) =>
        x.status === 200 &&
        x.lang === x.l &&
        x.dir === (["ar", "fa", "he", "ur"].includes(x.l) ? "rtl" : "ltr"),
    ),
    localeRows,
  );
  // Bridge read-only configuration.
  const bridge = await https(APP, "/api/bridge");
  check(
    "bridge.readonly",
    bridge.status === 200 &&
      bridge.json?.mode === "mainnet-readonly" &&
      bridge.json?.submission === false,
    bridge.json,
  );
  // Origin policy / proxy trust at the application layer.
  const post = (path, body, headers = {}) =>
    https(APP, path, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: ORIGIN,
        ...headers,
      },
      body,
    });
  const portfolio = await post("/api/portfolio", {
    identity: { evm: PUBLIC_ADDRESS },
    consent: true,
  });
  check(
    "portfolio.readonly",
    portfolio.status === 200 && Array.isArray(portfolio.json?.coverage),
    {
      status: portfolio.status,
      state: portfolio.json?.state,
      summary: portfolio.json?.coverageSummary,
      source: portfolio.json?.source,
    },
  );
  const origins = {
    foreign: await post(
      "/api/portfolio",
      { identity: { evm: PUBLIC_ADDRESS }, consent: true },
      { origin: "https://evil.example" },
    ),
    trailingSlash: await post(
      "/api/portfolio",
      { identity: { evm: PUBLIC_ADDRESS }, consent: true },
      { origin: `${ORIGIN}/` },
    ),
    noPort: await post(
      "/api/portfolio",
      { identity: { evm: PUBLIC_ADDRESS }, consent: true },
      { origin: `https://${APP}` },
    ),
    httpScheme: await post(
      "/api/portfolio",
      { identity: { evm: PUBLIC_ADDRESS }, consent: true },
      { origin: `http://${APP}:8443` },
    ),
    spoofedForwarded: await post(
      "/api/portfolio",
      { identity: { evm: PUBLIC_ADDRESS }, consent: true },
      {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "http",
        "x-forwarded-for": "1.2.3.4, 5.6.7.8",
      },
    ),
    noOrigin: await https(APP, "/api/portfolio", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: { identity: { evm: PUBLIC_ADDRESS }, consent: true },
    }),
  };
  const originStatus = Object.fromEntries(
    Object.entries(origins).map(([k, v]) => [k, v.status]),
  );
  check(
    "proxy-trust.origin",
    originStatus.foreign === 403 &&
      originStatus.trailingSlash === 403 &&
      originStatus.noPort === 403 &&
      originStatus.httpScheme === 403 &&
      originStatus.noOrigin === 403,
    originStatus,
  );
  // Caddy replaces client X-Forwarded-*; the spoofed request is processed as a normal same-origin call.
  check(
    "proxy-trust.spoofed-forwarded-ignored",
    [200, 429].includes(originStatus.spoofedForwarded),
    originStatus.spoofedForwarded,
  );
  // Swap / Bridge quotes (live upstream, read-only): availability is recorded, never assumed.
  const catalog = await post("/api/routing", { action: "catalog" });
  const quotes = {};
  if (catalog.status === 200)
    for (const [mode, destination, destinationAsset] of [
      ["swap", "1", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
      ["bridge", "8453", "0x0000000000000000000000000000000000000000"],
    ]) {
      const q = await post("/api/routing", {
        action: "quote",
        input: {
          source: "1",
          destination,
          sourceAsset: "0x0000000000000000000000000000000000000000",
          destinationAsset,
          amount: "10000000000000000",
          sourceAddress: PUBLIC_ADDRESS,
          destinationAddress: PUBLIC_ADDRESS,
          generation: catalog.json.generation,
          slippage: 0.005,
          preference: "receive",
          walletRevision: 0,
          mode,
          portfolioRevision: portfolio.json?.revision,
        },
      });
      quotes[mode] = {
        status: q.status,
        count: Array.isArray(q.json) ? q.json.length : 0,
        error: q.json?.error ?? null,
        allNonExecutable: Array.isArray(q.json)
          ? q.json.every((x) => x.executable === false)
          : null,
        fee: Array.isArray(q.json)
          ? q.json.every(
              (x) => x.platformFee.bps === 0 && x.platformFee.amount === "0",
            )
          : null,
      };
    }
  // Live upstream availability is recorded, not required; any returned quote must be non-executable at 0 bps.
  check(
    "routing.readonly-quotes",
    catalog.status === 200 &&
      Object.values(quotes).every(
        (q) =>
          q.status !== 200 || (q.allNonExecutable === true && q.fee === true),
      ),
    { catalog: catalog.status, quotes },
  );
  // Data API through the ingress: auth, revoked key, limiter.
  const client = JSON.parse(
    dataCli([
      "client:create",
      "--name",
      "V15 staging smoke",
      "--plan",
      "developer",
      "--scopes",
      "chains:read,balances:read",
    ])
      .out.split("\n")
      .pop(),
  );
  const mk = () =>
    JSON.parse(
      dataCli([
        "key:create",
        "--client",
        client.clientId,
        "--yes",
        "--stdout-json",
        "--test",
      ])
        .out.split("\n")
        .pop(),
    );
  const active = mk(),
    revoked = mk();
  dataCli(["key:revoke", "--key", revoked.prefix]);
  const apiHealth = await https(API, "/v1/health");
  const noKey = await https(API, "/v1/chains?limit=2");
  const withKey = await https(API, "/v1/chains?limit=2", {
    headers: { authorization: `Bearer ${active.apiKey}` },
  });
  const revokedKey = await https(API, "/v1/chains?limit=2", {
    headers: { authorization: `Bearer ${revoked.apiKey}` },
  });
  const publicMetrics = await https(API, "/v1/metrics", {
    headers: { authorization: `Bearer ${active.apiKey}` },
  });
  const coverage = await https(API, "/v1/chains/57073/coverage", {
    headers: { authorization: `Bearer ${active.apiKey}` },
  });
  check(
    "data-api.health",
    apiHealth.status === 200 && apiHealth.json?.data?.status === "ok",
    apiHealth.json,
  );
  check(
    "data-api.auth",
    noKey.status === 401 && withKey.status === 200 && revokedKey.status === 401,
    {
      noKey: noKey.status,
      withKey: withKey.status,
      revoked: revokedKey.status,
    },
  );
  check(
    "data-api.no-public-metrics",
    publicMetrics.status === 404,
    publicMetrics.status,
  );
  check(
    "data-api.coverage-integrity",
    coverage.status === 200 && !!coverage.json?.data?.index?.integrity,
    coverage.json?.data?.index?.integrity,
  );
  const burst = await Promise.all(
    Array.from({ length: 80 }, () =>
      https(API, "/v1/chains?limit=1", {
        headers: { authorization: `Bearer ${active.apiKey}` },
      }),
    ),
  );
  const burstCodes = burst.reduce(
    (m, r) => ((m[r.status] = (m[r.status] ?? 0) + 1), m),
    {},
  );
  check(
    "data-api.durable-limiter",
    (burstCodes[429] ?? 0) > 0 && (burstCodes[500] ?? 0) === 0,
    burstCodes,
  );
  // Metrics: internal-only with token; scrape healthy; rules loaded; invariants.
  const noToken = sh("docker", [
    "exec",
    "otherbridge-staging-prometheus",
    "wget",
    "-S",
    "-qO-",
    "http://app:3291/metrics",
  ]);
  check(
    "metrics.token-required",
    /401/.test(noToken.err),
    noToken.err.split("\n").find((l) => /HTTP/.test(l)),
  );
  const targets = (
    await (await fetch("http://127.0.0.1:59090/api/v1/targets")).json()
  ).data.activeTargets.map((t) => ({ job: t.labels.job, health: t.health }));
  check(
    "metrics.targets-up",
    targets.length >= 4 && targets.every((t) => t.health === "up"),
    targets,
  );
  const rules = (
    await (await fetch("http://127.0.0.1:59090/api/v1/rules")).json()
  ).data.groups;
  check(
    "alerts.rules-loaded",
    rules.length === 4 &&
      rules.reduce((s, g) => s + g.rules.length, 0) === 29 &&
      rules.some((g) => g.name === "otherbridge-v116" && g.rules.length === 8),
    rules.map((g) => `${g.name}:${g.rules.length}`),
  );
  for (const name of [
    "security_protected_baseline_mismatch",
    "security_dependency_audit_regression",
    "security_execution_flag_anomaly",
  ]) {
    const values = await prom("otherbridge_" + name);
    check(
      "v116." + name,
      values.length > 0 && values.every((v) => Number(v.value[1]) === 0),
      values.map((v) => v.value[1]),
    );
  }
  const inv = {};
  for (const k of [
    "execution_gate_open",
    "fee_collection_enabled",
    "write_registry_entries",
    "global_kill_enabled",
    "contract_registry_drift",
  ])
    inv[k] = (await prom(`otherbridge_security_${k}`)).map(
      (r) => `${r.metric.job}=${r.value[1]}`,
    );
  check(
    "security.invariants",
    inv.execution_gate_open.every((v) => v.endsWith("=0")) &&
      inv.fee_collection_enabled.every((v) => v.endsWith("=0")) &&
      inv.write_registry_entries.every((v) => v.endsWith("=0")) &&
      inv.global_kill_enabled.every((v) => v.endsWith("=1")) &&
      inv.global_kill_enabled.length >= 2,
    inv,
  );
  const witness = await prom("otherbridge_indexer_windows");
  out.witnessMetrics = witness.map((r) => ({
    chain: r.metric.chain,
    consensus: r.metric.consensus,
    value: r.value[1],
  }));
  // Browser: pages through the ingress, zero CSP violations; Grafana + Alertmanager screenshots.
  const browser = await chromium.launch({
    args: [`--host-resolver-rules=MAP ${APP} 127.0.0.1, MAP ${API} 127.0.0.1`],
  });
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__csp.push(e.effectiveDirective),
    );
  });
  const violations = {};
  for (const p of ["/", "/swap", "/portfolio", "/networks"]) {
    await page.goto(`${ORIGIN}${p}`, { waitUntil: "networkidle" });
    violations[p] = await page.evaluate(() => window.__csp);
    await page.screenshot({
      path: `${root}/screenshots/staging${p === "/" ? "-bridge" : p.replace("/", "-")}.png`,
    });
  }
  check(
    "browser.csp-through-ingress",
    Object.values(violations).every((v) => v.length === 0),
    violations,
  );
  const g = await context.newPage();
  await g.goto("http://127.0.0.1:53000/login");
  await g.fill('input[name="user"]', "otherbridge-admin");
  await g.fill(
    'input[name="password"]',
    env.OTHERBRIDGE_GRAFANA_ADMIN_PASSWORD,
  );
  await g.click('button[type="submit"]');
  await g.waitForURL(/\/(\?|$|d\/)/, { timeout: 30000 }).catch(() => {});
  for (const uid of ["ob-overview", "ob-indexer", "ob-security", "ob-backup"]) {
    await g
      .goto(
        `http://127.0.0.1:53000/d/${uid}?orgId=1&from=now-1h&to=now&kiosk`,
        { waitUntil: "networkidle" },
      )
      .catch(() => {});
    await g.waitForTimeout(4000);
    await g.screenshot({ path: `${root}/screenshots/grafana-${uid}.png` });
  }
  const anon = await fetch(
    "http://127.0.0.1:53000/api/dashboards/uid/ob-overview",
  );
  check("grafana.no-anonymous", anon.status === 401, anon.status);
  await browser.close();
  // Drill B: database unavailable -> Data API degrades, app limiter fails closed, alert fires; recovery.
  sh("docker", ["stop", "otherbridge-staging-postgres"]);
  const dbDownHealth = await waitFor(
    async () => {
      const r = await https(API, "/v1/health");
      return r.json?.data?.status === "degraded" ? r : null;
    },
    30000,
    2000,
  );
  const dbDownApi = await https(API, "/v1/chains?limit=1", {
    headers: { authorization: `Bearer ${active.apiKey}` },
  });
  const dbDownPortfolio = await post("/api/portfolio", {
    identity: { evm: PUBLIC_ADDRESS },
    consent: true,
  });
  const dbDownPage = await https(APP, "/");
  const dbAlert = await waitFor(
    async () =>
      (await alerts()).some(
        (a) => a.name === "OtherbridgeDatabaseDown" && a.state === "active",
      )
        ? await alerts()
        : null,
    240000,
  );
  sh("docker", ["start", "otherbridge-staging-postgres"]);
  const recovered = await waitFor(
    async () => {
      const r = await https(API, "/v1/chains?limit=1", {
        headers: { authorization: `Bearer ${active.apiKey}` },
      });
      return r.status === 200 ? r.status : null;
    },
    120000,
    3000,
  );
  const dbAlertCleared = await waitFor(
    async () =>
      !(await alerts()).some(
        (a) => a.name === "OtherbridgeDatabaseDown" && a.state === "active",
      )
        ? true
        : null,
    240000,
  );
  out.drills.B_database_unavailable = {
    dataApiHealth: dbDownHealth?.json?.data ?? null,
    dataApiKeyedRequest: {
      status: dbDownApi.status,
      error: dbDownApi.json?.error?.code,
    },
    appPortfolio: {
      status: dbDownPortfolio.status,
      error: dbDownPortfolio.json?.error,
      holdings: dbDownPortfolio.json?.holdings?.length ?? null,
    },
    appBridgePage: dbDownPage.status,
    alertFired: !!dbAlert,
    recoveredStatus: recovered,
    alertCleared: !!dbAlertCleared,
  };
  check(
    "drill-B",
    dbDownHealth &&
      [503].includes(dbDownApi.status) &&
      dbDownPortfolio.status === 503 &&
      dbDownPortfolio.json?.holdings === undefined &&
      dbDownPage.status === 200 &&
      dbAlert &&
      recovered === 200,
    out.drills.B_database_unavailable,
  );
  // Data API unavailable: app keeps serving (in-process data plane); target-down alert fires; recovery.
  sh("docker", ["stop", "otherbridge-staging-data-api"]);
  const apiDown = await https(API, "/v1/health").catch((e) => ({
    status: String(e.message),
  }));
  const appWhileApiDown = await post("/api/portfolio", {
    identity: { evm: PUBLIC_ADDRESS },
    consent: true,
  });
  const targetAlert = await waitFor(
    async () =>
      (await alerts()).some(
        (a) =>
          a.name === "OtherbridgeMetricsTargetDown" && a.state === "active",
      )
        ? true
        : null,
    300000,
  );
  sh("docker", [...compose, "up", "-d", "--wait", "data-api"]);
  const apiBack = await https(API, "/v1/health");
  out.drills.data_api_unavailable = {
    proxyStatus: apiDown.status,
    appPortfolio: appWhileApiDown.status,
    alertFired: !!targetAlert,
    recovered: apiBack.status,
  };
  check(
    "drill-data-api-unavailable",
    apiDown.status === 502 &&
      appWhileApiDown.status === 200 &&
      targetAlert &&
      apiBack.status === 200,
    out.drills.data_api_unavailable,
  );
  out.firingAlertsAtEnd = await alerts();
  dataCli(["key:revoke", "--key", active.prefix]);
} catch (error) {
  out.error = String(error?.stack ?? error)
    .replace(/ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]+/g, "[redacted]")
    .slice(0, 2000);
}
out.finishedAt = new Date().toISOString();
out.result =
  !out.error && Object.values(out.checks).every((c) => c.ok) ? "PASS" : "FAIL";
await writeFile(
  `${root}/staging-smoke.json`,
  JSON.stringify(out, null, 2).replace(
    /ob_(live|test)_[a-z0-9]{12}_[A-Za-z0-9_-]+/g,
    "[redacted]",
  ),
);
console.log(
  JSON.stringify({
    result: out.result,
    failed: Object.entries(out.checks)
      .filter(([, c]) => !c.ok)
      .map(([k]) => k),
    error: out.error?.slice(0, 300),
  }),
);
process.exit(out.result === "PASS" ? 0 : 1);
