// VEINED Guardian: the console (/guardian) and the panels inside Swap. SYNTHETIC_TEST_ONLY: the Agent Gate run and the
// Inspect reviews go through the real /api/guardian route (on-chain lookups off for this offline run); the NEAR
// Intents upstream is replaced by a recorded-shape fixture. Nothing is signed, approved, deposited or broadcast.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, readOnlyAddress } from "./fixtures";
import { fixtureCatalog } from "../fixtures/routing";
import { wallet, usdc, swapQuote } from "../fixtures/swap";
import { parseIntent, wire, type QuoteEvent } from "../../src/swap/model";
import { RECORDED_QUOTE } from "../../src/guardian/scenarios";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
async function base(page: Page) {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "en", url: ORIGIN }]);
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("otherbridge.language", "en");
  });
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const TOKENS = [
  {
    assetId: "nep141:wrap.near",
    decimals: 24,
    blockchain: "near",
    symbol: "wNEAR",
    contractAddress: "wrap.near",
  },
  {
    assetId:
      "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
    decimals: 6,
    blockchain: "near",
    symbol: "USDC",
    contractAddress:
      "17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1",
  },
  {
    assetId: "nep141:base.omft.near",
    decimals: 18,
    blockchain: "base",
    symbol: "ETH",
  },
];

test("GD1 Guardian is a destination: rail link, console, Agent Gate blocks the compromised agent", async ({
  page,
}) => {
  await base(page);
  await page.goto("/guardian");
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  await expect(nav.locator("a[href='/guardian']")).toHaveAttribute(
    "aria-current",
    "page",
  );
  const consoleView = page.getByTestId("guardian-console");
  await expect(consoleView.getByRole("heading", { level: 1 })).toHaveText(
    "Guardian",
  );
  // gc1: Agent Gate is one of the advanced demonstrations, one click below the assistant.
  await page.getByTestId("guardian-advanced").locator("summary").click();
  const agent = page.getByTestId("guardian-agent");
  await agent
    .getByRole("button", { name: "Replay a compromised agent" })
    .click();
  await expect(page.getByTestId("guardian-agent-tally")).toHaveText(
    "3 blocked · 1 sent to the owner · 3 allowed",
  );
  await expect(agent.locator(".guardian-step")).toHaveCount(7);
  expect(
    await agent
      .locator(".guardian-step")
      .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-decision"))),
  ).toEqual(["ALLOW", "ALLOW", "BLOCK", "BLOCK", "BLOCK", "ALLOW", "ESCALATE"]);
  // The injected transfer is explained by the policy, not by the agent's own words.
  const injected = agent.locator(".guardian-step").nth(2);
  await expect(injected).toContainText("claim your USDC reward");
  await expect(injected.locator(".guardian-step-why")).toContainText(
    "is not on the agent's allowlist",
  );
  await injected.getByText("Full review").click();
  await expect(
    page.getByTestId("guardian-agent-injected-transfer"),
  ).toHaveAttribute("data-level", "BLOCK");
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  expect(await overflow(page)).toBe(false);
});

test("GD2 Inspect: every known attack gets its verdict and the Chain Signatures gate follows it", async ({
  page,
}) => {
  await base(page);
  await page.goto("/guardian");
  // gc1: Inspect is the second Guardian mode (Chat is the first).
  await page.getByRole("tab", { name: "Inspect" }).click();
  const inspect = page.getByTestId("guardian-inspect");
  const expected: [string, string][] = [
    ["Fake USDC", "BLOCK"],
    ["Poisoned address", "BLOCK"],
    ["Full-access key", "BLOCK"],
    ["Look-alike token", "BLOCK"],
    ["Account deletion", "BLOCK"],
    ["Signed intent", "BLOCK"],
    ["Meta transaction", "HOLD"],
    ["Bridged USDC", "CAUTION"],
    ["Safe wrap", "CLEAR"],
  ];
  for (const [name, level] of expected) {
    await inspect.getByRole("button", { name, exact: true }).click();
    await expect(
      page.getByTestId("guardian-inspect-result"),
      name,
    ).toHaveAttribute("data-level", level);
  }
  // Safe wrap: a signing request may be prepared for the MPC signer, never submitted.
  await expect(page.getByTestId("guardian-signer")).toContainText(
    "request prepared for v1.signer-prod.testnet, not submitted.",
  );
  await inspect
    .getByRole("button", { name: "Full-access key", exact: true })
    .click();
  const panel = page.getByTestId("guardian-inspect-result");
  await expect(panel).toHaveAttribute("data-level", "BLOCK");
  await expect(panel.locator(".guardian-level")).toHaveText("Blocked");
  await expect(panel).toContainText("Grants a full-access key to alice.near");
  await expect(panel.locator(".guardian-steps li").first()).toHaveText(
    "Do not sign or send this.",
  );
  await expect(page.getByTestId("guardian-signer")).toContainText(
    "refused, no signing request is prepared.",
  );
  // Pasted input is reviewed by the same API; unreadable input is refused with a message.
  const box = inspect.getByLabel("Address, account or JSON");
  await box.fill("usdt.tether-tokens.near");
  await inspect.getByRole("button", { name: "Review", exact: true }).click();
  await expect(panel).toContainText(
    "usdt.tether-tokens.near imitates USDt (native on NEAR)",
  );
  await box.fill("{ not json");
  await inspect.getByRole("button", { name: "Review", exact: true }).click();
  await expect(inspect.locator(".notice.tone-danger")).toHaveText(
    "Guardian could not read this. Paste an address, a NEAR account or valid JSON.",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await inspect
    .getByRole("button", { name: "Signed intent", exact: true })
    .click();
  await expect(page.getByTestId("guardian-inspect-result")).toHaveAttribute(
    "data-level",
    "BLOCK",
  );
  expect(await overflow(page)).toBe(false);
});

test("GD3 Route toward NEAR: a real signed dry quote is verified by the server; any alteration is blocked", async ({
  page,
}) => {
  await base(page);
  const quoteBodies: Record<string, unknown>[] = [];
  await page.route("**/api/guardian", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === "intents-tokens")
      return route.fulfill({ json: { tokens: TOKENS } });
    if (body?.action === "intents-quote") {
      // Offline stand-in for the 1Click upstream: the recorded REAL signed quote is reviewed by the real server route
      // (intents-verify), so the signature check, request echo and freshness rules all run for real.
      quoteBodies.push(body.request);
      const reviewed = await route.fetch({
        postData: JSON.stringify({
          action: "intents-verify",
          request: RECORDED_QUOTE.request,
          response: RECORDED_QUOTE.response,
          sender: RECORDED_QUOTE.request.refundTo,
        }),
      });
      const json = await reviewed.json();
      return route.fulfill({
        json: { ...json, signed: RECORDED_QUOTE.response },
      });
    }
    return route.continue();
  });
  await page.goto("/guardian");
  // gc1: the NEAR route demo reads the live asset list only once its section is opened (never on page load).
  await page.getByTestId("guardian-advanced").locator("summary").click();
  const intents = page.getByTestId("guardian-intents");
  await expect(intents.getByLabel("From")).toHaveValue("nep141:base.omft.near");
  await intents.getByLabel("NEAR recipient").fill("alice.near");
  await intents.getByRole("button", { name: "Get a dry quote" }).click();
  const signature = page.getByTestId("guardian-intents-signature");
  await expect(signature).toHaveAttribute("data-signature", "VALID");
  await expect(signature).toContainText("verified with the 1Click manager key");
  await expect(page.getByTestId("guardian-intents-out")).toContainText(
    /You would receive about [\d.]+ wNEAR/,
  );
  const result = page.getByTestId("guardian-intents-result");
  await expect(result).toContainText("Signed by NEAR Intents (1Click)");
  // The recorded quote is genuine but older than two minutes: honest HOLD (refresh before use), never CLEAR.
  await expect(result).toHaveAttribute("data-level", "HOLD");
  expect(quoteBodies).toHaveLength(1);
  expect(quoteBodies[0]).toMatchObject({
    dry: true,
    originAsset: "nep141:base.omft.near",
    destinationAsset: "nep141:wrap.near",
    amount: "10000000000000000",
    recipient: "alice.near",
    refundType: "ORIGIN_CHAIN",
  });
  await intents.getByRole("button", { name: "Alter the amount" }).click();
  await expect(signature).toHaveAttribute("data-source", "tampered");
  await expect(signature).toHaveAttribute("data-signature", "INVALID");
  await expect(result).toHaveAttribute("data-level", "BLOCK");
  await expect(result).toContainText("The quote signature does not verify");
  await intents.getByRole("button", { name: "Alter the asset" }).click();
  await expect(result).toHaveAttribute("data-level", "BLOCK");
  await expect(result).toContainText(
    "The signed quote does not match your request (destinationAsset)",
  );
  await intents
    .getByRole("button", { name: "Review a recorded real quote (offline)" })
    .click();
  await expect(signature).toHaveAttribute("data-source", "recorded");
  await expect(signature).toHaveAttribute("data-signature", "VALID");
  await expect(result).toHaveAttribute("data-level", "HOLD");
});

test("GD5 one brand: the approved octopus is the app symbol, the Guardian mark and the icon, in both themes and on mobile", async ({
  page,
  request,
}) => {
  await base(page);
  await page.goto("/guardian");
  const logo = page.locator(
    "header a[href='/'] [data-brand-candidate='octopus-v1']",
  );
  await expect(logo.locator(".veined-logo-symbol")).toBeVisible();
  const loaded = async (selector: string) =>
    page
      .locator(selector)
      .first()
      .evaluate(
        (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
      );
  expect(await loaded("header .veined-logo-symbol")).toBe(true);
  expect(await loaded(".guardian-title-mark img")).toBe(true);
  await expect(page.locator(".guardian-title-mark img")).toHaveAttribute(
    "src",
    /brand-octopus\/tile-128\.png$/,
  );
  await page.locator(".theme-toggle").click();
  await expect(logo.locator(".veined-logo-light")).toBeVisible();
  await expect(logo.locator(".veined-logo-symbol")).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/guardian");
  await expect(page.locator("header .veined-mark img")).toHaveAttribute(
    "src",
    /brand-octopus\/tile-128\.png$/,
  );
  expect(await overflow(page)).toBe(false);
  const icon = await (await request.get("/icon.svg")).text();
  expect(icon).toContain("owner-approved artwork");
  expect((await request.get("/favicon.ico")).ok()).toBe(true);
  const manifest = await (await request.get("/manifest.webmanifest")).json();
  expect(manifest.icons.map((i: { src: string }) => i.src)).toContain(
    "/assets/veined/brand-octopus/maskable-512.png",
  );
  for (const i of manifest.icons)
    expect((await request.get(i.src)).ok(), i.src).toBe(true);
});

async function swapSetup(
  page: Page,
  receive: { level: string; risk: string[] },
) {
  await base(page);
  const asset = {
    chainId: "1",
    address: usdc,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    native: false,
    ...receive,
    sources: ["SYNTHETIC_TEST_ONLY"],
    logo: null,
    logoUrl: null,
    routable: true,
    routeStatus: "ROUTABLE",
    evidence: {
      curated: receive.level === "CURATED",
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
  await page.route("**/api/swap", async (route) => {
    const body = route.request().postDataJSON();
    if (body.action === "review")
      return route.fulfill({
        status: 422,
        json: { error: "SIMULATION_FAILED" },
      });
    const i = parseIntent(body.intent);
    const quotes = [
      swapQuote(i, "UNISWAP", {
        amountOut: 30_000_000n,
        minAmountOut: 29_850_000n,
        priceImpactBps: 20,
      }),
      swapQuote(i, "PANCAKESWAP_SMART", {
        amountOut: 31_000_000n,
        minAmountOut: 30_845_000n,
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
  return card;
}
test("GD4 Swap: Guardian reviews the selected route; a same-symbol impersonation blocks the review", async ({
  page,
}) => {
  const card = await swapSetup(page, { level: "CURATED", risk: [] });
  const panel = card.getByTestId("guardian-swap");
  await expect(panel).toHaveAttribute("data-level", "CLEAR");
  await expect(card.getByRole("button", { name: "Review Swap" })).toBeEnabled();
  await page.unrouteAll({ behavior: "ignoreErrors" });
  const blocked = await swapSetup(page, {
    level: "MARKET_LISTED",
    risk: ["SYMBOL_IMPERSONATION"],
  });
  const danger = blocked.getByTestId("guardian-swap");
  await expect(danger).toHaveAttribute("data-level", "BLOCK");
  await expect(danger).toContainText("USDC is not the USDC you know");
  await expect(blocked.locator(".guardian-block-note")).toHaveText(
    "Guardian blocked this route. Choose another token or route.",
  );
  await expect(
    blocked.getByRole("button", { name: "Review Swap" }),
  ).toBeDisabled();
});
