// G12 H01: the Portfolio's three kinds of coverage (native coins, reviewed tokens, activity index + DeFi) and the honest
// label of a native balance whose network reported no symbol, in the real product on synthetic data only
// (tests/fixtures/portfolio; SYNTHETIC_TEST_ONLY, nothing is live). Read-only: no quote, no signature, no transaction.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect } from "./fixtures";
import { portfolioFixture, holding, coverage } from "../fixtures/portfolio";
import { fixtureCatalog } from "../fixtures/routing";
import { normalizeActive } from "../../src/catalog/model";
import { summarize } from "../../src/data/core/coverage";
import type { PortfolioResult } from "../../src/portfolio/model";

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g12";
const WATCHED = "0x8a1f3c9b2d4e5f60718293a4b5c6d7e8f9a0b1c2";

async function setup(
  page: Page,
  result: PortfolioResult,
  options: { locale?: string; theme?: "dark" | "light" } = {},
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
  await page.route("**/api/portfolio", (r) => r.fulfill({ json: result }));
}
async function scan(page: Page) {
  await page.goto("/portfolio");
  await page.locator('[data-scan-mode="watch"]').click();
  await page.locator(".scan-field input").first().fill(WATCHED);
  await page.locator(".scan-button").click();
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();
}
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function shot(page: Page, name: string) {
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}
const tier = (page: Page, name: string) =>
  page.getByTestId("coverage-tiers").locator(`[data-tier="${name}"] dd`);

test("G12-PF-E1 the three kinds of coverage are counted from the scan itself; a failed network is 'not read', never empty", async ({
  page,
}) => {
  // Ethereum + Base complete, BNB Chain native only, Arbitrum failed; no activity index, no DeFi check.
  await setup(page, portfolioFixture());
  await scan(page);
  await expect(tier(page, "native")).toContainText(
    "3 networks read · 1 not read",
  );
  await expect(tier(page, "reviewed")).toContainText(
    "2 networks read · 2 not read",
  );
  await expect(tier(page, "reviewed")).toContainText(
    "other tokens are not discovered automatically",
  );
  await expect(tier(page, "discovered")).toHaveText(
    "Not available in this scan",
  );
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "g12-pf-e1-tiers");
});

test("G12-PF-E2 an indexed network and DeFi checks are counted as discovery; an incomplete token read is 'partly read'", async ({
  page,
}) => {
  const p = portfolioFixture();
  p.coverage = [
    coverage("1", "COMPLETE", { tokens: "INDEXED", tier: "FULL_INDEXED" }),
    coverage("8453", "PARTIAL", {
      tokens: "CURATED",
      reason: "TOKEN_READ_INCOMPLETE",
    }),
    coverage("56", "NATIVE_ONLY"),
    coverage("42161", "PENDING"),
  ];
  p.coverageSummary = summarize(p.coverage);
  const defi = {
    protocol: "Aave V3" as const,
    category: "lending" as const,
    planned: 2,
    observedAt: Date.now(),
    observedBlock: "1",
  };
  p.defiCoverage = [
    { ...defi, chainId: "1", state: "CHECKED", checked: 2 },
    { ...defi, chainId: "8453", state: "FAILED", checked: 0 },
  ];
  await setup(page, p);
  await scan(page);
  await expect(tier(page, "native")).toContainText(
    "3 networks read · 1 not read",
  );
  // The indexed network is discovery only; the incomplete token read is "partly read", never "read".
  await expect(tier(page, "reviewed")).toContainText(
    "0 networks read · 2 not read",
  );
  await expect(page.getByTestId("tier-partial")).toHaveText("1 partly read");
  await expect(tier(page, "discovered")).toHaveText(
    "1 networks indexed · 2 of 4 DeFi checks",
  );
});

test("G12-PF-E3 a native balance whose network reported no symbol is named honestly and stays unpriced", async ({
  page,
}) => {
  const p = portfolioFixture();
  p.holdings.push(
    holding("56", "3000000000000000000", null, { symbol: "?", name: "" }),
  );
  await setup(page, p);
  await scan(page);
  const row = page
    .locator('.asset-row[data-holding-chain="56"]')
    .filter({ hasText: "Native coin (symbol not known)" });
  await expect(row).toHaveCount(1);
  await expect(row.locator(".asset-value")).toContainText("Unknown");
  await expect(row).not.toContainText("$0.00");
});

for (const [name, width, locale, theme] of [
  ["phone", 390, "en", "dark"],
  ["rtl", 1440, "ar", "dark"],
  ["light", 1440, "tr", "light"],
] as const)
  test(`G12-PF-E4 ${name}: the coverage tiers fit, are localized and axe-clean`, async ({
    page,
  }) => {
    await setup(page, portfolioFixture(), { locale, theme });
    await page.setViewportSize({ width, height: 900 });
    await scan(page);
    const tiers = page.getByTestId("coverage-tiers");
    await tiers.scrollIntoViewIfNeeded();
    await expect(tiers.locator("dt")).toHaveCount(3);
    if (locale === "tr")
      await expect(tier(page, "native")).toContainText(
        "3 ağ okundu · 1 okunmadı",
      );
    if (locale === "ar")
      await expect(tier(page, "native")).not.toContainText("networks read");
    expect(await noOverflow(page)).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await shot(page, `g12-pf-e4-${name}`);
  });
