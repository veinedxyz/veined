// Production-build local acceptance. All wallet and transaction data below is synthetic browser replay.
import { chromium } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fixtureCatalog } from "../tests/fixtures/routing.ts";
import { portfolioFixture, holding } from "../tests/fixtures/portfolio.ts";
import { defiFixture, defiWallet, loan } from "../tests/fixtures/defi.ts";
import {
  installPrimaryAssets,
  installPrimarySwap,
} from "../tests/e2e/swap-primary.ts";
import { normalizeActive } from "../src/catalog/model.ts";
const out = process.argv[2];
if (!out) throw Error("EVIDENCE_DIRECTORY_REQUIRED");
mkdirSync(out + "/screenshots", { recursive: true });
const origin = "http://127.0.0.1:3118";
const server = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3118",
  ],
  {
    env: {
      ...process.env,
      OTHERBRIDGE_APP_ORIGINS: origin,
      OTHERBRIDGE_PUBLIC_INDEXING: "false",
      OTHERBRIDGE_PUBLIC_DEPLOYMENT: "false",
    },
    windowsHide: true,
  },
);
let log = "",
  browser;
server.stdout.on("data", (b) => (log += b));
server.stderr.on("data", (b) => (log += b));
const cases = [],
  errors = [],
  external = [],
  actions = [];
const catalog = fixtureCatalog(),
  portfolio = portfolioFixture(),
  defi = await defiFixture();
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
const matrix = [];
for (const width of [360, 390, 768, 1440])
  for (const theme of ["dark", "light"])
    for (const locale of ["en", "tr", "ar"])
      matrix.push({ width, theme, locale });
for (const locale of ["fa", "he", "ur"])
  matrix.push({ width: 390, theme: "dark", locale });
const paths = [
  "/",
  "/portfolio",
  "/swap",
  "/bridge",
  "/activity",
  "/networks",
  "/help",
  "/docs",
  "/settings",
  "/v118-missing-page",
];
function save() {
  writeFileSync(
    out + "/ui-progress.json",
    JSON.stringify({ cases, errors, external, actions }, null, 2) + "\n",
  );
}
async function check(page, id, meta, status = 200) {
  await page.locator("h1").first().waitFor();
  // Assess the settled dialog, not a sampled opacity frame of its accepted entrance animation.
  await page.evaluate(() =>
    Promise.all(
      [...document.querySelectorAll("dialog[open]")].flatMap((dialog) =>
        dialog
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished.catch(() => {})),
      ),
    ),
  );
  const shape = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
    dir: document.documentElement.dir,
    theme: document.documentElement.dataset.theme,
    title: document.title,
    // Include hidden UI text, but exclude executable script/style data (stable storage/i18n keys live there).
    text: (() => {
      const walker = document.createTreeWalker(
        document.body,
        NodeFilter.SHOW_TEXT,
      );
      const parts = [];
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.parentElement?.closest("script,style"))
          parts.push(node.textContent);
      }
      return parts.join(" ");
    })(),
    oldIcons: document.querySelectorAll(".brand-mark,.mk-brand svg").length,
    brokenImages: [...document.images]
      .filter((i) => i.complete && !i.naturalWidth)
      .map((i) => i.getAttribute("src")),
    csp: window.__v118Csp ?? [],
    walletRequests: window.__v118WalletRequests ?? [],
    social: [...document.querySelectorAll("a[href]")]
      .map((a) => a.getAttribute("href"))
      .filter((h) => /x\.com\/veinedxyz|mailto:/.test(h)),
    canon: document
      .querySelector('link[rel="canonical"]')
      ?.getAttribute("href"),
    og: document
      .querySelector('meta[property="og:site_name"]')
      ?.getAttribute("content"),
    robots: document
      .querySelector('meta[name="robots"]')
      ?.getAttribute("content"),
  }));
  const axe = await new AxeBuilder({ page }).analyze();
  const violations = axe.violations.map((v) => ({
    id: v.id,
    impact: v.impact,
    nodes: v.nodes.map((n) => n.target),
  }));
  const legacy = /other[- ]?bridge/i.test(shape.text ?? "");
  const pass =
    status === (meta.path === "/v118-missing-page" ? 404 : 200) &&
    shape.scroll <= shape.client + 1 &&
    shape.title.includes("VEINED") &&
    !legacy &&
    !shape.oldIcons &&
    !shape.brokenImages.length &&
    !shape.csp.length &&
    !shape.walletRequests.length &&
    !shape.social.length &&
    !violations.length &&
    shape.dir ===
      (["ar", "fa", "he", "ur"].includes(meta.locale) ? "rtl" : "ltr") &&
    /noindex/.test(shape.robots ?? "") &&
    (meta.path === "/v118-missing-page" || shape.theme === meta.theme);
  await page.screenshot({
    path: out + "/screenshots/" + id + ".png",
    fullPage: !meta.path.endsWith("#review"),
  });
  const { text, ...rest } = shape;
  cases.push({ id, ...meta, status, ...rest, legacy, violations, pass });
  save();
}
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
  browser = await chromium.launch();
  for (const spec of matrix) {
    const { width, theme, locale } = spec;
    const dictionary = JSON.parse(
      readFileSync("src/i18n/locales/" + locale + ".json", "utf8"),
    );
    const context = await browser.newContext({
      viewport: { width, height: 1000 },
      colorScheme: theme,
    });
    await context.addCookies([
      { name: "otherbridge.locale", value: locale, url: origin },
    ]);
    await context.addInitScript(
      ({ locale, theme }) => {
        localStorage.setItem("otherbridge.language", locale);
        localStorage.setItem("otherbridge.theme", theme);
        window.__v118Csp = [];
        window.__v118WalletRequests = [];
        document.addEventListener("securitypolicyviolation", (e) =>
          window.__v118Csp.push({
            directive: e.violatedDirective,
            blocked: e.blockedURI,
          }),
        );
        Object.defineProperty(window, "ethereum", {
          value: {
            request: async (args) => {
              window.__v118WalletRequests.push(args.method);
              throw Error("REAL_WALLET_FORBIDDEN_IN_PREVIEW");
            },
          },
        });
      },
      { locale, theme },
    );
    await context.route(
      (url) => url.hostname !== "127.0.0.1" && url.hostname !== "localhost",
      (r) => {
        external.push(r.request().url());
        return r.abort();
      },
    );
    await context.route("**/api/routing", (r) => r.fulfill({ json: catalog }));
    await context.route("**/api/catalog", (r) =>
      r.fulfill({
        json: normalizeActive(
          catalog.networks
            .filter((n) => n.mainnet)
            .map((n) => ({ name: n.name, chainId: n.id, tvl: 1e6 })),
          catalog,
          Date.now(),
          "SYNTHETIC_TEST_ONLY",
        ),
      }),
    );
    await context.route("**/api/portfolio", (r) =>
      r.fulfill({ json: portfolio }),
    );
    await context.route("**/api/portfolio/defi", (r) =>
      r.fulfill({
        json: {
          ...defi,
          wallet: r.request().postDataJSON().wallet.toLowerCase(),
        },
      }),
    );
    await installPrimaryAssets(context);
    await installPrimarySwap(context);
    for (const path of paths) {
      const page = await context.newPage();
      const id = `${width}-${theme}-${locale}-${path.replaceAll("/", "") || "landing"}`;
      page.on("pageerror", (e) => errors.push({ id, message: e.message }));
      page.on("request", (r) => {
        if (
          /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_sign|signTypedData|wallet_sendCalls|wallet_grantPermissions/.test(
            r.postData() ?? "",
          )
        )
          actions.push({ id, url: r.url() });
      });
      const response = await page.goto(origin + path, {
        waitUntil: "networkidle",
      });
      if (path !== "/v118-missing-page")
        await page.waitForFunction(
          (t) => document.documentElement.dataset.theme === t,
          theme,
        );
      await check(page, id, { ...spec, path }, response.status());
      if (path === "/portfolio" && ["en", "tr", "ar"].includes(locale)) {
        await page.locator(".scan-field input").first().fill(defiWallet);
        await page.locator(".scan-button").click();
        await page.getByTestId("defi-intelligence").waitFor();
        await page
          .getByRole("button", { name: dictionary.v114.explore, exact: false })
          .click();
        await page.getByTestId("defi-explore").waitFor();
        await page
          .locator(".defi-explore-count")
          .filter({ hasText: /\d/ })
          .waitFor();
        await check(page, id + "-explore", {
          ...spec,
          path: "/portfolio#explore",
        });
      }
      if (path === "/swap" && locale === "en") {
        const card = page.getByTestId("swap-intelligence");
        await card.locator(".token-select-trigger").nth(1).click();
        await page
          .getByRole("dialog")
          .getByRole("option")
          .filter({ hasText: "USDC" })
          .first()
          .click();
        await card.getByLabel(dictionary.v115.readAddress).fill(defiWallet);
        await card.locator("#meta-amount").fill("0.01");
        await card
          .getByRole("button", { name: "Compare providers", exact: true })
          .click();
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
        if (
          await dialog
            .getByRole("button", { name: /sign|approve|confirm swap/i })
            .count()
        )
          throw Error("UNEXPECTED_EXECUTION_CONTROL");
        await check(page, id + "-closed-review", {
          ...spec,
          path: "/swap#review",
        });
      }
      await page.close();
    }
    await context.close();
    console.log(`${width} ${theme} ${locale} complete`);
  }
  const metadataPage = await browser.newPage();
  await metadataPage.goto(origin);
  const metadata = await metadataPage.locator("head").evaluate((head) => ({
    canonical: head.querySelector('link[rel="canonical"]')?.href,
    ogSite: head.querySelector('meta[property="og:site_name"]')?.content,
    ogImage: head.querySelector('meta[property="og:image"]')?.content,
    twitterCard: head.querySelector('meta[name="twitter:card"]')?.content,
    twitterImage: head.querySelector('meta[name="twitter:image"]')?.content,
  }));
  const manifest = await (await fetch(origin + "/manifest.webmanifest")).json();
  const robots = await (await fetch(origin + "/robots.txt")).text();
  const sitemap = await (await fetch(origin + "/sitemap.xml")).text();
  const assetStatuses = {};
  for (const path of [
    "/icon.svg",
    "/apple-icon.png",
    "/og/veined-preview.png",
    "/og/otherbridge-og.png",
  ])
    assetStatuses[path] = (await fetch(origin + path)).status;
  const pass =
    new URL(metadata.canonical).href === "https://veined.xyz/" &&
    metadata.ogSite === "VEINED" &&
    metadata.ogImage === "https://veined.xyz/og/veined-preview.png" &&
    metadata.twitterCard === "summary_large_image" &&
    manifest.name === "VEINED" &&
    robots.includes("Disallow: /") &&
    !sitemap.includes("<loc>") &&
    Object.values(assetStatuses).every((s) => s === 200);
  writeFileSync(
    out + "/metadata.json",
    JSON.stringify(
      { metadata, manifest, robots, sitemap, assetStatuses, pass },
      null,
      2,
    ) + "\n",
  );
  if (!pass) throw Error("PRODUCTION_METADATA_FAILED");
} catch (e) {
  errors.push({ error: String(e) });
} finally {
  await browser?.close();
  server.kill();
  writeFileSync(out + "/server.log", log);
}
const expected = matrix.length * paths.length + 24 + 8;
const result = {
  at: new Date().toISOString(),
  cases,
  errors,
  external,
  actions,
  expected,
  pass:
    cases.length === expected &&
    cases.every((c) => c.pass) &&
    !errors.length &&
    !external.length &&
    !actions.length,
  execution: "CLOSED",
  realWalletPrompts: 0,
};
writeFileSync(out + "/ui.json", JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    pass: result.pass,
    cases: cases.length,
    expected,
    failures: cases.filter((c) => !c.pass).map((c) => c.id),
    errors,
  }),
);
if (!result.pass) process.exitCode = 1;
