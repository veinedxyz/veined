import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { checkPublicPage } from "./public-brand-check.mjs";
import { parseE2EOrigin } from "../src/server/e2e-origin.mjs";
import { requireFreeTestPort } from "./lib/test-port.mjs";
import { waitForHostMemory } from "./lib/test-memory.mjs";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("Unique evidence directory required");
await mkdir(`${base}/screenshots`, { recursive: true });
const { origin, port } = parseE2EOrigin(
  process.env.OTHERBRIDGE_PRODUCTION_TEST_ORIGIN ?? "http://127.0.0.1:3127",
);
const startedAt = new Date().toISOString();
await requireFreeTestPort(port);
const server = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    String(port),
  ],
  {
    env: {
      ...process.env,
      OTHERBRIDGE_APP_ORIGINS: origin,
      OTHERBRIDGE_MODE: "local-test",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "true",
    },
  },
);
let log = "",
  browser;
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const ids = [
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
const rtl = ["ar", "fa", "he", "ur"],
  results = [],
  errors = [],
  consoleErrors = [],
  reads = [];
let activeLocale = null;
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(origin)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const gate = await (await fetch(`${origin}/api/bridge`)).json();
  assert.equal(gate.mode, "mainnet-readonly");
  assert.equal(gate.submission, false);
  for (const locale of ids) {
    activeLocale = locale;
    if (process.env.OTHERBRIDGE_TEST_RESOURCE_ISOLATION === "1")
      await waitForHostMemory(`${base}/memory-admission/${locale}`);
    browser = await chromium.launch();
    const dir = rtl.includes(locale) ? "rtl" : "ltr",
      dictionary = JSON.parse(
        await readFile(`src/i18n/locales/${locale}.json`, "utf8"),
      );
    const ssr = [];
    // V1.11: landing ("/") and docs are public pages; the app starts at "/bridge".
    for (const path of [
      "/",
      "/docs",
      "/bridge",
      "/activity",
      "/networks",
      "/help",
      "/about",
      "/settings",
    ]) {
      const response = await fetch(origin + path, {
          headers: { Cookie: `otherbridge.locale=${locale}` },
        }),
        html = await response.text();
      assert.equal(response.status, 200);
      assert(html.includes(`lang="${locale}"`));
      assert(html.includes(`dir="${dir}"`));
      ssr.push({ path, status: response.status, lang: locale, dir });
    }
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1100 },
    });
    await context.addCookies([
      { name: "otherbridge.locale", value: locale, url: origin },
    ]);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push({ locale, error: e.message }));
    page.on("console", (m) => {
      if (m.type() === "error")
        consoleErrors.push({ locale, message: m.text() });
    });
    page.on("response", async (response) => {
      if (response.url().includes("/api/")) {
        reads.push({ locale, url: response.url(), status: response.status() });
      }
    });
    // Landing in this locale: same lang/dir, public brand check, no horizontal overflow.
    await page.goto(`${origin}/`);
    await page.locator(".mk-hero h1").waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    assert.equal(await page.locator("html").getAttribute("dir"), dir);
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await checkPublicPage(page, base, `${locale}-production-landing`);
    if (["tr", "en", "ar", "ja"].includes(locale))
      await page.screenshot({
        path: `${base}/screenshots/${locale}-production-landing-1440-dark.png`,
        fullPage: true,
      });
    await page.goto(`${origin}/bridge`);
    await page.locator(".intro").waitFor();
    assert.equal(await page.locator("html").getAttribute("lang"), locale);
    assert.equal(await page.locator("html").getAttribute("dir"), dir);
    assert(
      (await page.locator(".intro").innerText()).includes(
        dictionary.product.subtitle,
      ),
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await checkPublicPage(page, base, `${locale}-production-bridge`);
    const screenshot = `${base}/screenshots/${locale}-production-bridge-1440-dark.png`;
    await page.screenshot({ path: screenshot, fullPage: true });
    const a11y = [];
    if (["tr", "en", "es", "ru", "ar", "zh-CN", "ja"].includes(locale)) {
      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      await writeFile(
        `${base}/${locale}-axe.json`,
        JSON.stringify(axe, null, 2),
      );
      assert.deepEqual(axe.violations, []);
      a11y.push({ width: 1440, violations: 0 });
    }
    await page.locator(".header .language-entry").click();
    await page
      .locator(".language-picker[open] .language-list button")
      .first()
      .waitFor();
    assert.equal(
      await page
        .locator(".language-picker[open] .language-list button")
        .count(),
      24,
    );
    await page.screenshot({
      path: `${base}/screenshots/${locale}-production-language-selector-1440.png`,
    });
    await page.keyboard.press("Escape");
    if (rtl.includes(locale)) {
      await page.setViewportSize({ width: 360, height: 1100 });
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `${base}/screenshots/${locale}-production-bridge-360-dark.png`,
        fullPage: true,
      });
      await page.locator(".header .language-entry").click();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({
        path: `${base}/screenshots/${locale}-production-language-selector-360.png`,
      });
      await page.keyboard.press("Escape");
    }
    results.push({ locale, dir, ssr, screenshot, a11y });
    console.log("Production locale", locale, "PASS");
    await context.close();
    await browser.close();
    browser = undefined;
    activeLocale = null;
  }
  assert.deepEqual(errors, []);
  assert(
    consoleErrors.every((e) =>
      /Failed to load resource: the server responded with a status of (422|429|503)/.test(
        e.message,
      ),
    ),
    JSON.stringify(consoleErrors),
  );
  await writeFile(
    `${base}/production-i18n.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        result: "PASS",
        locales: 24,
        ssrSurfaces: 144,
        results,
        errors,
        consoleErrors,
        reads,
        gate,
        note: "Actual production SSR/browser pages; no mocked APIs. Expected read unavailability remains visible. Does not prove reserve or execution.",
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
} catch (error) {
  await writeFile(
    `${base}/production-i18n-failure.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        result: "FAIL",
        completedLocales: results.map((row) => row.locale),
        failedLocale: activeLocale,
        error: String(error),
        errors,
        consoleErrors,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  throw error;
} finally {
  await browser?.close();
  server.kill();
  await writeFile(`${base}/server.log`, log, { flag: "wx" });
}
