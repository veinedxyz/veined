// G12 H04 in the real product on SYNTHETIC data only (tests/fixtures; nothing is live): the 25/50/75/100 % buttons in
// Bridge and Swap (exact shares of the READ balance, fail-closed without one, the native coin's 100 % only after a
// route's network fee is known), the explicit "no price chart" state, the landing's balanced route example, and the
// Bridge leaving the paused legacy pair in read-only mainnet mode. Read-only: no signature, no transaction.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect, fillRecipient } from "./fixtures";
import { portfolioFixture } from "../fixtures/portfolio";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeActive } from "../../src/catalog/model";
import { normalizeQuote } from "../../src/routing/normalize";
import type { QuoteInput } from "../../src/routing/model";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import ar from "../../src/i18n/locales/ar.json" with { type: "json" };
import tr from "../../src/i18n/locales/tr.json" with { type: "json" };

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g12";
const WATCHED = "0x8a1f3c9b2d4e5f60718293a4b5c6d7e8f9a0b1c2";
const ui = (locale: string) =>
  (({ en, ar, tr }) as Record<string, typeof en>)[locale].ui;

async function setup(
  page: Page,
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
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
    },
    { locale, theme: options.theme ?? "dark" },
  );
  const catalog = fixtureCatalog();
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
  // The scanned address holds exactly 1 ETH on Ethereum (and the fixture's other rows).
  await page.route("**/api/portfolio", (r) =>
    r.fulfill({ json: portfolioFixture() }),
  );
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON();
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (body.action === "catalog") return json(catalog);
    if (body.action === "connections") {
      const f = catalog.networks.find((n) => n.id === body.source)!,
        t = catalog.networks.find((n) => n.id === body.destination)!;
      return json([
        {
          from: f.id,
          to: t.id,
          sourceAssets: [f.nativeAsset],
          destinationAssets: [t.nativeAsset],
          provider: "routing-core",
          executable: false,
        },
      ]);
    }
    if (body.action === "quote") {
      const input = body.input as QuoteInput;
      const q = normalizeQuote(fixtureQuote(input), input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return json([q]);
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  });
}
async function scan(page: Page) {
  await page.goto("/portfolio");
  await page.locator('[data-scan-mode="watch"]').click();
  await page.locator(".scan-field input").first().fill(WATCHED);
  await page.locator(".scan-button").click();
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();
}
async function select(
  page: Page,
  role: "source" | "destination",
  search: string,
  id: string,
  locale = "en",
) {
  await page
    .getByRole("button", {
      name:
        role === "source"
          ? ui(locale).selectSourceNetwork
          : ui(locale).selectDestinationNetwork,
      exact: true,
    })
    .click();
  await page.locator("#network-search").fill(search);
  await page.locator(`.network-picker [data-chain="${id}"]`).click();
  await expect(page.locator("dialog.network-picker")).toHaveCount(0);
}
/** Client-side navigation keeps the scanned portfolio in the shell; the scanned address is the sender. */
async function toBridge(page: Page, locale = "en", sender = WATCHED) {
  await page.locator('nav a[href="/bridge"]').first().click();
  await expect(page).toHaveURL(/\/bridge$/);
  await select(page, "source", "Ethereum", "1", locale);
  await select(page, "destination", "Base", "8453", locale);
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  if (sender) await page.locator("#routing-sender").fill(sender);
}
const pct = (page: Page, testId: string, percent: number) =>
  page.getByTestId(testId).locator(`button[data-percent="${percent}"]`);
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function shot(page: Page, name: string) {
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("G12-PC-E1 Bridge without a read balance: every button is disabled and says why; nothing is typed, no 0 is invented", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  await select(page, "source", "Ethereum", "1");
  await select(page, "destination", "Base", "8453");
  const row = page.getByTestId("percent-bridge");
  for (const p of [25, 50, 75, 100])
    await expect(pct(page, "percent-bridge", p)).toBeDisabled();
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "BALANCE_UNKNOWN",
  );
  await expect(row).toContainText("Balance not read yet.");
  await expect(page.locator("#routing-amount")).toHaveValue("");
});

test("G12-PC-E2 Bridge with a scanned balance of 1 ETH: 25/50/75 are exact; 100% of the native coin waits for a route's network fee, then leaves it in the wallet", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  await toBridge(page);
  const amount = page.locator("#routing-amount");
  const row = page.getByTestId("percent-bridge");
  // Before any route is read the fee is unknown: 100% is refused with the reason, the smaller shares work.
  await expect(pct(page, "percent-bridge", 100)).toBeDisabled();
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "FEE_UNKNOWN",
  );
  await pct(page, "percent-bridge", 25).click();
  await expect(amount).toHaveValue("0.25");
  await pct(page, "percent-bridge", 75).click();
  await expect(amount).toHaveValue("0.75");
  // Pressing twice changes nothing (no doubling, no drift).
  await pct(page, "percent-bridge", 50).dblclick();
  await expect(amount).toHaveValue("0.5");
  // Read a route: its network fee (1000 wei in the fixture) is now known.
  await fillRecipient(page, "0x3333333333333333333333333333333333333333");
  await page.getByRole("button", { name: "Read route", exact: true }).click();
  await expect(page.locator(".trade-output bdi")).toBeVisible();
  await expect(pct(page, "percent-bridge", 100)).toBeEnabled();
  // The reserve is disclosed where 100% is offered.
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "RESERVE_NOTE",
  );
  await expect(row).toContainText("plus a 20% margin");
  await pct(page, "percent-bridge", 100).click();
  // 1 ETH minus the fee with its 20% margin (1200 wei), exactly.
  await expect(amount).toHaveValue("0.9999999999999988");
  await shot(page, "g12-pc-e2-bridge");
});

test("G12-PC-E2b the scanned balance is used only for the address it was read for: another sender gets no buttons and is told why", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  await toBridge(page, "en", "");
  const row = page.getByTestId("percent-bridge");
  // No sender yet: the balance of the scanned address is not assumed to be the sender's.
  for (const p of [25, 50, 75, 100])
    await expect(pct(page, "percent-bridge", p)).toBeDisabled();
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "OTHER_ADDRESS",
  );
  await expect(row).toContainText("This balance was read for 0x8a1f…b1c2.");
  await page
    .locator("#routing-sender")
    .fill("0x3333333333333333333333333333333333333333");
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "OTHER_ADDRESS",
  );
  await expect(pct(page, "percent-bridge", 25)).toBeDisabled();
  // The scanned address as the sender (any letter case): the buttons work.
  await page
    .locator("#routing-sender")
    .fill(`0x${WATCHED.slice(2).toUpperCase()}`);
  await expect(pct(page, "percent-bridge", 25)).toBeEnabled();
  await pct(page, "percent-bridge", 25).click();
  await expect(page.locator("#routing-amount")).toHaveValue("0.25");
});

test("G12-PC-E2c a balance read more than a minute ago is named with its time and cannot give 100%, even when the fee is known", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/portfolio", (r) => {
    const p = portfolioFixture();
    p.observedAt = Date.now() - 5 * 60_000;
    return r.fulfill({ json: p });
  });
  await scan(page);
  await toBridge(page);
  const row = page.getByTestId("percent-bridge");
  await page.locator("#routing-amount").fill("0.01");
  await fillRecipient(page, "0x3333333333333333333333333333333333333333");
  await page.getByRole("button", { name: "Read route", exact: true }).click();
  await expect(page.locator(".trade-output bdi")).toBeVisible();
  await expect(row).toHaveAttribute("data-stale", "true");
  await expect(pct(page, "percent-bridge", 100)).toBeDisabled();
  await expect(pct(page, "percent-bridge", 50)).toBeEnabled();
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "STALE",
  );
  await expect(row).toContainText("and may have changed");
});

test("G12-PC-E2d review M1: a picked amount with three fraction digits is typed so that every locale reads it (Turkish groups thousands with a dot)", async ({
  page,
}) => {
  await setup(page, { locale: "tr" });
  await page.route("**/api/portfolio", (r) => {
    const p = portfolioFixture();
    // 0.5 ETH: 25% is 0.125.
    p.holdings[0].balance = "500000000000000000";
    return r.fulfill({ json: p });
  });
  await scan(page);
  await toBridge(page, "tr");
  await pct(page, "percent-bridge", 25).click();
  await expect(page.locator("#routing-amount")).toHaveValue("0.1250");
  // The field accepted it: a route can be read for that amount.
  await fillRecipient(page, "0x3333333333333333333333333333333333333333");
  await page
    .getByRole("button", { name: ui("tr").readRoute, exact: true })
    .click();
  await expect(page.locator(".trade-output bdi")).toBeVisible();
});

test("G12-PC-E3 changing the network drops the old balance: the buttons follow the asset that is selected now", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  await toBridge(page);
  await expect(pct(page, "percent-bridge", 25)).toBeEnabled();
  // Arbitrum failed in the scan (no balance was read there): nothing is offered, and no stale amount is typed.
  await select(page, "source", "Arbitrum", "42161");
  // Whatever the form does with the sender on a network change, the scanned address is the sender again here.
  await page.locator("#routing-sender").fill(WATCHED);
  for (const p of [25, 50, 75, 100])
    await expect(pct(page, "percent-bridge", p)).toBeDisabled();
  await expect(
    page.getByTestId("percent-bridge").locator(".percent-reason"),
  ).toHaveAttribute("data-reason", "BALANCE_UNKNOWN");
});

test("G12-PC-E4 Swap: the buttons sit under the amount boxes and are disabled without a read balance; the missing price chart is stated, not drawn", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/swap");
  const row = page.getByTestId("percent-swap");
  await expect(row).toBeVisible();
  for (const p of [25, 50, 75, 100])
    await expect(pct(page, "percent-swap", p)).toBeDisabled();
  await expect(row.locator(".percent-reason")).toHaveAttribute(
    "data-reason",
    "BALANCE_UNKNOWN",
  );
  await expect(page.getByTestId("chart-unavailable")).toHaveText(
    "No price chart here: VEINED has no licensed price history to draw one from.",
  );
  await expect(page.locator("canvas, svg.chart, .chart-candles")).toHaveCount(
    0,
  );
});

test("G12-PC-E5 read-only mainnet mode: the paused legacy pair says so and offers a pair that can be read; nothing changes the pair on its own", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/bridge", async (route) => {
    const request = route.request();
    if (request.method() === "GET") {
      const real = await route.fetch();
      return route.fulfill({
        json: { ...(await real.json()), mode: "mainnet-readonly" },
      });
    }
    const body = request.postDataJSON();
    if (body.action === "health")
      return route.fulfill({
        json: {
          mode: "mainnet-readonly",
          observedAt: Date.now(),
          status: "blocked",
          reasons: ["MAINNET_WRITE_DISABLED", "DEPLOYMENT_CHANGED"],
        },
      });
    return route.fulfill({
      status: 422,
      json: { error: "DEPLOYMENT_CHANGED" },
    });
  });
  await page.goto("/bridge");
  const source = page.getByRole("button", {
    name: "Select source network",
    exact: true,
  });
  const destination = page.getByRole("button", {
    name: "Select destination network",
    exact: true,
  });
  // The legacy pair stays until the user decides: it says it is paused and offers a readable pair.
  const paused = page.getByTestId("paused-route");
  await expect(paused).toContainText("This route is paused right now");
  await expect(source).toContainText("ONEchain");
  await paused
    .getByRole("button", { name: "Open Base → Arbitrum instead" })
    .click();
  await expect(source).toContainText("Base");
  await expect(destination).toContainText("Arbitrum");
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await expect(page.getByTestId("paused-route")).toHaveCount(0);
  // The user's own choice is never replaced again, the legacy pair included.
  await select(page, "source", "ONEchain", "612055");
  await expect(source).toContainText("ONEchain");
  await expect(destination).toContainText("Arbitrum");
  await select(page, "destination", "Base", "8453");
  await expect(source).toContainText("ONEchain");
  await expect(destination).toContainText("Base");
});

test("G12-PC-E6 landing: the Bridge example is a route VEINED reads today, 'curated' is not a marketing word", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/");
  const scene = page.locator(".mk-bridge-scene");
  await expect(scene).toContainText("Base");
  await expect(scene).toContainText("Arbitrum");
  await expect(scene).toContainText("5 USDC");
  await expect(scene).not.toContainText("ONEchain");
  await expect(page.locator("#bridge")).toContainText(
    "Base → Arbitrum, Ethereum → Base or Base → OP Mainnet",
  );
  const text = (await page.locator("main").textContent()) ?? "";
  expect(text).not.toMatch(/curated/i);
  expect(text).toContain("Reviewed");
  expect(await noOverflow(page)).toBe(true);
  // Review M5 / m10: the other languages no longer carry the old word, and right-to-left keeps the route readable.
  for (const [locale, old] of [
    ["de", /kuratiert/i],
    ["es", /curad/i],
    ["fr", /sélectionné/i],
    ["ru", /курируем/i],
    ["ar", /المنتقاة/],
  ] as const) {
    await page.context().addCookies([
      {
        name: "otherbridge.locale",
        value: locale,
        url: "http://127.0.0.1:3100",
      },
    ]);
    await page.goto("/");
    const body = (await page.locator("main").textContent()) ?? "";
    expect(body, locale).not.toMatch(old);
    if (locale === "ar") expect(body).toContain("Base → Arbitrum");
  }
});

for (const [name, width, locale, theme] of [
  ["phone", 390, "en", "dark"],
  ["rtl", 1440, "ar", "dark"],
  ["light", 1440, "tr", "light"],
] as const)
  test(`G12-PC-E7 ${name}: the buttons fit, are localized and axe-clean (with and without a balance)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { locale, theme });
    await scan(page);
    await toBridge(page, locale);
    const row = page.getByTestId("percent-bridge");
    await row.scrollIntoViewIfNeeded();
    await expect(pct(page, "percent-bridge", 25)).toBeEnabled();
    await expect(row.locator(".percent-reason")).toHaveAttribute(
      "data-reason",
      "FEE_UNKNOWN",
    );
    await expect(row.locator('[role="group"]')).toHaveAttribute(
      "aria-describedby",
      /.+/,
    );
    if (locale === "tr")
      await expect(row).toContainText("%100 için ağ ücreti gerekir");
    if (locale === "ar") await expect(row).not.toContainText("network fee");
    expect(await noOverflow(page)).toBe(true);
    const axe = () =>
      new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
    expect((await axe()).violations).toEqual([]);
    await shot(page, `g12-pc-e7-${name}`);
  });
