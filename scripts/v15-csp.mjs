// V1.5 CSP acceptance against the PRODUCTION build: exact header checks on every product surface,
// interaction surfaces (network selector, language selector, settings), injected XSS payloads served
// under the real CSP header, Data API docs with its hash-pinned stylesheet, and visual captures.
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { writeFile, mkdir } from "node:fs/promises";
import assert from "node:assert/strict";
const app = "http://127.0.0.1:3101";
const api = "http://127.0.0.1:3200";
const base = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/v15"}/csp`;
await mkdir(`${base}/screenshots`, { recursive: true });
const children = [];
const start = (args, env = {}) => {
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d));
  child.stderr.on("data", (d) => (log += d));
  children.push({ child, log: () => log });
  return child;
};
const wait = async (url) => {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(url);
      if (r.status < 500) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw Error(`TIMEOUT ${url}`);
};
const directives = (csp) =>
  Object.fromEntries(
    csp
      .split(";")
      .map((d) => d.trim())
      .filter(Boolean)
      .map((d) => {
        const [k, ...v] = d.split(/\s+/);
        return [k, v];
      }),
  );
function assertAppPolicy(csp) {
  const d = directives(csp);
  assert.ok(
    !/unsafe-inline/.test(d["script-src"].join(" ")),
    "script unsafe-inline",
  );
  assert.ok(
    !/unsafe-inline/.test(d["style-src"].join(" ")),
    "style unsafe-inline",
  );
  assert.ok(
    !/unsafe-eval/.test(d["script-src"].join(" ")),
    "production unsafe-eval",
  );
  assert.ok(
    d["script-src"].some((v) => /^'nonce-[A-Za-z0-9+/=]{20,}'$/.test(v)),
  );
  assert.ok(d["script-src"].includes("'strict-dynamic'"));
  assert.deepEqual(d["style-src-attr"], ["'none'"]);
  assert.deepEqual(d["frame-ancestors"], ["'none'"]);
  assert.deepEqual(d["object-src"], ["'none'"]);
  assert.deepEqual(d["base-uri"], ["'self'"]);
  assert.deepEqual(d["form-action"], ["'self'"]);
  assert.deepEqual(d["default-src"], ["'self'"]);
  assert.deepEqual(d["connect-src"], ["'self'"]);
  assert.deepEqual(d["img-src"], ["'self'", "data:"]);
  assert.deepEqual(d["font-src"], ["'self'"]);
  return d;
}
const result = {
  startedAt: new Date().toISOString(),
  pages: [],
  injections: [],
  docs: null,
  headers: {},
};
start(
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3101",
  ],
  {
    NODE_ENV: "production",
  },
);
const dataApi = !!process.env.OTHERBRIDGE_DATA_DATABASE_URL;
if (dataApi)
  start(["scripts/data.mjs", "api"], { OTHERBRIDGE_DATA_API_PORT: "3200" });
let browser;
try {
  await wait(app);
  if (dataApi) await wait(`${api}/v1/health`);
  // 1. Header exactness on every route (two requests: nonce must differ per response).
  // V1.11: "/" is the public landing, "/docs" the public docs; the app starts at "/bridge".
  const routes = [
    "/",
    "/docs",
    "/docs/safety",
    "/bridge",
    "/swap",
    "/portfolio",
    "/networks",
    "/activity",
    "/settings",
    "/help",
    "/about",
  ];
  for (const r of routes) {
    const [a, b] = await Promise.all([fetch(app + r), fetch(app + r)]);
    const csp = a.headers.get("content-security-policy");
    assertAppPolicy(csp);
    const na = /'nonce-([^']+)'/.exec(csp)[1],
      nb = /'nonce-([^']+)'/.exec(b.headers.get("content-security-policy"))[1];
    assert.notEqual(na, nb, "nonce reuse");
    const html = await a.text();
    assert.ok(
      !/<[a-z][^>]*\sstyle=/i.test(html),
      `inline style attribute in SSR HTML of ${r}`,
    );
    const inlineStyles = [...html.matchAll(/<style\b([^>]*)>/gi)].map(
      (m) => m[1],
    );
    assert.ok(
      inlineStyles.every((attrs) => attrs.includes(`nonce="${na}"`)),
      `un-nonced <style> on ${r}`,
    );
    result.headers[r] = {
      status: a.status,
      csp: csp.replace(/'nonce-[^']+'/g, "'nonce-<per-request>'"),
      inlineStyleElements: inlineStyles.length,
      xContentTypeOptions: a.headers.get("x-content-type-options"),
      referrerPolicy: a.headers.get("referrer-policy"),
      permissionsPolicy: a.headers.get("permissions-policy"),
      hsts: a.headers.get("strict-transport-security"),
    };
  }
  // 2. Browser: every surface + interactions, zero CSP violations and zero console errors.
  browser = await chromium.launch();
  for (const width of [1440, 390]) {
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
    });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__csp.push({
          directive: e.effectiveDirective,
          blocked: e.blockedURI,
          sample: e.sample,
        }),
      );
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    for (const r of routes) {
      await page.goto(app + r, { waitUntil: "networkidle" });
      if (r === "/bridge" && width === 1440) {
        await page
          .getByRole("button", { name: "Select source network" })
          .first()
          .click();
        await page.waitForTimeout(800);
        await page.screenshot({
          path: `${base}/screenshots/network-selector-${width}.png`,
        });
        await page.keyboard.press("Escape");
      }
      if (r === "/settings") {
        const lang = page.locator(".language-entry").first();
        if (await lang.count()) await lang.click().catch(() => {});
        await page.waitForTimeout(300);
      }
      await page.screenshot({
        path: `${base}/screenshots/${r === "/" ? "landing" : r.slice(1).replaceAll("/", "-")}-${width}.png`,
        fullPage: false,
      });
      const v = await page.evaluate(() => window.__csp);
      result.pages.push({
        route: r,
        width,
        violations: v,
        errors: [...errors],
      });
      assert.deepEqual(
        v,
        [],
        `CSP violations on ${r} @${width}: ${JSON.stringify(v)}`,
      );
      errors.length = 0;
    }
    // Arabic RTL portfolio under the same policy.
    await context.addCookies([
      { name: "otherbridge.locale", value: "ar", url: app },
    ]);
    await page.goto(`${app}/portfolio`, { waitUntil: "networkidle" });
    assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
    await page.screenshot({
      path: `${base}/screenshots/portfolio-ar-rtl-${width}.png`,
    });
    assert.deepEqual(await page.evaluate(() => window.__csp), []);
    // Theme classes resolve CSS variables without inline styles.
    if (width === 1440) {
      await page.goto(`${app}/bridge`, { waitUntil: "networkidle" });
      const glow = await page.evaluate(() =>
        getComputedStyle(document.querySelector("main"))
          .getPropertyValue("--source-glow")
          .trim(),
      );
      assert.match(glow, /^\d{1,3} \d{1,3} \d{1,3}$/);
      result.themeProbe = { sourceGlow: glow };
    }
    await context.close();
  }
  // 3. Injected payloads under the real header: nothing executes, nothing applies, all reported.
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__csp.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
      }),
    );
  });
  const payload = `
<script>window.__pwnInline=1</script>
<img id="pwnImg" src="/__nope.png" onerror="window.__pwnHandler=1">
<div id="pwnAttr" style="color: rgb(255, 0, 0)">x</div>
<style>#pwnStyleEl{color: rgb(0, 255, 0)}</style><div id="pwnStyleEl">y</div>
<script src="https://evil.example/x.js"></script>
<link rel="stylesheet" href="https://evil.example/x.css">
<a id="pwnJs" href="javascript:window.__pwnJs=1">j</a>
<iframe id="pwnFrame" src="data:text/html,<script>parent.__pwnFrame=1</script>"></iframe>
<object id="pwnObj" data="data:text/html,x"></object>`;
  await page.route(app + "/", async (route) => {
    const res = await route.fetch();
    const body = (await res.text()).replace("</body>", `${payload}</body>`);
    await route.fulfill({ response: res, body, headers: res.headers() });
  });
  await page.goto(app + "/", { waitUntil: "load" });
  await page.click("#pwnJs").catch(() => {});
  await page.waitForTimeout(1500);
  const state = await page.evaluate(() => ({
    inline: window.__pwnInline ?? null,
    handler: window.__pwnHandler ?? null,
    js: window.__pwnJs ?? null,
    frame: window.__pwnFrame ?? null,
    attrColor: getComputedStyle(document.getElementById("pwnAttr")).color,
    styleElColor: getComputedStyle(document.getElementById("pwnStyleEl")).color,
    violations: window.__csp,
  }));
  result.injections.push(state);
  assert.equal(state.inline, null);
  assert.equal(state.handler, null);
  assert.equal(state.js, null);
  assert.equal(state.frame, null);
  assert.notEqual(state.attrColor, "rgb(255, 0, 0)");
  assert.notEqual(state.styleElColor, "rgb(0, 255, 0)");
  const seen = new Set(state.violations.map((v) => v.directive));
  for (const d of [
    "script-src-elem",
    "script-src-attr",
    "style-src-attr",
    "style-src-elem",
    "frame-src",
    "object-src",
  ])
    assert.ok(seen.has(d), `no ${d} violation recorded: ${[...seen]}`);
  await context.close();
  // 4. Data API docs: hash-pinned stylesheet applies; injected style/script blocked.
  if (dataApi) {
    const r = await fetch(`${api}/v1/docs`, {
      headers: { Host: "127.0.0.1:3200" },
    });
    const csp = r.headers.get("content-security-policy");
    const d = directives(csp);
    assert.deepEqual(d["default-src"], ["'none'"]);
    assert.ok(
      /^'sha256-[A-Za-z0-9+/=]{44}'$/.test(d["style-src"][0]) &&
        d["style-src"].length === 1,
    );
    assert.ok(!/unsafe/.test(csp));
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 900 },
    });
    const p = await ctx.newPage();
    await p.addInitScript(() => {
      window.__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        window.__csp.push(e.effectiveDirective),
      );
    });
    await p.goto(`${api}/v1/docs`);
    const applied = await p.evaluate(
      () => getComputedStyle(document.querySelector("main")).maxWidth,
    );
    assert.equal(applied, "920px");
    assert.deepEqual(await p.evaluate(() => window.__csp), []);
    assert.equal(await p.locator("script").count(), 0);
    await p.screenshot({
      path: `${base}/screenshots/data-api-docs-hardened-csp.png`,
      fullPage: false,
    });
    await p.route(`${api}/v1/docs`, async (route) => {
      const res = await route.fetch();
      const body = (await res.text()).replace(
        "</main>",
        `<style>main{max-width:1px}</style><script>window.__pwn=1</script><p id="x" style="color:red">x</p></main>`,
      );
      await route.fulfill({ response: res, body, headers: res.headers() });
    });
    await p.goto(`${api}/v1/docs`);
    const after = await p.evaluate(() => ({
      maxWidth: getComputedStyle(document.querySelector("main")).maxWidth,
      pwn: window.__pwn ?? null,
      violations: window.__csp,
    }));
    assert.equal(after.maxWidth, "920px");
    assert.equal(after.pwn, null);
    assert.ok(after.violations.length >= 2);
    result.docs = { csp, appliedMaxWidth: applied, injected: after };
    await ctx.close();
  } else result.docs = "SKIPPED: OTHERBRIDGE_DATA_DATABASE_URL not set";
  result.result = "PASS";
} catch (error) {
  result.result = "FAIL";
  result.error = String(error?.stack ?? error).slice(0, 2000);
} finally {
  await browser?.close();
  for (const c of children) c.child.kill();
  result.finishedAt = new Date().toISOString();
  await writeFile(`${base}/csp-results.json`, JSON.stringify(result, null, 2));
  await writeFile(
    `${base}/server.log`,
    children
      .map((c) => c.log())
      .join("\n---\n")
      .replace(/postgres(ql)?:\/\/\S+/g, "[database-url]"),
  );
}
console.log(
  JSON.stringify({
    result: result.result,
    pages: result.pages.length,
    error: result.error?.slice(0, 400),
  }),
);
process.exit(result.result === "PASS" ? 0 : 1);
