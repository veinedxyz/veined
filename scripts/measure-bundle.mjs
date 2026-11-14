// Bundle measurement (production `next start`). V1.11: the app shell is /bridge (the landing page owns "/"); the
// landing page and /docs have their own budgets; lazy chunks (Swap, Portfolio, token and network pickers) are
// measured as the JS a real visit loads after the shell. Budgets live in scripts/bundle-budgets.json; any excess
// fails the run (exit code 1) — budgets are never raised silently.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("A unique evidence directory is required");
await mkdir(base, { recursive: true });
const budgets = JSON.parse(
  await readFile("scripts/bundle-budgets.json", "utf8"),
);
const origin = "http://127.0.0.1:3101";
const child = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3101",
  ],
  { cwd: process.env.OTHERBRIDGE_BUNDLE_SERVER_DIRECTORY ?? process.cwd() },
);
let browser,
  log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
async function context() {
  const c = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  await c.addCookies([
    { name: "otherbridge.locale", value: "tr", url: origin },
  ]);
  await c.addInitScript(() => {
    localStorage.setItem("otherbridge.language", "tr");
    localStorage.setItem("otherbridge.theme", "dark");
  });
  return c;
}
function recorder(page) {
  const seen = new Map();
  page.on("response", (r) => {
    if (r.request().resourceType() !== "script") return;
    const path = new URL(r.url()).pathname;
    if (seen.has(path)) return;
    seen.set(
      path,
      r
        .body()
        .then((b) => ({
          path,
          bytes: b.length,
          gzipBytes: gzipSync(b).length,
          sha256: createHash("sha256").update(b).digest("hex"),
        }))
        .catch(() => ({ path, bytes: 0, gzipBytes: 0, sha256: null })),
    );
  });
  return {
    async snapshot() {
      const files = await Promise.all(seen.values());
      return { files, gzipBytes: files.reduce((a, b) => a + b.gzipBytes, 0) };
    },
  };
}
const result = {
  at: new Date().toISOString(),
  budgets,
  pages: {},
  chunks: {},
  verdicts: {},
};
try {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await fetch(`${origin}/bridge`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch();
  // Initial loads (fresh context each: nothing cached).
  for (const [name, path] of [
    ["app", "/bridge"],
    ["landing", "/"],
    ["docs", "/docs"],
  ]) {
    const c = await context();
    const page = await c.newPage();
    const rec = recorder(page);
    await page.goto(origin + path, { waitUntil: "networkidle" });
    result.pages[name] = { path, ...(await rec.snapshot()) };
    if (name === "app") {
      const themeToggleMs = [];
      for (let i = 0; i < 5; i++) {
        const expected = i % 2 === 0 ? "light" : "dark";
        const at = performance.now();
        await page
          .getByRole("button", { name: "Görünüm", exact: true })
          .click();
        await page.waitForFunction(
          (t) => document.documentElement.dataset.theme === t,
          expected,
        );
        themeToggleMs.push(performance.now() - at);
      }
      result.pages.app.themeToggleMs = themeToggleMs;
      result.pages.app.timing = await page.evaluate(() =>
        performance.getEntriesByType("navigation").map((x) => x.toJSON()),
      );
    }
    await c.close();
  }
  // Lazy chunks: JS loaded after the app shell by a client navigation or an interaction.
  const c = await context();
  const page = await c.newPage();
  const rec = recorder(page);
  await page.goto(origin + "/bridge", { waitUntil: "networkidle" });
  let before = (await rec.snapshot()).files.map((f) => f.path);
  const delta = async (name, action) => {
    await action();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(500);
    const now = await rec.snapshot();
    const added = now.files.filter((f) => !before.includes(f.path));
    result.chunks[name] = {
      files: added,
      gzipBytes: added.reduce((a, b) => a + b.gzipBytes, 0),
    };
    before = now.files.map((f) => f.path);
  };
  await delta("networkPicker", async () => {
    await page.locator(".network-select-trigger").first().click();
    await page.locator(".network-picker[open]").waitFor({ timeout: 20000 });
    await page.keyboard.press("Escape");
  });
  await delta("swap", async () => {
    await page.locator('nav.main-nav a[href="/swap"]').click();
    await page.locator(".swap-card").waitFor({ timeout: 30000 });
  });
  await delta("tokenPicker", async () => {
    await page
      .getByTestId("swap-intelligence")
      .locator(".token-select-trigger")
      .first()
      .click({ timeout: 30000 });
    await page.locator(".token-picker[open]").waitFor({ timeout: 20000 });
    await page.keyboard.press("Escape");
  });
  await delta("portfolio", async () => {
    await page.locator('nav.main-nav a[href="/portfolio"]').click();
    await page.locator(".portfolio-page").waitFor({ timeout: 30000 });
  });
  await c.close();
  for (const name of ["app", "landing", "docs"]) {
    const used = result.pages[name].gzipBytes;
    result.verdicts[name] = {
      gzipBytes: used,
      budget: budgets[name],
      margin: budgets[name] - used,
      pass: used <= budgets[name],
    };
  }
  await writeFile(
    `${base}/initial-bundle.json`,
    JSON.stringify(result, null, 2),
    { flag: "wx" },
  );
  for (const [k, v] of Object.entries(result.verdicts))
    console.log(
      `${k}: ${v.gzipBytes} gzip bytes (budget ${v.budget}, margin ${v.margin}) ${v.pass ? "PASS" : "OVER BUDGET"}`,
    );
  for (const [k, v] of Object.entries(result.chunks))
    console.log(`chunk ${k}: +${v.gzipBytes} gzip bytes`);
  // Backwards-compatible line used by earlier evidence tooling.
  console.log("Initial browser JS", result.pages.app.gzipBytes, "gzip bytes");
  if (Object.values(result.verdicts).some((v) => !v.pass)) process.exitCode = 1;
} finally {
  await browser?.close();
  child.kill();
  await writeFile(`${base}/server.log`, log, { flag: "wx" });
}
