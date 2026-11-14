// V1.10 product UI/UX refinement: Swap, Portfolio, Bridge, Activity, Networks, Help and the wallet shell, driven
// with SYNTHETIC_TEST_ONLY fixtures (no live data, no wallet writes). Every test also records review screenshots.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { test, expect, privyModal, readOnlyAddress } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
import { fixtureCatalog, fixtureQuote, sender } from "../fixtures/routing";
import { coverage, holding } from "../fixtures/portfolio";
import { normalizeQuote } from "../../src/routing/normalize";
import { normalizeActive } from "../../src/catalog/model";
import { summarize } from "../../src/data/core/coverage";
import type { Holding, PortfolioResult } from "../../src/portfolio/model";

const base =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-10";
const shots = `${base}/screenshots`;
const SIGNING = /sign|sendRaw|eth_sendTransaction|permit/i;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const AERO = "0x940181a94a35a4569e4529a3cdfb74e38fd98631";
const SPAM = "0x1111111111111111111111111111111111111112";
const UNVERIFIED = "0x2222222222222222222222222222222222222223";

function token(
  chainId: string,
  address: string,
  symbol: string,
  name: string,
  balance: string,
  usd: number | null,
  extra: Partial<Holding> = {},
): Holding {
  return holding(chainId, balance, usd, {
    address,
    symbol,
    name,
    decimals: 18,
    native: false,
    routable: true,
    metadataVerified: true,
    discovery: "known-token",
    ...extra,
  });
}
// A realistic multi-network wallet: natives, verified tokens, dust, spam and an unverified token, with complete,
// native-only, pending, failed and catalog-only coverage.
export function showcasePortfolio(): PortfolioResult {
  const list = [
    coverage("1", "COMPLETE"),
    coverage("8453", "COMPLETE"),
    coverage("42161", "PARTIAL"),
    coverage("56", "NATIVE_ONLY"),
    coverage("10", "COMPLETE"),
    coverage("137", "PENDING"),
    coverage("43114", "FAILED"),
    coverage("900100", "CATALOG_ONLY"),
  ];
  const holdings = [
    holding("1", "1200000000000000000", 3360),
    token("1", USDC, "USDC", "USD Coin", "2450500000000000000000", 2450.5),
    holding("8453", "850000000000000000", 2380),
    token("8453", AERO, "AERO", "Aerodrome", "320000000000000000000", 410.4),
    token(
      "8453",
      UNVERIFIED,
      "BASED",
      "Based Token",
      "9000000000000000000000",
      12.6,
      {
        routable: false,
      },
    ),
    holding("42161", "50000000000000000", 140, { lastActivity: Date.now() }),
    token(
      "42161",
      "0x912ce59144191c1204e64559fe8253a0e49e6548",
      "ARB",
      "Arbitrum",
      "150000000000000000000",
      121.5,
    ),
    holding("56", "600000000000000000", 372),
    token(
      "56",
      SPAM,
      "CLAIM",
      "Claim reward at example",
      "1000000000000000000000",
      null,
      {
        spam: true,
        suspicious: true,
      },
    ),
    holding("10", "400000000000000", 0.42),
  ];
  const at = Date.now();
  return {
    state: "PARTIAL",
    holdings,
    coverage: list,
    coverageSummary: summarize(list),
    continuation: null,
    dataPlane: "AVAILABLE",
    source: "otherbridge-data-plane",
    observedAt: at,
    revision: "synthetic-v110",
    synthetic: true,
  };
}
async function setup(
  page: Page,
  options: {
    locale?: string;
    theme?: "dark" | "light";
    portfolio?: () => PortfolioResult;
    chainId?: string;
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
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
      const csp: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = csp;
      document.addEventListener("securitypolicyviolation", (e) =>
        csp.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    },
    { locale, theme: options.theme ?? "dark" },
  );
  await page.addInitScript(installWalletDoubles, {
    wallets: [
      "metamask",
      "rabby",
      "phantom",
      "coinbase",
    ] as (keyof typeof WALLET_DOUBLES)[],
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
            tvl: 54_000_000_000 / (i + 1),
          })),
        catalog,
        Date.now(),
        "SYNTHETIC_TEST_ONLY",
      ),
    }),
  );
  const routing: { action: string }[] = [];
  await page.route("**/api/portfolio", (route) =>
    route.fulfill({
      json: {
        ...(options.portfolio ?? showcasePortfolio)(),
        observedAt: Date.now(),
      },
    }),
  );
  await page.route("**/api/routing", (route) => {
    const body = route.request().postDataJSON();
    routing.push(body);
    if (body.action === "catalog") return route.fulfill({ json: catalog });
    if (body.action === "assets")
      return route.fulfill({
        json: [
          catalog.networks.find((n) => n.id === body.chain)!.nativeAsset,
          {
            chainId: body.chain,
            address: "0x4444444444444444444444444444444444444444",
            symbol: "TOKEN",
            name: "Synthetic buy token",
            decimals: 18,
          },
          {
            chainId: body.chain,
            address: USDC,
            symbol: "USDC",
            name: "USD Coin",
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
    if (body.action === "quote") {
      const raw = fixtureQuote(body.input);
      if (body.input.mode === "swap") {
        const tool = catalog.tools.find((t) => t.kind === "exchange")!;
        raw.tool = tool.id;
        raw.toolDetails = { ...raw.toolDetails, key: tool.id, name: tool.name };
        raw.type = "swap";
        raw.estimate.feeCosts[0].name = "Exchange fee";
      }
      raw.action.toToken = {
        ...raw.action.toToken,
        address: body.input.destinationAsset,
        ...(body.input.mode === "swap"
          ? { symbol: "TOKEN", name: "Synthetic buy token" }
          : {}),
      };
      raw.estimate.toAmount = "9000000000000000";
      raw.estimate.toAmountMin = "8955000000000000";
      const q = normalizeQuote(raw, body.input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return route.fulfill({
        json: [
          { ...q, id: "best-value", outputUsd: "31", duration: 90 },
          {
            ...q,
            id: "fastest",
            expected: "8800000000000000",
            minimum: "8700000000000000",
            outputUsd: "30",
            duration: 5,
            fees: [],
          },
        ],
      });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
  return { routing };
}
async function snap(page: Page, name: string, full = true) {
  await mkdir(shots, { recursive: true });
  // The header is sticky: full-page captures start from the top so it is drawn once, in place.
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
  // The only allowed report is the intentionally refused Privy embedded-wallet iframe (V1.9 boundary).
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
async function connect(page: Page, name: RegExp = /^MetaMask$/) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page).getByRole("button", { name }).first().click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
}
test.beforeAll(async () => mkdir(shots, { recursive: true }));

for (const width of [1440, 390])
  test(`V110 swap ${width}: token picker, quote summary, route options, readiness, no execution`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    const env = await setup(page);
    await page.goto("/swap");
    await expect(page.locator("#meta-amount")).toBeVisible();
    // Empty quote state explains what is missing and what execution would need.
    await expect(page.locator(".trade-hint")).toContainText("Enter an amount");
    // V1.11: the execution state is the disabled CTA (no readiness wall before a quote).
    await expect(page.locator(".execution-status")).toContainText(
      "Execution closed",
    );
    // V1.12 keeps the actionable empty hint on the form; the quote panel appears only after a quote.
    await expect(page.locator(".quote-card")).toHaveCount(0);
    await snap(page, `v110-swap-empty-${width}`);
    // Token picker (dialog): search, held/native marks, selection binds the quote input.
    await page.getByRole("button", { name: /^Destination token/ }).click();
    const picker = page.locator("dialog.token-picker[open]");
    await expect(picker).toBeVisible();
    // V1.11: an unlisted route token is found by its exact contract address (never by symbol alone).
    await page
      .locator("#token-search")
      .fill("0x4444444444444444444444444444444444444444");
    await expect(picker.locator(".token-option")).toHaveCount(1);
    await snap(page, `v110-swap-token-picker-${width}`, false);
    await axe(page);
    await page.locator("#token-search").press("Enter");
    await expect(picker).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: /^Destination token/ }),
    ).toContainText("TOKEN");
    await (await readOnlyAddress(page)).fill(sender);

    await page.locator("#meta-amount").fill("0.01");
    await page
      .getByRole("button", { name: "Compare providers", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Review Swap", exact: true }),
    ).toBeEnabled();
    await expect(page.locator("#meta-receive")).toContainText("9");
    await page.getByText("Route details", { exact: true }).click();
    const details = page.locator("details.disclosure[open]").first();
    await expect(details).toContainText("Minimum received");
    await expect(details).toContainText("VEINED fee");
    await expect(page.locator(".meta-quote-options button")).toHaveCount(2);
    await snap(page, `v110-swap-quote-${width}`);
    await page.getByLabel("Route preference").selectOption("FASTEST");
    await page
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    await expect(
      page.locator(".review-dialog[aria-labelledby='meta-review-title'][open]"),
    ).toContainText("Execution closed");
    await expect(
      page
        .locator(".review-dialog[aria-labelledby='meta-review-title']")
        .getByRole("button", { name: /sign|approve|confirm swap/i }),
    ).toHaveCount(0);
    await snap(page, `v110-swap-review-${width}`, false);
    await axe(page);
    await page
      .locator(".review-dialog[aria-labelledby='meta-review-title']")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await page.getByRole("button", { name: "Reverse tokens" }).click();
    await expect(
      page.getByRole("button", { name: "Review Swap", exact: true }),
    ).toHaveCount(0);
    expect(
      env.routing.every(
        (r) => !["execute", "approve", "sign", "broadcast"].includes(r.action),
      ),
    ).toBe(true);
    await noWritesOrCsp(page);
  });

test("V110 swap: connected wallet starts on its own network and pre-fills both addresses", async ({
  page,
}) => {
  await setup(page, { chainId: "0x2105" });
  await page.goto("/bridge");
  await connect(page);
  // Client-side navigation keeps the connect-only session (a reload intentionally starts disconnected).
  await page.getByRole("link", { name: "Swap", exact: true }).first().click();
  await expect(page.locator("header .wallet-button")).toContainText(
    "0x3333…3333",
  );
  await expect(
    page.getByRole("button", { name: "Select source network", exact: true }),
  ).toContainText("Base");
  // V1.11: From = connected wallet, Recipient = same wallet; no raw address fields unless chosen.
  await expect(
    page.getByLabel("Wallet address for read-only quotes"),
  ).toHaveCount(0);
  await expect(page.locator("#routing-recipient")).toHaveCount(0);
  await expect(page.locator(".trade-parties")).toContainText(
    "Connected wallet",
  );
  await expect(page.locator(".trade-parties")).toContainText("Same wallet");
  await expect(page.locator(".trade-parties")).toContainText("0x3333…3333");
  await snap(page, "v110-swap-connected-1440");
  await noWritesOrCsp(page);
});

for (const width of [1440, 390])
  test(`V110 portfolio ${width}: summary, allocation, chain rows, asset filters, coverage truth`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    await setup(page);
    await page.goto("/portfolio");
    await expect(
      page.getByRole("heading", { name: "Nothing scanned yet" }),
    ).toBeVisible();
    await snap(page, `v110-portfolio-empty-${width}`);
    await page.locator('input[aria-label^="evm "]').fill(sender);
    await page
      .getByRole("button", { name: "Scan balances", exact: true })
      .click();
    const summary = page.getByTestId("portfolio-summary");
    await expect(summary).toBeVisible();
    // Spam is excluded from the total; dust keeps significant digits.
    await expect(summary.locator(".summary-value")).toHaveText("$9,247.42");
    await expect(summary).toContainText("Networks checked");
    await expect(summary).toContainText("1 pending · 1 failed");
    await expect(page.locator(".alloc-seg")).toHaveCount(5);
    // Chain rows are sorted by value and never include pending/failed/catalog-only networks.
    await expect(page.locator(".chain-row").first()).toHaveAttribute(
      "data-chain",
      "1",
    );
    for (const id of ["137", "43114", "900100"])
      await expect(page.locator(`[data-chain="${id}"]`)).toHaveCount(0);
    await expect(page.getByTestId("portfolio-coverage")).toContainText(
      "Networks that were not checked are never counted as empty.",
    );
    await expect(page.locator(".coverage-bar span")).toHaveCount(4);
    await snap(page, `v110-portfolio-${width}`);
    await axe(page);
    // Expand a chain row: its assets are listed inline.
    await page.locator('[data-chain="8453"] summary').click();
    await expect(
      page.locator('[data-chain="8453"] .chain-assets li'),
    ).toHaveCount(3);
    // Search, network filter, flagged filter and spam toggle.
    const rows = page.locator(".portfolio-assets article");
    await expect(rows).toHaveCount(8);
    await page.getByRole("searchbox", { name: "Search assets" }).fill("usd");
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("USDC");
    await page.getByRole("searchbox", { name: "Search assets" }).fill("");
    await page
      .getByRole("combobox", { name: "Filter by network" })
      .selectOption("8453");
    await expect(rows).toHaveCount(3);
    await page
      .getByRole("combobox", { name: "Filter by network" })
      .selectOption("all");
    await page.getByLabel("Flagged only").check();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("Unverified token");
    await page.getByLabel("Spam tokens").check();
    await expect(rows).toHaveCount(2);
    await expect(page.locator(`[data-token="${SPAM}"]`)).toContainText(
      "Spam tokens",
    );
    // A flagged token never offers Bridge/Swap prefill.
    await expect(
      page
        .locator(`[data-token="${UNVERIFIED}"]`)
        .getByRole("button", { name: "Swap" }),
    ).toHaveCount(0);
    await page.getByLabel("Flagged only").uncheck();
    await page.getByLabel("Spam tokens").uncheck();
    await page.getByRole("combobox", { name: "Sort by" }).selectOption("name");
    await expect(rows.first()).toContainText("AERO");
    await snap(page, `v110-portfolio-filters-${width}`);
    await page.locator(".portfolio-coverage-details summary").click();
    await expect(
      page.locator('.portfolio-coverage-details li[data-coverage="FAILED"]'),
    ).toContainText("Check failed");
    await noWritesOrCsp(page);
  });

test("V110 portfolio: checked networks with no balance show an honest empty state, never invented zeros", async ({
  page,
}) => {
  await setup(page, {
    portfolio: () => {
      const list = [coverage("1", "COMPLETE"), coverage("137", "PENDING")];
      return {
        ...showcasePortfolio(),
        holdings: [],
        coverage: list,
        coverageSummary: summarize(list),
      };
    },
  });
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "No balances found" }),
  ).toBeVisible();
  await expect(page.getByTestId("coverage-sentence")).toContainText(
    "1 more are still being checked",
  );
  await expect(page.locator("[data-chain]")).toHaveCount(0);
  await snap(page, "v110-portfolio-no-balances-1440");
  await axe(page);
});

test("V110 portfolio → swap: held tokens appear first in the token picker and as quick chips", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await page
    .locator(`[data-token="${USDC}"]`)
    .getByRole("button", { name: "Swap", exact: true })
    .click();
  await expect(page).toHaveURL(/\/swap$/);
  await expect(
    page.getByRole("button", { name: /^Source token/ }),
  ).toContainText("USDC");
  await expect(page.locator(".held-chips button")).toHaveCount(2);
  await expect(
    page.getByLabel("Wallet address for read-only quotes"),
  ).toHaveValue(sender);
  await page.getByRole("button", { name: /^Source token/ }).click();
  await expect(page.locator(".token-option").first()).toContainText("ETH");
  await expect(page.locator(".token-option").nth(1)).toContainText("USDC");
  await snap(page, "v110-swap-held-tokens-1440", false);
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog.token-picker")).toHaveCount(0);
});

test("V1151 watch address change clears scanned balances, held ranking and prior quote", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await page
    .locator(`[data-token="${USDC}"]`)
    .getByRole("button", { name: "Swap", exact: true })
    .click();
  const card = page.getByTestId("swap-intelligence");
  const address = card.getByLabel("Wallet address for read-only quotes");
  await expect(address).toHaveValue(sender);
  await expect(
    card.locator(".trade-amount-box").first().locator("small"),
  ).toContainText("2,450.5");
  await card.getByRole("button", { name: /^Destination token/ }).click();
  await page.getByRole("option").filter({ hasText: "ETH" }).first().click();
  await card.locator("#meta-amount").fill("0.01");
  await card
    .getByRole("button", { name: "Compare providers", exact: true })
    .click();
  await expect(
    card.getByRole("button", { name: "Review Swap", exact: true }),
  ).toBeEnabled();
  await address.fill("0x5555555555555555555555555555555555555555");
  await expect(
    card.locator(".trade-amount-box").first().locator("small"),
  ).toHaveText("Balance: —");
  await expect(card.locator(".held-chips button")).toHaveCount(0);
  await expect(
    card.getByRole("button", { name: "Review Swap", exact: true }),
  ).toHaveCount(0);
  await card.getByRole("button", { name: /^Source token/ }).click();
  await expect(page.locator("#token-group-0")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await address.fill(sender);
  await expect(
    card.locator(".trade-amount-box").first().locator("small"),
  ).toContainText("2,450.5");
  await expect(card.locator(".held-chips button")).toHaveCount(2);
  await noWritesOrCsp(page);
});

for (const [width, theme] of [
  [1440, "dark"],
  [390, "dark"],
  [1440, "light"],
] as const)
  test(`V110 bridge, activity, networks, help ${width} ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1100 });
    await setup(page, { locale: "tr", theme });
    await page.goto("/bridge");
    await expect(page.locator(".intro h1")).toBeVisible();
    await expect(page.locator(".fees-head")).toContainText("Ücret dökümü");
    // V1.11: one route-health state and at most three compact rows.
    await expect(page.locator(".health-card .status-list li")).toHaveCount(0);
    await page.locator(".health-card details > summary").click();
    await expect(page.locator(".health-card .status-list li")).toHaveCount(3);
    await expect(page.locator(".health-card [data-route-state]")).toHaveCount(
      1,
    );
    await expect(page.locator(".under-button")).toHaveText(
      "Gerçek gönderim kapalı",
    );
    await snap(page, `v110-bridge-${width}-${theme}`);
    await axe(page);
    await page.goto("/activity");
    await expect(page.locator(".empty-facts li")).toHaveCount(3);
    await expect(
      page.getByRole("group", { name: "İşlem filtresi" }),
    ).toBeVisible();
    await snap(page, `v110-activity-${width}-${theme}`);
    await axe(page);
    await page.goto("/networks");
    await expect(page.locator(".route-overview .network-card")).toHaveCount(2);
    await expect(
      page.locator(".active-catalog-list article").first(),
    ).toBeVisible();
    await snap(page, `v110-networks-${width}-${theme}`);
    await axe(page);
    await page.goto("/help");
    await expect(page.locator(".help-steps li")).toHaveCount(3);
    await page.locator(".faq details").first().locator("summary").click();
    await snap(page, `v110-help-${width}-${theme}`);
    await axe(page);
    await noWritesOrCsp(page);
  });

test("V110 wallet: Privy modal, connected chip and wallet dialog stay consistent across surfaces", async ({
  page,
}) => {
  await setup(page, { chainId: "0x7a69" });
  await page.goto("/bridge");
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await snap(page, "v110-privy-modal-1440", false);
  await privyModal(page)
    .getByRole("button", { name: /^MetaMask$/ })
    .first()
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
  const chip = page.locator("header .wallet-button");
  await expect(chip.locator(".wallet-icon")).toBeVisible();
  await expect(chip.locator(".wallet-address")).toHaveText("0x3333…3333");
  await expect(chip.locator(".wallet-chain")).toHaveText("#31337");
  await snap(page, "v110-bridge-connected-1440");
  for (const label of ["Swap", "Activity", "Networks", "Help", "Portfolio"]) {
    await page.getByRole("link", { name: label, exact: true }).first().click();
    await expect(page.locator("h1")).toBeVisible();
    await expect(chip.locator(".wallet-address")).toHaveText("0x3333…3333");
  }
  // V1.11: "My wallet" mode scans the connected wallet; no address field to fill.
  await expect(page.locator('[data-scan-mode="wallet"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".scan-primary.is-wallet code")).toHaveText(
    "0x3333…3333",
  );
  await chip.click();
  const dialog = page.getByRole("dialog", { name: "Wallet" });
  await expect(dialog).toContainText("Connected");
  await expect(dialog).toContainText("No signature was requested");
  await snap(page, "v110-wallet-dialog-1440", false);
  await axe(page);
  await page.setViewportSize({ width: 390, height: 900 });
  await snap(page, "v110-wallet-dialog-390", false);
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(chip).toHaveText("Connect wallet");
  await noWritesOrCsp(page);
});

// Keep all 6 x 8 layout assertions, but release the browser context and its
// intercepted network buffers between viewport/zoom scenarios. Each scenario
// uses the existing 30-second default (the old combined test had 180 seconds).
for (const [width, zoom] of [
  [360, 1],
  [390, 1],
  [768, 1],
  [1440, 1],
  [768, 2],
  [1440, 2],
] as const)
  test(`V110 no horizontal overflow on any surface at ${width} px and ${zoom * 100}% CSS zoom`, async ({
    page,
  }) => {
    await setup(page, { locale: "tr" });
    const offenders = () =>
      page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>("body *")]
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return (
              r.width > 0 &&
              r.right > document.documentElement.clientWidth + 1 &&
              !e.closest(
                "dialog, .main-nav, .active-catalog-list, .catalog-caps",
              )
            );
          })
          .slice(0, 6)
          .map(
            (e) =>
              `${e.tagName}.${e.className} ${Math.round(e.getBoundingClientRect().right)}`,
          ),
      );
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/bridge",
      "/swap",
      "/portfolio",
      "/activity",
      "/networks",
      "/help",
      "/about",
      "/settings",
    ]) {
      await page.goto(path);
      await expect(page.locator("h1")).toBeVisible();
      if (path === "/portfolio") {
        await page.locator('input[aria-label^="evm "]').fill(sender);
        await page
          .getByRole("button", { name: "Bakiyeleri tara", exact: true })
          .click();
        await expect(page.getByTestId("portfolio-summary")).toBeVisible();
      }
      if (zoom === 2) await page.addStyleTag({ content: "html { zoom: 2 }" });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > window.innerWidth,
      );
      expect({
        width,
        zoom,
        path,
        overflow,
        offenders: overflow ? await offenders() : [],
      }).toEqual({
        width,
        zoom,
        path,
        overflow: false,
        offenders: [],
      });
    }
  });
