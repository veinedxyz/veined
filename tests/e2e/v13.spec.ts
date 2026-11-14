import { installPrimarySwap } from "./swap-primary";
import type { Page } from "@playwright/test";
import { test, expect, readOnlyAddress } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { fixtureCatalog, fixtureQuote, sender } from "../fixtures/routing";
import { portfolioFixture } from "../fixtures/portfolio";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeActive } from "../../src/catalog/model";
import { locales } from "../../src/i18n/config";
import { loadDictionary, translate } from "../../src/i18n/messages";
import { publicBrandDenylist } from "../../src/content/public-labels";
const base =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-3";
test.beforeEach(async ({ page }) => {
  await mkdir(base, { recursive: true });
  page.on("pageerror", (e) => {
    void appendFile(`${base}/page-errors.log`, e.stack + "\n");
  });
});
async function setup(page: Page, locale = "en", noRoute = false) {
  if (noRoute) await installPrimarySwap(page, true);
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  const catalog = fixtureCatalog(),
    portfolio = portfolioFixture();
  await page.route("**/api/bridge", (route) =>
    route.fulfill({
      json:
        route.request().method() === "GET"
          ? { mode: "mainnet-readonly", submission: false }
          : {
              mode: "mainnet-readonly",
              status: "blocked",
              observedAt: Date.now(),
              reasons: ["DEPLOYMENT_UNVERIFIED"],
            },
    }),
  );
  const active = normalizeActive(
    [
      ...catalog.networks
        .filter((n) => n.mainnet)
        .map((n, i) => ({ name: n.name, chainId: n.id, tvl: 1000000 - i })),
      ...Array.from({ length: 600 }, (_, i) => ({
        name: `Synthetic ${i}`,
        chainId: 900000 + i,
        tvl: i + 1,
      })),
    ],
    catalog,
    Date.now(),
    "SYNTHETIC_TEST_ONLY",
  );
  await page.route("**/api/catalog", (route) =>
    route.fulfill({ json: active }),
  );
  let scans = 0;
  await page.route("**/api/portfolio", (route) => {
    scans++;
    const data = route.request().postDataJSON();
    expect(data.consent).toBe(true);
    return route.fulfill({
      json: {
        ...portfolio,
        revision: `synthetic-${scans}`,
        observedAt: Date.now(),
      },
    });
  });
  await page.route("**/api/routing", (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "catalog") return route.fulfill({ json: catalog });
    if (body.action === "assets")
      return route.fulfill({
        json: [
          catalog.networks.find((n) => n.id === body.chain)!.nativeAsset,
          {
            chainId: body.chain,
            address: "0x4444444444444444444444444444444444444444",
            symbol: "TOKEN",
            name: "Synthetic buy token",
            decimals: 18,
          },
        ],
      });
    if (body.action === "connections") {
      const f = catalog.networks.find((n) => n.id === body.source)!,
        t = catalog.networks.find((n) => n.id === body.destination)!;
      return route.fulfill({
        json: [
          {
            from: f.id,
            to: t.id,
            sourceAssets: [f.nativeAsset],
            destinationAssets: [t.nativeAsset],
            provider: "routing-core",
            executable: false,
          },
        ],
      });
    }
    if (body.action === "quote") {
      if (noRoute)
        return route.fulfill({
          status: 422,
          json: { error: "NO_EXECUTABLE_ROUTE" },
        });
      const raw = fixtureQuote(body.input);
      if (body.input.mode === "swap") {
        const tool = catalog.tools.find((t) => t.kind === "exchange")!;
        raw.tool = tool.id;
        raw.toolDetails = { ...raw.toolDetails, key: tool.id, name: tool.name };
        raw.type = "swap";
        raw.estimate.feeCosts[0].name = "Exchange fee";
      }
      raw.action.toToken = {
        ...raw.action.toToken,
        address: body.input.destinationAsset,
        ...(body.input.mode === "swap"
          ? { symbol: "TOKEN", name: "Synthetic buy token" }
          : {}),
      };
      raw.estimate.toAmount = "9000000000000000";
      raw.estimate.toAmountMin = "8955000000000000";
      const q = normalizeQuote(raw, body.input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return route.fulfill({
        json: [
          { ...q, id: "best-value", outputUsd: "31", duration: 90 },
          {
            ...q,
            id: "fastest",
            expected: "8800000000000000",
            minimum: "8700000000000000",
            outputUsd: "30",
            duration: 5,
            fees: [],
          },
        ],
      });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
  return { portfolio, catalog, scanCount: () => scans };
}
async function snap(page: Page, name: string) {
  await mkdir(`${base}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${base}/screenshots/v13-synthetic-${name}.png`,
    fullPage: !(await page.locator("dialog[open]").count()),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function scan(page: Page) {
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();
}
async function swapQuote(page: Page) {
  await page.goto("/swap");
  await expect(page.locator("#meta-amount")).toBeVisible();
  // V1.10: the buy token is chosen in the token picker dialog (was a native select).
  await page.getByRole("button", { name: /^Destination token/ }).click();
  // V1.11: an unlisted route token is reached by its exact contract address (the default list is curated).
  await page
    .locator("#token-search")
    .fill("0x4444444444444444444444444444444444444444");
  await page
    .locator(
      '.token-option[data-token-option="0x4444444444444444444444444444444444444444"]',
    )
    .click();
  await expect(page.locator("dialog.token-picker")).toHaveCount(0);
  await (await readOnlyAddress(page)).fill(sender);

  await page.locator("#meta-amount").fill("0.01");
  await page
    .getByRole("button", { name: "Compare providers", exact: true })
    .click();
}
for (const width of [1440, 390])
  test(`V13 ${width} portfolio / attention / balance bridge / swap / fee / partial`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    const env = await setup(page);
    await page.goto("/portfolio");
    expect(env.scanCount()).toBe(0);
    await scan(page);
    await snap(page, `portfolio-${width}`);
    await expect(page.locator(".attention")).toContainText(
      "No native gas detected",
    );
    await snap(page, `attention-partial-${width}`);
    await page
      .locator('[data-token="0x0000000000000000000000000000000000000000"]')
      .first()
      .getByRole("button", { name: "Bridge", exact: true })
      .click();
    await expect(page.getByTestId("multichain-form")).toBeVisible();
    await page
      .getByRole("button", { name: "Select source network", exact: true })
      .click();
    await expect(page.locator(".picker-option").first()).toContainText("Base");
    expect(await page.locator(".picker-option").count()).toBeLessThanOrEqual(
      10,
    );
    await snap(page, `balance-selector-${width}`);
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await snap(page, `bridge-${width}`);
    await swapQuote(page);
    await expect(
      page.getByRole("button", { name: "Review Swap", exact: true }),
    ).toBeEnabled();
    await snap(page, `swap-alternatives-${width}`);
    await page.getByLabel("Route preference").selectOption("FASTEST");
    await page
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    await expect(
      page.locator(".review-dialog[aria-labelledby='meta-review-title']"),
    ).toContainText("VEINED fee");
    await expect(
      page.locator(".review-dialog[aria-labelledby='meta-review-title']"),
    ).toContainText("0%");
    await expect(
      page
        .locator(".review-dialog[aria-labelledby='meta-review-title']")
        .getByRole("button", { name: /sign|approve|confirm swap/i }),
    ).toHaveCount(0);
    await snap(page, `review-zero-fee-security-${width}`);
    await page
      .locator(".review-dialog[aria-labelledby='meta-review-title']")
      .getByRole("button", { name: "Close" })
      .click();
    await page.locator("#meta-amount").fill("0.02");
    await expect(
      page.getByRole("button", { name: "Review Swap", exact: true }),
    ).toHaveCount(0);
  });
test("V13 600-chain catalog / keyboard / search / no route / ONE gate", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/networks");
  await expect(page.locator(".active-catalog-list article")).toHaveCount(8);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await snap(page, "active-networks");
  await page.locator("#catalog-search").fill("Synthetic 599");
  await expect(page.locator(".active-catalog-list article")).toHaveCount(1);
  await page.goto("/bridge");
  await page
    .getByRole("button", { name: "Select source network", exact: true })
    .click();
  await page.locator("#network-search").fill("Synthetic 350");
  await expect(page.locator(".picker-option")).toHaveCount(1);
  await page.locator("#network-search").press("Enter");
  await expect(page.locator("dialog.network-picker")).toBeVisible();
  await snap(page, "no-route");
  await page.locator("#network-search").fill("ONEchain");
  await page.locator("#network-search").press("Enter");
  await snap(page, "onechain-gated");
});
test("V13 no same-chain route returns neutral error", async ({ page }) => {
  await setup(page, "en", true);
  await swapQuote(page);
  await expect(
    page.getByTestId("swap-intelligence").getByRole("alert"),
  ).toBeVisible();
  await snap(page, "swap-no-route");
});
test("V13 address refresh persists across navigation, favorites contain IDs only", async ({
  page,
}) => {
  const env = await setup(page);
  await scan(page);
  await page.getByRole("link", { name: "Swap", exact: true }).first().click();
  await expect(page.locator("#meta-amount")).toBeVisible();
  await page
    .getByRole("link", { name: "Portfolio", exact: true })
    .first()
    .click();
  await expect(page.locator('input[aria-label^="evm "]')).toHaveValue(sender);
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(() => env.scanCount()).toBe(2);
  await page.getByRole("link", { name: "Swap", exact: true }).first().click();
  await page
    .getByRole("button", { name: "Select source network", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Favorites · Ethereum", exact: true })
    .click();
  await page.getByRole("button", { name: "Favorites", exact: true }).click();
  await expect(page.locator(".picker-option")).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("otherbridge:favorite-networks"),
    ),
  ).toBe('["1"]');
});
for (const locale of locales)
  test(`V13 new surfaces ${locale.id} localized / RTL / brand / axe`, async ({
    page,
  }) => {
    await setup(page, locale.id);
    await loadDictionary(locale.id);
    await page.goto("/portfolio");
    await expect(
      page.getByRole("heading", {
        name: translate(locale.id, "v13.portfolio"),
        exact: true,
      }),
    ).toBeVisible();
    await page.locator('input[aria-label^="evm "]').fill(sender);
    await page
      .getByRole("button", {
        name: translate(locale.id, "v13.scan"),
        exact: true,
      })
      .click();
    await expect(page.getByTestId("portfolio-summary")).toBeVisible();
    expect(await page.locator("body").textContent()).not.toMatch(
      publicBrandDenylist,
    );
    expect(await page.locator("html").getAttribute("dir")).toBe(locale.dir);
    if (locale.id === "ar") await snap(page, "ar-rtl-portfolio");
    await page.goto("/swap");
    await expect(page.locator("#meta-amount")).toBeVisible();
    await expect(
      page
        .getByRole("heading", {
          name: translate(locale.id, "v13.swap"),
          exact: true,
        })
        .first(),
    ).toBeVisible();
    if (locale.id === "zh-CN") await snap(page, "zh-cn-swap");
    const axe = await new AxeBuilder({ page }).analyze();
    await mkdir(`${base}/v13-locales`, { recursive: true });
    await writeFile(
      `${base}/v13-locales/${locale.id}.json`,
      JSON.stringify(
        {
          locale: locale.id,
          axe,
          publicText: await page.locator("body").textContent(),
        },
        null,
        2,
      ),
    );
    expect(axe.violations).toEqual([]);
  });
