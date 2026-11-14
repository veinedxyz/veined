// LIVE in-product dry run on the production runtime (opt-in): drives an already running
// `pnpm g7:product-pilot --dry-run` (local-g7-pilot artifact with the REAL Privy App ID, real read-only mainnet
// preflight) with a generic recording wallet through the real Privy connect-only modal (no Privy doubles), walks
// every product route, returns to Bridge and runs the fresh final preflight up to the arm, which dry-run
// suppresses — no send request can exist. Records route timings, server RSS and third-party hosts.
// Usage: G7_PRODUCT_LIVE_DRY_RUN_URL=<printed URL> pnpm g7:product-pilot:e2e product-live-routes
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import {
  installMockWallet,
  type MockWalletConfig,
  type WalletCall,
} from "./mock-wallet";

const URL_ = process.env.G7_PRODUCT_LIVE_DRY_RUN_URL;
const SHOTS =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g7-product-pilot";
const EOA = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
const EMBEDDED_IFRAME_REFUSED = /^Framing 'https:\/\/auth\.privy\.io\/'/;
test.skip(
  !URL_,
  "set G7_PRODUCT_LIVE_DRY_RUN_URL to the URL printed by `pnpm g7:product-pilot --dry-run`",
);

test("live dry run (real Privy, production runtime): every route, back to Bridge, fresh final preflight; send suppressed", async ({
  page,
}) => {
  test.setTimeout(420000);
  mkdirSync(SHOTS, { recursive: true });
  const origin = new URL(URL_!).origin;
  const problems: string[] = [];
  const hosts = new Set<string>();
  page.on("console", (m) => {
    if (m.type() === "error" && !EMBEDDED_IFRAME_REFUSED.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin && /^https?:|^wss?:/.test(u.protocol))
      hosts.add(u.host);
  });
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await page.addInitScript(installMockWallet, {
    accounts: [EOA],
    chainId: "0x956d7",
    send: "hash",
    rdns: "test.local.dry-run-wallet",
    isMock: false,
    name: "Dry-run recording wallet",
  } satisfies MockWalletConfig);
  const identity = async () =>
    (await (await fetch(`${origin}/g7-pilot/runtime`)).json()) as Record<
      string,
      unknown
    >;
  const before = await identity();
  expect(before.mode).toBe("dry-run");
  expect(before.runtime).toBe("next-production");

  const t0 = Date.now();
  await page.goto(URL_!);
  const card = page.locator(".bridge-card");
  await expect(card).toContainText("CONTROLLED PILOT", { timeout: 60000 });
  const timings: Record<string, number> = { firstBridgeMs: Date.now() - t0 };
  // Real Privy (the owner's App ID): connect-only modal, generic injected wallet.
  await card.getByRole("button", { name: "Connect wallet" }).click();
  const modal = page.locator("#privy-modal-content");
  await expect(modal).toBeVisible({ timeout: 60000 });
  await modal
    .getByRole("button", { name: /Dry-run recording wallet/ })
    .first()
    .click();
  await expect(modal).toBeHidden({ timeout: 60000 });
  const chip = page.locator("header .wallet-button .wallet-address");
  await expect(chip).toBeVisible({ timeout: 30000 });
  const address = await chip.textContent();
  await page.screenshot({
    path: `${SHOTS}/live-01-bridge-connected.png`,
    fullPage: true,
  });
  for (const [href, name] of [
    ["/swap", "swap"],
    ["/portfolio", "portfolio"],
    ["/activity", "activity"],
    ["/networks", "networks"],
    ["/help", "help"],
    ["/bridge", "bridge"],
  ] as const) {
    const at = Date.now();
    await page.locator(`nav.main-nav a[href="${href}"]`).click();
    if (href === "/bridge")
      await expect(card).toContainText("CONTROLLED PILOT");
    else {
      await expect(page).toHaveURL(new RegExp(`${href}$`));
      await expect(page.locator("main h1")).toBeVisible();
    }
    timings[`${name}Ms`] = Date.now() - at;
    await expect(chip).toHaveText(address!);
    await page.screenshot({
      path: `${SHOTS}/live-route-${name}.png`,
      fullPage: false,
    });
  }
  await page.goBack();
  await expect(page).toHaveURL(/\/help$/);
  await page.goForward();
  await expect(card).toContainText("CONTROLLED PILOT");
  // Fresh G7 preflight: the Review in wallet step runs the final mainnet preflight; dry-run suppresses the arm.
  const review = card.getByRole("button", { name: /Review transfer/ });
  await expect(review).toBeEnabled({ timeout: 120000 });
  await expect(card).toContainText("5 ONE");
  await review.click();
  const dialog = page.getByRole("dialog", {
    name: "Review the 5 ONE pilot transfer",
  });
  await dialog.locator("details summary").click();
  await expect(dialog).toContainText("re-verified in this browser ✓");
  await dialog.getByLabel("I reviewed the 5 ONE pilot transaction.").check();
  await dialog
    .getByLabel(
      "I accept the centralized ONEbridge trust model for this pilot.",
    )
    .check();
  await dialog.locator("#pilot-phrase").fill("G7 5 ONE");
  await page.screenshot({
    path: `${SHOTS}/live-02-review.png`,
    fullPage: true,
  });
  const finalAt = Date.now();
  await dialog.getByRole("button", { name: /Review in wallet/ }).click();
  await expect(dialog).toContainText(
    /Dry run complete|No wallet request was made/,
    { timeout: 180000 },
  );
  timings.finalPreflightMs = Date.now() - finalAt;
  await expect(dialog).toContainText("Dry run complete");
  await page.screenshot({
    path: `${SHOTS}/live-03-dry-run-complete.png`,
    fullPage: true,
  });
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __g7Mock: { calls: WalletCall[] } }).__g7Mock
        .calls,
  );
  const methods = [...new Set(calls.map((c) => c.method))].sort();
  expect(methods).toEqual([
    "eth_accounts",
    "eth_chainId",
    "eth_requestAccounts",
  ]);
  const csp = (
    await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
  ).filter((v) => !v.startsWith("frame-src https://auth.privy.io"));
  expect(csp).toEqual([]);
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll(
          "nextjs-portal, [data-nextjs-toast], #__next-build-watcher",
        ).length,
    ),
  ).toBe(0);
  const after = await identity();
  writeFileSync(
    `${SHOTS}/live-dry-run-routes.json`,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        sessionId: after.sessionId,
        state: after.state,
        pid: after.pid,
        rssBytes: after.rssBytes,
        peakRssBytes: after.peakRssBytes,
        timings,
        walletMethods: methods,
        walletCalls: calls.length,
        thirdPartyHosts: [...hosts].sort(),
        problems,
      },
      null,
      1,
    ),
  );
  expect(after.state).toBe("DRY_RUN_COMPLETE");
  expect(problems).toEqual([]);
});

test("live soak (production runtime): 10 full route cycles on the same server; server RSS sampled after each cycle", async ({
  page,
}) => {
  test.setTimeout(420000);
  mkdirSync(SHOTS, { recursive: true });
  const origin = new URL(URL_!).origin;
  const rss = async () =>
    (
      (await (await fetch(`${origin}/g7-pilot/runtime`)).json()) as {
        rssBytes: number;
        peakRssBytes: number;
      }
    ).rssBytes;
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !EMBEDDED_IFRAME_REFUSED.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(URL_!);
  await expect(page.locator(".bridge-card")).toContainText("CONTROLLED PILOT", {
    timeout: 60000,
  });
  const samples: { cycle: number; rssBytes: number; cycleMs: number }[] = [
    { cycle: 0, rssBytes: await rss(), cycleMs: 0 },
  ];
  for (let cycle = 1; cycle <= 10; cycle++) {
    const at = Date.now();
    for (const href of [
      "/swap",
      "/portfolio",
      "/activity",
      "/networks",
      "/help",
      "/bridge",
    ]) {
      await page.locator(`nav.main-nav a[href="${href}"]`).click();
      if (href === "/bridge")
        await expect(page.locator(".bridge-card")).toContainText(
          "CONTROLLED PILOT",
        );
      else await expect(page.locator("main h1")).toBeVisible();
    }
    samples.push({ cycle, rssBytes: await rss(), cycleMs: Date.now() - at });
  }
  // Idle: one more sample after 60 s without navigation.
  await page.waitForTimeout(60000);
  samples.push({ cycle: -1, rssBytes: await rss(), cycleMs: 0 });
  writeFileSync(
    `${SHOTS}/live-soak.json`,
    JSON.stringify(
      { at: new Date().toISOString(), samples, problems },
      null,
      1,
    ),
  );
  expect(problems).toEqual([]);
});
