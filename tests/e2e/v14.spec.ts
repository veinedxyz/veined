import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile, appendFile } from "node:fs/promises";
import { fixtureCatalog, sender } from "../fixtures/routing";
import {
  firstPage,
  secondPage,
  unavailablePage,
  INDEXED_TOKEN,
  PENDING_CHAINS,
} from "../fixtures/portfolio-v14";
import { normalizeActive } from "../../src/catalog/model";
import { locales } from "../../src/i18n/config";
import { loadDictionary, translate } from "../../src/i18n/messages";
import { publicBrandDenylist } from "../../src/content/public-labels";
const base =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-4";
test.beforeEach(async ({ page }) => {
  await mkdir(base, { recursive: true });
  page.on(
    "pageerror",
    (e) => void appendFile(`${base}/page-errors.log`, e.stack + "\n"),
  );
});
async function setup(
  page: Page,
  locale = "en",
  mode: "progressive" | "unavailable" = "progressive",
) {
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  const catalog = fixtureCatalog();
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
  const requests: { continuation?: string }[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  await page.route("**/api/portfolio", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.consent).toBe(true);
    requests.push(body);
    if (mode === "unavailable")
      return route.fulfill({ json: unavailablePage() });
    if (!body.continuation) return route.fulfill({ json: firstPage() });
    expect(body.continuation).toBe("synthetic-continuation-1");
    await gate;
    return route.fulfill({ json: secondPage() });
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
            name: "Synthetic token",
            decimals: 18,
          },
          {
            chainId: body.chain,
            address: "0x9999999999999999999999999999999999999999",
            symbol: "AAA",
            name: "Unheld token",
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
    return route.fulfill({
      status: 422,
      json: { error: "NO_EXECUTABLE_ROUTE" },
    });
  });
  return { requests, release };
}
async function snap(page: Page, name: string) {
  await mkdir(`${base}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${base}/screenshots/v14-synthetic-${name}.png`,
    fullPage: !(await page.locator("dialog[open]").count()),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function scan(page: Page, label = "Scan balances") {
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page.getByRole("button", { name: label, exact: true }).click();
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();
}
test("V14 progressive self-hosted scan: >40 networks, pending never empty, indexed token, coverage markers", async ({
  page,
}) => {
  const env = await setup(page);
  await scan(page);
  const sentence = page.getByTestId("coverage-sentence");
  await expect(sentence).toContainText(
    "VEINED checked 64 networks; 30 more are still being checked.",
  );
  await expect(page.getByTestId("still-checking")).toContainText(
    "Still checking 30 networks",
  );
  await expect(page.getByTestId("attention-indexing")).toContainText(
    "31 networks are still indexing or waiting to be checked.",
  );
  await expect(
    page.getByText(
      "Networks that were not checked are never counted as empty.",
    ),
  ).toBeVisible();
  // Pending networks are never presented as empty holdings.
  for (const id of PENDING_CHAINS.slice(0, 5))
    await expect(page.locator(`[data-chain="${id}"]`)).toHaveCount(0);
  await snap(page, "progressive-scan-1440");
  env.release();
  await expect(sentence).toContainText("VEINED checked 94 networks.");
  await expect(page.getByTestId("still-checking")).toHaveCount(0);
  expect(env.requests).toHaveLength(2);
  expect(env.requests[1].continuation).toBe("synthetic-continuation-1");
  await expect(page.getByTestId("portfolio-coverage")).toContainText(
    "Self-hosted VEINED data",
  );
  await snap(page, "self-hosted-portfolio-1440");
  // Forgotten network asset found after continuation is pinned in the breakdown and attention list.
  await expect(page.locator('[data-chain="900005"]')).toContainText(
    "Synthetic 5",
  );
  await expect(page.locator(".attention")).toContainText("SYN5");
  await expect(page.locator(".attention")).toContainText(
    "Network without executable routes",
  );
  // Indexed discovery marker and history-coverage marker.
  const indexed = page.locator(`[data-token="${INDEXED_TOKEN}"]`);
  await expect(indexed).toContainText("Found by VEINED index");
  await expect(indexed).toHaveAttribute("data-discovery", "indexed");
  await expect(page.locator('[data-chain="42161"]')).toContainText(
    "Token history not fully indexed",
  );
  await indexed.scrollIntoViewIfNeeded();
  await snap(page, "indexed-token-1440");
  await page.locator(".portfolio-coverage-details summary").click();
  const details = page.locator(".portfolio-coverage-details");
  await expect(
    details.locator('li[data-coverage="NATIVE_ONLY"]').first(),
  ).toContainText("Native only");
  await expect(
    details.locator('li[data-coverage="CATALOG_ONLY"]').first(),
  ).toContainText("Not checked (catalog)");
  await expect(details.locator('li[data-coverage="INDEXING"]')).toContainText(
    "Indexing in progress",
  );
  await expect(details.locator('li[data-coverage="FAILED"]')).toContainText(
    "Check failed",
  );
  expect(await details.locator("li").count()).toBeGreaterThan(40);
  await details
    .locator('li[data-coverage="CATALOG_ONLY"]')
    .first()
    .scrollIntoViewIfNeeded();
  await snap(page, "coverage-over-40-native-catalog-indexing-1440");
  const axe = await new AxeBuilder({ page }).analyze();
  expect(axe.violations).toEqual([]);
  expect(await page.locator("body").textContent()).not.toMatch(
    publicBrandDenylist,
  );
});
test("V14 balance priority: bridge prefill, network selector holdings first, swap held tokens first", async ({
  page,
}) => {
  const env = await setup(page);
  env.release();
  await scan(page);
  await expect(page.getByTestId("coverage-sentence")).toContainText(
    "94 networks",
  );
  await page
    .locator('[data-token="0x4444444444444444444444444444444444444444"]')
    .getByRole("button", { name: "Bridge", exact: true })
    .click();
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await page
    .getByRole("button", { name: "Select source network", exact: true })
    .click();
  const first = page.locator(".picker-option").first();
  await expect(first).toContainText("Base");
  await snap(page, "network-selector-holdings-1440");
  await page.getByRole("button", { name: "Close", exact: true }).click();
  await snap(page, "bridge-balance-priority-1440");
  await page.goto("/swap");
  await expect(page.locator("#meta-amount")).toBeVisible();
  // V1.10: the source token list lives in the token picker dialog (was a native select).
  await page.getByRole("button", { name: /^Source token/ }).click();
  await expect(page.locator(".token-option").first()).toBeVisible();
  // V1.11: the registry list arrives asynchronously after the native row.
  await expect(page.locator(".token-option").nth(1)).toBeVisible();
  const options = await page.locator(".token-option").allTextContents();
  expect(options.length).toBeGreaterThan(1);
  await page.keyboard.press("Escape");
  await snap(page, "swap-balance-priority-1440");
});
test("V14 mobile portfolio 390 has no horizontal overflow", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const env = await setup(page);
  env.release();
  await scan(page);
  await expect(page.getByTestId("coverage-sentence")).toContainText(
    "94 networks",
  );
  await snap(page, "portfolio-mobile-390");
});
test("V14 data plane unavailable: honest notice, no invented zero, Bridge still usable", async ({
  page,
}) => {
  await setup(page, "en", "unavailable");
  await scan(page);
  await expect(page.getByTestId("data-plane-notice")).toContainText(
    "Portfolio data is unavailable right now. Bridge and Swap still work with manual selection.",
  );
  await expect(page.getByTestId("coverage-sentence")).toContainText(
    "VEINED checked 0 networks.",
  );
  await expect(page.locator(".portfolio-assets article")).toHaveCount(0);
  await snap(page, "data-plane-unavailable-1440");
  // Manual chain/token selection keeps working without portfolio data.
  await page.goto("/bridge");
  await expect(
    page.getByRole("button", { name: "Select source network", exact: true }),
  ).toBeEnabled();
  await page.goto("/swap");
  await expect(page.locator("#meta-amount")).toBeVisible();
});
test("V14 AR RTL portfolio coverage", async ({ page }) => {
  const env = await setup(page, "ar");
  env.release();
  await loadDictionary("ar");
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page
    .getByRole("button", { name: translate("ar", "v13.scan"), exact: true })
    .click();
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();
  expect(await page.locator("html").getAttribute("dir")).toBe("rtl");
  await expect(page.getByTestId("portfolio-coverage")).toContainText(
    translate("ar", "v14.dataSource"),
  );
  await expect(page.getByTestId("coverage-sentence")).toContainText("94");
  await snap(page, "ar-rtl-portfolio");
});
for (const locale of locales)
  test(`V14 coverage strings ${locale.id} localized / dir / axe`, async ({
    page,
  }) => {
    const env = await setup(page, locale.id);
    env.release();
    await loadDictionary(locale.id);
    await page.goto("/portfolio");
    await page.locator('input[aria-label^="evm "]').fill(sender);
    await page
      .getByRole("button", {
        name: translate(locale.id, "v13.scan"),
        exact: true,
      })
      .click();
    await expect(page.getByTestId("portfolio-coverage")).toContainText(
      translate(locale.id, "v14.dataSource"),
    );
    await expect(page.getByTestId("coverage-sentence")).toContainText(
      translate(locale.id, "v14.checkedAll", {
        checked: new Intl.NumberFormat(locale.id).format(94),
      }),
    );
    expect(await page.locator("html").getAttribute("dir")).toBe(locale.dir);
    const text = (await page.locator("body").textContent()) ?? "";
    expect(text).not.toMatch(publicBrandDenylist);
    expect(text).not.toMatch(/v14\.\w+/);
    const axe = await new AxeBuilder({ page }).analyze();
    await mkdir(`${base}/v14-locales`, { recursive: true });
    await writeFile(
      `${base}/v14-locales/${locale.id}.json`,
      JSON.stringify(
        {
          locale: locale.id,
          violations: axe.violations.length,
          dir: locale.dir,
        },
        null,
        2,
      ),
    );
    expect(axe.violations).toEqual([]);
  });
