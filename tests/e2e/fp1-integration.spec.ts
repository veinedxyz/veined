// fp1 full-product integration audit: Guardian is the shared security layer of the Bridge review (not only a side
// panel), the Swap review honours the server's Guardian refusal, and Portfolio never shows unpriced DeFi value as $0.00.
// SYNTHETIC_TEST_ONLY: routing, swap, portfolio and DeFi upstreams are fixtures; nothing is signed, approved or sent.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, readOnlyAddress } from "./fixtures";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote } from "../../src/routing/normalize";
import type { QuoteInput } from "../../src/routing/model";
import { wallet, usdc, swapQuote } from "../fixtures/swap";
import { parseIntent, wire, type QuoteEvent } from "../../src/swap/model";
import { defiFixture, defiWallet } from "../fixtures/defi";
import { portfolioFixture, holding } from "../fixtures/portfolio";
import { normalizeActive } from "../../src/catalog/model";
import type { DefiScan } from "../../src/defi/model";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const BURN = "0x000000000000000000000000000000000000dEaD";
async function english(page: Page) {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "en", url: ORIGIN }]);
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("otherbridge.language", "en");
  });
}
async function bridge(page: Page, recipient: string) {
  await english(page);
  const catalog = fixtureCatalog();
  await page.route("**/api/catalog", (route) =>
    route.fulfill({ status: 422, json: { error: "SYNTHETIC_UNAVAILABLE" } }),
  );
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "catalog") return route.fulfill({ json: catalog });
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
      const input = body.input as QuoteInput;
      return route.fulfill({
        json: [normalizeQuote(fixtureQuote(input), input, catalog)],
      });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
  await page.goto("/bridge");
  for (const [role, search, id] of [
    ["Select source network", "Ethereum", "1"],
    ["Select destination network", "Base", "8453"],
  ]) {
    await page.getByRole("button", { name: role }).click();
    await page.locator("#network-search").fill(search);
    await page.locator(`.network-picker [data-chain="${id}"]`).click();
    await expect(page.locator("dialog.network-picker")).toHaveCount(0);
  }
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await page.locator("#routing-amount").fill("0.01");
  await page.locator("#routing-sender").fill(wallet);
  if (recipient !== wallet) {
    await page.locator(".trade-parties .toggle input[type=checkbox]").check();
    await page.locator("#routing-recipient").fill(recipient);
  }
  await page.getByRole("button", { name: "Read route", exact: true }).click();
}

test("FP1-E1 Bridge: Guardian's verdict gates the route review and appears inside it", async ({
  page,
}) => {
  await bridge(page, wallet);
  const side = page.getByTestId("guardian-bridge");
  // VEINED's own read-only markers are not route-source notes: a clean self route is CLEAR.
  await expect(side).toHaveAttribute("data-level", "CLEAR");
  const review = page.getByRole("button", {
    name: "Review route",
    exact: true,
  });
  await expect(review).toBeEnabled();
  await review.click();
  const dialog = page.locator(".routing-review");
  await expect(dialog).toBeVisible();
  const inside = dialog.getByTestId("guardian-bridge-review");
  await expect(inside).toHaveAttribute("data-level", "CLEAR");
  await expect(inside).toHaveAttribute(
    "data-digest",
    (await side.getAttribute("data-digest"))!,
  );
  await expect(
    dialog.getByRole("button", { name: "Save preview to Activity" }),
  ).toBeEnabled();
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa"])
        .include(".routing-review")
        .analyze()
    ).violations,
  ).toEqual([]);
});

test("FP1-E2 Bridge: a burn-address recipient is blocked and the route review cannot open", async ({
  page,
}) => {
  await bridge(page, BURN);
  const side = page.getByTestId("guardian-bridge");
  await expect(side).toHaveAttribute("data-level", "BLOCK");
  await expect(side.locator('[data-code="RECIPIENT_BURN"]')).toBeVisible();
  await expect(page.locator(".guardian-block-note")).toHaveText(
    "Guardian blocked this route. Choose another token or route.",
  );
  await expect(
    page.getByRole("button", { name: "Review route", exact: true }),
  ).toBeDisabled();
  await expect(page.locator(".routing-review")).not.toBeVisible();
});

test("FP1-E3 Swap: a review the server's Guardian refuses reads as Guardian's block", async ({
  page,
}) => {
  await english(page);
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
  const asset = {
    chainId: "1",
    address: usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    native: false,
    level: "CURATED",
    risk: [],
    sources: ["SYNTHETIC_TEST_ONLY"],
    logo: null,
    logoUrl: null,
    routable: true,
    routeStatus: "ROUTABLE",
    evidence: {
      curated: true,
      trustWallet: false,
      marketListed: null,
      dex: null,
      onebridge: null,
    },
  };
  await page.route("**/api/assets", (route) =>
    route.fulfill({
      json: { assets: [asset], results: [asset], lookup: false },
    }),
  );
  const reviews: unknown[] = [];
  await page.route("**/api/swap", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "review") {
      reviews.push(body);
      return route.fulfill({
        status: 403,
        json: { error: "GUARDIAN_BLOCKED", verdict: { level: "BLOCK" } },
      });
    }
    const i = parseIntent(body.intent);
    const quotes = [
      swapQuote(i, "UNISWAP", {
        amountOut: 30_000_000n,
        minAmountOut: 29_850_000n,
        priceImpactBps: 20,
      }),
      swapQuote(i, "PANCAKESWAP_SMART", {
        amountOut: 29_900_000n,
        minAmountOut: 29_750_000n,
        priceImpactBps: 25,
      }),
    ];
    const events: QuoteEvent[] = [
      {
        type: "providers",
        providers: quotes.map((q) => ({
          mode: q.mode,
          status: "OK" as const,
          latencyMs: 20,
          quoteCount: 1,
        })),
      },
      ...quotes.map((quote) => ({ type: "quote" as const, quote })),
      { type: "settled", elapsedMs: 50 },
    ];
    await route.fulfill({
      contentType: "application/x-ndjson",
      body: events.map(wire).join("\n") + "\n",
    });
  });
  await page.goto("/swap");
  const card = page.getByTestId("swap-intelligence");
  await card.locator(".token-select-trigger").nth(1).click();
  await page
    .getByRole("dialog")
    .getByRole("option")
    .filter({ hasText: "USDC" })
    .first()
    .click();
  await (await readOnlyAddress(card)).fill(wallet);
  await card.locator("#meta-amount").fill("0.01");
  await card.getByRole("button", { name: "Compare providers" }).click();
  await expect(card.getByTestId("guardian-swap")).toHaveAttribute(
    "data-level",
    "CLEAR",
  );
  await card.getByRole("button", { name: "Review Swap" }).click();
  await expect(card.getByRole("alert")).toHaveText(
    "Guardian blocked this route. Choose another token or route.",
  );
  await expect(page.getByTestId("guardian-swap-review")).toHaveCount(0);
  expect(reviews).toHaveLength(1);
});

test("FP1-E4 Portfolio: an unpriced DeFi position reads Unpriced (never $0.00) and one unpriced count is shown", async ({
  page,
}) => {
  await english(page);
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
  const plain = s.positions.find((p) => !p.borrowed.length)!;
  const unpriced = {
    ...plain,
    id: "fp1-unpriced-position",
    positionKey: "fp1",
    protocolId: "fp1-unpriced",
    protocolName: "Unpriced Fixture Protocol",
    grossAssetsUsd: "0.000000",
    supplied: plain.supplied.map((a) => ({ ...a, valueUsd: null })),
    collateral: plain.collateral.map((a) => ({ ...a, valueUsd: null })),
    underlying: plain.underlying.map((a) => ({ ...a, valueUsd: null })),
    representations: [],
  };
  const p = portfolioFixture();
  p.holdings = [holding("1", "1000000000000000000", 2800)];
  await page.route("**/api/portfolio", (r) => r.fulfill({ json: p }));
  await page.route("**/api/portfolio/defi", (r) => {
    const b = r.request().postDataJSON();
    const value: DefiScan = {
      ...s,
      wallet: b.wallet.toLowerCase(),
      positions: [...s.positions, unpriced],
    };
    return r.fulfill({ json: value });
  });
  await page.goto("/portfolio");
  await page
    .getByRole("textbox", { name: "evm Source address", exact: true })
    .fill(defiWallet);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  const tile = page
    .locator(".defi-allocation button")
    .filter({ hasText: "Unpriced Fixture Protocol" });
  await expect(tile).toContainText("Unpriced");
  await expect(tile).not.toContainText("$0.00");
  const notes = page.locator(".defi-value-notes");
  await expect(notes).toContainText("Unpriced assets:");
  const noted = Number(
    /Unpriced assets: (\d+)/.exec((await notes.textContent()) ?? "")?.[1],
  );
  await expect(page.getByTestId("unpriced-count")).toHaveText(
    `${noted} unpriced`,
  );
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  const group = page
    .locator(".defi-protocol-group")
    .filter({ hasText: "Unpriced Fixture Protocol" });
  await expect(group.locator(".defi-protocol-total")).toHaveText("Unpriced");
  await expect(group.locator(".defi-card-value bdi").first()).toHaveText(
    "Unpriced",
  );
});
