// VWP G09: the wallet connection completed on the accepted default layer (Privy, connect-only), measured in the real
// product with the REAL Privy SDK against the deterministic Privy/WalletConnect doubles (./fixtures, ./privy-mock) and
// EIP-6963 wallet doubles: no App ID of a real Privy app, no third-party network, no real wallet, no signature, no
// transaction. Adds the states the G02/V1.9 suites did not prove for Privy: reload/reconnect, a rejected connection
// and retry, an unsupported network, no extension at all (WalletConnect QR is the only way in), and Guardian review
// compatibility with a connected wallet.
import type { Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { test, expect, privyModal } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";

const evidence = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/vwp"}/screenshots`;
const A = "0x3333333333333333333333333333333333333333";
const SIGNING = /sign|sendRaw|eth_sendTransaction|eth_signTypedData/i;
type Wallets = (keyof typeof WALLET_DOUBLES)[];

async function setup(
  page: Page,
  options: {
    wallets?: Wallets;
    chainId?: string;
    connect?: "accept" | "reject";
  } = {},
) {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", "en");
    localStorage.setItem("otherbridge.theme", "dark");
  });
  if ((options.wallets ?? ["metamask"]).length)
    await page.addInitScript(installWalletDoubles, {
      wallets: options.wallets ?? ["metamask"],
      account: A,
      chainId: options.chainId ?? "0x7a69",
      doubles: WALLET_DOUBLES,
      connect: options.connect ?? "accept",
    });
}
const walletCalls = (page: Page) =>
  page.evaluate(
    () =>
      ((window as unknown as { __walletCalls?: { method: string }[] })
        .__walletCalls ?? []) as { method: string }[],
  );
const headerWallet = (page: Page) => page.locator("header .wallet-button");
async function connect(page: Page, name: RegExp) {
  await headerWallet(page).click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page).getByRole("button", { name }).first().click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
}
test.beforeAll(async () => mkdir(evidence, { recursive: true }));

test("VWP-W1 reload: a connected Privy session does not come back by itself; connecting again is one explicit click", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/swap");
  await connect(page, /^MetaMask$/);
  await expect(headerWallet(page)).toContainText("0x3333…3333");
  await page.reload();
  await expect(page.getByTestId("swap-intelligence")).toBeVisible();
  // The wallet still remembers the site (eth_accounts would answer), yet VEINED starts disconnected.
  await expect(headerWallet(page)).toHaveText("Connect wallet", {
    timeout: 20000,
  });
  await connect(page, /^MetaMask$/);
  await expect(headerWallet(page)).toContainText("0x3333…3333");
  expect(
    (await walletCalls(page)).filter((c) => SIGNING.test(c.method)),
  ).toEqual([]);
});

test("VWP-W2 a connection rejected in the wallet leaves no session, says so, and a retry can still connect", async ({
  page,
}) => {
  await setup(page, { connect: "reject" });
  await page.goto("/bridge");
  await headerWallet(page).click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page)
    .getByRole("button", { name: /^MetaMask$/ })
    .first()
    .click();
  // Privy shows its own rejected/retry state; VEINED never shows a connected identity.
  await expect(privyModal(page)).toContainText(
    /reject|declin|denied|retry|try again/i,
    {
      timeout: 20000,
    },
  );
  await expect(headerWallet(page)).not.toContainText("0x3333");
  await page.screenshot({ path: `${evidence}/vwp-w2-rejected.png` });
  await page.keyboard.press("Escape");
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
  await expect(headerWallet(page)).toHaveText("Connect wallet");
  // The wallet now accepts: the same explicit path connects.
  await page.evaluate(() =>
    (
      window as unknown as {
        __wallets: Record<string, { setConnect: (m: string) => void }>;
      }
    ).__wallets.metamask.setConnect("accept"),
  );
  await connect(page, /^MetaMask$/);
  await expect(headerWallet(page)).toContainText("0x3333…3333");
  expect(
    (await walletCalls(page)).filter((c) => SIGNING.test(c.method)),
  ).toEqual([]);
});

test("VWP-W3 an unsupported network is shown as it is; VEINED never switches by itself and never asks to sign", async ({
  page,
}) => {
  // Polygon (0x89) is outside the trusted switch registry of this build (ONEchain, BSC, local 31337).
  await setup(page, { chainId: "0x89" });
  await page.goto("/bridge");
  await connect(page, /^MetaMask$/);
  await expect(headerWallet(page)).toContainText("0x3333…3333");
  await expect(headerWallet(page)).toContainText("#137");
  const calls = await walletCalls(page);
  expect(
    calls.filter((c) => /wallet_(switch|add)EthereumChain/.test(c.method)),
  ).toEqual([]);
  expect(calls.filter((c) => SIGNING.test(c.method))).toEqual([]);
  await page.screenshot({ path: `${evidence}/vwp-w3-unsupported.png` });
});

test("VWP-W4 no browser extension: only paths that need no extension are offered, nothing is fabricated, nothing connects by itself", async ({
  page,
}) => {
  // In the live app the Privy modal also lists WalletConnect's registry (QR / mobile; see the G09 live probe with the
  // owner's App ID). The deterministic registry double is empty, so here the only extension-free path is Coinbase
  // Wallet's own mobile path; the point proven is that no injected wallet is invented and no account is requested.
  await setup(page, { wallets: [] });
  await page.goto("/swap");
  await headerWallet(page).click();
  const modal = privyModal(page);
  await expect(modal).toBeVisible({ timeout: 20000 });
  await expect(
    modal.getByRole("button", { name: /Coinbase Wallet/ }).first(),
  ).toBeVisible();
  for (const name of [/^MetaMask$/, /^Rabby Wallet$/, /^Phantom$/])
    await expect(modal.getByRole("button", { name })).toHaveCount(0);
  await page.screenshot({ path: `${evidence}/vwp-w4-no-extension.png` });
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden({ timeout: 20000 });
  await expect(headerWallet(page)).toHaveText("Connect wallet");
  expect(await page.evaluate(() => "ethereum" in window)).toBe(false);
});

test("VWP-W5 Guardian stays compatible with a connected wallet: it reviews, sees the page, and never asks the wallet to sign", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/swap");
  await connect(page, /^MetaMask$/);
  await page.getByTestId("guardian-dock-trigger").click();
  const panel = page.getByTestId("guardian-dock-panel");
  await expect(panel.getByTestId("guardian-dock-context")).toBeVisible();
  await panel.locator(".gchat-chips .gchat-chip[data-chip='x-page']").click();
  await expect(panel.locator(".gchat-msg.is-guardian").last()).toContainText(
    /\w/,
  );
  await page.keyboard.press("Escape");
  // In-app navigation keeps the session (a full reload would end it, VWP-W1).
  await page
    .getByRole("link", { name: "Guardian", exact: true })
    .first()
    .click();
  await expect(page).toHaveURL(/\/guardian$/);
  await page.locator("#guardian-tab-inspect").click();
  await page.locator(".guardian-scenario").first().click();
  await page.getByRole("button", { name: "Review", exact: true }).click();
  await expect(page.locator(".guardian-panel").first()).toBeVisible({
    timeout: 20000,
  });
  await expect(headerWallet(page)).toContainText("0x3333…3333");
  expect(
    (await walletCalls(page)).filter((c) => SIGNING.test(c.method)),
  ).toEqual([]);
});
