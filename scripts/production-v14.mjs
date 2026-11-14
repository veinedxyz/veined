// V1.4 production (loopback `next start`) read-only checks with the self-hosted data plane.
// Live public-address scan; the address is redacted in saved JSON and visually masked in images.
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { checkPublicPage } from "./public-brand-check.mjs";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("UNIQUE_EVIDENCE_ROOT_REQUIRED");
const apiEvidence = process.env.OTHERBRIDGE_API_EVIDENCE_DIR;
await mkdir(`${base}/screenshots`, { recursive: true });
const origin = "http://127.0.0.1:3101",
  at = new Date().toISOString(),
  address = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const redact = (v) =>
  JSON.parse(
    JSON.stringify(v).replaceAll(address, "[SUPPLIED_PUBLIC_ADDRESS_REDACTED]"),
  );
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
      OTHERBRIDGE_DATA_LOG: "on",
    },
  },
);
let log = "",
  browser;
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const errors = [],
  csp = [],
  externalImages = [],
  portfolioResponses = [],
  checks = [];
// V1.5: the production CSP refuses injected <style> (no 'unsafe-inline'), so evidence masking uses
// the CSSOM (element.style), which CSP does not govern. Same selectors and effect as V1.4.
const maskSelector = 'input[aria-label^="evm "], .portfolio-assets code';
const applyMask = (page) =>
  page.evaluate((selector) => {
    for (const el of document.querySelectorAll(selector))
      el.style.setProperty("filter", "blur(6px)", "important");
  }, maskSelector);
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
  const bridge = await fetch(origin + "/api/bridge", {
    method: "POST",
    headers: { Origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(bridge.headers.get("cache-control"), "private, no-store");
  checks.push({ check: "bridge private no-store", result: "PASS" });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.addCookies([
    { name: "otherbridge.locale", value: "en", url: origin },
  ]);
  await context.addInitScript(() =>
    document.addEventListener("securitypolicyviolation", (e) =>
      (window.v14Csp ??= []).push({
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
  page.on("response", async (r) => {
    if (r.url().endsWith("/api/portfolio") && r.request().method() === "POST")
      try {
        portfolioResponses.push({ status: r.status(), body: await r.json() });
      } catch {}
  });
  await page.goto(origin + "/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(address);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await page.getByTestId("coverage-sentence").waitFor({ timeout: 60000 });
  await applyMask(page);
  await page.screenshot({
    path: `${base}/screenshots/v14-live-progressive-scan.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Check again", exact: true })
    .waitFor({ timeout: 120000 });
  const sentence = await page.getByTestId("coverage-sentence").textContent();
  await applyMask(page);
  await page.screenshot({
    path: `${base}/screenshots/v14-live-self-hosted-portfolio.png`,
    fullPage: true,
  });
  await page.locator(".portfolio-coverage-details summary").click();
  await page.screenshot({
    path: `${base}/screenshots/v14-live-coverage-details.png`,
    fullPage: true,
  });
  const axe = await new AxeBuilder({ page }).analyze();
  assert.deepEqual(axe.violations, []);
  await checkPublicPage(page, base, "v14-production-portfolio");
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  checks.push({
    path: "/portfolio",
    axe: "PASS",
    overflow: "PASS",
    brand: "PASS",
    sentence,
  });
  // Bridge with live holdings: selector lists networks with balances first.
  const firstBridge = page
    .locator(".portfolio-assets article button", { hasText: "Bridge" })
    .first();
  if (await firstBridge.count()) {
    await firstBridge.click();
    await page.getByTestId("multichain-form").waitFor();
    await page
      .getByRole("button", { name: "Select source network", exact: true })
      .click();
    await page.screenshot({
      path: `${base}/screenshots/v14-live-network-selector-holdings.png`,
    });
    const firstOption = await page
      .locator(".picker-option")
      .first()
      .textContent();
    checks.push({
      check: "selector holdings first",
      firstOption: firstOption?.slice(0, 80),
    });
    await page.getByRole("button", { name: "Close", exact: true }).click();
  }
  await page.goto(origin + "/networks");
  await page.locator("main h1").first().waitFor();
  await page.screenshot({
    path: `${base}/screenshots/v14-live-networks-capability.png`,
    fullPage: false,
  });
  const networksText = (await page.locator("main").textContent()) ?? "";
  checks.push({
    path: "/networks",
    walletTokensShown: /Wallet tokens/.test(networksText),
  });
  csp.push(...(await page.evaluate(() => window.v14Csp ?? [])));
  // Local Data API docs (loopback service) and redacted CLI evidence.
  try {
    const docs = await context.newPage();
    await docs.goto("http://127.0.0.1:3200/v1/docs");
    await docs.screenshot({
      path: `${base}/screenshots/v14-local-data-api-docs.png`,
      fullPage: true,
    });
    checks.push({
      check: "data api docs page",
      result: "PASS",
      scripts: await docs.locator("script").count(),
    });
    await docs.close();
  } catch (e) {
    checks.push({
      check: "data api docs page",
      result: "UNAVAILABLE",
      error: String(e).slice(0, 100),
    });
  }
  if (apiEvidence) {
    const client = await readFile(`${apiEvidence}/client-create.json`, "utf8");
    const key = await readFile(
      `${apiEvidence}/key-create-redacted.json`,
      "utf8",
    );
    assert.ok(
      !/ob_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/.test(client + key),
      "secret present in CLI evidence",
    );
    const cli = await context.newPage();
    const esc = (s) =>
      s.replace(
        /[&<>]/g,
        (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c],
      );
    await cli.setContent(
      `<body style="background:#111;color:#ddd;font:14px ui-monospace,monospace;padding:24px"><p>$ pnpm data:client:create --name "Otherbridge internal app" --plan internal --scopes …</p><pre>${esc(client)}</pre><p>$ pnpm data:key:create --client &lt;cli_…&gt; --yes --stdout-json   # secret shown once to the operator, redacted here</p><pre>${esc(key)}</pre></body>`,
    );
    await cli.screenshot({
      path: `${base}/screenshots/v14-api-key-cli-redacted.png`,
    });
    await cli.close();
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, []);
  assert.deepEqual(externalImages, []);
  assert.ok(
    portfolioResponses.length >= 1 &&
      portfolioResponses.every((r) => r.status === 200),
  );
  const last = portfolioResponses.at(-1).body;
  await writeFile(
    `${base}/live-portfolio-pages.json`,
    JSON.stringify(redact(portfolioResponses), null, 2),
  );
  const summary = {
    at,
    finishedAt: new Date().toISOString(),
    result: "PASS",
    gate,
    dataPlaneStore: process.env.OTHERBRIDGE_DATA_DATABASE_URL
      ? "postgres"
      : "committed-registry-snapshot",
    pages: portfolioResponses.length,
    lastPage: {
      dataPlane: last.dataPlane,
      source: last.source,
      summary: last.coverageSummary,
      continuation: !!last.continuation,
    },
    checks,
    paidPortfolioCredential: process.env.OTHERBRIDGE_PORTFOLIO_API_KEY
      ? "PRESENT_UNUSED"
      : "ABSENT",
    errors,
    csp,
    externalImages,
    realSignatures: 0,
    approvals: 0,
    broadcasts: 0,
    deploys: 0,
    feeCollection: 0,
  };
  await writeFile(
    `${base}/production-v14.json`,
    JSON.stringify(redact(summary), null, 2),
  );
  console.log(JSON.stringify(redact(summary), null, 1));
} catch (error) {
  await writeFile(
    `${base}/production-v14-failure.json`,
    JSON.stringify(
      {
        at,
        error: String(error?.stack ?? error).slice(0, 4000),
        log: log.slice(-4000),
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await writeFile(`${base}/production-v14-server.log`, redact(log));
}
