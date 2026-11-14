import { test, expect, readOnlyAddress } from "./fixtures";
import { installPrimaryAssets } from "./swap-primary";
import AxeBuilder from "@axe-core/playwright";
import { fixtureCatalog, fixtureQuote, sender } from "../fixtures/routing";
import { holding, portfolioFixture } from "../fixtures/portfolio";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeActive } from "../../src/catalog/model";
import { positionContracts } from "../../src/portfolio/positions";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
const root =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-12-2/adhoc";
async function setup(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "otherbridge.locale", value: "en", url: "http://127.0.0.1:3100" },
    ]);
  await page.addInitScript(() => {
    localStorage.setItem("otherbridge.language", "en");
    localStorage.setItem("otherbridge.theme", "dark");
  });
  const catalog = fixtureCatalog();
  await installPrimaryAssets(page);
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      json: normalizeActive(
        catalog.networks
          .filter((n) => n.mainnet)
          .map((n) => ({ name: n.name, chainId: n.id, tvl: 1000000 })),
        catalog,
        Date.now(),
        "SYNTHETIC_TEST_ONLY",
      ),
    }),
  );
  await page.route("**/api/routing", (route) => {
    const b = route.request().postDataJSON(),
      n = catalog.networks.find((n) => n.id === b.chain);
    if (b.action === "catalog") return route.fulfill({ json: catalog });
    if (b.action === "assets")
      return route.fulfill({
        json: [
          n!.nativeAsset,
          {
            chainId: n!.id,
            address: "0x" + "44".repeat(20),
            symbol: "TOKEN",
            name: "Synthetic token",
            decimals: 18,
          },
        ],
      });
    if (b.action === "connections") return route.fulfill({ json: [] });
    if (b.action === "quote") {
      const raw = fixtureQuote(b.input),
        tool = catalog.tools.find((t) => t.kind === "exchange")!;
      raw.tool = tool.id;
      raw.toolDetails = { ...raw.toolDetails, key: tool.id, name: tool.name };
      raw.type = "swap";
      raw.action.toToken = {
        ...raw.action.toToken,
        address: b.input.destinationAsset,
        symbol: "TOKEN",
        decimals: 18,
      };
      const q = normalizeQuote(raw, b.input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return route.fulfill({ json: [q] });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
  const p = positionContracts.find((p) => p.category === "staking")!,
    d = positionContracts.find((p) => p.chainId === "1" && p.role === "debt")!;
  const portfolio = portfolioFixture();
  portfolio.holdings = [
    holding("1", "1000000000000000000", 100),
    ...[
      [p, null],
      [d, 500],
    ].map(([p, usd]) => {
      const c = p as (typeof positionContracts)[number];
      return holding("1", "1000000000000000000", usd as number | null, {
        address: c.address,
        native: false,
        symbol: c.symbol,
        name: c.symbol,
        decimals: c.decimals,
        position: {
          protocol: c.protocol,
          category: c.category,
          role: c.role,
          source: c.source,
        },
        routable: false,
      });
    }),
  ];
  portfolio.defiCoverage = [
    {
      chainId: "1",
      protocol: "Lido",
      category: "staking",
      state: "PARTIAL",
      checked: 1,
      planned: 2,
      observedAt: Date.now(),
      observedBlock: "20",
    },
  ];
  await page.route("**/api/portfolio", (route) =>
    route.fulfill({ json: portfolio }),
  );
}
async function shot(page: Page, name: string) {
  mkdirSync(root + "/screenshots", { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}
for (const width of [390, 1440])
  test(`V1122 compact bridge and swap ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    await page.goto("/bridge");
    await expect(page.locator(".bridge-receive")).toBeVisible();
    await expect(page.locator(".health-card .status-list")).toHaveCount(0);
    const card = await page.locator(".bridge-card").boundingBox();
    expect(card!.height).toBeLessThan(700);
    const pair = await page.locator(".route-pair .network-box").all();
    const a = await pair[0].boundingBox(),
      b = await pair[1].boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    await shot(page, `bridge-${width}`);
    await page.goto("/swap");
    await expect(page.locator(".execution-status")).toContainText(
      "Execution closed",
    );
    await expect(
      page.locator(".trade-settings-disclosure"),
    ).not.toHaveAttribute("open", "");
    await page.getByRole("button", { name: /^Destination token/ }).click();
    await page.locator("#token-search").fill("0x" + "44".repeat(20));
    await page.locator("#token-search").press("Enter");
    await (await readOnlyAddress(page)).fill(sender);
    await page.locator("#meta-amount").fill("0.01");
    await expect(page.locator("#routing-recipient")).toHaveCount(0);
    await page
      .getByRole("button", { name: "Compare providers", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Review Swap", exact: true }),
    ).toBeEnabled();
    await page.getByText("Route details", { exact: true }).click();
    await expect(page.locator("details.disclosure[open]")).toContainText(
      "VEINED fee",
    );
    await page.getByText("Route details", { exact: true }).click();
    await shot(page, `swap-${width}`);
    await page
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    // Guardian candidate: the dialog now holds two disclosures (Advanced and Guardian's passed checks); none starts open.
    await expect(
      page.locator(
        ".review-dialog[aria-labelledby='meta-review-title'] details",
      ),
    ).toHaveCount(2);
    await expect(
      page.locator(
        ".review-dialog[aria-labelledby='meta-review-title'] details[open]",
      ),
    ).toHaveCount(0);
    await expect(
      page.locator(".review-dialog[aria-labelledby='meta-review-title']"),
    ).toContainText("Execution closed");
    await expect(
      page
        .locator(".review-dialog[aria-labelledby='meta-review-title']")
        .getByRole("button", { name: /sign|approve|confirm swap/i }),
    ).toHaveCount(0);
    await shot(page, `review-${width}`);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    mkdirSync(root + "/measurements", { recursive: true });
    writeFileSync(
      `${root}/measurements/form-${width}.json`,
      JSON.stringify({ bridgeHeight: card!.height, viewport: width }),
    );
  });
test("V1122 wallet / DeFi filtering preserves unpriced positions and excludes debt from assets", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/portfolio");
  await page
    .getByRole("textbox", { name: "evm Source address", exact: true })
    .fill(sender);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await expect(page.locator(".portfolio-positions")).toBeVisible();
  await expect(page.getByTestId("portfolio-summary")).toContainText("$100.00");
  await page.getByRole("button", { name: "DeFi", exact: true }).click();
  await expect(page.locator(".portfolio-assets .asset-row")).toHaveCount(2);
  await expect(page.locator(".portfolio-positions")).toContainText(
    "not net worth",
  );
  await page.locator(".portfolio-positions summary").click();
  await expect(page.locator(".position-unsupported")).toContainText(
    "Claimable rewards",
  );
  await expect(page.locator(".defi-coverage-list")).toContainText("Partial");
  await shot(page, "portfolio-defi");
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations,
  ).toEqual([]);
});
