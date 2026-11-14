import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { defiFixture, defiWallet, loan } from "../fixtures/defi";
import { portfolioFixture, holding } from "../fixtures/portfolio";
import { fixtureCatalog } from "../fixtures/routing";
import { normalizeActive } from "../../src/catalog/model";
import type { DefiScan } from "../../src/defi/model";
// V1.14 Explore DeFi coverage. The catalog route serves the accepted local catalog (no upstream); wallet data is a
// SYNTHETIC FIXTURE. No wallet session, no signature and no transaction exists in any of these tests.
const root =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-14/adhoc";
const LOCALES = [
  "ar",
  "bn",
  "de",
  "en",
  "es",
  "fa",
  "fr",
  "he",
  "hi",
  "id",
  "it",
  "ja",
  "ko",
  "nl",
  "pl",
  "pt-BR",
  "ru",
  "th",
  "tr",
  "uk",
  "ur",
  "vi",
  "zh-CN",
  "zh-TW",
];
const RTL = new Set(["ar", "fa", "he", "ur"]);
const messages = (locale: string) =>
  JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, "utf8")) as {
    v114: Record<string, string>;
  };
async function setup(
  page: Page,
  options: { locale?: string; theme?: string; mode?: "partial" } = {},
) {
  const locale = options.locale ?? "en";
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.addInitScript(
    ({ locale, theme }) => {
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          e.violatedDirective,
        ),
      );
    },
    { locale, theme: options.theme ?? "dark" },
  );
  const catalog = fixtureCatalog();
  await page.route("**/api/routing", (r) => r.fulfill({ json: catalog }));
  await page.route("**/api/catalog", (r) =>
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
  await page.route("**/api/assets", (r) => r.fulfill({ json: { assets: [] } }));
  const s = await defiFixture();
  if (options.mode === "partial") {
    s.positions[0].borrowed[0].valueUsd = null;
    s.coverage[1].state = "NOT_CHECKED";
  }
  const p = portfolioFixture();
  p.holdings = [
    holding("1", "1000000000000000000", 2800),
    holding("1", "1000000", 1, {
      address: loan,
      native: false,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    }),
  ];
  const walletRequests: string[] = [];
  page.on("request", (r) => {
    const body = r.postData() ?? "";
    if (
      /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_sign|signTypedData|wallet_sendCalls|wallet_grantPermissions/.test(
        body,
      )
    )
      walletRequests.push(r.url());
  });
  await page.route("**/api/portfolio", (r) => r.fulfill({ json: p }));
  await page.route("**/api/portfolio/defi", (r) => {
    const b = r.request().postDataJSON();
    const value: DefiScan = {
      ...s,
      wallet: b.wallet.toLowerCase(),
      positions: s.positions,
    };
    return r.fulfill({ json: value });
  });
  return { s, walletRequests };
}
async function scan(page: Page) {
  await page.goto("/portfolio");
  await page.locator(".scan-field input").first().fill(defiWallet);
  await page.locator(".scan-button").click();
  await expect(page.getByTestId("defi-intelligence")).toBeVisible();
}
async function explore(page: Page, locale = "en") {
  await page
    .getByRole("button", { name: messages(locale).v114.explore, exact: false })
    .click();
  await expect(page.getByTestId("defi-explore")).toBeVisible();
  await expect(page.locator(".defi-explore-count")).toHaveText(/\d/, {
    timeout: 15000,
  });
}
async function shot(page: Page, name: string) {
  mkdirSync(root + "/screenshots", { recursive: true });
  await page.screenshot({
    path: root + "/screenshots/" + name + ".png",
    fullPage: true,
  });
}
async function axe(page: Page, name: string) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  mkdirSync(root + "/screenshots", { recursive: true });
  writeFileSync(
    root + "/screenshots/axe-" + name + ".json",
    JSON.stringify(r.violations, null, 2),
  );
  expect(r.violations).toEqual([]);
}
const noOverflow = async (page: Page) =>
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
test("V114 explorer searches every protocol and shows truthful coverage with TVL kept separate", async ({
  page,
}) => {
  const { walletRequests } = await setup(page);
  await scan(page);
  await explore(page);
  await shot(page, "explore-protocols");
  const search = page.getByRole("searchbox", { name: "Search protocols" });
  await search.fill("aave v3");
  const aave = page
    .locator(".defi-explore-row", { hasText: "Aave V3" })
    .first();
  await expect(aave).toBeVisible({ timeout: 15000 });
  await expect(aave).toContainText("Full position support");
  await aave.click();
  const dialog = page.locator(".defi-dialog[open]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".defi-explore-tvl")).toContainText(
    "Protocol TVL (context, not your balance)",
  );
  await expect(dialog).toContainText("VEINED coverage");
  await expect(
    dialog.locator("button").filter({
      hasText: /Deposit|Withdraw|Borrow|Repay|Claim|Stake|Swap|Bridge/,
    }),
  ).toHaveCount(0);
  await shot(page, "explore-detail-aave");
  await axe(page, "explore-detail");
  await page.keyboard.press("Escape");
  await search.fill("");
  await page
    .getByRole("combobox", { name: "Coverage" })
    .selectOption("CATALOG_ONLY");
  const catalogOnly = page.locator(".defi-explore-row").first();
  await expect(catalogOnly).toContainText(
    "Cataloged — position adapter not yet implemented",
    { timeout: 15000 },
  );
  await catalogOnly.click();
  await expect(page.locator(".defi-dialog[open]")).toContainText(
    "Not checked: cataloged only, never treated as zero",
  );
  await page.keyboard.press("Escape");
  expect(walletRequests).toEqual([]);
  expect(await cspViolations(page)).toEqual([]);
});
test("V114 networks tab lists EVM and non-EVM networks with capabilities", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  await explore(page);
  await page.getByRole("tab", { name: "Networks" }).click();
  const search = page.getByRole("searchbox", { name: "Search networks" });
  await search.fill("solana");
  const solana = page
    .locator(".defi-explore-item", { hasText: "Solana" })
    .first();
  await expect(solana).toBeVisible({ timeout: 15000 });
  await expect(solana).toContainText("No DeFi engine for this network type");
  await search.fill("ethereum");
  await expect(
    page.locator(".defi-explore-item", { hasText: "Ethereum" }).first(),
  ).toBeVisible({ timeout: 15000 });
  await shot(page, "explore-networks");
  await axe(page, "explore-networks");
});
test("V114 long catalog stays windowed: thousands of results, bounded DOM rows", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  await explore(page);
  await page.getByRole("combobox", { name: "Status" }).selectOption("ALL");
  await expect(page.locator(".defi-explore-count")).toHaveText(/\d/, {
    timeout: 15000,
  });
  const total = Number(
    (await page.locator(".defi-explore-count").innerText()).replace(
      /[^\d]/g,
      "",
    ),
  );
  expect(total).toBeGreaterThan(5000);
  const more = page.getByRole("button", { name: "Load more" });
  const started = Date.now();
  for (let i = 0; i < 4 && (await more.isVisible()); i++) await more.click();
  await page
    .locator(".defi-explore-viewport")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  const rows = await page.locator(".defi-explore-item").count();
  expect(rows).toBeLessThan(60);
  await noOverflow(page);
  mkdirSync(root + "/performance", { recursive: true });
  writeFileSync(
    root + "/performance/explore-ui.json",
    JSON.stringify(
      {
        totalResults: total,
        renderedRows: rows,
        loadMoreAndScrollMs: Date.now() - started,
      },
      null,
      2,
    ),
  );
});
for (const width of [390, 768])
  test(`V114 explorer responsive ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { theme: "light" });
    await scan(page);
    await explore(page);
    await page
      .getByRole("searchbox", { name: "Search protocols" })
      .fill("lido");
    await expect(page.locator(".defi-explore-row").first()).toBeVisible({
      timeout: 15000,
    });
    await noOverflow(page);
    await shot(page, "explore-" + width);
    await axe(page, "explore-light-" + width);
  });
test("V114 value summary keeps unchecked coverage and unpriced debt explicit; fees are shown outside the net", async ({
  page,
}) => {
  await setup(page, { mode: "partial" });
  await scan(page);
  const notes = page.locator(".defi-value-notes");
  await expect(notes).toContainText("Known net value is incomplete");
  await expect(notes).toContainText("Unchecked coverage");
  await expect(notes).toContainText("Unpriced debt: 1");
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await page
    .locator('[data-protocol="uniswap-v3"] .defi-position-header')
    .first()
    .click();
  const dialog = page.locator(".defi-dialog[open]");
  await expect(dialog).toContainText(
    "Uncollected fees (exact at the source block)",
  );
  await expect(
    dialog.locator("button").filter({ hasText: /Collect|Claim|Withdraw/ }),
  ).toHaveCount(0);
  await shot(page, "position-v3-fees");
  await page.keyboard.press("Escape");
});
for (const locale of LOCALES)
  test(`V114 ${locale} explorer is translated${RTL.has(locale) ? " and RTL" : ""}`, async ({
    page,
  }) => {
    await setup(page, { locale });
    await scan(page);
    await explore(page, locale);
    const m = messages(locale).v114;
    await expect(page.locator("#defi-explore-title")).toHaveText(
      m.exploreTitle,
    );
    await expect(page.getByRole("tab", { name: m.tabProtocols })).toBeVisible();
    await expect(page.getByRole("tab", { name: m.tabNetworks })).toBeVisible();
    if (RTL.has(locale))
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await noOverflow(page);
    expect(await cspViolations(page)).toEqual([]);
    if (["en", "tr", "ar", "ja"].includes(locale))
      await shot(page, "explore-" + locale);
  });
