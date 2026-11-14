// SYNTHETIC_TEST_ONLY. No wallet connection or transaction API is used.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { test, expect, readOnlyAddress } from "./fixtures";
import { fixtureCatalog } from "../fixtures/routing";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import { loadDictionary } from "../../src/i18n/messages";
import type { Locale } from "../../src/i18n/config";
import { wallet, usdc, swapQuote } from "../fixtures/swap";
import {
  parseIntent,
  wire,
  type SwapQuote,
  type QuoteEvent,
} from "../../src/swap/model";
const evidence =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ??
  "evidence/otherbridge-v1-15/ui-local";
async function setup(
  page: Page,
  options: {
    impact?: boolean;
    stale?: boolean;
    failure?: boolean;
    outage?: boolean;
    late?: boolean;
    locale?: string;
    theme?: string;
    amount?: string;
  } = {},
) {
  const locale = options.locale ?? "en",
    theme = options.theme ?? "dark",
    dictionary = await loadDictionary(locale as Locale);
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.addInitScript(
    ({ locale, theme, late }) => {
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
      if (late) {
        const original = window.fetch;
        window.fetch = async (...args) => {
          const response = await original(...args);
          if (
            String(args[0]) !== "/api/swap" ||
            !String(args[1]?.body).includes('"action":"quote"')
          )
            return response;
          const lines = (await response.text()).trim().split("\n");
          return new Response(
            new ReadableStream({
              start(controller) {
                const encoder = new TextEncoder();
                lines.forEach((line, n) =>
                  setTimeout(
                    () => {
                      controller.enqueue(encoder.encode(line + "\n"));
                      if (n === lines.length - 1) controller.close();
                    },
                    n < 3 ? 0 : 2500,
                  ),
                );
              },
            }),
            { headers: { "Content-Type": "application/x-ndjson" } },
          );
        };
      }
    },
    { locale, theme, late: options.late },
  );
  const catalog = fixtureCatalog();
  await page.route("**/api/routing", (route) => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: body.action === "catalog" ? catalog : [] });
  });
  const asset = {
    chainId: "1",
    address: usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    native: false,
    level: "CURATED",
    risk: [],
    sources: ["otherbridge-curated"],
    logo: null,
    logoUrl: null,
    routable: true,
    routeStatus: "ROUTABLE",
    evidence: {
      curated: true,
      trustWallet: true,
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
  const reviews: string[] = [],
    intents: unknown[] = [];
  let quotes: SwapQuote[] = [];
  await page.route("**/api/swap", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "review") {
      reviews.push(body.id);
      if (options.failure)
        return route.fulfill({
          status: 422,
          json: { error: "SIMULATION_FAILED" },
        });
      const q = quotes.find((q) => q.id === body.id)!;
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
    }
    intents.push(body.intent);
    const i = parseIntent(body.intent);
    quotes = [
      swapQuote(i, "UNISWAP", {
        amountOut: 30_000_000n,
        minAmountOut: 29_850_000n,
        priceImpactBps: options.impact ? 2000 : 20,
      }),
      swapQuote(i, "PANCAKESWAP_SMART", {
        amountOut: 31_000_000n,
        minAmountOut: 30_845_000n,
        priceImpactBps: options.impact ? 2000 : 25,
      }),
    ];
    if (options.stale)
      quotes.forEach((q) => {
        q.expiresAt = Date.now() + 1200;
      });
    if (options.late)
      quotes.push(
        swapQuote(i, "UNISWAP", {
          amountOut: 33_000_000n,
          minAmountOut: 32_835_000n,
        }),
      );
    const providers = quotes.slice(0, 2).map((q) => ({
      mode: q.mode,
      status: "OK" as const,
      latencyMs: 20,
      quoteCount: 1,
    }));
    const events: QuoteEvent[] = [
      { type: "providers", providers },
      ...quotes.map((quote) => ({ type: "quote" as const, quote })),
      ...(options.outage
        ? [
            {
              type: "health" as const,
              health: {
                mode: "UNISWAP" as const,
                status: "PROVIDER_TIMEOUT" as const,
                latencyMs: 8000,
                quoteCount: 0,
              },
            },
          ]
        : []),
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
  await (await readOnlyAddress(card, dictionary.v115.readAddress)).fill(wallet);
  await card.locator("#meta-amount").fill(options.amount ?? "0.01");
  return { card, reviews, intents };
}
test("V115 compares providers, preserves alternate choice, reviews with execution closed", async ({
  page,
}) => {
  const { card, reviews } = await setup(page);
  await card.getByRole("button", { name: "Compare providers" }).click();
  await expect(
    card.getByText("Best of 2 checked providers", { exact: false }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: /PancakeSwap · V3/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await card.getByRole("button", { name: /Uniswap · V3/ }).click();
  await card.getByRole("button", { name: "Review Swap" }).click();
  await expect(
    page
      .getByRole("dialog")
      .getByText("Execution closed — route verified for review"),
  ).toBeVisible();
  expect(reviews).toHaveLength(1);
  await expect(
    page
      .getByRole("dialog")
      .getByRole("button", { name: /sign|approve|confirm swap/i }),
  ).toHaveCount(0);
});
test("V115 late improvement never replaces an explicitly selected quote", async ({
  page,
}) => {
  const { card } = await setup(page, { late: true });
  await card.getByRole("button", { name: "Compare providers" }).click();
  await card.getByRole("button", { name: /PancakeSwap · V3/ }).click();
  await expect(card.getByText("A better quote is available")).toBeVisible();
  await expect(
    card.getByRole("button", { name: /PancakeSwap · V3/ }),
  ).toHaveAttribute("aria-pressed", "true");
});
test("V115 input mutation cancels reviewable routes", async ({ page }) => {
  const { card } = await setup(page);
  await card.getByRole("button", { name: "Compare providers" }).click();
  await expect(card.getByRole("button", { name: "Review Swap" })).toBeEnabled();
  await card.locator("#meta-amount").fill("0.02");
  await expect(card.getByRole("button", { name: "Review Swap" })).toHaveCount(
    0,
  );
});
test("V115 expired quote cannot be reviewed", async ({ page }) => {
  const { card } = await setup(page, { stale: true });
  await card.getByRole("button", { name: "Compare providers" }).click();
  await card.getByRole("button", { name: /PancakeSwap · V3/ }).click();
  await expect(
    card.getByText("Quote expired. Refresh before review."),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Review Swap" }),
  ).toBeDisabled();
});
test("V115 high impact blocks review", async ({ page }) => {
  const { card } = await setup(page, { impact: true });
  await card.getByRole("button", { name: "Compare providers" }).click();
  await expect(card.getByRole("alert")).toHaveText(
    "Price impact is above the review limit.",
  );
  await expect(card.getByRole("button", { name: "Review Swap" })).toHaveCount(
    0,
  );
});
test("V115 independent simulation failure is explicit", async ({ page }) => {
  const { card } = await setup(page, { failure: true });
  await card.getByRole("button", { name: "Compare providers" }).click();
  await card.getByRole("button", { name: "Review Swap" }).click();
  await expect(card.getByRole("alert")).toHaveText(
    "Independent simulation failed. Review is blocked.",
  );
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
test("V115 provider outage does not suppress a valid alternate", async ({
  page,
}) => {
  const { card } = await setup(page, { outage: true });
  await card.getByRole("button", { name: "Compare providers" }).click();
  await expect(
    card.getByRole("button", { name: /PancakeSwap · V3/ }),
  ).toBeVisible();
  await card.getByText("Provider availability", { exact: true }).click();
  await expect(card.getByText(en.v115.PROVIDER_TIMEOUT)).toBeVisible();
});
for (const [locale, amount] of [
  ["tr", "0,01"],
  ["ar", "٠٫٠١"],
] as const)
  test(`V1151 localized amount ${locale} binds exact integer input`, async ({
    page,
  }) => {
    const dictionary = await loadDictionary(locale);
    const { card, intents } = await setup(page, { locale, amount });
    await card
      .getByRole("button", { name: dictionary.v115.compare, exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: dictionary.v115.review, exact: true }),
    ).toBeEnabled();
    expect(intents[0]).toMatchObject({
      chain: "1",
      amount: "10000000000000000",
    });
  });
for (const variant of [360, 390, 768, 1440].flatMap((width) =>
  ["light", "dark"].flatMap((theme) =>
    ["en", "ar", "fa", "he", "ur"].map((locale) => ({ width, theme, locale })),
  ),
))
  test(`V115 layout ${variant.width} ${variant.theme} ${variant.locale}: axe and overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: variant.width, height: 1000 });
    const dictionary = await loadDictionary(variant.locale as Locale);
    const { card } = await setup(page, variant);
    await card
      .getByRole("button", {
        name: dictionary.v115.compare,
      })
      .click();
    await expect(
      card.getByRole("button", { name: /PancakeSwap · V3/ }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include('[data-testid="swap-intelligence"]')
          .analyze()
      ).violations,
    ).toEqual([]);
    if (["ar", "fa", "he", "ur"].includes(variant.locale))
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await mkdir(`${evidence}/screenshots`, { recursive: true });
    await page.screenshot({
      path: `${evidence}/screenshots/v115-${variant.width}-${variant.theme}-${variant.locale}.png`,
      fullPage: true,
    });
  });
