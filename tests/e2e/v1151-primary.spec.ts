// UI response replay only. The recorded Solana economics are independently verified by
// v1151-solana-economic.test.ts; these tests never connect a wallet, sign or broadcast.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, readOnlyAddress } from "./fixtures";
import { fixtureCatalog } from "../fixtures/routing";
import { wallet, swapQuote } from "../fixtures/swap";
import replay from "../fixtures/solana-economic-whirlpool.json" with { type: "json" };
import { makeQuote } from "../../src/swap/server/provider";
import {
  parseIntent,
  wire,
  type SwapIntent,
  type SwapQuote,
} from "../../src/swap/model";
import { SOLANA_CHAIN_ID } from "../../src/assets/model";

async function base(page: Page) {
  await page
    .context()
    .addCookies([
      { name: "otherbridge.locale", value: "en", url: "http://127.0.0.1:3100" },
    ]);
  await page.addInitScript(() =>
    localStorage.setItem("otherbridge.language", "en"),
  );
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
}

async function refreshSetup(page: Page) {
  await base(page);
  const requests: SwapIntent[] = [];
  await page.route("**/api/swap", async (route) => {
    const body = route.request().postDataJSON();
    expect(body.action).toBe("quote");
    const i = parseIntent(body.intent);
    requests.push(i);
    const quotes = [
      swapQuote(i, "UNISWAP", {
        amountOut: 30_000_000n,
        minAmountOut: 29_850_000n,
      }),
      swapQuote(i, "PANCAKESWAP_SMART", {
        amountOut: requests.length > 1 ? 35_000_000n : 31_000_000n,
        minAmountOut: requests.length > 1 ? 34_825_000n : 30_845_000n,
      }),
    ];
    return route.fulfill({
      contentType: "application/x-ndjson",
      body:
        [
          ...quotes.map((quote) => ({ type: "quote", quote })),
          { type: "settled", elapsedMs: 20 },
        ]
          .map(wire)
          .join("\n") + "\n",
    });
  });
  await page.goto("/swap");
  const card = page.getByTestId("swap-intelligence");
  await card.getByRole("button", { name: /^Destination token/ }).click();
  await page.locator("#token-search").fill("USDC");
  await page.getByRole("option").filter({ hasText: "USDC" }).first().click();
  await (await readOnlyAddress(card)).fill(wallet);
  await card.locator("#meta-amount").fill("0.01");
  await card
    .getByRole("button", { name: "Compare providers", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: /Uniswap · V3/ }),
  ).toBeVisible();
  return { card, requests };
}

test("V1151 automatic refresh preserves the selected quote version, keyboard focus and intent", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { card, requests } = await refreshSetup(page);
  const choice = card.getByRole("button", { name: /Uniswap · V3/ });
  await choice.focus();
  await page.keyboard.press("Enter");
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => requests.length, { timeout: 22000 }).toBe(2);
  await expect(choice).toBeFocused();
  await expect(choice).toHaveAttribute("aria-pressed", "true");
  await expect(choice).toContainText("30 USDC");
  await expect(
    card.getByText("A better quote is available", { exact: true }),
  ).toBeVisible();
  expect(requests[1]).toEqual(requests[0]);
  await card.locator("#meta-amount").fill("0.02");
  await expect(
    card.getByRole("button", { name: "Review Swap", exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(4500);
  expect(requests).toHaveLength(2);
});

test("V1151 hidden page pauses refresh and visible page requotes once", async ({
  page,
}) => {
  test.setTimeout(60000);
  const { requests } = await refreshSetup(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(16500);
  expect(requests).toHaveLength(1);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "visible",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await expect.poll(() => requests.length).toBe(2);
  await page.waitForTimeout(1000);
  expect(requests).toHaveLength(2);
});

for (const provider of ["Jupiter", "Titan"] as const)
  test(`V1151 Solana ${provider}: exact mint import, economic review replay and execution closed`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await base(page);
    const mint = replay.result.intent.tokenIn.address;
    const asset = {
      chainId: SOLANA_CHAIN_ID,
      address: mint,
      symbol: "NEON",
      name: "Imported Solana mint",
      decimals: 9,
      native: false,
      level: "IMPORTED_UNVERIFIED",
      risk: [],
      sources: ["SYNTHETIC_TEST_ONLY"],
      logoUrl: null,
      routable: false,
      routeStatus: "NO_VERIFIED_ROUTE",
      evidence: {
        curated: false,
        trustWallet: false,
        marketListed: null,
        dex: null,
        onebridge: null,
      },
    };
    await page.route("**/api/assets", (route) => {
      const b = route.request().postDataJSON();
      if (b.action === "preview") {
        expect(b.chain).toBe(SOLANA_CHAIN_ID);
        expect(b.address).toBe(mint);
        return route.fulfill({
          json: {
            asset,
            importable: true,
            warnings: [],
            steps: [
              { step: "address", ok: true, detail: "SOLANA_MINT" },
              { step: "metadata", ok: true, detail: "SPL_TOKEN_DECIMALS_9" },
            ],
          },
        });
      }
      return route.fulfill({ json: { assets: [], results: [], lookup: true } });
    });
    let q: SwapQuote;
    const actions: string[] = [];
    await page.route("**/api/swap", async (route) => {
      const b = route.request().postDataJSON();
      actions.push(b.action);
      const i = parseIntent(b.intent);
      expect(i.ecosystem).toBe("SVM");
      expect(i.tokenIn.address).toBe(mint);
      expect(i.tokenOut.native).toBe(true);
      expect(i.taker).toBe(replay.result.intent.taker);
      expect(i.recipient).toBe(i.taker);
      if (b.action === "quote") {
        expect(i.amount).toBe(BigInt(replay.result.intent.amount));
        expect(i.slippage).toEqual({ mode: "MANUAL", bps: 80 });
        q = makeQuote(
          i,
          provider,
          provider === "Jupiter" ? "JUPITER_ROUTER" : "TITAN",
          i.amount,
          BigInt(replay.result.quote.amountOut),
          replay.result.quote.route as SwapQuote["route"],
          {
            build: "UNSIGNED_BUILD",
            sourceBlock: String(replay.result.sourceSlot),
            priceImpactBps: 15,
          },
        );
        return route.fulfill({
          contentType: "application/x-ndjson",
          body:
            [
              {
                type: "providers",
                providers: [
                  { mode: q.mode, status: "OK", quoteCount: 1, latencyMs: 20 },
                ],
              },
              { type: "quote", quote: q },
              { type: "settled", elapsedMs: 20 },
            ]
              .map(wire)
              .join("\n") + "\n",
        });
      }
      expect(b.action).toBe("review");
      expect(b.id).toBe(q.id);
      expect(replay.result.inspection.review).toBe("ECONOMICS_VERIFIED");
      expect(replay.result.simulation.status).toBe("PASSED");
      expect(replay.result.broadcasts).toBe(0);
      return route.fulfill({
        contentType: "application/json",
        body: wire({
          state: "EXECUTION_CLOSED",
          verifiedForReview: true,
          quote: q,
          expiresAt: q.expiresAt,
          digest: "a".repeat(64),
          transactionDigest: replay.result.simulation.transactionDigest,
          decoded: replay.result.inspection,
          simulation: {
            ...replay.result.simulation,
            source: "RECORDED_UNSIGNED_SOLANA_ECONOMIC_REPLAY",
          },
        }),
      });
    });
    await page.goto("/swap");
    await page
      .getByRole("button", { name: "Select source network", exact: true })
      .click();
    await page.locator("#network-search").fill("Solana");
    await page
      .locator(".picker-option")
      .filter({ hasText: "Solana" })
      .first()
      .click();
    const card = page.getByTestId("swap-intelligence");
    await card.getByRole("button", { name: /^Source token/ }).click();
    await page.locator("#token-search").fill(mint);
    await page
      .getByRole("button", { name: "Look up this token", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Import token", exact: true })
      .click();
    const row = page.locator(`[data-token-option="${mint}"]`);
    await expect(row).toHaveAttribute("data-level", "IMPORTED_UNVERIFIED");
    await row.click();
    await card.getByRole("button", { name: /^Destination token/ }).click();
    await page.getByRole("option").filter({ hasText: "SOL" }).first().click();
    await (await readOnlyAddress(card)).fill(replay.result.intent.taker);
    await expect(card.locator('input[placeholder^="0x"]')).toHaveCount(0);
    await card.locator("#meta-amount").fill("1799");
    await card.locator(".trade-settings-disclosure summary").click();
    await card.getByLabel("Manual slippage", { exact: true }).check();
    await card
      .getByRole("spinbutton", { name: "Slippage tolerance %", exact: true })
      .fill("0.8");
    await card.locator(".trade-settings-disclosure summary").click();
    await card
      .getByRole("button", { name: "Compare providers", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: new RegExp(`${provider} · SOLANA`) }),
    ).toHaveAttribute("aria-pressed", "true");
    await card
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    const dialog = page.locator(".review-dialog[open]");
    await expect(dialog).toContainText(
      "Execution closed — route verified for review",
    );
    await expect(dialog).toContainText(
      "RECORDED_UNSIGNED_SOLANA_ECONOMIC_REPLAY",
    );
    await expect(dialog).toContainText("Whirlpool");
    await expect(dialog).toContainText("VEINED fee: 0%");
    await expect(dialog).toContainText(
      "Estimated network fee: 0.000005221 SOL",
    );
    await expect(dialog).toContainText("Account rent: ≤");
    await dialog.getByText("Advanced", { exact: true }).click();
    await expect(dialog).toContainText(
      replay.result.simulation.transactionDigest,
    );
    await expect(dialog).toContainText(replay.result.quote.route[0].pool);
    await expect(
      dialog.getByRole("button", { name: /sign|approve|confirm swap/i }),
    ).toHaveCount(0);
    expect(actions).toEqual(["quote", "review"]);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    const imports = await page.evaluate(
      (key) => JSON.parse(localStorage.getItem(key) ?? "[]"),
      `otherbridge:imported-tokens:${SOLANA_CHAIN_ID}`,
    );
    expect(imports[0].address).toBe(mint);
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await card.getByRole("button", { name: /^Source token/ }).click();
    await page.locator("#token-search").fill(mint);
    await expect(page.locator(`[data-token-option="${mint}"]`)).toHaveAttribute(
      "data-level",
      "IMPORTED_UNVERIFIED",
    );
  });
