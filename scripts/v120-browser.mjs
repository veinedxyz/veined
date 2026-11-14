// Real Chromium visual/performance evidence. Wallet execution is forbidden.
// Run: node --experimental-transform-types --disable-warning=ExperimentalWarning --import ./scripts/ts-hooks.mjs scripts/v120-browser.mjs <evidence-root> <before|after> <origin> <quick|ui|perf|interactions|overview|all>
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixtureCatalog } from "../tests/fixtures/routing.ts";
import { normalizeActive } from "../src/catalog/model.ts";

const [root, phase = "before", origin = "http://127.0.0.1:3101", mode = "all"] =
  process.argv.slice(2);
if (!root || !["before", "after"].includes(phase))
  throw Error("EVIDENCE_ROOT_AND_VALID_PHASE_REQUIRED");
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin))
  throw Error("LOCAL_PREVIEW_ONLY");
const out = join(root, phase),
  perfOut = join(root, "performance"),
  discovery = join(root, "discovery");
for (const dir of [out, join(out, "screenshots"), perfOut, discovery])
  mkdirSync(dir, { recursive: true });
const fixtureFile = join(discovery, "browser-fixture.json");
if (!existsSync(fixtureFile)) {
  const now = Date.now(),
    routing = fixtureCatalog(now);
  writeFileSync(
    fixtureFile,
    JSON.stringify(
      {
        label:
          "SYNTHETIC_TEST_ONLY — frozen catalog for identical before/after UI and lab measurements",
        routing,
        catalog: normalizeActive(
          routing.networks
            .filter((n) => n.mainnet)
            .map((n) => ({ name: n.name, chainId: n.id, tvl: 1e6 })),
          routing,
          now,
          "SYNTHETIC_TEST_ONLY",
        ),
        bridge: { mode: "mainnet-readonly", submission: false, version: "1" },
      },
      null,
      2,
    ),
  );
}
const fixtureText = readFileSync(fixtureFile, "utf8"),
  fixture = JSON.parse(fixtureText);
const fixtureHash = createHash("sha256").update(fixtureText).digest("hex");
const harnessSha256 = createHash("sha256")
  .update(readFileSync(new URL(import.meta.url)))
  .digest("hex");
const slowMobile = process.env.VEINED_SLOW_MOBILE === "1";
const paths = [
  "/",
  "/bridge",
  "/swap",
  "/portfolio",
  "/networks",
  "/activity",
  "/help",
  "/docs",
  "/app",
  "/settings",
];
const browser = await chromium.launch();
const report = {
  phase,
  origin,
  mode,
  startedAt: new Date().toISOString(),
  browser: browser.version(),
  fixtureHash,
  harnessSha256,
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  syntheticFixtures: true,
  cases: [],
  errors: [],
};
// Resume a large visual matrix without losing already captured evidence.
if (mode === "ui" && existsSync(join(out, "ui-report.json"))) {
  const prior = JSON.parse(readFileSync(join(out, "ui-report.json"), "utf8"));
  if (prior.fixtureHash !== fixtureHash || prior.origin !== origin)
    throw Error("RESUME_FIXTURE_OR_ORIGIN_MISMATCH");
  report.cases = prior.cases;
  report.resumedFrom = prior.startedAt;
}
const method = {
  browser: browser.version(),
  fixtureHash,
  harnessSha256,
  sameHarness: "scripts/v120-browser.mjs",
  server: "production preview supplied by caller",
  network: slowMobile
    ? "CDP 150ms latency, 1.6Mbps download, 750Kbps upload, CPU 4x; local requests, external blocked"
    : "localhost, unthrottled; all external browser requests blocked",
  fixtures:
    "Frozen synthetic routing/catalog/assets and execution-disabled config. Unknown API calls return a labelled 503; no wallet calls or live financial execution.",
  performance: `3 sequential samples per path and viewport; each uses a fresh browser context (cold HTTP browser cache; Playwright request routing also disables HTTP cache). Node/OS and production server cache are not purged. ${slowMobile ? "Simulated mobile uses CDP 150ms latency, 1.6Mbps down, 750Kbps up, 4x CPU slowdown. This is not a physical device." : "No CPU or network throttling. Mobile means viewport width at DPR 1, not a physical mobile CPU."} Reported initial LCP/CLS use the 1-second-after-load settled cutoff before scroll; later observer records are also retained. CLS uses maximum session-window score excluding recent-input shifts. These are lab measurements, not field CWV.`,
  bytes:
    "PerformanceResourceTiming encodedBodySize, decodedBodySize, and transferSize; script includes JS fetched via prefetch before initial cutoff. Initial cutoff is 1 second after load plus settled fonts and two frames. Lazy bytes are resources added by scripted scroll afterward. Not bundle gzip estimates.",
  interaction:
    "Real trusted Playwright click where a harmless theme toggle or FAQ is available; EventTiming duration and click-to-next-two-rAF latency. This is lab interaction latency, NOT field INP.",
  scroll:
    "requestAnimationFrame interval distribution during 120 scripted scroll frames (at most 2200px range). Not a real-user FPS measurement.",
  coverage:
    "UI full matrix: 360,390,768,1440,1920 widths x dark/light x en/tr/ar x all named routes, plus reduced-motion spot checks. Screenshots are fullPage; landing also has an initial viewport and per-section captures for 390/1440 dark English.",
};
writeFileSync(join(perfOut, "method.json"), JSON.stringify(method, null, 2));
function save() {
  writeFileSync(
    join(out, `${mode}-report.json`),
    JSON.stringify(report, null, 2),
  );
}
async function contextFor(spec) {
  const context = await browser.newContext({
    viewport: { width: spec.width, height: 1000 },
    colorScheme: spec.theme,
    reducedMotion: spec.reducedMotion ? "reduce" : "no-preference",
    serviceWorkers: "block",
  });
  await context.addCookies([
    { name: "otherbridge.locale", value: spec.locale, url: origin },
  ]);
  await context.addInitScript(({ locale, theme }) => {
    localStorage.setItem("otherbridge.language", locale);
    localStorage.setItem("otherbridge.theme", theme);
    window.__v119 = {
      csp: [],
      wallet: [],
      lcp: [],
      shifts: [],
      events: [],
      longtasks: [],
    };
    document.addEventListener("securitypolicyviolation", (e) =>
      window.__v119.csp.push({
        directive: e.violatedDirective,
        blocked: e.blockedURI,
      }),
    );
    Object.defineProperty(window, "ethereum", {
      configurable: false,
      value: {
        request: async (args) => {
          window.__v119.wallet.push(args.method);
          throw Error("REAL_WALLET_FORBIDDEN_IN_PREVIEW");
        },
      },
    });
    const observe = (type, callback, options = {}) => {
      try {
        new PerformanceObserver((list) =>
          list.getEntries().forEach(callback),
        ).observe({ type, buffered: true, ...options });
      } catch {}
    };
    observe("largest-contentful-paint", (e) =>
      window.__v119.lcp.push({
        startTime: e.startTime,
        size: e.size,
        tag: e.element?.tagName,
        url: e.url,
      }),
    );
    observe("layout-shift", (e) =>
      window.__v119.shifts.push({
        startTime: e.startTime,
        value: e.value,
        hadRecentInput: e.hadRecentInput,
      }),
    );
    observe(
      "event",
      (e) =>
        window.__v119.events.push({
          name: e.name,
          startTime: e.startTime,
          duration: e.duration,
          processingStart: e.processingStart,
          processingEnd: e.processingEnd,
          interactionId: e.interactionId,
        }),
      { durationThreshold: 16 },
    );
    observe("longtask", (e) =>
      window.__v119.longtasks.push({
        startTime: e.startTime,
        duration: e.duration,
      }),
    );
  }, spec);
  const blocked = [],
    unknownApi = [];
  await context.route("**/*", async (route) => {
    const req = route.request(),
      url = new URL(req.url());
    if (url.origin !== origin) {
      blocked.push(req.url());
      return route.abort();
    }
    if (!url.pathname.startsWith("/api/")) return route.continue();
    let apiBody = {};
    try {
      apiBody = req.postDataJSON() ?? {};
    } catch {}
    if (
      url.pathname === "/api/routing" &&
      (req.method() === "GET" || apiBody.action === "catalog")
    )
      return route.fulfill({ json: fixture.routing });
    if (url.pathname === "/api/catalog")
      return route.fulfill({ json: fixture.catalog });
    if (url.pathname === "/api/bridge" && req.method() === "GET")
      return route.fulfill({ json: fixture.bridge });
    if (url.pathname === "/api/bridge" && apiBody.action === "health")
      return route.fulfill({
        json: {
          mode: "mainnet-readonly",
          observedAt: fixture.routing.observedAt,
          status: "unknown",
          reasons: ["PROVIDER_UNAVAILABLE"],
        },
      });
    if (url.pathname === "/api/assets") {
      let body = {};
      try {
        body = req.postDataJSON() ?? {};
      } catch {}
      const assets = [
        {
          address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
        },
      ].map((a) => ({
        ...a,
        chainId: body.chain,
        native: false,
        level: "CURATED",
        risk: [],
        sources: ["SYNTHETIC_TEST_ONLY"],
        logo: null,
        logoUrl: null,
        routable: true,
        routeStatus: "ROUTABLE",
        evidence: {
          curated: true,
          trustWallet: false,
          marketListed: null,
          dex: null,
          onebridge: null,
        },
      }));
      return route.fulfill({ json: { assets, results: assets, lookup: true } });
    }
    unknownApi.push({ url: req.url(), method: req.method() });
    return route.fulfill({
      status: 503,
      json: { error: "SYNTHETIC_TEST_ONLY_UNEXERCISED_API" },
    });
  });
  return { context, blocked, unknownApi };
}
async function settled(page, spec, path) {
  const started = performance.now();
  const response = await page.goto(origin + path, {
    waitUntil: "load",
    timeout: 45000,
  });
  await page.locator("h1").first().waitFor({ timeout: 20000 });
  await page.waitForFunction(
    (theme) => document.documentElement.dataset.theme === theme,
    spec.theme,
    { timeout: 15000 },
  );
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(1000);
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
  return { status: response?.status(), readyMs: performance.now() - started };
}
async function inspect(page) {
  return page.evaluate(() => {
    const nodes = [...document.querySelectorAll("body *")];
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
      documentHeight: document.documentElement.scrollHeight,
      dir: document.documentElement.dir,
      theme: document.documentElement.dataset.theme,
      title: document.title,
      overflowNodes: nodes
        .filter((n) => {
          const r = n.getBoundingClientRect();
          return (
            r.width > 0 &&
            (r.left < -1 || r.right > innerWidth + 1) &&
            getComputedStyle(n).position !== "fixed"
          );
        })
        .slice(0, 16)
        .map((n) => ({
          tag: n.tagName,
          class: typeof n.className === "string" ? n.className : "",
          width: n.getBoundingClientRect().width,
        })),
      brokenImages: [...document.images]
        .filter((i) => i.complete && !i.naturalWidth)
        .map((i) => i.getAttribute("src")),
      pendingImages: [...document.images]
        .filter((i) => !i.complete)
        .map((i) => i.getAttribute("src")),
      csp: window.__v119.csp,
      wallet: window.__v119.wallet,
      reducedMotion: matchMedia("(prefers-reduced-motion: reduce)").matches,
      activeAnimations: document
        .getAnimations()
        .filter((a) => a.playState === "running")
        .map((a) => ({
          name: a.animationName ?? "transition",
          duration: a.effect?.getTiming().duration,
          iterations:
            a.effect?.getTiming().iterations === Infinity
              ? "Infinity"
              : a.effect?.getTiming().iterations,
        })),
    };
  });
}
function idFor(spec, path) {
  return `${spec.width}-${spec.theme}-${spec.locale}-${path.replaceAll("/", "") || "landing"}${spec.reducedMotion ? "-reduced" : ""}`;
}
async function uiCase(spec, path) {
  const id = idFor(spec, path),
    { context, blocked, unknownApi } = await contextFor(spec),
    page = await context.newPage(),
    errors = [],
    consoleErrors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  try {
    const nav = await settled(page, spec, path);
    const initial = await inspect(page);
    if (
      path === "/" &&
      spec.theme === "dark" &&
      spec.locale === "en" &&
      [390, 1440].includes(spec.width) &&
      !spec.reducedMotion
    )
      await page.screenshot({
        path: join(out, "screenshots", `${id}-viewport.png`),
      });
    // Reveal and load each page section before the full-page capture.
    await page.evaluate(async () => {
      for (
        let y = 0;
        y < document.documentElement.scrollHeight;
        y += innerHeight * 0.75
      ) {
        scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 60));
      }
      scrollTo(0, 0);
    });
    await page.waitForTimeout(350);
    await page.screenshot({
      path: join(out, "screenshots", `${id}.png`),
      fullPage: true,
    });
    const shape = await inspect(page);
    if (
      path === "/" &&
      spec.theme === "dark" &&
      spec.locale === "en" &&
      [390, 1440].includes(spec.width) &&
      !spec.reducedMotion
    ) {
      const sections = page.locator("main section");
      for (let i = 0; i < (await sections.count()); i++)
        await sections.nth(i).screenshot({
          path: join(
            out,
            "screenshots",
            `${id}-section-${String(i + 1).padStart(2, "0")}.png`,
          ),
          animations: "disabled",
        });
    }
    const axe = await new AxeBuilder({ page }).analyze();
    const violations = axe.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      description: v.description,
      nodes: v.nodes.map((n) => ({
        target: n.target,
        failureSummary: n.failureSummary,
      })),
    }));
    const reducedMotionPass =
      !spec.reducedMotion ||
      shape.activeAnimations.every(
        (a) => typeof a.duration === "number" && a.duration <= 1,
      );
    const pass =
      nav.status === 200 &&
      shape.scrollWidth <= shape.clientWidth + 1 &&
      !shape.brokenImages.length &&
      !shape.csp.length &&
      !shape.wallet.length &&
      !errors.length &&
      !consoleErrors.length &&
      !violations.length &&
      shape.dir === (spec.locale === "ar" ? "rtl" : "ltr") &&
      reducedMotionPass;
    report.cases.push({
      id,
      path,
      ...spec,
      ...nav,
      initial,
      ...shape,
      violations,
      errors,
      consoleErrors,
      blocked,
      unknownApi,
      reducedMotionPass,
      pass,
    });
    console.log(`${phase} ${id}: ${pass ? "PASS" : "ISSUES"}`);
  } catch (e) {
    await page
      .screenshot({
        path: join(out, "screenshots", `${id}-error.png`),
        fullPage: true,
      })
      .catch(() => {});
    report.errors.push({
      id,
      error: String(e),
      pageErrors: errors,
      consoleErrors,
      body: await page
        .locator("body")
        .innerText()
        .catch(() => "unavailable"),
    });
    console.log(`${phase} ${id}: ERROR ${e.message}`);
  } finally {
    await context.close();
    save();
  }
}
async function resourceMetrics(page) {
  return page.evaluate(() => {
    const entries = performance.getEntriesByType("resource").map((e) => ({
      name: e.name,
      initiatorType: e.initiatorType,
      startTime: e.startTime,
      duration: e.duration,
      transferSize: e.transferSize,
      encodedBodySize: e.encodedBodySize,
      decodedBodySize: e.decodedBodySize,
    }));
    const sum = (predicate) =>
      entries.filter(predicate).reduce(
        (a, e) => ({
          count: a.count + 1,
          transfer: a.transfer + e.transferSize,
          encoded: a.encoded + e.encodedBodySize,
          decoded: a.decoded + e.decodedBodySize,
        }),
        { count: 0, transfer: 0, encoded: 0, decoded: 0 },
      );
    let cls = 0,
      score = 0,
      first = 0,
      last = null;
    for (const shift of window.__v119.shifts.filter((s) => !s.hadRecentInput)) {
      if (
        last !== null &&
        shift.startTime - last < 1000 &&
        shift.startTime - first < 5000
      )
        score += shift.value;
      else {
        first = shift.startTime;
        score = shift.value;
      }
      last = shift.startTime;
      cls = Math.max(cls, score);
    }
    return {
      elapsedMs: performance.now(),
      lcpMs: window.__v119.lcp.at(-1)?.startTime ?? null,
      cls,
      lcpEntries: window.__v119.lcp,
      shifts: window.__v119.shifts,
      navigation: performance.getEntriesByType("navigation")[0]?.toJSON(),
      js: sum((e) => /\.m?js(?:\?|$)/.test(e.name)),
      images: sum(
        (e) =>
          e.initiatorType === "img" ||
          /\.(avif|webp|png|svg|jpe?g)(?:\?|$)/.test(e.name),
      ),
      total: sum(() => true),
      entries,
      longtasks: window.__v119.longtasks,
    };
  });
}
async function perfCase(spec, path, sample) {
  const { context, blocked, unknownApi } = await contextFor(spec),
    page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (slowMobile) {
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.enable");
    await cdp.send("Network.emulateNetworkConditions", {
      offline: false,
      latency: 150,
      downloadThroughput: 1600000 / 8,
      uploadThroughput: 750000 / 8,
    });
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
  }
  try {
    const nav = await settled(page, spec, path),
      initial = await resourceMetrics(page);
    const raf = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const intervals = [];
          let prior,
            n = 0;
          const max = Math.min(
            2200,
            Math.max(0, document.documentElement.scrollHeight - innerHeight),
          );
          const frame = (t) => {
            if (prior !== undefined) intervals.push(t - prior);
            prior = t;
            scrollTo(0, (max * (1 - Math.cos((n / 120) * Math.PI * 2))) / 2);
            if (++n < 120) requestAnimationFrame(frame);
            else {
              scrollTo(0, 0);
              resolve(intervals);
            }
          };
          requestAnimationFrame(frame);
        }),
    );
    await page.waitForTimeout(300);
    const afterScroll = await resourceMetrics(page),
      initialNames = new Set(initial.entries.map((e) => e.name)),
      lazyEntries = afterScroll.entries.filter(
        (e) => !initialNames.has(e.name),
      );
    const sorted = [...raf].sort((a, b) => a - b),
      quantile = (p) =>
        sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
    let interaction = {
      target: null,
      note: "No harmless interaction target found",
    };
    const candidates = [
      page.locator(".theme-toggle").first(),
      page.locator("main details summary").first(),
    ];
    for (const target of candidates) {
      if (!(await target.count()) || !(await target.isVisible())) continue;
      await target.scrollIntoViewIfNeeded();
      await target.evaluate((el) =>
        el.addEventListener(
          "click",
          () => {
            const start = performance.now();
            window.__v119.clickStart = start;
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                window.__v119.clickTwoFramesMs = performance.now() - start;
              }),
            );
          },
          { once: true },
        ),
      );
      const label = await target.evaluate(
        (el) => el.getAttribute("aria-label") || el.textContent?.slice(0, 120),
      );
      await target.click();
      await page.waitForTimeout(150);
      interaction = await page.evaluate(
        (label) => ({
          target: label,
          clickToTwoFramesMs: window.__v119.clickTwoFramesMs ?? null,
          eventTiming: window.__v119.events.filter(
            (e) => e.startTime >= (window.__v119.clickStart ?? Infinity) - 25,
          ),
          note: "Lab interaction; not field INP",
        }),
        label,
      );
      break;
    }
    let softNavigation = null;
    const targetPath = path === "/bridge" ? "/swap" : "/bridge",
      link = page
        .locator(`a[href="${targetPath}"]`)
        .filter({ visible: true })
        .first();
    if (await link.count()) {
      const start = performance.now();
      await link.click();
      await page.waitForURL((url) => url.pathname === targetPath);
      await page.locator("h1").first().waitFor();
      await page.evaluate(
        () =>
          new Promise((r) =>
            requestAnimationFrame(() => requestAnimationFrame(r)),
          ),
      );
      softNavigation = {
        from: path,
        to: targetPath,
        clickToDestinationTwoFramesMs: performance.now() - start,
        note: "Browser automation wall time including actionability; not router CPU time",
      };
    }
    const result = {
      path,
      ...spec,
      sample,
      ...nav,
      initial,
      afterScroll,
      lazy: {
        entries: lazyEntries,
        encodedBytes: lazyEntries.reduce((s, e) => s + e.encodedBodySize, 0),
        transferBytes: lazyEntries.reduce((s, e) => s + e.transferSize, 0),
      },
      scroll: {
        intervalsMs: raf,
        medianMs: quantile(0.5),
        p95Ms: quantile(0.95),
        maxMs: sorted.at(-1),
        over32Ms: raf.filter((v) => v > 32).length,
      },
      interaction,
      softNavigation,
      safety: await inspect(page),
      errors,
      blocked,
      unknownApi,
    };
    report.cases.push(result);
    console.log(
      `${phase} PERF ${spec.width} ${path} #${sample}: LCP=${initial.lcpMs} CLS=${initial.cls} JS=${initial.js.encoded}`,
    );
  } catch (e) {
    report.errors.push({ path, ...spec, sample, error: String(e) });
    console.log(`PERF ERROR ${path}: ${e.message}`);
  } finally {
    await context.close();
    writeFileSync(
      join(perfOut, `${phase}-raw.json`),
      JSON.stringify(report, null, 2),
    );
  }
}

async function interactionCases(width) {
  const { portfolioFixture, holding } =
    await import("../tests/fixtures/portfolio.ts");
  const { defiFixture, defiWallet, loan } =
    await import("../tests/fixtures/defi.ts");
  const { installPrimaryAssets, installPrimarySwap } =
    await import("../tests/e2e/swap-primary.ts");
  const interactionFixtureFile = join(discovery, "interaction-fixture.json");
  if (!existsSync(interactionFixtureFile)) {
    const portfolio = portfolioFixture();
    portfolio.holdings = [
      holding("1", "1000000000000000000", 2800),
      holding("1", "1000000", 1, {
        address: loan,
        native: false,
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      }),
    ];
    writeFileSync(
      interactionFixtureFile,
      JSON.stringify(
        {
          label:
            "SYNTHETIC_TEST_ONLY — loaded portfolio/DeFi views; no live scan",
          portfolio,
          defi: await defiFixture(),
          wallet: defiWallet,
        },
        null,
        2,
      ),
    );
  }
  const interactionText = readFileSync(interactionFixtureFile, "utf8"),
    synthetic = JSON.parse(interactionText);
  report.interactionFixtureHash = createHash("sha256")
    .update(interactionText)
    .digest("hex");
  const spec = { width, theme: "dark", locale: "en" },
    { context, blocked, unknownApi } = await contextFor(spec);
  await context.route("**/api/portfolio", (r) =>
    r.fulfill({ json: synthetic.portfolio }),
  );
  await context.route("**/api/portfolio/defi", (r) =>
    r.fulfill({
      json: {
        ...synthetic.defi,
        wallet: r.request().postDataJSON().wallet.toLowerCase(),
      },
    }),
  );
  await installPrimaryAssets(context);
  await installPrimarySwap(context);
  const page = await context.newPage(),
    errors = [],
    consoleErrors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  const dictionary = JSON.parse(
    readFileSync("src/i18n/locales/en.json", "utf8"),
  );
  async function record(label, path, fullPage = true, extra = {}) {
    await page.evaluate(() =>
      Promise.all(
        [...document.querySelectorAll("dialog[open]")].flatMap((dialog) =>
          dialog
            .getAnimations({ subtree: true })
            .map((animation) => animation.finished.catch(() => {})),
        ),
      ),
    );
    await page.waitForTimeout(100);
    const id = `${width}-dark-en-${label}`,
      shape = await inspect(page);
    await page.screenshot({
      path: join(out, "screenshots", `${id}.png`),
      fullPage,
    });
    const axe = await new AxeBuilder({ page }).analyze(),
      violations = axe.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => ({
          target: n.target,
          failureSummary: n.failureSummary,
        })),
      }));
    const pass =
      shape.scrollWidth <= shape.clientWidth + 1 &&
      !shape.brokenImages.length &&
      !shape.csp.length &&
      !shape.wallet.length &&
      !errors.length &&
      !consoleErrors.length &&
      !violations.length;
    report.cases.push({
      id,
      path,
      ...spec,
      ...shape,
      violations,
      errors: [...errors],
      consoleErrors: [...consoleErrors],
      blocked: [...blocked],
      unknownApi: [...unknownApi],
      synthetic: true,
      ...extra,
      pass,
    });
    save();
    console.log(`${phase} INTERACTION ${id}: ${pass ? "PASS" : "ISSUES"}`);
  }
  async function markFirstResult(button, selector, label) {
    await button.evaluate(
      (el, { selector, label }) => {
        window.__v119.labResults ??= {};
        el.addEventListener(
          "click",
          () => {
            const start = performance.now();
            const observer = new MutationObserver(() => {
              const result = document.querySelector(selector);
              if (!result || !result.getBoundingClientRect().height) return;
              observer.disconnect();
              const domMs = performance.now() - start;
              requestAnimationFrame(() =>
                requestAnimationFrame(() => {
                  window.__v119.labResults[label] = {
                    clickToDOMMs: domMs,
                    clickToTwoFramesMs: performance.now() - start,
                    note: "Synthetic fixture response; lab UI render timing, not production provider/indexer latency or field INP",
                  };
                }),
              );
            });
            observer.observe(document.body, { childList: true, subtree: true });
          },
          { once: true },
        );
      },
      { selector, label },
    );
  }
  try {
    await settled(page, spec, "/portfolio");
    await page.locator(".scan-field input").first().fill(synthetic.wallet);
    const scanButton = page.locator(".scan-button");
    await markFirstResult(
      scanButton,
      '[data-testid="portfolio-summary"]',
      "firstScanResult",
    );
    await scanButton.click();
    await page.getByTestId("portfolio-summary").waitFor();
    await page.getByTestId("defi-intelligence").waitFor();
    await page.locator(".defi-allocation button").first().waitFor();
    await page.waitForFunction(() =>
      Boolean(window.__v119.labResults?.firstScanResult),
    );
    await record("portfolio-loaded", "/portfolio#loaded", true, {
      timing: await page.evaluate(
        () => window.__v119.labResults.firstScanResult,
      ),
    });
    for (const view of ["defi", "debt", "rewards"]) {
      await page.locator(`#portfolio-tab-${view}`).click();
      await page.locator(".defi-position-card").first().waitFor();
      await record(`portfolio-${view}`, `/portfolio#${view}`, true, {
        visiblePositions: await page.locator(".defi-position-card").count(),
      });
    }
    if (phase === "after") {
      await page.locator('a[href="/app"]').first().click();
      await page.waitForURL((url) => url.pathname === "/app");
      await page.locator(".overview-wallet h2").waitFor();
      const watchedState = await page.locator(".overview-wallet").innerText();
      if (watchedState.includes(dictionary.v110.notScanned))
        throw Error("OVERVIEW_INCORRECTLY_SHOWS_NOT_SCANNED_AFTER_PUBLIC_SCAN");
      if (
        (await page.locator(".overview-wallet h2").innerText()) !==
        dictionary.v13.portfolio
      )
        throw Error("OVERVIEW_WATCHED_PORTFOLIO_HEADING_MISMATCH");
      await record("app-watched-portfolio", "/app#watched-portfolio", true, {
        watchedState,
        walletConnected: false,
      });
    }
    await settled(page, spec, "/swap");
    const card = page.getByTestId("swap-intelligence");
    await card.locator(".token-select-trigger").nth(1).click();
    const token = page
      .getByRole("dialog")
      .getByRole("option")
      .filter({ hasText: "USDC" })
      .first();
    await token.waitFor();
    await record("swap-token-picker", "/swap#token-picker", false);
    await token.click();
    await card.getByLabel(dictionary.v115.readAddress).fill(synthetic.wallet);
    await card.locator("#meta-amount").fill("0.01");
    const compare = card.getByRole("button", {
      name: "Compare providers",
      exact: true,
    });
    await markFirstResult(compare, ".meta-quote-options button", "firstQuote");
    await compare.click();
    await card.locator(".meta-quote-options button").first().waitFor();
    await card
      .getByRole("button", { name: "Review Swap", exact: true })
      .waitFor();
    await page.waitForFunction(() =>
      Boolean(window.__v119.labResults?.firstQuote),
    );
    await record("swap-provider-comparison", "/swap#comparison", true, {
      timing: await page.evaluate(() => window.__v119.labResults.firstQuote),
      providerOptions: await card.locator(".meta-quote-options button").count(),
    });
    await card
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    const dialog = page.locator(".review-dialog[open]");
    await dialog.waitFor();
    await page
      .getByText("Execution closed — route verified for review", {
        exact: false,
      })
      .waitFor();
    const forbiddenButtons = await dialog
      .getByRole("button", { name: /sign|approve|confirm swap/i })
      .count();
    if (forbiddenButtons) throw Error("UNEXPECTED_EXECUTION_CONTROL");
    await record("swap-closed-review", "/swap#review", false, {
      execution: "CLOSED",
      forbiddenButtons,
    });
  } catch (e) {
    report.errors.push({ width, mode: "interactions", error: String(e) });
    save();
    console.log(`INTERACTION ERROR ${width}: ${e.message}`);
  } finally {
    await context.close();
  }
}
try {
  if (mode === "overview")
    for (const width of [1440, 390])
      await uiCase({ width, theme: "dark", locale: "en" }, "/app");
  if (["quick", "ui", "all"].includes(mode)) {
    const matrix = [];
    const widths = mode === "quick" ? [1440, 390] : [1440, 390, 360, 768, 1920];
    for (const width of widths)
      for (const theme of mode === "quick" ? ["dark"] : ["dark", "light"])
        for (const locale of mode === "quick" ? ["en"] : ["en", "tr", "ar"])
          matrix.push({ width, theme, locale });
    const queue = [];
    for (const spec of matrix)
      for (const path of mode === "quick"
        ? ["/", "/bridge", "/swap", "/portfolio"]
        : paths)
        if (!report.cases.some((c) => c.id === idFor(spec, path)))
          queue.push({ spec, path });
    await Promise.all(
      Array.from({ length: mode === "quick" ? 1 : 3 }, async () => {
        while (queue.length) {
          const task = queue.shift();
          await uiCase(task.spec, task.path);
        }
      }),
    );
    if (mode !== "quick")
      for (const spec of matrix)
        for (const path of ["/", "/bridge", "/swap", "/portfolio"])
          await uiCase({ ...spec, reducedMotion: true }, path);
  }
  if (["perf", "all"].includes(mode)) {
    for (const width of slowMobile ? [390] : [1440, 390])
      for (const path of slowMobile
        ? ["/portfolio", "/app"]
        : ["/", "/bridge", "/swap", "/portfolio"])
        for (let sample = 1; sample <= 3; sample++)
          await perfCase({ width, theme: "dark", locale: "en" }, path, sample);
  }
  if (mode === "interactions")
    for (const width of [1440, 390]) await interactionCases(width);
} finally {
  report.finishedAt = new Date().toISOString();
  save();
  if (["perf", "all"].includes(mode))
    writeFileSync(
      join(perfOut, `${phase}-raw.json`),
      JSON.stringify(report, null, 2),
    );
  await browser.close();
}

// Keep a compact view alongside raw observer/resource records. Never substitute
// these aggregates for the original samples when investigating a regression.
if (["perf", "all"].includes(mode)) {
  const median = (values) => {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  };
  const summaryFor = (data) =>
    Object.entries(
      Object.groupBy(
        data.cases.filter((c) => c.initial?.js),
        (c) => `${c.width} ${c.path}`,
      ),
    ).map(([key, samples]) => ({
      key,
      samples: samples.length,
      lcpMedianMs: median(samples.map((c) => c.initial.lcpMs)),
      lcpMaxMs: Math.max(...samples.map((c) => c.initial.lcpMs ?? 0)),
      clsMax: Math.max(...samples.map((c) => c.initial.cls)),
      clsAfterScrollMax: Math.max(...samples.map((c) => c.afterScroll.cls)),
      initialJsEncodedBytes: median(samples.map((c) => c.initial.js.encoded)),
      initialImageEncodedBytes: median(
        samples.map((c) => c.initial.images.encoded),
      ),
      lazyEncodedBytes: median(samples.map((c) => c.lazy.encodedBytes)),
      readyMedianMs: median(samples.map((c) => c.readyMs)),
      scrollP95MedianMs: median(samples.map((c) => c.scroll.p95Ms)),
      clickToTwoFramesMedianMs: median(
        samples.map((c) => c.interaction.clickToTwoFramesMs),
      ),
      softNavigationMedianMs: median(
        samples.map((c) => c.softNavigation?.clickToDestinationTwoFramesMs),
      ),
      fieldINP: "NOT_MEASURED — lab interaction latency only",
    }));
  const summary = summaryFor(report);
  writeFileSync(
    join(perfOut, `${phase}-summary.json`),
    JSON.stringify({ fixtureHash, summary }, null, 2),
  );
  if (phase === "after" && existsSync(join(perfOut, "before-raw.json"))) {
    const baseline = JSON.parse(
      readFileSync(join(perfOut, "before-raw.json"), "utf8"),
    );
    if (baseline.fixtureHash !== fixtureHash)
      throw Error("PERFORMANCE_FIXTURE_MISMATCH");
    const prior = summaryFor(baseline);
    const comparison = summary.map((after) => {
      const before = prior.find((item) => item.key === after.key);
      const deltas = Object.fromEntries(
        Object.keys(after)
          .filter(
            (k) =>
              k !== "samples" &&
              typeof after[k] === "number" &&
              typeof before?.[k] === "number",
          )
          .map((k) => [
            k,
            {
              absolute: after[k] - before[k],
              percent: before[k]
                ? ((after[k] - before[k]) / before[k]) * 100
                : null,
            },
          ]),
      );
      return { key: after.key, before, after, deltas };
    });
    writeFileSync(
      join(perfOut, "comparison.json"),
      JSON.stringify({ fixtureHash, method, comparison }, null, 2),
    );
  }
}
