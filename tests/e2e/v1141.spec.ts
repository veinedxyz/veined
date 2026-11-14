import { test, expect } from "./fixtures";
import type { Page, Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { defiFixture, defiWallet, loan } from "../fixtures/defi";
import { portfolioFixture, holding } from "../fixtures/portfolio";
import { fixtureCatalog } from "../fixtures/routing";
import { normalizeActive } from "../../src/catalog/model";
import type { DefiScan } from "../../src/defi/model";
// V1.14.1 progressive DeFi rendering. The DeFi API answers like the server's NDJSON path (one validated line per
// finished deployment, then the complete round). Wallet data is a SYNTHETIC FIXTURE; no wallet session, signature or
// transaction exists in any of these tests.
const root =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-14-1/adhoc";
const OTHER = "0x" + "b2".repeat(20);
type Mode = "full" | "mixed";
function ndjson(s: DefiScan, wallet: string) {
  const scan: DefiScan = {
    ...s,
    wallet,
    positions: s.positions.map((p) => ({ ...p, wallet })),
  };
  const lines = scan.coverage.map((c) =>
    JSON.stringify({
      type: "progress",
      coverage: c,
      positions: scan.positions.filter(
        (p) => p.deploymentId === c.deploymentId,
      ),
      replaced: scan.replacementOwners[c.deploymentId] ?? [],
    }),
  );
  return [...lines, JSON.stringify({ type: "scan", scan })].join("\n") + "\n";
}
async function setup(page: Page, mode: Mode, delayMs = 1500) {
  await page.addInitScript(() => {
    localStorage.setItem("otherbridge.language", "en");
    localStorage.setItem("otherbridge.theme", "dark");
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        e.violatedDirective,
      ),
    );
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
  for (const c of s.coverage) c.scanResult = "NONZERO";
  if (mode === "mixed") {
    // A MetaMorpho registry prefilter cut short by a throttling provider, and one adapter whose endpoint cooled down.
    const vault = s.coverage.find((c) => c.protocolId === "morpho-vault")!;
    Object.assign(vault, {
      state: "PARTIAL_POSITION",
      reason: "DISCOVERY_INCOMPLETE",
      tier: "HISTORICAL_INTERACTION",
    });
    const comp = s.coverage.find((c) => c.protocolId === "compound-iii")!;
    Object.assign(comp, {
      state: "FAILED",
      result: "UNKNOWN",
      scanResult: "FAILED",
      reason: "RPC_COOLDOWN",
    });
    s.positions = s.positions.filter((p) => p.protocolId !== "compound-iii");
    s.replacementOwners[comp.deploymentId] = [];
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
  ];
  const walletRequests: string[] = [];
  const defiAccept: string[] = [];
  page.on("request", (r) => {
    if (
      /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_sign|signTypedData|wallet_sendCalls|wallet_grantPermissions/.test(
        r.postData() ?? "",
      )
    )
      walletRequests.push(r.url());
  });
  await page.route("**/api/portfolio", (r) => r.fulfill({ json: p }));
  const pending: Route[] = [];
  await page.route("**/api/portfolio/defi", async (r) => {
    defiAccept.push(r.request().headers()["accept"] ?? "");
    const b = r.request().postDataJSON() as { wallet: string; held?: string[] };
    // The native coin is never sent as a receipt candidate.
    expect((b.held ?? []).some((h) => /:0x0{40}$/.test(h))).toBe(false);
    pending.push(r);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    const wallet = b.wallet.toLowerCase();
    const scan: DefiScan =
      wallet === OTHER
        ? {
            ...s,
            wallet,
            positions: [],
            coverage: s.coverage.map((c) => ({
              ...c,
              result: "ZERO",
              scanResult: "CHECKED_ZERO",
            })),
            replacedWalletAssets: [],
            replacementOwners: {},
          }
        : s;
    await r.fulfill({
      status: 200,
      contentType: "application/x-ndjson; charset=utf-8",
      body: ndjson(scan, wallet),
    });
  });
  return { s, walletRequests, defiAccept, pending };
}
async function shot(page: Page, name: string) {
  mkdirSync(root + "/screenshots", { recursive: true });
  await page.screenshot({
    path: root + "/screenshots/" + name + ".png",
    fullPage: true,
  });
}
const receipts = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      ["walletFirstResultMs", "firstDefiResultMs", "fullDefiScanMs"].map(
        (n) => [
          n,
          performance.getEntriesByName("otherbridge:" + n, "measure")[0]
            ?.duration ?? null,
        ],
      ),
    ),
  );
const csp = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
async function scan(page: Page, wallet = defiWallet) {
  await page.goto("/portfolio");
  await page.locator(".scan-field input").first().fill(wallet);
  await page.locator(".scan-button").click();
}
for (const viewport of [
  { name: "desktop", width: 1440, height: 1100 },
  { name: "mobile", width: 390, height: 844 },
]) {
  test(`V1141 ${viewport.name}: wallet assets render first, DeFi streams in, timing receipts are recorded`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    const { walletRequests, defiAccept } = await setup(page, "full");
    await scan(page);
    // Wallet-first: the wallet page is on screen while the DeFi round is still in flight.
    await expect(page.locator(".portfolio-chains-card")).toBeVisible();
    await expect(
      page.getByTestId("defi-intelligence").getByRole("status"),
    ).toHaveText("Checking supported protocols…");
    await shot(page, `wallet-first-${viewport.name}`);
    await expect(
      page.getByTestId("defi-intelligence").getByRole("status"),
    ).toHaveText("Supported DeFi positions", { timeout: 15000 });
    await expect(page.getByTestId("defi-intelligence")).toContainText("Lido");
    await shot(page, `first-defi-${viewport.name}`);
    expect(defiAccept[0]).toContain("application/x-ndjson");
    const r = await receipts(page);
    expect(r.walletFirstResultMs).not.toBeNull();
    expect(r.firstDefiResultMs).not.toBeNull();
    expect(r.fullDefiScanMs).not.toBeNull();
    expect(r.walletFirstResultMs!).toBeLessThanOrEqual(r.firstDefiResultMs!);
    mkdirSync(root + "/performance", { recursive: true });
    writeFileSync(
      root + `/performance/browser-receipts-${viewport.name}.json`,
      JSON.stringify(
        {
          kind: "BROWSER_USER_TIMING_SYNTHETIC_FIXTURE",
          viewport,
          defiDelayMs: 1500,
          ...r,
        },
        null,
        1,
      ),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(await csp(page)).toEqual([]);
    expect(walletRequests).toEqual([]);
  });
}
test("V1141 partial MetaMorpho, failed and full coverage stay distinct after a streamed round", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { walletRequests } = await setup(page, "mixed", 300);
  await scan(page);
  await expect(
    page.getByTestId("defi-intelligence").getByRole("status"),
  ).toHaveText("Supported DeFi positions", { timeout: 15000 });
  await page.locator(".defi-coverage summary").click();
  const list = page.locator(".position-coverage-list");
  await expect(list.locator(".pill.tone-danger")).toHaveText(["Read failed"]);
  await expect(list.locator(".pill.tone-warn").first()).toBeVisible();
  await expect(list.locator(".pill.tone-ok").first()).toHaveText(
    "Positions checked",
  );
  await expect(list).toContainText("Morpho Vaults");
  await shot(page, "coverage-partial-failed-full-mobile");
  const a = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  mkdirSync(root + "/screenshots", { recursive: true });
  writeFileSync(
    root + "/screenshots/axe-coverage-mobile.json",
    JSON.stringify(a.violations, null, 2),
  );
  expect(a.violations).toEqual([]);
  expect(await csp(page)).toEqual([]);
  expect(walletRequests).toEqual([]);
});
test("V1141 an address switch during a streamed round discards the previous identity's results", async ({
  page,
}) => {
  const { walletRequests, pending } = await setup(page, "full", 2500);
  await scan(page);
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  // Switch identity while the first DeFi round is still in flight.
  await page.locator(".scan-field input").first().fill(OTHER);
  await page.locator(".scan-button").click();
  await expect(
    page.getByTestId("defi-intelligence").getByRole("status"),
  ).toHaveText("Supported DeFi positions", { timeout: 20000 });
  // The first identity's late round (Lido position) never renders for the new identity.
  await page.waitForTimeout(3000);
  await expect(page.locator(".defi-allocation")).not.toContainText("Lido");
  await expect(page.locator(".defi-allocation")).toBeVisible();
  await shot(page, "account-switch-desktop");
  expect(walletRequests).toEqual([]);
});
