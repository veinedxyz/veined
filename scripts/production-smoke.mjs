import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const url = "http://127.0.0.1:3101";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1";
await mkdir(`${base}/screenshots`, { recursive: true });
await mkdir(`${base}/logs`, { recursive: true });
const child = spawn(
  process.execPath,
  [
    "node_modules/next/dist/bin/next",
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
  for (const path of [
    "/",
    "/activity",
    "/networks",
    "/help",
    "/about",
    "/settings",
  ]) {
    const response = await page.goto(url + path);
    assert.equal(response.status(), 200);
    await page.locator("h1").waitFor();
    if (path === "/")
      await page.getByRole("button", { name: /Yeniden kontrol et/ }).waitFor();
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
      path === "/" || path === "/networks" ? await networkLogos() : [];
    results.push({
      path,
      status: 200,
      theme: "dark",
      width: 1440,
      a11yViolations: 0,
      logos,
    });
    await page.screenshot({
      path: `${base}/screenshots/production-${path === "/" ? "bridge" : path.slice(1)}.png`,
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
      for (const path of ["/", "/networks"]) {
        const response = await page.goto(url + path);
        assert.equal(response.status(), 200);
        await page.waitForFunction(
          (theme) => document.documentElement.dataset.theme === theme,
          theme,
        );
        await page.locator("h1").waitFor();
        if (path === "/")
          await page
            .getByRole("button", { name: /Yeniden kontrol et/ })
            .waitFor();
        const logos = await networkLogos();
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
          path: `${base}/screenshots/production-identity-${path === "/" ? "bridge" : "networks"}-${width}-${theme}.png`,
          fullPage: true,
        });
        csp.push(...(await page.evaluate(() => window.cspViolations ?? [])));
      }
    }
  }
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
