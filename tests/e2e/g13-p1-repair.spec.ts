// G13 Phase 1: the five audited P1 repairs (VBA-P1-01 … 05) in the real product on SYNTHETIC data only
// (tests/fixtures; nothing is live, no wallet, no real balance). Read-only: no signature, approval or transaction.
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { test, expect, fillRecipient } from "./fixtures";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { portfolioFixture, holding } from "../fixtures/portfolio";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeActive } from "../../src/catalog/model";
import type { Catalog, QuoteInput } from "../../src/routing/model";
import type { PortfolioResult } from "../../src/portfolio/model";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import tr from "../../src/i18n/locales/tr.json" with { type: "json" };

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g13";
const PARTY = "0x3333333333333333333333333333333333333333";
type Raw = ReturnType<typeof fixtureQuote>;
const dict = { en, tr } as const;
const labels = (locale: keyof typeof dict) => ({
  source: dict[locale].ui.selectSourceNetwork,
  destination: dict[locale].ui.selectDestinationNetwork,
  read: dict[locale].ui.readRoute,
});

/** A server double that behaves like the routing adapter: it holds ONE current catalog; a quote whose generation is
 * not that catalog's is refused with CATALOG_CHANGED (src/adapters/routing-core.ts + src/routing/normalize.ts). */
interface Server {
  catalog: Catalog;
  /** Every quote request's generation, in order. */
  quotes: string[];
  catalogReads: number;
  mutate: (raw: Raw) => void;
  /** Refuse every quote with CATALOG_CHANGED (a catalog that keeps changing). */
  alwaysChanged: boolean;
  /** Catalog reads answer 503 (the route source is down). */
  catalogFails: boolean;
  /** Catalog reads wait for this promise before answering. */
  catalogHold: Promise<void> | null;
}
const withGeneration = (c: Catalog, generation: string): Catalog => ({
  ...structuredClone(c),
  generation,
});
async function bridgeSetup(page: Page, locale: keyof typeof dict = "en") {
  await page.addInitScript((locale) => {
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", locale);
    localStorage.setItem("otherbridge.theme", "dark");
  }, locale);
  const server: Server = {
    catalog: withGeneration(fixtureCatalog(), "1800000000000-g13content0001"),
    quotes: [],
    catalogReads: 0,
    mutate: () => {},
    alwaysChanged: false,
    catalogFails: false,
    catalogHold: null,
  };
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      status: 422,
      json: { error: "SYNTHETIC_CATALOG_UNAVAILABLE" },
    }),
  );
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON();
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    const catalog = server.catalog;
    if (body.action === "catalog") {
      server.catalogReads++;
      if (server.catalogHold) await server.catalogHold;
      // The page may have aborted this read meanwhile (the user changed the form): nothing to answer then.
      try {
        if (server.catalogFails)
          return await json({ error: "PROVIDER_UNAVAILABLE" }, 503);
        return await json(server.catalog);
      } catch {
        return;
      }
    }
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
      server.quotes.push(input.generation);
      if (server.alwaysChanged || input.generation !== catalog.generation)
        return json({ error: "CATALOG_CHANGED" }, 422);
      const raw = fixtureQuote(input);
      server.mutate(raw);
      const q = normalizeQuote(raw, input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return json([q]);
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  });
  await page.goto("/bridge");
  return server;
}
async function pick(
  page: Page,
  role: "source" | "destination",
  search: string,
  id: string,
  locale: keyof typeof dict,
) {
  await page
    .getByRole("button", { name: labels(locale)[role], exact: true })
    .click();
  await page.locator("#network-search").fill(search);
  await page.locator(`.network-picker [data-chain="${id}"]`).click();
  await expect(page.locator("dialog.network-picker")).toHaveCount(0);
}
async function form(
  page: Page,
  amount: string,
  locale: keyof typeof dict = "en",
) {
  await pick(page, "source", "Ethereum", "1", locale);
  await pick(page, "destination", "Base", "8453", locale);
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await page.locator("#routing-amount").fill(amount);
  await page.locator("#routing-sender").fill(PARTY);
  await fillRecipient(page, PARTY);
}
const read = (page: Page, locale: keyof typeof dict = "en") =>
  page.getByRole("button", { name: labels(locale).read, exact: true }).click();
const output = (page: Page) => page.locator(".trade-output bdi");
async function shot(page: Page, name: string) {
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("G13-P1-03-E1 a timestamp-only catalog refill is adopted and the route is read again exactly once", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  await form(page, "0.01");
  await read(page);
  await expect(output(page)).toBeVisible();
  // The route source refilled its catalog five minutes later: same networks and tools, new generation.
  server.catalog = withGeneration(
    server.catalog,
    "1800000301000-g13content0001",
  );
  const before = server.quotes.length;
  await page.locator("#routing-amount").fill("0.02");
  await read(page);
  await expect(output(page)).toBeVisible();
  await expect(page.getByText(en.routingErrors.CATALOG_CHANGED)).toHaveCount(0);
  const after = server.quotes.slice(before);
  // One refused read with the old generation, one automatic read with the adopted one — nothing more.
  expect(after).toEqual([
    "1800000000000-g13content0001",
    "1800000301000-g13content0001",
  ]);
  await page.waitForTimeout(1500);
  expect(server.quotes.length - before).toBe(2);
  await shot(page, "g13-p1-03-e1-recovered");
});

test("G13-P1-03-E2 a catalog whose content changed is adopted but never re-read silently: the user reads again", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  await form(page, "0.01");
  await read(page);
  await expect(output(page)).toBeVisible();
  const changed = withGeneration(
    server.catalog,
    "1800000301000-g13content0002",
  );
  changed.tools = changed.tools.slice(0, -1);
  server.catalog = changed;
  const before = server.quotes.length;
  await page.locator("#routing-amount").fill("0.02");
  await read(page);
  await expect(page.getByText(en.routingErrors.CATALOG_CHANGED)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(server.quotes.slice(before)).toEqual(["1800000000000-g13content0001"]);
  // The adopted catalog is used by the user's next read (no hidden button needed).
  await read(page);
  await expect(output(page)).toBeVisible();
  expect(server.quotes.slice(before)).toEqual([
    "1800000000000-g13content0001",
    "1800000301000-g13content0002",
  ]);
});

test("G13-P1-03-E3 a catalog that keeps changing gets one automatic read at most, then the message (no loop)", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  await form(page, "0.01");
  await read(page);
  await expect(output(page)).toBeVisible();
  server.catalog = withGeneration(
    server.catalog,
    "1800000301000-g13content0001",
  );
  server.alwaysChanged = true;
  const before = server.quotes.length;
  await page.locator("#routing-amount").fill("0.02");
  await read(page);
  await expect(page.getByText(en.routingErrors.CATALOG_CHANGED)).toBeVisible();
  await page.waitForTimeout(2000);
  expect(server.quotes.length - before).toBe(2);
});

test("G13-P1-01-E1 Turkish: 0,002 is read as 0.002 (exact wei); 4,995 names both readings instead of 'enter an amount'", async ({
  page,
}) => {
  const server = await bridgeSetup(page, "tr");
  await form(page, "4,995", "tr");
  const hint = page.locator(".trade-hint");
  await expect(hint).toContainText("4995");
  await expect(hint).toContainText("4,9950");
  await expect(hint).not.toContainText(tr.v110.needAmount);
  await expect(
    page.getByRole("button", { name: labels("tr").read, exact: true }),
  ).toBeDisabled();
  await shot(page, "g13-p1-01-e1-tr-ambiguous");
  await page.locator("#routing-amount").fill("0,002");
  await expect(hint).toHaveCount(0);
  await read(page, "tr");
  await expect(output(page)).toBeVisible();
  expect(server.quotes.length).toBe(1);
});

test("G13-P1-01-E2 Turkish: the quote request carries exactly 0,002 ETH and 4,9950 ETH", async ({
  page,
}) => {
  await bridgeSetup(page, "tr");
  const amounts: string[] = [];
  page.on("request", (r) => {
    if (r.url().endsWith("/api/routing") && r.method() === "POST") {
      const b = r.postDataJSON();
      if (b?.action === "quote") amounts.push(b.input.amount);
    }
  });
  await form(page, "0,002", "tr");
  await read(page, "tr");
  await expect(output(page)).toBeVisible();
  await page.locator("#routing-amount").fill("4,9950");
  await read(page, "tr");
  await expect(output(page)).toBeVisible();
  expect(amounts).toEqual(["2000000000000000", "4995000000000000000"]);
});

test("G13-P1-02-E1 a small transfer whose loss is the route's own fees: Guardian names the fees and never advises a smaller amount", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  server.mutate = (raw) => {
    raw.estimate.fromAmountUSD = "0.05";
    raw.estimate.toAmountUSD = "0.0457";
    raw.estimate.feeCosts[0].amountUSD = "0.0043";
  };
  await form(page, "0.00002");
  await read(page);
  const g = page.getByTestId("guardian-bridge");
  await expect(g).toBeVisible();
  await expect(g).toContainText("Route fees: 8.60% of the amount");
  await expect(g).toContainText("at least half of the 8.60% difference");
  await expect(g).toContainText(en.guardian.s.LARGER_AMOUNT);
  await expect(g).not.toContainText(en.guardian.s.REDUCE_AMOUNT);
  await expect(g).not.toContainText(en.guardian.w.ROUTE_IMPACT);
  await shot(page, "g13-p1-02-e1-fee-share");
});

test("G13-P1-02-E2 when the route reports no dollar value for its fees, Guardian keeps the accepted price-impact advice", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  server.mutate = (raw) => {
    raw.estimate.fromAmountUSD = "0.05";
    raw.estimate.toAmountUSD = "0.0457";
    delete (raw.estimate.feeCosts[0] as { amountUSD?: string }).amountUSD;
  };
  await form(page, "0.00002");
  await read(page);
  const g = page.getByTestId("guardian-bridge");
  await expect(g).toBeVisible();
  await expect(g).toContainText(en.guardian.s.REDUCE_AMOUNT);
});

// ---- Portfolio (VBA-P1-04, VBA-P1-05) ----
const WATCHED = "0x8a1f3c9b2d4e5f60718293a4b5c6d7e8f9a0b1c2";
const ZERO = "0x0000000000000000000000000000000000000000";
async function portfolioSetup(
  page: Page,
  result: PortfolioResult,
  locale: keyof typeof dict = "en",
) {
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.addInitScript((locale) => {
    localStorage.setItem("otherbridge.language", locale);
    localStorage.setItem("otherbridge.theme", "dark");
  }, locale);
  const catalog = fixtureCatalog();
  await page.route("**/api/routing", (r) => r.fulfill({ json: catalog }));
  await page.route("**/api/catalog", (r) =>
    r.fulfill({
      json: normalizeActive(
        [
          ...catalog.networks
            .filter((n) => n.mainnet)
            .map((n) => ({ name: n.name, chainId: n.id, tvl: 1e6 })),
          { name: "Manta", chainId: "169", tvl: 1e6 },
        ],
        catalog,
        Date.now(),
        "SYNTHETIC_TEST_ONLY",
      ),
    }),
  );
  await page.route("**/api/assets", (r) => r.fulfill({ json: { assets: [] } }));
  await page.route("**/api/portfolio", (r) => r.fulfill({ json: result }));
  await page.goto("/portfolio");
  await page.locator('[data-scan-mode="watch"]').click();
  await page.locator(".scan-field input").first().fill(WATCHED);
  await page.locator(".scan-button").click();
  await expect(page.getByTestId("portfolio-summary")).toBeVisible();
}
// SYNTHETIC balance (never a real wallet's: review fix — the audited owner balance must not be a fixture).
const manta = (balance = "7000000000000000") => ({
  ...holding("1", balance, null),
  chainId: "169",
  address: ZERO,
  symbol: "MANTA",
  name: "",
  native: true,
});

test("G13-P1-04-E1 a network whose balances are all unpriced reads Unknown + count, never $0.00 0%; a mixed one names its unpriced rows", async ({
  page,
}) => {
  const p = portfolioFixture();
  p.holdings.push(manta());
  p.holdings.push(
    holding("8453", "5000000", null, {
      address: "0x7777777777777777777777777777777777777777",
      native: false,
      symbol: "UNPRICED",
      name: "Synthetic unpriced token",
      decimals: 6,
    }),
  );
  await portfolioSetup(page, p);
  const mantaRow = page.locator(
    '.chain-row[data-chain="169"] .chain-row-value',
  );
  await expect(mantaRow).toContainText("Unknown");
  await expect(mantaRow).toContainText("1 unpriced");
  await expect(mantaRow).not.toContainText("$0.00");
  await expect(mantaRow).not.toContainText("0%");
  await expect(mantaRow.locator("strong")).toHaveAttribute(
    "data-value-known",
    "false",
  );
  const base = page.locator('.chain-row[data-chain="8453"] .chain-row-value');
  await expect(base).toContainText("$5,600.00");
  await expect(base).toContainText("1 unpriced");
  await expect(base.locator("strong")).toHaveAttribute(
    "data-value-known",
    "true",
  );
  // A fully priced network is unchanged.
  await expect(
    page.locator('.chain-row[data-chain="1"] .chain-row-value'),
  ).not.toContainText("unpriced");
  await shot(page, "g13-p1-04-e1-network-rows");
});

test("G13-P1-05-E1 native ETH on Manta Pacific is named ETH (never MANTA) and stays honestly unpriced", async ({
  page,
}) => {
  const p = portfolioFixture();
  p.holdings.push(manta());
  await portfolioSetup(page, p);
  const row = page.locator('.asset-row[data-holding-chain="169"]');
  await expect(row).toHaveCount(1);
  await expect(row.locator(".asset-id strong")).toHaveText("ETH");
  await expect(row).not.toContainText("MANTA");
  await expect(row.locator(".asset-value")).toContainText("Unknown");
  await expect(page.locator('.chain-row[data-chain="169"]')).toContainText(
    "ETH",
  );
  await expect(page.locator('.chain-row[data-chain="169"]')).not.toContainText(
    "MANTA",
  );
  await shot(page, "g13-p1-05-e1-manta-eth");
});

test("G13-P1-03-E4 a catalog read that fails during recovery shows the message and re-reads nothing; the next read recovers", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  await form(page, "0.01");
  await read(page);
  await expect(output(page)).toBeVisible();
  server.catalog = withGeneration(
    server.catalog,
    "1800000301000-g13content0001",
  );
  server.catalogFails = true;
  const before = server.quotes.length;
  await page.locator("#routing-amount").fill("0.02");
  await read(page);
  await expect(page.getByText(en.routingErrors.CATALOG_CHANGED)).toBeVisible();
  await page.waitForTimeout(1500);
  expect(server.quotes.length - before).toBe(1);
  server.catalogFails = false;
  await read(page);
  await expect(output(page)).toBeVisible();
  expect(server.quotes.slice(before)).toEqual([
    "1800000000000-g13content0001",
    "1800000000000-g13content0001",
    "1800000301000-g13content0001",
  ]);
});

test("G13-P1-03-E5 changing the form while the catalog is re-read cancels the recovery: no read with the old inputs", async ({
  page,
}) => {
  const server = await bridgeSetup(page);
  await form(page, "0.01");
  await read(page);
  await expect(output(page)).toBeVisible();
  server.catalog = withGeneration(
    server.catalog,
    "1800000301000-g13content0001",
  );
  let release = () => {};
  server.catalogHold = new Promise<void>((r) => (release = r));
  const before = server.quotes.length;
  const reads = server.catalogReads;
  await page.locator("#routing-amount").fill("0.02");
  await read(page);
  await expect.poll(() => server.catalogReads).toBeGreaterThan(reads);
  await page.locator("#routing-amount").fill("0.03");
  server.catalogHold = null;
  release();
  await page.waitForTimeout(1500);
  expect(server.quotes.length - before).toBe(1);
  await expect(output(page)).toHaveCount(0);
});

test("G13-P1-04-E2 the DeFi card never shows $0.00 for what it does not know: loading, failed, all-unpriced wallet", async ({
  page,
}) => {
  const p = portfolioFixture();
  p.holdings = [manta()];
  let release = () => {};
  const hold = new Promise<void>((r) => (release = r));
  await page.route("**/api/portfolio/defi", async (r) => {
    await hold;
    await r
      .fulfill({ status: 503, json: { error: "SYNTHETIC_NOT_CHECKED" } })
      .catch(() => {});
  });
  await portfolioSetup(page, p);
  const fact = (label: string) =>
    page
      .locator(".defi-summary-facts > div")
      .filter({ hasText: label })
      .locator("strong");
  await expect(fact(en.v113.defiValue)).toHaveText(en.ui.loading);
  await expect(fact(en.v113.borrowed)).toHaveText(en.ui.loading);
  await expect(fact(en.v113.walletValue)).toHaveText(en.v113.unpriced);
  release();
  await expect(fact(en.v113.defiValue)).toHaveText(en.ui.unknown);
  await expect(fact(en.v113.borrowed)).toHaveText(en.ui.unknown);
  await expect(page.locator(".defi-summary-facts")).not.toContainText("$0.00");
});
