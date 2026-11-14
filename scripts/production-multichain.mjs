import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { checkPublicPage } from "./public-brand-check.mjs";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("A unique evidence directory is required");
await mkdir(`${base}/screenshots`, { recursive: true });
const origin = "http://127.0.0.1:3101",
  startedAt = new Date().toISOString();
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
      OTHERBRIDGE_MODE: "local-test",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "true",
    },
  },
);
let browser,
  log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const errors = [],
  csp = [],
  externalImages = [],
  expectedReadFailures = [],
  results = [];
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const gate = await (await fetch(`${origin}/api/routing`)).json();
  assert.equal(gate.mode, "mainnet-readonly");
  assert.equal(gate.execution.enabled, false);
  for (const key of ["sign", "approve", "broadcast", "deploy"])
    assert.equal(gate.execution[key], null);
  for (const action of ["execute", "approve", "sign", "broadcast", "deploy"]) {
    const r = await fetch(`${origin}/api/routing`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    assert.equal(r.status, 422);
    assert.deepEqual(await r.json(), { error: "INVALID_REQUEST" });
  }
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await context.addInitScript(() => {
    localStorage.setItem("otherbridge.language", "tr");
    document.addEventListener("securitypolicyviolation", (e) =>
      (window.cspViolations ??= []).push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
      }),
    );
  });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") {
      if (
        /Failed to load resource: the server responded with a status of 422/.test(
          m.text(),
        )
      )
        expectedReadFailures.push(m.text());
      else errors.push(m.text());
    }
  });
  page.on("request", (r) => {
    if (r.resourceType() === "image" && new URL(r.url()).origin !== origin)
      externalImages.push(r.url());
  });
  const quotes = [];
  page.on("response", (r) => {
    if (
      r.url() === `${origin}/api/routing` &&
      r.request().postDataJSON()?.action === "quote"
    )
      quotes.push(
        r
          .json()
          .then((body) => ({
            status: r.status(),
            request: r.request().postDataJSON(),
            body,
          }))
          .catch((error) => ({
            status: r.status(),
            captureError: String(error),
          })),
      );
  });
  async function capture(name) {
    const publicBrand = await checkPublicPage(page, base, name);
    // Check every local asset, including images below the current viewport.
    await page.locator("[data-network-logo] img").evaluateAll((images) =>
      images.forEach((image) => {
        image.loading = "eager";
      }),
    );
    await page.waitForFunction(() =>
      Array.from(document.querySelectorAll("[data-network-logo] img")).every(
        (i) => i.complete && i.naturalWidth > 0,
      ),
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
      false,
    );
    const a11y = await new AxeBuilder({ page }).analyze();
    await writeFile(`${base}/axe-${name}.json`, JSON.stringify(a11y, null, 2), {
      flag: "wx",
    });
    assert.deepEqual(a11y.violations, []);
    await page.screenshot({
      path: `${base}/screenshots/${name}.png`,
      fullPage: (await page.locator("dialog[open]").count()) === 0,
    });
    csp.push(...(await page.evaluate(() => window.cspViolations ?? [])));
    results.push({
      name,
      publicBrand,
      a11yViolations: 0,
      width: await page.evaluate(() => innerWidth),
      theme: await page.evaluate(() => document.documentElement.dataset.theme),
    });
  }
  async function select(role, search, id) {
    await page
      .getByRole("button", {
        name: role === "source" ? "Kaynak ağ seç" : "Hedef ağ seç",
      })
      .click();
    await page.locator("#network-search").fill(search);
    await page.locator(`.network-picker [data-chain="${id}"]`).click();
  }
  await page.goto(`${origin}/bridge`); // V1.11: "/" is the public landing
  const t = performance.now();
  await page.getByRole("button", { name: "Kaynak ağ seç" }).click();
  await page.locator("#network-search").waitFor();
  const selectorOpenMs = performance.now() - t;
  await page.waitForFunction(
    () => document.querySelectorAll(".picker-option").length > 0,
    {},
    { timeout: 30000 },
  );
  await capture("production-live-selector-desktop-dark");
  await page.locator("#network-search").fill("Ethereum");
  await page.locator('.network-picker [data-chain="1"]').click();
  await select("destination", "Base", "8453");
  await page
    .getByRole("status")
    .filter({ hasText: "Veride mevcut" })
    .waitFor({ timeout: 30000 });
  await page.locator("#routing-amount").fill("0.01");
  await page
    .locator("#routing-sender")
    .fill("0x3333333333333333333333333333333333333333");
  await page
    .locator("#routing-recipient")
    .fill("0x3333333333333333333333333333333333333333");
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await page.waitForFunction(
    () =>
      !!document.querySelector(".quote-preview") ||
      !!document.querySelector(".multichain-form [role=alert]"),
    {},
    { timeout: 30000 },
  );
  let liveQuote = "BLOCKED";
  if (
    await page
      .getByRole("button", { name: "Rotayı incele", exact: true })
      .count()
  ) {
    await page
      .getByRole("button", { name: "Rotayı incele", exact: true })
      .click();
    assert(await page.locator(".routing-review button.primary").isDisabled());
    liveQuote = "PASS_READ_ONLY";
  }
  await capture("production-live-eth-base-desktop-dark");
  // Keep the same real read-only quote open while verifying English labels.
  if (liveQuote === "PASS_READ_ONLY") {
    await page
      .locator(".routing-review")
      .getByRole("button", { name: "Kapat" })
      .click();
    await page.getByRole("button", { name: "Dil" }).click();
    await page
      .locator(".language-picker[open]")
      .getByRole("button", { name: "English", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Review route", exact: true })
      .click();
    await capture("production-live-eth-base-review-en-dark");
    await page
      .locator(".routing-review")
      .getByRole("button", { name: "Close" })
      .click();
    await page.getByRole("button", { name: "Language" }).click();
    await page
      .locator(".language-picker[open]")
      .getByRole("button", { name: "Türkçe", exact: true })
      .click();
  }
  if (await page.locator(".routing-review").isVisible())
    await page
      .locator(".routing-review")
      .getByRole("button", { name: "Kapat" })
      .click();
  for (const [width, theme] of [
    [1440, "light"],
    [360, "dark"],
  ]) {
    await page.evaluate((theme) => {
      localStorage.setItem("otherbridge.theme", theme);
      document.documentElement.dataset.theme = theme;
    }, theme);
    await page.setViewportSize({ width, height: 1100 });
    await capture(`production-live-eth-base-${width}-${theme}`);
    await page.getByRole("button", { name: "Hedef ağ seç" }).click();
    await capture(`production-live-selector-${width}-${theme}`);
    await page.locator("#network-search").press("Escape");
  }
  const catalogResponse = await fetch(`${origin}/api/routing`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "catalog" }),
  });
  const catalog = await catalogResponse.json(),
    sol = catalog.networks.find((n) => n.key === "sol");
  assert(sol);
  await select("destination", "Solana", sol.id);
  await page
    .getByRole("status")
    .filter({ hasText: "Veride mevcut" })
    .waitFor({ timeout: 30000 });
  await page
    .locator("#routing-recipient")
    .fill("FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z");
  await page.locator("#routing-amount").fill("0.01");
  await page
    .locator("#routing-sender")
    .fill("0x3333333333333333333333333333333333333333");
  await page.getByRole("button", { name: "Rotayı oku", exact: true }).click();
  await page.waitForFunction(
    () =>
      !!document.querySelector(".quote-preview") ||
      !!document.querySelector(".multichain-form [role=alert]"),
    {},
    { timeout: 30000 },
  );
  let nonEvmLiveQuote = "BLOCKED";
  if (
    await page
      .getByRole("button", { name: "Rotayı incele", exact: true })
      .count()
  ) {
    await page
      .getByRole("button", { name: "Rotayı incele", exact: true })
      .click();
    assert(await page.locator(".routing-review button.primary").isDisabled());
    nonEvmLiveQuote = "PASS_READ_ONLY";
  }
  await capture("production-live-evm-solana-mobile-dark");
  await page.goto(`${origin}/networks`);
  await page.locator(".catalog-section").waitFor();
  await capture("production-live-networks-mobile-dark");
  const quoteResponses = await Promise.all(quotes);
  assert(quoteResponses.every((r) => !("captureError" in r)));
  await writeFile(
    `${base}/quote-responses.json`,
    JSON.stringify(quoteResponses, null, 2),
    { flag: "wx" },
  );
  await writeFile(
    `${base}/browser-diagnostic.json`,
    JSON.stringify(
      { errors, csp, externalImages, expectedReadFailures },
      null,
      2,
    ),
    { flag: "wx" },
  );
  // A brand-repair acceptance run requires a real ETH→Base review, not just
  // catalog availability or a synthetic browser fixture.
  assert.equal(
    liveQuote,
    "PASS_READ_ONLY",
    "Real ETH→Base review unavailable; raw quote response is preserved",
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, []);
  assert.deepEqual(externalImages, []);
  if (expectedReadFailures.length)
    assert(quoteResponses.some((r) => r.status === 422));
  await writeFile(
    `${base}/production-multichain.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        result: "PASS",
        gate,
        rejectedWriteActions: 5,
        selectorOpenMs,
        liveQuote,
        nonEvmLiveQuote,
        results,
        errors,
        csp,
        externalImages,
        expectedReadFailures,
        signatures: 0,
        approvals: 0,
        broadcasts: 0,
        deploys: 0,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  console.log("Production multichain PASS", liveQuote);
} finally {
  await browser?.close();
  server.kill();
  await writeFile(`${base}/server.log`, log, { flag: "wx" });
}
