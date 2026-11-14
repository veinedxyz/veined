import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { checkPublicPage } from "./public-brand-check.mjs";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("UNIQUE_EVIDENCE_ROOT_REQUIRED");
await mkdir(`${base}/screenshots`, { recursive: true });
const origin = "http://127.0.0.1:3101",
  at = new Date().toISOString();
const server = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3101",
  ],
  {
    env: {
      ...process.env,
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "true",
      OTHERBRIDGE_MODE: "local-test",
    },
  },
);
let log = "",
  browser;
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const checks = [],
  observations = [],
  errors = [],
  csp = [],
  externalImages = [];
const address = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const sanitize = (value) =>
  JSON.parse(
    JSON.stringify(value).replaceAll(
      address,
      "[SUPPLIED_PUBLIC_ADDRESS_REDACTED]",
    ),
  );
async function post(path, body, headers = {}) {
  const r = await fetch(origin + path, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  return {
    status: r.status,
    body: await r.json(),
    cache: r.headers.get("cache-control"),
  };
}
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const gate = await (await fetch(origin + "/api/routing")).json();
  assert.equal(gate.execution.enabled, false);
  for (const key of ["sign", "approve", "broadcast", "deploy"])
    assert.equal(gate.execution[key], null);
  for (const path of ["/api/catalog", "/api/portfolio"]) {
    assert.equal(
      (await post(path, {}, { Origin: "https://invalid.example" })).status,
      403,
    );
    assert.equal((await post(path, { unknown: true })).status, 422);
    assert.equal((await post(path, "x".repeat(17000))).status, 422);
    assert.equal(
      (await post(path, '{"__proto__":{"polluted":true}}')).status,
      422,
    );
    checks.push({
      path,
      origin: "PASS",
      malformed: "PASS",
      oversized: "PASS",
      prototype: "PASS",
    });
  }
  assert.equal(
    (
      await post("/api/portfolio", {
        identity: { evm: address },
        consent: false,
      })
    ).status,
    422,
  );
  for (const action of [
    "execute",
    "sign",
    "approve",
    "broadcast",
    "deploy",
    "feeCollect",
  ])
    assert.equal((await post("/api/routing", { action })).status, 422);
  const active = await post("/api/catalog", { refresh: true });
  assert.equal(active.status, 200);
  assert.ok(active.body.chains.length > 0);
  await writeFile(
    `${base}/active-catalog-observation.json`,
    JSON.stringify(active, null, 2),
  );
  observations.push({
    kind: "active-catalog",
    status: active.body.stale ? "STALE_FALLBACK" : "LIVE",
    observedAt: active.body.observedAt,
    chains: active.body.chains.length,
  });
  const portfolio = await post("/api/portfolio", {
    identity: { evm: address },
    consent: true,
  });
  assert.equal(portfolio.status, 200);
  assert.match(portfolio.cache, /private.*no-store/);
  await writeFile(
    `${base}/sanitized-native-portfolio.json`,
    JSON.stringify(sanitize(portfolio), null, 2),
  );
  observations.push({
    kind: "native-portfolio",
    status: portfolio.body.state,
    // V1.4: self-hosted data plane fields replace the retired broadCoverage credential state.
    source: portfolio.body.source,
    dataPlane: portfolio.body.dataPlane,
    dataPlaneStore: process.env.OTHERBRIDGE_DATA_DATABASE_URL
      ? "postgres"
      : "committed-registry-snapshot",
    coverageSummary: portfolio.body.coverageSummary,
    continuation: !!portfolio.body.continuation,
    holdings: portfolio.body.holdings.length,
    coverage: portfolio.body.coverage,
    privacy:
      "Explicit consent; user-supplied public address redacted in saved evidence",
  });
  const catalog = await post("/api/routing", {
    action: "catalog",
    refresh: true,
  });
  if (catalog.status === 200 && !catalog.body.stale) {
    for (const [mode, destination, destinationAsset] of [
      ["swap", "1", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"],
      ["bridge", "8453", "0x0000000000000000000000000000000000000000"],
    ]) {
      const input = {
        source: "1",
        destination,
        sourceAsset: "0x0000000000000000000000000000000000000000",
        destinationAsset,
        amount: "10000000000000000",
        sourceAddress: address,
        destinationAddress: address,
        generation: catalog.body.generation,
        slippage: 0.005,
        preference: "receive",
        walletRevision: 0,
        mode,
        portfolioRevision: portfolio.body.revision,
      };
      const q = await post("/api/routing", { action: "quote", input });
      if (q.status === 200) {
        assert.ok(q.body.length > 0);
        for (const quote of q.body) {
          assert.equal(quote.executable, false);
          assert.equal(quote.platformFee.bps, 0);
          assert.equal(quote.platformFee.amount, "0");
          assert.equal(quote.requirements.reason, "WRITE_DISABLED");
        }
      }
      await writeFile(
        `${base}/live-${mode}-quotes.json`,
        JSON.stringify(sanitize(q), null, 2),
      );
      observations.push({
        kind: `${mode}-quotes`,
        status: q.status === 200 ? "LIVE_READONLY" : "UNAVAILABLE",
        http: q.status,
        count: q.status === 200 ? q.body.length : 0,
        error: q.status === 200 ? null : q.body.error,
      });
    }
  } else observations.push({ kind: "quotes", status: "STALE_CATALOG_BLOCKED" });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.addCookies([
    { name: "otherbridge.locale", value: "en", url: origin },
  ]);
  await context.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      (window.v13Csp ??= []).push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
      }),
    ),
  );
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.resourceType() === "image" && new URL(r.url()).origin !== origin)
      externalImages.push(r.url());
  });
  for (const path of ["/portfolio", "/swap", "/networks"]) {
    await page.goto(origin + path);
    await page.locator("main h1").first().waitFor();
    await checkPublicPage(page, base, `v13-production-${path.slice(1)}`);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    const axe = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(axe.violations, []);
    csp.push(...(await page.evaluate(() => window.v13Csp ?? [])));
    await page.screenshot({
      path: `${base}/screenshots/v13-production-${path.slice(1)}.png`,
      fullPage: true,
    });
    checks.push({ path, axe: "PASS", overflow: "PASS", brand: "PASS" });
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, []);
  assert.deepEqual(externalImages, []);
  await writeFile(
    `${base}/production-v13.json`,
    JSON.stringify(
      {
        at,
        finishedAt: new Date().toISOString(),
        result: "PASS",
        gate,
        checks,
        observations,
        errors,
        csp,
        externalImages,
        realSignatures: 0,
        approvals: 0,
        broadcasts: 0,
        deploys: 0,
        feeCollection: 0,
      },
      null,
      2,
    ),
  );
  console.log(JSON.stringify({ result: "PASS", observations }, null, 2));
} finally {
  await browser?.close();
  server.kill();
  await writeFile(`${base}/server.log`, log);
}
