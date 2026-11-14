// SYNTHETIC_TEST_ONLY: shared primary-swap fixture, isolated from all public providers.
import type { BrowserContext, Page } from "@playwright/test";
import { parseIntent, wire, type SwapQuote } from "../../src/swap/model";
import { swapQuote } from "../fixtures/swap";
export async function installPrimaryAssets(target: BrowserContext | Page) {
  await target.route("**/api/assets", async (route) => {
    const body = route.request().postDataJSON();
    const assets = [
      {
        address: "0x" + "44".repeat(20),
        symbol: "TOKEN",
        name: "Synthetic token",
        decimals: 18,
      },
      {
        address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
      },
    ].map((a) => ({
      ...a,
      chainId: body.chain,
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
    }));
    const query = String(body.query ?? "").toLowerCase();
    return route.fulfill({
      json: {
        assets,
        results: assets.filter((a) =>
          `${a.address} ${a.symbol} ${a.name}`.toLowerCase().includes(query),
        ),
        lookup: true,
      },
    });
  });
}
export async function installPrimarySwap(
  target: BrowserContext | Page,
  empty = false,
) {
  let quotes: SwapQuote[] = [];
  await target.route("**/api/swap", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "quote") {
      if (empty)
        return route.fulfill({
          status: 503,
          json: { error: "PROVIDER_UNAVAILABLE" },
        });
      const intent = parseIntent(body.intent),
        amount = 9n * 10n ** BigInt(intent.tokenOut.decimals);
      quotes = [
        swapQuote(intent, "UNISWAP", {
          amountOut: amount,
          minAmountOut: (amount * 995n) / 1000n,
          latencyMs: 90,
        }),
        swapQuote(intent, "PANCAKESWAP_SMART", {
          amountOut: (amount * 99n) / 100n,
          minAmountOut: (amount * 98n) / 100n,
          latencyMs: 5,
        }),
      ];
      return route.fulfill({
        contentType: "application/x-ndjson",
        body:
          [
            {
              type: "providers",
              providers: quotes.map((q) => ({
                mode: q.mode,
                status: "OK",
                latencyMs: q.latencyMs,
                quoteCount: 1,
              })),
            },
            ...quotes.map((quote) => ({ type: "quote", quote })),
            { type: "settled", elapsedMs: 100 },
          ]
            .map(wire)
            .join("\n") + "\n",
      });
    }
    const q = quotes.find((q) => q.id === body.id);
    if (body.action !== "review" || !q)
      return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
    return route.fulfill({
      contentType: "application/json",
      body: wire({
        state: "EXECUTION_CLOSED",
        verifiedForReview: true,
        quote: q,
        expiresAt: q.expiresAt,
        digest: "a".repeat(64),
        transactionDigest: "b".repeat(64),
        simulation: { source: "SYNTHETIC_TEST_ONLY", gasOrCompute: "42000" },
        decoded: { approval: { kind: "NONE", spender: null, amount: "0" } },
      }),
    });
  });
}
