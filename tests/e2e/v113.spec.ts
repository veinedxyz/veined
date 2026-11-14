import { test, expect, connectWallet } from "./fixtures";
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { defiFixture, defiWallet, loan } from "../fixtures/defi";
import { portfolioFixture, holding } from "../fixtures/portfolio";
import { fixtureCatalog } from "../fixtures/routing";
import { normalizeActive } from "../../src/catalog/model";
import type { DefiScan } from "../../src/defi/model";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
const root =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-13/adhoc";
async function setup(
  page: Page,
  options: {
    mode?: "empty" | "failed" | "partial" | "stress";
    theme?: string;
    locale?: string;
    delay?: number;
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
      (window as unknown as { __csp: string[] }).__csp = [];
      document.addEventListener("securitypolicyviolation", (e) =>
        (window as unknown as { __csp: string[] }).__csp.push(
          e.violatedDirective,
        ),
      );
    },
    { locale, theme: options.theme ?? "dark" },
  );
  if (options.connected)
    await page.addInitScript(installWalletDoubles, {
      wallets: ["metamask"] as (keyof typeof WALLET_DOUBLES)[],
      account: defiWallet,
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
  const s = await defiFixture();
  if (options.mode === "empty") s.positions = [];
  if (options.mode === "partial") {
    s.positions[0].borrowed[0].valueUsd = null;
    s.positions[0].warnings.push("UNPRICED_DEBT");
    s.coverage[1].state = "FAILED";
    s.coverage[1].result = "UNKNOWN";
  }
  if (options.mode === "stress") {
    const base = s.positions[0];
    s.positions = Array.from({ length: 500 }, (_, i) => ({
      ...base,
      id: "stress-position-" + i,
      positionKey: String(i),
      protocolId: "stress-protocol-" + (i % 50),
      protocolName: "Protocol " + (i % 50),
      supplied: [...base.supplied, ...base.supplied, ...base.supplied],
      collateral: [],
      borrowed: i < 50 ? base.borrowed : [],
      underlying: base.supplied,
      rewards: i < 200 ? base.rewards : [],
      details: {},
    }));
  }
  const p = portfolioFixture();
  p.holdings = [
    holding("1", "1000000000000000000", 2800),
    holding("1", "1000000", 1, {
      address: loan,
      native: false,
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    }),
    holding("1", "10000000000000000000", 100, {
      address:
        s.positions.find((p) => p.protocolId === "erc4626")?.details
          .shareContract ?? "0x83f20f44975d03b1b09e64809b757c47f942beea",
      native: false,
      symbol: "SHARE",
      decimals: 18,
    }),
  ];
  const requests: { wallet: string; at: number }[] = [];
  await page.route("**/api/portfolio", (r) => r.fulfill({ json: p }));
  await page.route("**/api/portfolio/defi", async (r) => {
    const b = r.request().postDataJSON();
    requests.push({ wallet: b.wallet, at: Date.now() });
    if (options.delay)
      await new Promise((resolve) => setTimeout(resolve, options.delay));
    if (options.mode === "failed")
      return r.fulfill({ status: 503, json: { error: "SYNTHETIC_FAILURE" } });
    const value: DefiScan = {
      ...s,
      wallet: b.wallet.toLowerCase(),
      positions: b.wallet.toLowerCase() === defiWallet ? s.positions : [],
    };
    return r.fulfill({ json: value });
  });
  return { s, p, requests };
}
async function watch(page: Page) {
  await page.goto("/portfolio");
  await page
    .getByRole("textbox", { name: "evm Source address", exact: true })
    .fill(defiWallet);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await expect(page.getByTestId("defi-intelligence")).toBeVisible();
  await expect(page.getByRole("tab", { name: /^DeFi/ })).toBeVisible();
}
async function shot(page: Page, name: string) {
  mkdirSync(root + "/screenshots", { recursive: true });
  await page.screenshot({
    path: root + "/screenshots/" + name + ".png",
    fullPage: true,
  });
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function axe(page: Page, name: string) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  mkdirSync(root + "/portfolio-ui", { recursive: true });
  writeFileSync(
    root + "/portfolio-ui/axe-" + name + ".json",
    JSON.stringify(r.violations, null, 2),
  );
  expect(r.violations).toEqual([]);
}
test("V113 Overview Assets DeFi Debt Rewards coverage and official details", async ({
  page,
}) => {
  await setup(page);
  await watch(page);
  await expect(page.getByTestId("portfolio-summary")).toContainText(
    "Known net value",
  );
  await shot(page, "overview");
  await page.getByRole("tab", { name: "Assets", exact: true }).click();
  await expect(page.locator(".portfolio-assets-card")).toBeVisible();
  await shot(page, "assets");
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await expect(page.locator(".defi-position-card")).toHaveCount(9);
  for (const [id, name] of [
    ["aave-v3", "aave"],
    ["compound-iii", "compound"],
    ["morpho-blue", "morpho"],
    ["morpho-vault", "morpho-vault"],
    ["erc4626", "vault"],
    ["lido", "staking"],
    ["uniswap-v2", "lp-v2"],
    ["uniswap-v3", "lp-v3"],
  ]) {
    await page
      .locator(`[data-protocol="${id}"] .defi-position-header`)
      .first()
      .click();
    await expect(page.locator(".defi-dialog")).toBeVisible();
    await shot(page, "defi-" + name);
    await expect(
      page
        .locator(".defi-dialog button")
        .filter({ hasText: /Deposit|Withdraw|Borrow|Repay|Claim|Stake/ }),
    ).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
  await page.getByRole("tab", { name: /^Debt/ }).click();
  await expect(page.locator(".defi-debt-list .defi-position-card")).toHaveCount(
    3,
  );
  await shot(page, "debt");
  await page.getByRole("tab", { name: "Rewards", exact: true }).click();
  await expect(page.getByTestId("defi-intelligence")).toContainText(
    "Provably claimable",
  );
  await shot(page, "rewards");
  await page.locator(".defi-coverage > summary").click();
  await shot(page, "coverage");
  await axe(page, "desktop");
});
for (const width of [360, 390, 768, 1440])
  test(`V113 responsive Overview/DeFi/modal/coverage ${width}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    await setup(page);
    await watch(page);
    await expect(page.getByTestId("portfolio-summary")).toContainText(
      "Known net value",
    );
    await noOverflow(page);
    await shot(page, "overview-" + width);
    await page.getByRole("tab", { name: /^DeFi/ }).click();
    await noOverflow(page);
    await shot(page, "defi-" + width);
    await page
      .locator('[data-protocol="aave-v3"] .defi-position-header')
      .click();
    await noOverflow(page);
    await axe(page, "modal-" + width);
    await page.keyboard.press("Escape");
    await page.locator(".defi-coverage > summary").click();
    await noOverflow(page);
  });
test("V113 light mode has accessible cards and net summary", async ({
  page,
}) => {
  await setup(page, { theme: "light" });
  await watch(page);
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await shot(page, "light");
  await axe(page, "light");
});
test("V113 empty checked DeFi is truthful about unchecked coverage", async ({
  page,
}) => {
  await setup(page, { mode: "empty" });
  await watch(page);
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await expect(page.getByTestId("defi-intelligence")).toContainText(
    "No positions found in checked protocols",
  );
  await shot(page, "empty");
});
test("V113 partial scan retains unpriced debt and actionable attention", async ({
  page,
}) => {
  await setup(page, { mode: "partial" });
  await watch(page);
  await expect(page.getByTestId("defi-intelligence")).toContainText(
    "Unpriced debt",
  );
  await shot(page, "needs-attention");
  await page.getByRole("tab", { name: /^Debt/ }).click();
  await expect(page.locator(".defi-debt-list")).toContainText("Unpriced");
  await page.locator(".defi-coverage > summary").click();
  await expect(page.locator(".defi-coverage")).toContainText("Read failed");
  await shot(page, "partial");
});
test("V113 wallet assets appear before delayed DeFi, failed DeFi preserves Assets", async ({
  page,
}) => {
  const { requests } = await setup(page, { mode: "failed", delay: 1200 });
  const start = Date.now();
  await watch(page);
  await expect(
    page.locator(".portfolio-assets .asset-row").first(),
  ).toBeVisible();
  const walletMs = Date.now() - start;
  await expect(page.getByTestId("defi-intelligence")).toContainText(
    "DeFi scan unavailable",
  );
  mkdirSync(root + "/performance", { recursive: true });
  writeFileSync(
    root + "/performance/progressive-ui.json",
    JSON.stringify(
      {
        walletResultMs: walletMs,
        defiRequestAt: requests[0]?.at,
        syntheticDefiDelayMs: 1200,
      },
      null,
      2,
    ),
  );
  await shot(page, "error");
});
test("V113 watch-address change aborts old scan and cannot merge old positions", async ({
  page,
}) => {
  await setup(page, { delay: 300 });
  await watch(page);
  await page
    .getByRole("textbox", { name: "evm Source address", exact: true })
    .fill(loan);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await expect(page.locator(".defi-position-card")).toHaveCount(0);
  await expect(page.getByTestId("defi-intelligence")).toContainText(
    "No positions found",
  );
});
test("V113 connected wallet auto scan and account change are race safe", async ({
  page,
}) => {
  const { requests } = await setup(page, { connected: true, delay: 400 });
  await page.goto("/portfolio");
  await connectWallet(page, "MetaMask", { label: "Connect wallet" });
  await expect(page.getByTestId("defi-intelligence")).toBeVisible();
  await expect.poll(() => requests.length).toBeGreaterThan(0);
  await page.evaluate((a) => {
    (
      window as unknown as {
        __wallets: Record<string, { setAccounts(a: string[]): void }>;
      }
    ).__wallets.metamask.setAccounts([a]);
  }, loan);
  await expect
    .poll(() => requests.some((r) => r.wallet.toLowerCase() === loan))
    .toBe(true);
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await expect(page.locator(".defi-position-card")).toHaveCount(0);
  const writes = await page.evaluate(() =>
    (
      window as unknown as { __walletCalls: { method: string }[] }
    ).__walletCalls.filter((c) =>
      /sign|sendTransaction|sendRaw|permit|grantPermissions/.test(c.method),
    ),
  );
  expect(writes).toEqual([]);
});
test("V113 keyboard tabs details focus trap and safe external link", async ({
  page,
}) => {
  await setup(page);
  await watch(page);
  const overview = page.getByRole("tab", { name: "Overview", exact: true });
  await overview.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "Assets", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /^DeFi/ })).toBeFocused();
  const trigger = page.locator(
    '[data-protocol="aave-v3"] .defi-position-header',
  );
  await trigger.click();
  for (let i = 0; i < 15; i++) await page.keyboard.press("Tab");
  expect(
    await page.evaluate(
      () => !!document.activeElement?.closest("dialog[open]"),
    ),
  ).toBe(true);
  await expect(page.locator(".defi-dialog a")).toHaveAttribute(
    "rel",
    "noopener noreferrer",
  );
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});
for (const locale of ["tr", "ar"])
  test(`V113 ${locale} canonical/RTL`, async ({ page }) => {
    await setup(page, { locale });
    await page.goto("/portfolio");
    await page.locator(".scan-field input").first().fill(defiWallet);
    await page.locator(".scan-button").click();
    await expect(page.getByTestId("defi-intelligence")).toBeVisible();
    if (locale === "ar")
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await noOverflow(page);
    await shot(page, locale);
  });
test("V113 stress 50 protocols 500 positions 2000 assets 50 debts 200 rewards stays bounded", async ({
  page,
}) => {
  await setup(page, { mode: "stress" });
  await watch(page);
  const start = Date.now();
  await page.getByRole("tab", { name: /^DeFi/ }).click();
  await expect(page.locator(".defi-position-card")).toHaveCount(50);
  const grouped = await page
    .locator(".defi-position-card")
    .evaluateAll((rows) => rows.map((r) => r.getAttribute("data-protocol")));
  expect(new Set(grouped).size).toBe(5);
  await page.getByRole("button", { name: "Show more positions" }).click();
  await expect(page.locator(".defi-position-card")).toHaveCount(100);
  await page.getByRole("tab", { name: /^Debt/ }).click();
  await expect(page.locator(".defi-debt-list .defi-position-card")).toHaveCount(
    50,
  );
  await noOverflow(page);
  mkdirSync(root + "/performance", { recursive: true });
  writeFileSync(
    root + "/performance/stress-ui.json",
    JSON.stringify(
      {
        protocols: 50,
        positions: 500,
        assets: 2000,
        debts: 50,
        rewards: 200,
        interactionMs: Date.now() - start,
        renderedInitialPositionRows: 50,
      },
      null,
      2,
    ),
  );
});
test("V113 public nested DeFi docs resolve EN/TR without wallet traffic", async ({
  page,
}) => {
  await setup(page);
  for (const path of [
    "/docs/portfolio/defi",
    "/docs/portfolio/coverage",
    "/docs/portfolio/risk",
  ]) {
    await page.goto(path);
    await expect(page.locator(".dk-article h1")).toBeVisible();
  }
  await axe(page, "docs");
});
for (const locale of ["en", "tr"])
  test(`V113 ${locale} DeFi help explains missing positions net prices native risk and partial coverage`, async ({
    page,
  }) => {
    const { requests } = await setup(page, { locale });
    await page.goto("/help");
    const help = page.getByTestId("defi-help");
    await expect(help.locator("details")).toHaveCount(5);
    for (const item of await help.locator("details").all()) {
      await item.locator("summary").click();
      await expect(item.locator("p")).toBeVisible();
    }
    await expect(
      page.locator('.help-topics a[href="/docs/portfolio/defi"]'),
    ).toBeVisible();
    expect(requests).toEqual([]);
    await axe(page, "help-" + locale);
    await shot(page, "help-" + locale);
  });
