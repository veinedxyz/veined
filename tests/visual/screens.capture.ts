// Visual QA capture (SYNTHETIC_TEST_ONLY). Deterministic doubles for routing, swap quotes, portfolio, Privy and
// injected wallets; the points pages run against the isolated simulation server. Screenshots only: no wallet
// signature, approval, broadcast or live provider request. The same script captures the baseline and the redesign.
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, privyModal, test, readOnlyAddress } from "../e2e/fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "../e2e/privy-mock";
import { fixtureCatalog } from "../fixtures/routing";
import { portfolioFixture } from "../fixtures/portfolio";
import { wallet as readWallet } from "../fixtures/swap";
import { fixtureAccount } from "../../src/points/fixtures";

const OUT = process.env.UX_CAPTURE_OUT ?? "test-results/visual";
const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const OPS = process.env.PTS_E2E_OPS_TOKEN ?? "";
const OWNER = process.env.PTS_E2E_OWNER_TOKEN ?? "";
const ATLAS = fixtureAccount("atlas");
const ONLY = (process.env.UX_CAPTURE_ONLY ?? "").split(",").filter(Boolean);
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
  { name: "1920", width: 1920, height: 1080 },
  { name: "360", width: 360, height: 780 },
] as const;
const PAGE_VIEWPORTS = [
  VIEWPORTS[4],
  VIEWPORTS[0],
  VIEWPORTS[1],
  VIEWPORTS[2],
  VIEWPORTS[3],
] as const;
const ROUTES = [
  ["landing", "/"],
  ["overview", "/app"],
  ["swap", "/swap"],
  ["bridge", "/bridge"],
  ["portfolio", "/portfolio"],
  ["activity", "/activity"],
  ["networks", "/networks"],
  ["help", "/help"],
  ["points", "/points"],
  ["settings", "/settings"],
  ["about", "/about"],
  ["docs", "/docs"],
] as const;
const wants = (group: string) => !ONLY.length || ONLY.includes(group);
const metrics: Record<string, unknown> = {};

interface Prep {
  locale?: string;
  theme?: "dark" | "light";
  wallet?: boolean;
  chainId?: string;
}
async function prep(page: Page, o: Prep = {}) {
  const locale = o.locale ?? "en",
    theme = o.theme ?? "dark";
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript(
    ([l, th]) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", l);
      localStorage.setItem("otherbridge.theme", th);
    },
    [locale, theme] as const,
  );
  await page.route("**/api/routing", (r) =>
    r.fulfill({ json: fixtureCatalog() }),
  );
  await page.route("**/api/portfolio", (r) =>
    r.fulfill({ json: portfolioFixture("PARTIAL") }),
  );
  if (o.wallet)
    await page.addInitScript(installWalletDoubles, {
      wallets: ["metamask" as const],
      account: ATLAS,
      chainId: o.chainId ?? "0x7a69",
      doubles: WALLET_DOUBLES,
    });
}
async function settle(page: Page, ms = 700) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(ms);
}
async function measure(page: Page, name: string) {
  metrics[name] = await page.evaluate(() => {
    const de = document.documentElement;
    const small = [
      ...document.querySelectorAll<HTMLElement>(
        "button, a[href], input, select, summary, [role=tab], [role=option]",
      ),
    ].filter((el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return (
        r.width > 0 &&
        r.height > 0 &&
        s.visibility !== "hidden" &&
        r.top < innerHeight * 3 &&
        (r.height < 24 || r.width < 24) &&
        !el.closest(".sr-only, .skip")
      );
    });
    return {
      overflowX: de.scrollWidth > innerWidth + 1,
      scrollWidth: de.scrollWidth,
      height: de.scrollHeight,
      smallTargets: small.length,
      smallSample: small
        .slice(0, 8)
        .map(
          (el) =>
            `${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]}:${(el.textContent ?? "").trim().slice(0, 24)}`,
        ),
    };
  });
}
async function shot(page: Page, name: string, fullPage = true) {
  const path = `${OUT}/${name}.png`;
  mkdirSync(dirname(path), { recursive: true });
  await measure(page, name);
  await page.screenshot({ path, fullPage, animations: "disabled" });
}
async function ready(page: Page, key: string) {
  if (key === "swap")
    await expect(page.getByTestId("swap-intelligence")).toBeVisible({
      timeout: 60000,
    });
  else if (key === "landing" || key === "docs")
    await expect(page.locator("h1").first()).toBeVisible({ timeout: 60000 });
  else
    await expect(page.locator("main h1").first()).toBeVisible({
      timeout: 60000,
    });
}
async function go(page: Page, href: string) {
  await page
    .locator(`header a[href='${href}'], footer a[href='${href}']`)
    .first()
    .evaluate((a) => (a as HTMLAnchorElement).click());
  await expect(page).toHaveURL(new RegExp(`${href}$`));
}
async function quoteSwap(page: Page) {
  await page.goto("/swap");
  await ready(page, "swap");
  const card = page.getByTestId("swap-intelligence");
  await card.getByRole("button", { name: /^Destination token/ }).click();
  await page.locator("#token-search").fill("USDC");
  await page.getByRole("option").filter({ hasText: "USDC" }).first().click();
  const read = await readOnlyAddress(card);
  if (await read.count()) await read.fill(readWallet);
  await card.locator("#meta-amount").fill("1.5");
  await card
    .getByRole("button", { name: "Compare providers", exact: true })
    .click();
  await expect(card.getByRole("button", { name: /Uniswap · V3/ })).toBeVisible({
    timeout: 30000,
  });
  return card;
}
const admin = (request: APIRequestContext, token: string, body: unknown) =>
  request.post("/api/admin/points", {
    headers: { origin: ORIGIN, authorization: `Bearer ${token}` },
    data: body,
  });

test.describe.configure({ mode: "serial" });
test.afterAll(async () => {
  mkdirSync(OUT, { recursive: true });
  const { writeFileSync, existsSync, readFileSync } = await import("node:fs");
  const file = `${OUT}/metrics.json`;
  const prior = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  writeFileSync(file, JSON.stringify({ ...prior, ...metrics }, null, 1));
});

for (const vp of PAGE_VIEWPORTS)
  test(`pages @ ${vp.name}`, async ({ page }) => {
    test.skip(!wants("pages") && !wants(`pages-${vp.name}`));
    test.setTimeout(600000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await prep(page);
    for (const [key, href] of ROUTES) {
      await page.goto(href);
      await ready(page, key);
      // Lazy artwork below the fold loads only when scrolled into view, as for a real visitor.
      if (key === "landing")
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 600) {
            window.scrollTo(0, y);
            await new Promise((r) => setTimeout(r, 60));
          }
          window.scrollTo(0, 0);
        });
      await settle(page, key === "landing" ? 1200 : 700);
      await shot(page, `pages/${vp.name}/${key}`);
    }
  });

for (const vp of [VIEWPORTS[0], VIEWPORTS[2]])
  test(`swap and bridge states @ ${vp.name}`, async ({ page }) => {
    test.skip(!wants("states"));
    test.setTimeout(300000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await prep(page);
    await page.goto("/swap");
    await ready(page, "swap");
    const card0 = page.getByTestId("swap-intelligence");
    await card0.getByRole("button", { name: /^Destination token/ }).click();
    await expect(page.locator("#token-search")).toBeVisible();
    await settle(page);
    await shot(page, `states/${vp.name}/swap-token-picker`, false);
    await page.keyboard.press("Escape");
    const card = await quoteSwap(page);
    await settle(page);
    await shot(page, `states/${vp.name}/swap-quoted`);
    await card
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    await expect(page.locator("dialog.review-dialog[open]")).toBeVisible({
      timeout: 20000,
    });
    await settle(page);
    await shot(page, `states/${vp.name}/swap-review`, false);
    await page.keyboard.press("Escape");
    await page.goto("/bridge");
    await ready(page, "bridge");
    await page
      .getByRole("button", { name: "Select source network" })
      .first()
      .click();
    await expect(page.getByRole("dialog").first()).toBeVisible();
    await settle(page);
    await shot(page, `states/${vp.name}/bridge-network-picker`, false);
  });

for (const vp of [VIEWPORTS[0], VIEWPORTS[2]])
  test(`connected wallet @ ${vp.name}`, async ({ page }) => {
    test.skip(!wants("connected"));
    test.setTimeout(300000);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await prep(page, { wallet: true });
    await page.goto("/swap");
    await ready(page, "swap");
    await page
      .getByRole("button", { name: "Connect wallet", exact: true })
      .first()
      .click();
    await expect(privyModal(page)).toBeVisible({ timeout: 30000 });
    await settle(page, 1200);
    await shot(page, `states/${vp.name}/wallet-modal`, false);
    await privyModal(page)
      .getByRole("button", { name: /^MetaMask$/ })
      .first()
      .click();
    await expect(privyModal(page)).toBeHidden({ timeout: 30000 });
    await expect(page.locator("header .wallet-button")).toContainText(
      ATLAS.slice(0, 6),
      { timeout: 20000 },
    );
    await settle(page, 1500);
    await shot(page, `states/${vp.name}/swap-connected`);
    // Client-side navigation keeps the synthetic wallet session (a reload would drop the double's permission).
    await go(page, "/portfolio");
    await ready(page, "portfolio");
    await settle(page, 2500);
    await shot(page, `states/${vp.name}/portfolio-connected`);
    await go(page, "/points");
    await ready(page, "points");
    await settle(page, 1500);
    await shot(page, `states/${vp.name}/points-week1-connected`);
    await page.locator("header .wallet-button").click();
    await settle(page);
    await shot(page, `states/${vp.name}/wallet-dialog`, false);
  });

test("locales and RTL", async ({ page }) => {
  test.skip(!wants("locales"));
  test.setTimeout(600000);
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    for (const [locale, keys] of [
      ["ar", ["overview", "swap", "bridge", "points"]],
      ["de", ["overview", "swap"]],
      ["ru", ["overview", "bridge"]],
      ["ja", ["overview"]],
      ["fr", ["overview"]],
    ] as const) {
      await page.context().clearCookies();
      const p = await page.context().newPage();
      await p.setViewportSize({ width: vp.width, height: vp.height });
      await prep(p, { locale });
      for (const key of keys) {
        const href = ROUTES.find(([k]) => k === key)![1];
        await p.goto(href);
        await ready(p, key);
        await settle(p);
        await shot(p, `locales/${vp.name}/${locale}-${key}`, key !== "points");
      }
      await p.close();
    }
  }
});

test("light theme and 200% zoom", async ({ browser }) => {
  test.skip(!wants("theme"));
  test.setTimeout(600000);
  const light = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const lp = await light.newPage();
  await prep(lp, { theme: "light" });
  for (const key of ["overview", "swap", "bridge", "portfolio", "points"]) {
    const href = ROUTES.find(([k]) => k === key)![1];
    await lp.goto(href);
    await ready(lp, key);
    await settle(lp);
    await shot(lp, `theme/light-1440-${key}`);
  }
  await lp.setViewportSize({ width: 390, height: 844 });
  for (const key of ["overview", "swap", "bridge", "points"]) {
    const href = ROUTES.find(([k]) => k === key)![1];
    await lp.goto(href);
    await ready(lp, key);
    await settle(lp);
    await shot(lp, `theme/light-390-${key}`);
  }
  await light.close();
  // 200% browser zoom of a 1440 x 900 window = a 720 x 450 CSS viewport at device scale 2.
  const zoom = await browser.newContext({
    viewport: { width: 720, height: 450 },
    deviceScaleFactor: 2,
  });
  const zp = await zoom.newPage();
  await prep(zp);
  for (const key of ["overview", "swap", "bridge", "points"]) {
    const href = ROUTES.find(([k]) => k === key)![1];
    await zp.goto(href);
    await ready(zp, key);
    await settle(zp);
    await shot(zp, `zoom200/${key}`, false);
  }
  await zoom.close();
});

test("points admin and week 2 publication", async ({ page, request }) => {
  test.skip(!wants("points") || !OPS || !OWNER);
  test.setTimeout(300000);
  await prep(page);
  await page.goto("/admin/points");
  await expect(page.getByLabel("Admin token")).toBeVisible({ timeout: 60000 });
  await settle(page);
  await shot(page, "states/1440/admin-login");
  await page.getByLabel("Admin token").fill(OPS);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Accounts and provisional ranking")).toBeVisible({
    timeout: 30000,
  });
  await settle(page);
  await shot(page, "states/1440/admin-operator");
  expect(
    (
      await admin(request, OPS, {
        action: "sim-clock",
        advanceSeconds: 7 * 24 * 3600,
      })
    ).status(),
  ).toBe(200);
  const calc = await (
    await admin(request, OPS, { action: "calculate", season: 1 })
  ).json();
  const calculationId =
    calc.calculationId ?? calc.calculation?.id ?? calc.result?.calculationId;
  expect(
    (
      await admin(request, OWNER, {
        action: "finalize",
        season: 1,
        calculationId,
      })
    ).status(),
  ).toBe(200);
  expect(
    (await admin(request, OWNER, { action: "publish", season: 1 })).status(),
  ).toBe(200);
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/points");
    await expect(
      page.getByRole("heading", { name: "Season 1 results" }),
    ).toBeVisible({ timeout: 30000 });
    await settle(page);
    await shot(page, `states/${vp.name}/points-week2`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/admin/points");
  await page.getByLabel("Admin token").fill(OWNER);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("PUBLISHED").first()).toBeVisible({
    timeout: 30000,
  });
  await settle(page);
  await shot(page, "states/1440/admin-published");
});

// Loading, empty and error states with deterministic doubles: held responses (loading) and failing endpoints (error)
// for the points ledger, a swap quote and a portfolio scan, plus the unscanned portfolio and empty activity.
// No live provider request.
test("loading, empty and error states", async ({ page }) => {
  test.skip(!wants("edge"));
  test.setTimeout(400000);
  for (const vp of [VIEWPORTS[0], VIEWPORTS[2]]) {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await prep(page);
    const held: Array<() => void> = [];
    const hold = (pattern: string) =>
      page.route(pattern, async (r) => {
        await new Promise<void>((resolve) => held.push(resolve));
        await r.fallback();
      });
    const fail = (pattern: string) =>
      page.route(pattern, (r) =>
        r.fulfill({ status: 503, json: { error: "unavailable" } }),
      );
    const scan = async () => {
      await page.goto("/portfolio");
      await ready(page, "portfolio");
      await page.locator(".scan-field input").first().fill(readWallet);
      await page.locator(".scan-button").first().click();
    };
    // Points ledger: loading, then error.
    await hold("**/api/points**");
    await page.goto("/points");
    await expect(page.locator("main h1").first()).toBeVisible({
      timeout: 60000,
    });
    await settle(page, 1000);
    await shot(page, `edge/${vp.name}/points-loading`, false);
    held.splice(0).forEach((release) => release());
    await page.unroute("**/api/points**");
    await fail("**/api/points**");
    await page.goto("/points");
    await expect(page.locator("main h1").first()).toBeVisible({
      timeout: 60000,
    });
    await settle(page, 2500);
    await shot(page, `edge/${vp.name}/points-error`, false);
    await page.unroute("**/api/points**");
    // Swap quote: the providers endpoint fails.
    await fail("**/api/swap**");
    await page.goto("/swap");
    await ready(page, "swap");
    const card = page.getByTestId("swap-intelligence");
    await card.getByRole("button", { name: /^Destination token/ }).click();
    await page.locator("#token-search").fill("USDC");
    await page.getByRole("option").filter({ hasText: "USDC" }).first().click();
    const read = await readOnlyAddress(card);
    if (await read.count()) await read.fill(readWallet);
    await card.locator("#meta-amount").fill("1.5");
    await card
      .getByRole("button", { name: "Compare providers", exact: true })
      .click();
    await settle(page, 3000);
    await shot(page, `edge/${vp.name}/swap-quote-error`);
    await page.unroute("**/api/swap**");
    // Portfolio scan: loading, then error, then the unscanned empty state.
    await page.unroute("**/api/portfolio");
    await hold("**/api/portfolio");
    await scan();
    await settle(page, 1000);
    await shot(page, `edge/${vp.name}/portfolio-loading`, false);
    held.splice(0).forEach((release) => release());
    await page.unroute("**/api/portfolio");
    await fail("**/api/portfolio");
    await scan();
    await settle(page, 2500);
    await shot(page, `edge/${vp.name}/portfolio-error`, false);
    await page.unroute("**/api/portfolio");
    await page.goto("/portfolio");
    await ready(page, "portfolio");
    await settle(page, 1200);
    await shot(page, `edge/${vp.name}/portfolio-empty`, false);
    await page.goto("/activity");
    await ready(page, "activity");
    await settle(page);
    await shot(page, `edge/${vp.name}/activity-empty`, false);
    await page.unrouteAll({ behavior: "ignoreErrors" });
  }
});
