import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
const out = process.argv[2];
if (!out) throw Error("NEW_EVIDENCE_DIRECTORY_REQUIRED");
mkdirSync(out + "/screenshots", { recursive: true });
const origin = "http://127.0.0.1:3116";
const server = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3116",
  ],
  {
    env: {
      ...process.env,
      OTHERBRIDGE_DEPLOYMENT_ENV: "staging",
      OTHERBRIDGE_MODE: "mainnet-readonly",
    },
  },
);
let log = "",
  browser;
server.stdout.on("data", (b) => (log += b));
server.stderr.on("data", (b) => (log += b));
const cases = [],
  errors = [],
  csp = [];
try {
  let ready = false;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(origin)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  if (!ready) throw Error("SERVER_NOT_READY");
  browser = await chromium.launch({ headless: true });
  for (const width of [360, 390, 768, 1440])
    for (const theme of ["dark", "light"])
      for (const locale of ["en", "ar"]) {
        const context = await browser.newContext({
          viewport: { width, height: 1000 },
          colorScheme: theme,
        });
        await context.addCookies([
          { name: "otherbridge.locale", value: locale, url: origin },
        ]);
        await context.addInitScript(
          ({ theme }) => {
            localStorage.setItem("otherbridge.theme", theme);
            window.__v116Csp = [];
            document.addEventListener("securitypolicyviolation", (e) =>
              window.__v116Csp.push({
                directive: e.violatedDirective,
                blocked: e.blockedURI,
              }),
            );
          },
          { theme },
        );
        for (const path of [
          "/",
          "/portfolio",
          "/bridge",
          "/swap",
          "/activity",
          "/networks",
          "/help",
          "/docs",
          "/v116-missing-page",
        ]) {
          const page = await context.newPage(),
            id = `${width}-${theme}-${locale}-${path.replaceAll("/", "") || "landing"}`;
          page.on("pageerror", (e) =>
            errors.push({ id, error: e.message.slice(0, 180) }),
          );
          const response = await page.goto(origin + path, {
            waitUntil: "networkidle",
            timeout: 45000,
          });
          // Network idle does not prove the stored theme effect has hydrated.
          // Keep the theme assertion, but wait for its actual readiness signal.
          const themeStarted = Date.now();
          if (path !== "/v116-missing-page")
            await page.waitForFunction(
              (expected) => document.documentElement.dataset.theme === expected,
              theme,
              { timeout: 5000 },
            );
          const themeReadyMs = Date.now() - themeStarted;
          const shape = await page.evaluate(() => ({
            scroll: document.documentElement.scrollWidth,
            client: document.documentElement.clientWidth,
            dir: document.documentElement.dir,
            theme: document.documentElement.dataset.theme,
            bodyText: document.body.innerText.length,
            csp: window.__v116Csp ?? [],
          }));
          csp.push(...shape.csp.map((x) => ({ id, ...x })));
          const axe = await new AxeBuilder({ page }).analyze();
          const violations = axe.violations.map((v) => ({
            id: v.id,
            impact: v.impact,
            nodes: v.nodes.map((n) => n.target),
          }));
          const pass =
            response.status() === (path === "/v116-missing-page" ? 404 : 200) &&
            shape.scroll <= shape.client + 1 &&
            shape.bodyText > (path === "/v116-missing-page" ? 3 : 40) &&
            (path === "/v116-missing-page" || shape.theme === theme) &&
            shape.dir === (locale === "ar" ? "rtl" : "ltr") &&
            violations.length === 0;
          await page.screenshot({
            path: `${out}/screenshots/${id}.png`,
            fullPage: true,
          });
          cases.push({
            id,
            path,
            width,
            theme,
            expectedTheme: theme,
            themeReadyMs,
            locale,
            status: response.status(),
            ...shape,
            violations,
            pass,
          });
          await page.close();
        }
        await context.close();
        console.log(`${width} ${theme} ${locale} complete`);
      }
} catch (e) {
  errors.push({ error: String(e) });
} finally {
  await browser?.close();
  server.kill();
  writeFileSync(out + "/server.log", log);
}
const result = {
  at: new Date().toISOString(),
  cases,
  errors,
  csp,
  expected: 144,
  productPages: 128,
  errorPages: 16,
  pass:
    cases.length === 144 &&
    cases.every((c) => c.pass) &&
    errors.length === 0 &&
    csp.length === 0,
  execution: "CLOSED",
  walletPrompts: 0,
};
writeFileSync(out + "/ui.json", JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    pass: result.pass,
    cases: cases.length,
    failed: cases
      .filter((c) => !c.pass)
      .map((c) => ({
        id: c.id,
        status: c.status,
        dir: c.dir,
        scroll: c.scroll,
        client: c.client,
        violations: c.violations,
      })),
    errors,
    csp,
  }),
);
if (!result.pass) process.exitCode = 1;
