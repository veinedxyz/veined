// VWP G10: the portfolio's DeBank-level information order in the real product, on synthetic data only
// (tests/fixtures/portfolio + tokens added here; every value is SYNTHETIC_TEST_ONLY, nothing is live): the account
// band (the identity the shown result was scanned for, total KNOWN value), network allocation with chain marks and
// share lines that filter the table, the holdings table (price as read with its provenance, amount, value with
// share), grouping by network with honest subtotals (unknown never reads $0.00, debt named apart), spam and suspicious
// tokens kept apart (spam never counted even when it carries a price), unpriced and failed coverage kept explicit,
// mobile and RTL layouts, axe in both themes with grouping on and the flagged list open. Read-only: no quote, no
// signature, no transaction.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect, connectWallet } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
import { portfolioFixture, holding } from "../fixtures/portfolio";
import { fixtureCatalog } from "../fixtures/routing";
import { normalizeActive } from "../../src/catalog/model";
import type { Holding } from "../../src/portfolio/model";

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/vwp";
const WATCHED = "0x8a1f3c9b2d4e5f60718293a4b5c6d7e8f9a0b1c2";
const OWN = "0x1111111111111111111111111111111111111111";
const SUSPICIOUS = "0x7777777777777777777777777777777777777777";
const UNPRICED = "0x8888888888888888888888888888888888888888";
const TOKEN = "0x4444444444444444444444444444444444444444";
const SPAM = "0x6666666666666666666666666666666666666666";
// One fixed observation time for the price evidence, so the shown time can be checked exactly.
const PRICE_AT = Date.UTC(2026, 10, 10, 14, 5);

async function setup(
  page: Page,
  options: {
    locale?: string;
    theme?: "dark" | "light";
    extra?: Holding[];
    connected?: boolean;
  } = {},
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
  if (options.connected)
    await page.addInitScript(installWalletDoubles, {
      wallets: ["metamask"] as (keyof typeof WALLET_DOUBLES)[],
      account: OWN,
      chainId: "0x1",
      doubles: WALLET_DOUBLES,
    });
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
  const p = portfolioFixture();
  for (const h of p.holdings) {
    // Spam carries a read price here, so "spam is never counted" is proven by the total, not by a missing price.
    if (h.address === SPAM) Object.assign(h, { usd: 999, priceAt: Date.now() });
    // Price evidence as the data plane reports it: one verified, one derived.
    if (h.address === TOKEN)
      h.price = {
        priceUsd: "1.2",
        observedAt: PRICE_AT,
        confidence: "verified",
        method: "data-plane",
      };
  }
  p.holdings.push(
    holding("8453", "5000000000000000000000", 25, {
      address: SUSPICIOUS,
      native: false,
      symbol: "USDC",
      name: "USD Coin (look-alike)",
      decimals: 18,
      suspicious: true,
      price: {
        priceUsd: "0.005",
        observedAt: PRICE_AT,
        confidence: "derived",
        method: "routing-list",
      },
    }),
    holding("1", "42000000000000000000", null, {
      address: UNPRICED,
      native: false,
      symbol: "NOPRICE",
      name: "Unpriced token",
    }),
    ...(options.extra ?? []),
  );
  // The connected wallet's own read holds only its Ethereum ETH; any other identity reads the full fixture.
  const own = { ...p, holdings: p.holdings.slice(0, 1) };
  await page.route("**/api/portfolio", (r) => {
    const body = JSON.parse(r.request().postData() ?? "{}") as {
      identity?: { evm?: string };
    };
    return r.fulfill({
      json: body.identity?.evm?.toLowerCase() === OWN ? own : p,
    });
  });
  return p;
}
async function scan(page: Page) {
  await page.goto("/portfolio");
  await page
    .getByRole("textbox", { name: "evm Source address", exact: true })
    .fill(WATCHED);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
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
async function group(page: Page) {
  await page.getByRole("checkbox", { name: "Small balances" }).check();
  await page.getByTestId("portfolio-group").check();
}
/** The table's reading order as [chain of the nearest head, chain of the row] pairs, plus the heads in order. */
const groupingOrder = (page: Page) =>
  page.locator(".portfolio-assets > :is(h3, article)").evaluateAll((els) => {
    const heads: string[] = [];
    const rows: [string | null, string | null][] = [];
    for (const e of els)
      if (e.tagName === "H3") heads.push(e.getAttribute("data-group-chain")!);
      else
        rows.push([heads.at(-1) ?? null, e.getAttribute("data-holding-chain")]);
    return { heads, rows };
  });

test("VWP-P1 account band and allocation: the address read, the total KNOWN value, chain marks with share lines that filter the table", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  const summary = page.getByTestId("portfolio-summary");
  await expect(summary.locator(".summary-account")).toContainText(
    "Viewed address",
  );
  await expect(summary.locator(".summary-account code")).toHaveAttribute(
    "title",
    WATCHED,
  );
  await expect(summary).toContainText("Total known value");
  // Known value only: ETH 2,800 + Base ETH 5,600 + TOKEN 120 + DUST 0.0001 + the suspicious token's read 25. The spam
  // token's read $999 and the unpriced token add nothing.
  await expect(summary.locator(".summary-value")).toHaveText("$8,545.00");
  await expect(summary.locator(".alloc-title")).toHaveText(
    "Network allocation",
  );
  const cells = summary.locator(".chain-atlas > li:not(.atlas-more)");
  await expect(cells.first()).toContainText("Base");
  await expect(cells.first().locator(".atlas-mark img")).toBeVisible();
  const fill = await cells
    .first()
    .locator(".atlas-share")
    .evaluate((e) => Number(getComputedStyle(e).getPropertyValue("--fill")));
  expect(fill).toBeGreaterThan(0.6);
  expect(fill).toBeLessThan(0.7);
  await cells.first().locator(".atlas-hit").click();
  await expect(
    page.getByRole("combobox", { name: "Filter by network" }),
  ).toHaveValue("8453");
  await expect(page.locator(".asset-row")).toHaveCount(2);
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "vwp-p1-overview");
});

test("VWP-P2 grouping by network: every row under its own network's single head, heads ordered by the figure they show, unknown never $0.00", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  await group(page);
  const heads = page.locator(".asset-group-head");
  await expect(heads).toHaveCount(3);
  const { heads: order, rows } = await groupingOrder(page);
  expect(order).toEqual(["8453", "1", "56"]);
  expect(new Set(order).size).toBe(order.length);
  expect(rows.length).toBeGreaterThan(0);
  for (const [head, row] of rows) expect(row).toBe(head);
  // Each head names what its figure is: the known value of the rows shown under it.
  for (const i of [0, 1, 2])
    await expect(heads.nth(i)).toContainText("Known value of shown assets");
  await expect(heads.nth(0).locator(".asset-group-total")).toHaveText(
    "$5,625.00",
  );
  // Ethereum: ETH 2,800 + DUST 0.0001 known; the unpriced token is named, not valued.
  await expect(heads.nth(1).locator(".asset-group-total")).toHaveText(
    "$2,800.00",
  );
  await expect(heads.nth(1).locator(".asset-group-note")).toHaveText(
    "1 unpriced",
  );
  await expect(heads.nth(2).locator(".asset-group-total")).toHaveText(
    "$120.00",
  );
  await expect(heads.nth(2).locator(".asset-group-note")).toHaveCount(0);
  await shot(page, "vwp-p2-grouped");
  // A group whose shown rows are all unpriced reads Unknown, never a firm $0.00.
  await page.getByRole("searchbox", { name: "Search assets" }).fill("NOPRICE");
  await expect(heads).toHaveCount(1);
  await expect(heads.nth(0)).toContainText("Ethereum");
  await expect(heads.nth(0).locator(".asset-group-total")).toHaveText(
    "Unknown",
  );
  await expect(heads.nth(0)).toContainText("1 unpriced");
  await expect(heads.nth(0)).not.toContainText("$0.00");
});

test("VWP-P2b grouping keeps debt apart: a borrowed position is named beside the group, never added to its known value", async ({
  page,
}) => {
  await setup(page, {
    extra: [
      holding("1", "300000000", 300, {
        address: "0x9999999999999999999999999999999999999999",
        native: false,
        symbol: "vdUSDC",
        name: "Variable debt USDC",
        decimals: 6,
        position: {
          protocol: "Aave V3",
          category: "borrowing",
          role: "debt",
          source: "https://example.invalid/synthetic-test-only",
        },
      }),
    ],
  });
  await scan(page);
  // Debt never adds to the known value (unchanged headline).
  await expect(
    page.getByTestId("portfolio-summary").locator(".summary-value"),
  ).toHaveText("$8,545.00");
  await group(page);
  const eth = page.locator('.asset-group-head[data-group-chain="1"]');
  await expect(eth.locator(".asset-group-total")).toHaveText("$2,800.00");
  await expect(eth).toContainText("Debt $300.00");
  await expect(eth).toContainText("1 unpriced");
});

test("VWP-P3 spam and suspicious tokens are kept apart: spam is never counted, suspicious metadata is marked and explained, columns line up", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  // Spam is not in the table by default; the suspicious token is, with its mark.
  await expect(page.locator(`.asset-row[data-token="${SPAM}"]`)).toHaveCount(0);
  await expect(
    page.locator(`.asset-row[data-token="${SUSPICIOUS}"]`),
  ).toContainText("Suspicious metadata");
  const flagged = page.getByTestId("portfolio-flagged");
  await expect(flagged).toBeVisible();
  await expect(flagged.locator("summary")).toContainText(
    "Spam and suspicious tokens",
  );
  await flagged.locator("summary").click();
  await expect(flagged).toContainText(
    "Spam tokens are never counted in the total",
  );
  const items = flagged.locator("li");
  await expect(items).toHaveCount(2);
  await expect(items.filter({ hasText: "SPAM" })).toContainText("Spam token");
  await expect(items.filter({ hasText: "USDC" })).toContainText(
    "Suspicious metadata",
  );
  // One set of column tracks: addresses start, and amounts end, at the same place in every row.
  const edge = (sel: string, side: "left" | "right") =>
    items
      .locator(sel)
      .evaluateAll(
        (els, side) => els.map((e) => e.getBoundingClientRect()[side]),
        side,
      );
  for (const [sel, side] of [
    ["code", "left"],
    [".flagged-amount", "right"],
  ] as const) {
    const [a, b] = await edge(sel, side);
    expect(Math.abs(a - b)).toBeLessThan(1);
  }
  await shot(page, "vwp-p3-flagged");
});

test("VWP-P4 unknown stays unknown: an unpriced token shows Unpriced and Unknown, a failed network is failed, never zero", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  const row = page.locator(`.asset-row[data-token="${UNPRICED}"]`);
  await expect(row.locator(".asset-price")).toContainText("Unpriced");
  await expect(row.locator(".asset-value")).toContainText("Unknown");
  await expect(page.getByTestId("unpriced-count")).toBeVisible();
  await page.locator(".portfolio-coverage-details summary").click();
  await expect(
    page.locator('.portfolio-coverage-details li[data-coverage="FAILED"]'),
  ).toContainText("Arbitrum");
});

test("VWP-P6 pricing provenance: the unit price as read, its confidence, method and observation time; named on a phone", async ({
  page,
}) => {
  await setup(page);
  await scan(page);
  const when = await page.evaluate(
    (at) =>
      new Intl.DateTimeFormat("en", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(at),
    PRICE_AT,
  );
  const token = page.locator(`.asset-row[data-token="${TOKEN}"] .asset-price`);
  await expect(token).toContainText("$1.20");
  // Read as the reader sees it: the bidi isolate marks around the method id are invisible.
  const seen = (sel: string) =>
    page
      .locator(sel)
      .evaluate((e) => (e.textContent ?? "").replace(/[\u2066-\u2069]/g, ""));
  await expect
    .poll(() => seen(`.asset-row[data-token="${TOKEN}"] .price-source`))
    .toBe(`verified price · via data-plane · ${when}`);
  await expect
    .poll(() => seen(`.asset-row[data-token="${SUSPICIOUS}"] .price-source`))
    .toBe(`derived price · via routing-list · ${when}`);
  // Each part is isolated: confidence, method and time are separate bidi runs.
  await expect(token.locator(".price-source > bdi")).toHaveCount(3);
  // The price column is named by the table head on wide screens, by the row on a phone.
  await expect(token.locator(".asset-price-label")).toBeHidden();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(token.locator(".asset-price-label")).toBeVisible();
  await expect(token.locator(".asset-price-label")).toHaveText("Price");
  expect(await noOverflow(page)).toBe(true);
  await shot(page, "vwp-p6-price-phone");
});

test("VWP-P7 the account band names the identity the result was read for, also after leaving and returning with a wallet connected", async ({
  page,
}) => {
  await setup(page, { connected: true });
  await page.goto("/portfolio");
  await connectWallet(page, "MetaMask", { label: "Connect wallet" });
  const summary = page.getByTestId("portfolio-summary");
  const band = summary.locator(".summary-account");
  await expect(summary.locator(".summary-value")).toHaveText("$2,800.00");
  await expect(band).toContainText("Connected wallet");
  expect(
    (await band.locator("code").getAttribute("title"))?.toLowerCase(),
  ).toBe(OWN);
  // Another address, explicitly.
  await page.locator('[data-scan-mode="watch"]').click();
  await page.locator(".scan-field input").first().fill(WATCHED);
  await page.locator(".scan-button").click();
  await expect(summary.locator(".summary-value")).toHaveText("$8,545.00");
  await expect(band).toContainText("Viewed address");
  await expect(band.locator("code")).toHaveAttribute("title", WATCHED);
  // Leave through a row's Bridge action and come back: the kept result is still the viewed address's, and the band
  // says so (never "Connected wallet" above another address's totals).
  await page
    .locator(".asset-row .asset-actions button", { hasText: "Bridge" })
    .first()
    .click();
  await expect(page).toHaveURL(/\/bridge/);
  await page.locator('a[href="/portfolio"]').first().click();
  await expect(summary.locator(".summary-value")).toHaveText("$8,545.00");
  await expect(band).toContainText("Viewed address");
  await expect(band).not.toContainText("Connected wallet");
  await expect(band.locator("code")).toHaveAttribute("title", WATCHED);
  const writes = await page.evaluate(() =>
    (
      window as unknown as { __walletCalls: { method: string }[] }
    ).__walletCalls.filter((c) =>
      /sign|sendTransaction|sendRaw|permit|grantPermissions/.test(c.method),
    ),
  );
  expect(writes).toEqual([]);
});

for (const [name, width, locale, theme] of [
  ["phone", 390, "en", "dark"],
  ["rtl", 1440, "ar", "dark"],
  ["light", 1440, "en", "light"],
] as const)
  test(`VWP-P5 ${name}: the ledger fits, reads and is axe-clean, also grouped with the flagged list open`, async ({
    page,
  }) => {
    await setup(page, { locale, theme });
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/portfolio");
    await page.locator('[data-scan-mode="watch"]').click();
    await page.locator(".scan-field input").first().fill(WATCHED);
    await page.locator(".scan-button").click();
    await expect(page.getByTestId("portfolio-summary")).toBeVisible();
    expect(await noOverflow(page)).toBe(true);
    const axe = () =>
      new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
    expect((await axe()).violations).toEqual([]);
    await shot(page, `vwp-p5-${name}`);
    // The price source never interleaves its parts, in RTL as in LTR (three isolated runs).
    await expect(
      page.locator(`.asset-row[data-token="${TOKEN}"] .price-source > bdi`),
    ).toHaveCount(3);
    await page
      .locator(".portfolio-toggles input[type=checkbox]")
      .first()
      .check();
    await page.getByTestId("portfolio-group").check();
    await expect(page.locator(".asset-group-head")).toHaveCount(3);
    await page.getByTestId("portfolio-flagged").locator("summary").click();
    await expect(
      page.getByTestId("portfolio-flagged").locator("li"),
    ).toHaveCount(2);
    expect(await noOverflow(page)).toBe(true);
    expect((await axe()).violations).toEqual([]);
    await shot(page, `vwp-p5-${name}-grouped`);
  });
