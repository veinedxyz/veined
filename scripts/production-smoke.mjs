import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
import { checkPublicPage } from "./public-brand-check.mjs";
import { parseE2EOrigin } from "../src/server/e2e-origin.mjs";
import { requireFreeTestPort } from "./lib/test-port.mjs";
const { origin: url, port } = parseE2EOrigin(
  process.env.OTHERBRIDGE_PRODUCTION_TEST_ORIGIN ?? "http://127.0.0.1:3127",
);
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
await mkdir(`${base}/screenshots`, { recursive: true });
await mkdir(`${base}/logs`, { recursive: true });
await requireFreeTestPort(port);
const child = spawn(
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
      OTHERBRIDGE_APP_ORIGINS: url,
      OTHERBRIDGE_MODE: "local-test",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "true",
    },
  },
);
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
let browser;
const results = [];
const startedAt = new Date().toISOString();
try {
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  const config = await (await fetch(`${url}/api/bridge`)).json();
  assert.equal(config.mode, "mainnet-readonly");
  assert.equal(config.submission, false);
  const quote = await fetch(`${url}/api/bridge`, {
    method: "POST",
    headers: { Origin: url, "Content-Type": "application/json" },
    body: JSON.stringify({
      action: "quote",
      account: "0x3333333333333333333333333333333333333333",
      amount: "0",
    }),
  });
  assert.equal(quote.status, 422);
  assert.deepEqual(await quote.json(), { error: "INVALID_AMOUNT" });
  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  const page = await context.newPage();
  const errors = [];
  const csp = [];
  const externalImages = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("request", (request) => {
    if (
      request.resourceType() === "image" &&
      new URL(request.url()).origin !== url
    )
      externalImages.push(request.url());
  });
  async function networkLogos() {
    // Asset health checks deliberately load offscreen lazy logos as well.
    await page.locator("main [data-network-logo] img").evaluateAll((images) =>
      images.forEach((image) => {
        image.loading = "eager";
      }),
    );
    await page.waitForFunction(() =>
      Array.from(
        document.querySelectorAll("main [data-network-logo] img"),
      ).every((image) => image.complete && image.naturalWidth > 0),
    );
    const logos = await page
      .locator("main [data-network-logo] img")
      .evaluateAll((images) =>
        images.map((image) => ({
          network: image.parentElement.dataset.networkLogo,
          src: image.getAttribute("src"),
          width: image.getBoundingClientRect().width,
          loaded: image.complete && image.naturalWidth > 0,
        })),
      );
    for (const id of ["onechain", "bsc"])
      assert(
        logos.some(
          (logo) =>
            logo.network === id &&
            logo.src === `/networks/${id}.svg` &&
            logo.loaded &&
            logo.width >= 15,
        ),
      );
    return logos;
  }
  await page.addInitScript(() => {
    localStorage.setItem("otherbridge.language", "tr");
    document.addEventListener("securitypolicyviolation", (e) => {
      (window.cspViolations ??= []).push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
        source: e.sourceFile,
        line: e.lineNumber,
      });
    });
  });
  // V1.11: "/" is the public landing and "/docs" the public docs; the app starts at "/bridge".
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
    const response = await page.goto(url + path);
    assert.equal(response.status(), 200);
    await page.locator("h1").waitFor();
    // V1.11: the health card shows one route state; its refresh control lives in Safety details.
    if (path === "/bridge")
      await page.locator(".health-card [data-route-state]").waitFor();
    await page.waitForTimeout(150);
    const headers = response.headers();
    assert(headers["content-security-policy"].includes("nonce-"));
    assert(
      !headers["content-security-policy"].includes(
        "script-src 'self' 'unsafe-inline'",
      ),
    );
    assert(!headers["content-security-policy"].includes("unsafe-eval"));
    assert.equal(headers["x-content-type-options"], "nosniff");
    const a11y = await new AxeBuilder({ page }).analyze();
    assert.deepEqual(a11y.violations, []);
    const logos =
      path === "/bridge" || path === "/networks" ? await networkLogos() : [];
    await checkPublicPage(
      page,
      base,
      `tr-dark-${path === "/" ? "landing" : path.slice(1).replaceAll("/", "-")}`,
    );
    results.push({
      path,
      status: 200,
      theme: "dark",
      width: 1440,
      a11yViolations: 0,
      logos,
    });
    await page.screenshot({
      path: `${base}/screenshots/production-${path === "/" ? "landing" : path.slice(1).replaceAll("/", "-")}.png`,
      fullPage: true,
    });
    csp.push(...(await page.evaluate(() => window.cspViolations ?? [])));
  }
  for (const theme of ["dark", "light"]) {
    for (const width of [360, 1440]) {
      if (theme === "dark" && width === 1440) continue;
      await page.evaluate(
        (theme) => localStorage.setItem("otherbridge.theme", theme),
        theme,
      );
      await page.setViewportSize({ width, height: 1100 });
      for (const path of ["/bridge", "/networks"]) {
        const response = await page.goto(url + path);
        assert.equal(response.status(), 200);
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        await page.locator("h1").waitFor();
        if (path === "/bridge")
          await page.locator(".health-card [data-route-state]").waitFor();
        const logos = await networkLogos();
        await checkPublicPage(
          page,
          base,
          `tr-${theme}-${width}-${path === "/bridge" ? "bridge" : "networks"}`,
        );
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth,
          ),
          false,
        );
        const a11y = await new AxeBuilder({ page }).analyze();
        assert.deepEqual(a11y.violations, []);
        results.push({
          path,
          status: 200,
          theme,
          width,
          a11yViolations: 0,
          logos,
        });
        await page.screenshot({
          path: `${base}/screenshots/production-identity-${path === "/bridge" ? "bridge" : "networks"}-${width}-${theme}.png`,
          fullPage: true,
        });
        csp.push(...(await page.evaluate(() => window.cspViolations ?? [])));
      }
    }
  }
  // A separate context verifies English hydration and browser textContent too.
  const english = await browser.newContext({
    viewport: { width: 1440, height: 1100 },
  });
  await english.addInitScript(() =>
    localStorage.setItem("otherbridge.language", "en"),
  );
  const enPage = await english.newPage();
  enPage.on("pageerror", (error) => errors.push(error.message));
  // V1.11: "/" is the public landing and "/docs" the public docs; the app starts at "/bridge".
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
    assert.equal((await enPage.goto(url + path)).status(), 200);
    await enPage.waitForFunction(() => document.documentElement.lang === "en");
    await enPage.locator("h1").waitFor();
    await checkPublicPage(
      enPage,
      base,
      `en-dark-${path === "/" ? "landing" : path.slice(1).replaceAll("/", "-")}`,
    );
    results.push({ path, status: 200, language: "en", publicBrand: "PASS" });
  }
  await english.close();
  await writeFile(
    `${base}/csp-diagnostic.json`,
    JSON.stringify({ errors, csp, externalImages }, null, 2),
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(csp, []);
  assert.deepEqual(externalImages, []);
  await writeFile(
    `${base}/production-smoke.json`,
    JSON.stringify(
      {
        startedAt,
        finishedAt: new Date().toISOString(),
        config,
        results,
        browserErrors: errors,
        cspViolations: csp,
        externalImages,
        publicBrand:
          "PASS (full browser body.textContent; TR/EN, all public routes)",
        result: "PASS",
        note: "Malicious local-test/enable env values still fail closed in production. No real wallet used.",
      },
      null,
      2,
    ),
  );
  console.log("Production smoke PASS");
} finally {
  await browser?.close();
  child.kill();
  await writeFile(`${base}/logs/production-server.log`, log);
}
