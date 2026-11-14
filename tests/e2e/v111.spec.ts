// V1.11 product completion: landing + docs (bundle boundary, no wallet/portfolio/routing traffic), standardized
// dialogs, network environments, the ONEbridge asset picker, the asset registry token picker (import flow),
// From/Recipient parties and the automatic read-only portfolio scan. SYNTHETIC_TEST_ONLY fixtures; no wallet writes.
import type { Page, Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { test, expect, privyModal } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
import { fixtureCatalog, fixtureQuote, sender } from "../fixtures/routing";
import { coverage, holding } from "../fixtures/portfolio";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeActive } from "../../src/catalog/model";
import { summarize } from "../../src/data/core/coverage";
import type { Holding, PortfolioResult } from "../../src/portfolio/model";

const base =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-11";
const shots = `${base}/screenshots`;
const SIGNING = /sign|sendRaw|eth_sendTransaction|permit/i;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const NEW_TOKEN = "0x" + "e5".repeat(20);
const SPOOF = "0x" + "e6".repeat(20);
const OTHER = "0x4444444444444444444444444444444444444444";

function token(
  chainId: string,
  address: string,
  symbol: string,
  balance: string,
  usd: number | null,
  extra: Partial<Holding> = {},
) {
  return holding(chainId, balance, usd, {
    address,
    symbol,
    name: symbol,
    decimals: 18,
    native: false,
    routable: true,
    metadataVerified: true,
    discovery: "curated",
    ...extra,
  });
}
// A wallet with a curated-scan network, a full index, an unpriced token and a testnet balance (never valued).
function walletPortfolio(owner = sender): PortfolioResult {
  const list = [
    coverage("1", "COMPLETE", {
      tier: "CURATED_BALANCE_SCAN",
      tokens: "CURATED" as never,
    }),
    coverage("8453", "COMPLETE", { tier: "FULL_INDEXED", tokens: "INDEXED" }),
    coverage("56", "NATIVE_ONLY"),
    coverage("137", "PENDING"),
    coverage("11155111", "COMPLETE"),
  ];
  const holdings = [
    holding("1", "1000000000000000000", 2800),
    token("1", USDC, "USDC", "1500000000000000000000", 1500),
    token("1", "0x" + "77".repeat(20), "NOPRICE", "42000000000000000000", null),
    holding("8453", "500000000000000000", 1400),
    holding("56", "200000000000000000", 120),
    holding("11155111", "9000000000000000000", 25200),
  ];
  return {
    state: "PARTIAL",
    holdings: owner === sender ? holdings : holdings.slice(0, 1),
    coverage: list,
    coverageSummary: summarize(list),
    continuation: null,
    dataPlane: "AVAILABLE",
    source: "otherbridge-data-plane",
    observedAt: Date.now(),
    revision: `synthetic-v111-${owner.slice(2, 6)}`,
    synthetic: true,
  };
}
type AssetsMock = (body: {
  action: string;
  chain: string;
  query?: string;
  address?: string;
}) => unknown;
async function setup(
  page: Page,
  options: { locale?: string; assets?: AssetsMock; chainId?: string } = {},
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
    ({ locale }) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", "dark");
      const csp: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = csp;
      document.addEventListener("securitypolicyviolation", (e) =>
        csp.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    },
    { locale },
  );
  await page.addInitScript(installWalletDoubles, {
    wallets: ["metamask", "rabby"] as (keyof typeof WALLET_DOUBLES)[],
    account: sender,
    chainId: options.chainId ?? "0x1",
    doubles: WALLET_DOUBLES,
  });
  const catalog = fixtureCatalog();
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      json: normalizeActive(
        catalog.networks
          .filter((n) => n.mainnet)
          .map((n, i) => ({
            name: n.name,
            chainId: n.id,
            tvl: 54e9 / (i + 1),
          })),
        catalog,
        Date.now(),
        "SYNTHETIC_TEST_ONLY",
      ),
    }),
  );
  const portfolio: { identity: { evm?: string }; priority?: string[] }[] = [];
  await page.route("**/api/portfolio", (route) => {
    const body = route.request().postDataJSON();
    portfolio.push(body);
    return route.fulfill({
      json: walletPortfolio(String(body.identity?.evm ?? "").toLowerCase()),
    });
  });
  const assets: { action: string }[] = [];
  await page.route("**/api/assets", async (route) => {
    const body = route.request().postDataJSON();
    assets.push(body);
    const mocked = options.assets?.(body);
    if (mocked === undefined) return route.continue();
    return route.fulfill({ json: mocked });
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
            address: OTHER,
            symbol: "TOKEN",
            name: "Synthetic buy token",
            decimals: 18,
          },
          {
            chainId: body.chain,
            address: USDC,
            symbol: "USDC",
            name: "USD Coin",
            decimals: 6,
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
      const raw = fixtureQuote(body.input);
      if (body.input.mode === "swap") {
        const tool = catalog.tools.find((t) => t.kind === "exchange")!;
        raw.tool = tool.id;
        raw.toolDetails = { ...raw.toolDetails, key: tool.id, name: tool.name };
        raw.type = "swap";
        raw.estimate.feeCosts[0].name = "Exchange fee";
        raw.action.toToken = {
          ...raw.action.toToken,
          address: body.input.destinationAsset,
          symbol: "USDC",
          name: "USD Coin",
          decimals: 6,
        };
      }
      if (body.input.mode !== "swap") {
        raw.estimate.toAmount = "9000000000000000";
        raw.estimate.toAmountMin = "8955000000000000";
      }
      const q = normalizeQuote(raw, body.input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return route.fulfill({
        json: [{ ...q, id: "best-value", outputUsd: "31", duration: 90 }],
      });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
  return { portfolio, assets };
}
async function snap(page: Page, name: string, full = true) {
  await mkdir(shots, { recursive: true });
  if (full) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: `${shots}/${name}.png`,
    fullPage: full && !(await page.locator("dialog[open]").count()),
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function noWritesOrCsp(page: Page) {
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __walletCalls?: { method: string }[] })
        .__walletCalls ?? [],
  );
  expect(calls.filter((c) => SIGNING.test(c.method))).toEqual([]);
  expect(
    (
      await page.evaluate(
        () => (window as unknown as { __csp: string[] }).__csp,
      )
    ).filter((v) => !v.startsWith("frame-src https://auth.privy.io")),
  ).toEqual([]);
}
async function axe(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page)
    .getByRole("button", { name: /^MetaMask$/ })
    .first()
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
}
test.beforeAll(async () => mkdir(shots, { recursive: true }));

// ---------------------------------------------------------------- landing + docs
const FINANCIAL =
  /\/api\/(portfolio|routing|bridge|assets|catalog)|auth\.privy\.io|walletconnect|reown|g7|privy-io/i;
for (const width of [1440, 390])
  test(`V111 landing ${width}: CTA, docs link, no fabricated socials, no wallet/portfolio/routing traffic`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const seen: string[] = [];
    page.on("request", (r: Request) => seen.push(r.url()));
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const launch = page
      .locator(".mk-header")
      .getByRole("link", { name: "Launch App" });
    await expect(launch).toHaveAttribute("href", "/app");
    if (width > 560)
      await expect(
        page
          .locator(".mk-header")
          .getByRole("link", { name: "Docs", exact: true })
          .first(),
      ).toHaveAttribute("href", "/docs");
    await expect(
      page.locator(".mk-hero").getByRole("link", { name: "Read the docs" }),
    ).toHaveAttribute("href", "/docs");
    // Social URLs are configuration only: unset ones are hidden, never "#".
    await expect(page.locator('a[href="#"]')).toHaveCount(0);
    for (const href of await page
      .locator("a[href]")
      .evaluateAll((a) => a.map((x) => x.getAttribute("href") ?? "")))
      expect(/^(\/|https:\/\/|#[a-z])/.test(href)).toBe(true);
    // No absolute safety/audit/coverage claims (the FAQ may ask the question; the answer makes no such claim).
    const text = (await page.locator("body").innerText()).toLowerCase();
    expect(text).not.toMatch(
      /100% safe|\btrustless\b|\b(is|been|fully) audited\b|all chains guaranteed|all tokens guaranteed|risk-free/,
    );
    await page.waitForLoadState("networkidle");
    expect(seen.filter((u) => FINANCIAL.test(u))).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { __walletCalls?: unknown[] }).__walletCalls ??
          [],
      ),
    ).toEqual([]);
    await snap(page, `v111-landing-${width}`);
    if (width === 1440) await axe(page);
    await noWritesOrCsp(page);
    // The CTA opens the app.
    await launch.click();
    await expect(page).toHaveURL(/\/app$/);
  });

for (const width of [1440, 390])
  test(`V111 docs ${width}: navigation, search, safe rendering, 404`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    const seen: string[] = [];
    page.on("request", (r: Request) => seen.push(r.url()));
    await page.goto("/docs");
    await expect(page.locator(".dk-article h1")).toBeVisible();
    // Both responsive menus retain every documentation destination.
    await expect(page.locator(".dk-desktop-nav nav a")).toHaveCount(14);
    if (width === 390) {
      await page.locator(".dk-mobile-nav summary").click();
      await expect(page.locator(".dk-mobile-nav nav a")).toHaveCount(14);
      await page.locator(".dk-mobile-nav summary").click();
    }
    await expect(page.locator(".dk-article")).toHaveAttribute("lang", "en");
    // No stale "G5 BLOCKED" wording anywhere in the public docs.
    expect(await page.locator(".dk-article").innerText()).not.toMatch(
      /G5\s+BLOCKED/,
    );
    await page.locator("#docs-search").fill("fee");
    await expect(page.locator("ul.dk-results a").first()).toBeVisible();
    await snap(page, `v111-docs-search-${width}`);
    await page.locator("ul.dk-results a").first().click();
    await expect(page).toHaveURL(/\/docs\/(fees|[a-z]+)(#.*)?$/);
    await page.waitForLoadState("networkidle");
    // Search input is plain text: markup is never interpreted.
    await page
      .locator("#docs-search")
      .fill('<img src=x onerror="window.__xss=1">');
    await expect(page.locator(".dk-results")).toBeVisible();
    expect(
      await page.evaluate(
        () => (window as unknown as { __xss?: number }).__xss,
      ),
    ).toBeUndefined();
    expect(await page.locator(".dk img[src='x']").count()).toBe(0);
    await page.goto("/docs/safety");
    await expect(page.locator(".dk-article h1")).toBeVisible();
    await snap(page, `v111-docs-safety-${width}`);
    if (width === 1440) await axe(page);
    expect(seen.filter((u) => FINANCIAL.test(u))).toEqual([]);
    expect((await page.goto("/docs/not-a-page"))?.status()).toBe(404);
  });

test("V111 docs follow the canonical documentation languages (TR native, other locales English with a note)", async ({
  page,
}) => {
  await setup(page, { locale: "tr" });
  await page.goto("/docs");
  await expect(page.locator(".dk-article")).toHaveAttribute("lang", "tr");
  await expect(page.locator(".dk-lang-note")).toHaveCount(0);
  await setup(page, { locale: "de" });
  await page
    .context()
    .addCookies([
      { name: "otherbridge.locale", value: "de", url: "http://127.0.0.1:3100" },
    ]);
  await page.goto("/docs/fees");
  await expect(page.locator(".dk-article")).toHaveAttribute("lang", "en");
  await expect(page.locator(".dk-lang-note")).toBeVisible();
});

// ---------------------------------------------------------------- dialogs + environments
test("V111 dialogs: X, Escape and backdrop close; inside click stays; focus is trapped and returned", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  const trigger = page.getByRole("button", { name: "Select source network" });
  const picker = page.locator("dialog.network-picker[open]");
  // Escape
  await trigger.click();
  await expect(picker).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // X
  await trigger.click();
  await picker.getByRole("button", { name: "Close", exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  // Inside click keeps it open; a backdrop press + release closes it.
  await trigger.click();
  await picker.locator("#picker-title").click();
  await expect(picker).toBeVisible();
  // Focus trap: Tab cycles inside the dialog.
  for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest("dialog[open]"),
    ),
  ).toBe(true);
  for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest("dialog[open]"),
    ),
  ).toBe(true);
  await page.mouse.click(4, 4);
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await noWritesOrCsp(page);
});

test("V111 network environments: Mainnets default, Testnets tab, environment-scoped search, no mixed route", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  await page.getByRole("button", { name: "Select source network" }).click();
  const picker = page.locator("dialog.network-picker[open]");
  await expect(picker.locator('[data-environment="mainnet"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(
    picker.locator('[data-environment="testnet"] .count'),
  ).toHaveText("5");
  // A testnet name does not match while browsing mainnets…
  await page.locator("#network-search").fill("Sepolia");
  await expect(
    picker.locator('.picker-option[data-chain="84532"]'),
  ).toHaveCount(0);
  // …unless "Search all networks" is on.
  await picker.getByText("Search all networks").click();
  await expect(
    picker.locator('.picker-option[data-chain="84532"]'),
  ).toBeVisible();
  await page.locator("#network-search").fill("");
  await picker.locator('[data-environment="testnet"]').click();
  await expect(picker.getByRole("note")).toContainText(
    "Testnet assets have no real value",
  );
  await snap(page, "v111-bridge-testnet-selector-1440", false);
  await axe(page);
  await page.keyboard.press("Escape");
  // Mainnet source + testnet destination is refused before any quote.
  await page.getByRole("button", { name: "Select source network" }).click();
  await page.locator("#network-search").fill("Ethereum");
  await page.locator('.network-picker [data-chain="1"]').click();
  await page
    .getByRole("button", { name: "Select destination network" })
    .click();
  await page
    .locator('dialog.network-picker[open] [data-environment="testnet"]')
    .click();
  await page.locator('.network-picker [data-chain="84532"]').click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Mainnet and testnet networks cannot be combined" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Read route", exact: true }),
  ).toBeDisabled();
  await noWritesOrCsp(page);
});

// ---------------------------------------------------------------- bridge assets + route UI
test("V111 ONEbridge asset picker: native first, verified vs registered-only pairs, unverified pair cannot be quoted", async ({
  page,
}) => {
  // Local test chain (31337), so the only reason a quote can be refused below is the unverified pair.
  await setup(page, { chainId: "0x7a69" });
  await page.goto("/bridge");
  await connect(page);
  await page.getByLabel("Amount to send", { exact: true }).fill("1");
  const quote = page.getByRole("button", { name: "Calculate fees" });
  await expect(quote).toBeEnabled();
  const trigger = page.getByRole("button", { name: /^Select asset/ });
  await expect(trigger).toContainText("ONE");
  await trigger.click();
  const picker = page.locator("dialog.token-picker[open]");
  const options = picker.getByRole("option");
  await expect(options).toHaveCount(2);
  await expect(options.first()).toContainText("ONE → CROSS");
  await expect(options.first()).toContainText("Verified route");
  await expect(options.nth(1)).toContainText("USDTx → USDT");
  await expect(options.nth(1)).toContainText("No verified route");
  await snap(page, "v111-bridge-asset-picker-1440", false);
  await axe(page);
  await options.nth(1).click();
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const notice = page
    .locator(".notice.tone-warn")
    .filter({ hasText: "No verified route" });
  await expect(notice).toContainText("USDTx → USDT is registered on ONEbridge");
  await expect(quote).toBeDisabled();
  await trigger.click();
  await picker.getByRole("option").first().click();
  await expect(notice).toHaveCount(0);
  await expect(quote).toBeEnabled();
  await noWritesOrCsp(page);
});

test("V111 bridge route UI: one health state, at most three facts, details on demand, no read-only labels", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  const health = page.locator(".health-card");
  await expect(health.locator("[data-route-state]")).toHaveCount(1);
  expect(await health.locator(".route-facts li").count()).toBeLessThanOrEqual(
    3,
  );
  await expect(page.locator("main")).not.toContainText(/\bRead only\b/);
  await health.locator("details.disclosure > summary").first().click();
  await expect(health.locator("details.disclosure[open]")).toBeVisible();
  await snap(page, "v111-bridge-route-info-1440");
  await noWritesOrCsp(page);
});

// ---------------------------------------------------------------- swap: registry picker + import + parties
const preview = (address: string, opts: { blocked?: boolean } = {}) => ({
  asset: {
    chainId: "1",
    address,
    native: false,
    symbol: opts.blocked ? "USDC" : "NEW",
    name: opts.blocked ? "USD Coin" : "New Token",
    decimals: 9,
    level: opts.blocked ? "BLOCKED" : "IMPORTED_UNVERIFIED",
    sources: ["onchain"],
    logo: null,
    risk: opts.blocked
      ? ["SYMBOL_IMPERSONATION", "BIDI_OR_INVISIBLE"]
      : ["NO_MARKET_EVIDENCE"],
    logoUrl: null,
    evidence: {
      curated: false,
      trustWallet: false,
      marketListed: null,
      dex: null,
      onebridge: null,
    },
    routeStatus: "NO_VERIFIED_ROUTE",
  },
  steps: [
    { step: "address", ok: true, detail: "EVM_ADDRESS" },
    { step: "code", ok: true, detail: "CONTRACT_CODE_PRESENT" },
    { step: "metadata", ok: true, detail: "ERC20_METADATA_READ" },
    { step: "curated", ok: false, detail: "NOT_CURATED" },
    { step: "market", ok: false, detail: "NO_EXACT_LISTING" },
    { step: "dex", ok: false, detail: "NO_DEX_PAIR" },
    { step: "logo", ok: false, detail: "NO_LOGO" },
    { step: "route", ok: false, detail: "NO_VERIFIED_ROUTE" },
  ],
  warnings: opts.blocked
    ? ["SYMBOL_IMPERSONATION", "BIDI_OR_INVISIBLE"]
    : ["NO_MARKET_EVIDENCE"],
  importable: !opts.blocked,
});
const assetsMock: AssetsMock = (body) => {
  if (body.action === "search" && /^0x[0-9a-f]{40}$/i.test(body.query ?? ""))
    return { results: [], lookup: true };
  if (body.action === "preview")
    return preview(body.address!.toLowerCase(), {
      blocked: body.address!.toLowerCase() === SPOOF,
    });
  return undefined;
};
for (const width of [1440, 390])
  test(`V111 swap ${width}: ranked registry picker, exact-address import stays unverified during quote discovery`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    const env = await setup(page, { assets: assetsMock });
    await page.goto("/swap");
    await expect(page.locator("#meta-amount")).toBeVisible();
    await snap(page, `v111-swap-default-${width}`);
    await page.getByRole("button", { name: /^Destination token/ }).click();
    const picker = page.locator("dialog.token-picker[open]");
    await expect(picker).toBeVisible();
    // Native first in "Native and curated"; selection starts quote discovery without asserting a verified route.
    await expect(picker.locator("#token-group-1")).toHaveText(
      "Native and curated",
    );
    await expect(picker.locator(".token-option").first()).toContainText("ETH");
    await expect(picker.locator(`[data-token-option="${USDC}"]`)).toBeVisible();
    await expect(
      picker.locator(`[data-token-option="${USDC}"] .level-badge`).first(),
    ).toHaveText(/Canonical|Curated/);
    await snap(page, `v111-swap-curated-picker-${width}`, false);
    if (width === 1440) await axe(page);
    // Unknown exact address → explicit lookup → preview → import (device only, unverified).
    await page.locator("#token-search").fill(NEW_TOKEN);
    await picker.getByRole("button", { name: "Look up this token" }).click();
    const card = picker.locator(".import-preview");
    await expect(card.locator(".import-steps li")).toHaveCount(8);
    await expect(card).toContainText("Imported · unverified");
    await expect(card).toContainText(
      "No exact market listing and no DEX pair were found.",
    );
    await snap(page, `v111-swap-import-warning-${width}`, false);
    await card.getByRole("button", { name: "Import token" }).click();
    const row = picker.locator(`[data-token-option="${NEW_TOKEN}"]`);
    await expect(row).toContainText("Imported · unverified");
    await expect(row).toHaveAttribute("data-level", "IMPORTED_UNVERIFIED");
    await expect(row).toHaveAttribute("aria-disabled", "false");
    await expect(
      page.getByRole("button", { name: "Review Swap", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () =>
          JSON.parse(
            localStorage.getItem("otherbridge:imported-tokens:1") ?? "[]",
          ).length,
      ),
    ).toBe(1);
    // An impersonating token cannot be imported.
    await page.locator("#token-search").fill(SPOOF);
    await picker.getByRole("button", { name: "Look up this token" }).click();
    await expect(picker.locator(".import-preview")).toContainText(
      "Same symbol as a curated token",
    );
    await expect(
      picker.getByRole("button", { name: "Import token" }),
    ).toBeDisabled();
    await page.keyboard.press("Escape");
    expect(env.assets.filter((a) => a.action === "preview")).toHaveLength(2);
    await noWritesOrCsp(page);
  });

test("V111 swap parties: connected wallet, explicit recipient and bound quote", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/swap");
  await connect(page);
  await expect(page.locator(".trade-parties")).toContainText(
    "Connected wallet",
  );
  await expect(page.locator(".trade-parties")).toContainText("Same wallet");
  await expect(
    page.getByLabel("Wallet address for read-only quotes"),
  ).toHaveCount(0);
  await page.locator(".trade-settings-disclosure > summary").click();
  await page.getByLabel("Send to another address").check();
  await page.getByLabel("Recipient", { exact: true }).fill(OTHER);
  await expect(page.locator(".trade-settings-disclosure")).toContainText(
    "Funds will go to a different address",
  );
  await page.getByLabel("Send to another address").uncheck();
  await expect(page.getByLabel("Recipient", { exact: true })).toHaveCount(0);
  await page.locator(".trade-settings-disclosure > summary").click();
  await page.getByRole("button", { name: /^Destination token/ }).click();
  // Symbol search finds curated tokens; an unlisted route token is reachable only by its exact address.
  await page.locator("#token-search").fill("tok");
  await expect(page.locator(`[data-token-option="${OTHER}"]`)).toHaveCount(0);
  await page.locator("#token-search").fill("usdc");
  await page.locator(`[data-token-option="${USDC}"]`).click();
  await expect(
    page.getByRole("button", { name: /^Destination token/ }),
  ).toContainText("USDC");
  await page.locator("#meta-amount").fill("0.01");
  await page
    .getByRole("button", { name: "Compare providers", exact: true })
    .click();

  await expect(page.locator("#meta-receive")).toContainText("9");
  await page.getByText("Route details", { exact: true }).click();
  await expect(page.locator("details.disclosure[open]")).toContainText(
    "Minimum received",
  );
  await expect(page.locator("details.disclosure[open]")).toContainText(
    "Not run",
  );
  await snap(page, "v111-swap-quote-1440");
  await noWritesOrCsp(page);
});

// ---------------------------------------------------------------- portfolio
test("V111 portfolio: connected wallet scans automatically (read-only), account change rescans, watch mode is explicit", async ({
  page,
}) => {
  const env = await setup(page);
  await page.goto("/portfolio");
  await expect(page.locator('[data-scan-mode="watch"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await connect(page);
  await expect(page.locator('[data-scan-mode="wallet"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const summary = page.getByTestId("portfolio-summary");
  await expect(summary).toBeVisible({ timeout: 20000 });
  expect(env.portfolio.length).toBeGreaterThanOrEqual(1);
  expect(env.portfolio[0].identity.evm?.toLowerCase()).toBe(
    sender.toLowerCase(),
  );
  expect(env.portfolio[0].priority).toEqual(["1"]);
  // Known value excludes the testnet balance; unpriced assets are counted, not dropped.
  await expect(summary.locator(".summary-value")).toHaveText("$5,820.00");
  await expect(summary.getByTestId("unpriced-count")).toContainText(
    "1 unpriced",
  );
  await expect(summary).toContainText(
    "Testnet assets never count toward the total.",
  );
  // The testnet holding is listed but enters no share: allocation, chain share, asset share or native/token split.
  await expect(summary.locator(".alloc-legend")).not.toContainText("Sepolia");
  const split = await summary.locator(".summary-facts dd").nth(2).innerText();
  for (const pct of split.match(/-?\d+%/g) ?? [])
    expect(Number(pct.replace("%", ""))).toBeGreaterThanOrEqual(0);
  const testnetRow = page.locator('[data-chain="11155111"]');
  await expect(testnetRow.locator(".chain-row-value")).toContainText("Testnet");
  await expect(testnetRow.locator(".chain-row-value")).not.toContainText("$");
  await expect(page.locator(".chain-row").first()).not.toHaveAttribute(
    "data-chain",
    "11155111",
  );
  // Coverage classes are explicit per network.
  await expect(page.locator('[data-chain="1"] .chain-row-state')).toContainText(
    "Curated balance scan",
  );
  await expect(
    page.locator('[data-chain="8453"] .chain-row-state'),
  ).toContainText("Full index");
  await expect(
    page.locator('[data-chain="56"] .chain-row-state'),
  ).toContainText("Native only");
  await snap(page, "v111-portfolio-auto-scan-1440");
  await axe(page);
  // Account change: the previous wallet's result is dropped and the new account is scanned.
  const before = env.portfolio.length;
  await page.evaluate(
    (b) =>
      (
        window as unknown as {
          __wallets: Record<string, { setAccounts: (a: string[]) => void }>;
        }
      ).__wallets.metamask.setAccounts([b]),
    OTHER,
  );
  await expect.poll(() => env.portfolio.length).toBeGreaterThan(before);
  expect(env.portfolio.at(-1)!.identity.evm?.toLowerCase()).toBe(OTHER);
  await expect(summary.locator(".summary-value")).toHaveText("$2,800.00");
  // View another address: explicit, no automatic scan.
  const count = env.portfolio.length;
  await page.locator('[data-scan-mode="watch"]').click();
  await expect(page.locator('input[aria-label^="evm "]')).toBeVisible();
  await page.waitForTimeout(500);
  expect(env.portfolio.length).toBe(count);
  await noWritesOrCsp(page);
});

test("V111 portfolio mobile: results, classes and unpriced marker fit 390 px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 1100 });
  await setup(page);
  await page.goto("/portfolio");
  await connect(page);
  await expect(page.getByTestId("portfolio-summary")).toBeVisible({
    timeout: 20000,
  });
  await snap(page, "v111-portfolio-mobile-390");
  await noWritesOrCsp(page);
});

test("V111 activity: a saved route preview shows registry token logos and amounts, never a completed transfer", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/swap");
  await connect(page);
  await page.getByRole("button", { name: /^Destination token/ }).click();
  await page.locator("#token-search").fill("usdc");
  await page.locator(`[data-token-option="${USDC}"]`).click();
  await page.locator("#meta-amount").fill("0.01");
  await page
    .getByRole("button", { name: "Compare providers", exact: true })
    .click();
  await page.getByRole("button", { name: "Review Swap", exact: true }).click();
  await page.getByRole("button", { name: "Save preview to Activity" }).click();
  await expect(
    page.getByRole("button", { name: "Preview saved" }),
  ).toBeVisible();
  await page
    .locator(".review-dialog[aria-labelledby='meta-review-title']")
    .getByRole("button", { name: "Close" })
    .click();
  await page
    .getByRole("link", { name: "Activity", exact: true })
    .first()
    .click();
  await page
    .locator(".preview-card > summary")
    .filter({ hasText: "Ethereum" })
    .click();
  const tokens = page.locator(".preview-tokens").first();
  // Exact-address resolution through the registry: native ETH and USDC with formatted amounts.
  await expect(tokens).toContainText("0.01 ETH");
  await expect(tokens).toContainText("USDC");
  await expect(tokens.locator(`[title="${USDC}"] img`)).toHaveCount(1);
  await expect(page.locator(".catalog-section")).not.toContainText(
    "Delivery verified",
  );
  await snap(page, "v111-activity-1440");
  await axe(page);
  await noWritesOrCsp(page);
});
