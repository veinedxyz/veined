// In-product G7 pilot E2E (fixture pilot data, recording mock wallet). The normal Otherbridge Bridge screen must:
// lock the pilot to exactly 5 ONE (no MAX, no edits), accept only the new pilot EOA, keep the chain switch a
// separate step followed by a fresh check, require both checkboxes + the exact phrase, make exactly one wallet
// send request with the reviewed parameters, stop on rejection/errors/bounds, and show product-style tracking.
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, privyModal } from "../e2e/fixtures";
import { startHarness, type Harness } from "./harness";
import {
  installMockWallet,
  type MockWalletConfig,
  type WalletCall,
} from "./mock-wallet";

const EOA = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
const OLD_EOA = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const PROXY = "0xb81d6e000000000000000000000000000000c0de";
const SEND = "eth_send" + "Transaction";
const SHOTS =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g7-product-pilot";
const ALLOWED = new Set([
  "eth_accounts",
  "eth_chainId",
  "eth_requestAccounts",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  SEND,
]);

let harness: Harness | null = null;
test.afterEach(async () => {
  if (!harness) return;
  const h = harness;
  harness = null;
  h.stop();
  await h.stopped;
});
async function open(
  page: Page,
  scenario: string,
  wallet: Partial<MockWalletConfig> = {},
  extra: string[] = [],
) {
  harness = await startHarness(
    ["--fixture", scenario, ...extra],
    "scripts/g7-product-pilot.ts",
    180000,
  );
  await page.addInitScript(installMockWallet, {
    accounts: [EOA],
    chainId: "0x956d7",
    send: "hash",
    ...wallet,
  } satisfies MockWalletConfig);
  await page.goto(harness.url);
  await expect(page.locator(".bridge-card")).toContainText(
    "CONTROLLED PILOT · LOCAL ONLY · 5 ONE AUTHORIZED",
    {
      timeout: 120000,
    },
  );
  return harness;
}
const card = (page: Page) => page.locator(".bridge-card");
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __g7Mock: { calls: WalletCall[] } }).__g7Mock
        .calls,
  );
const sends = async (page: Page) =>
  (await calls(page)).filter((c) => c.method === SEND);
async function connect(page: Page) {
  // V1.9: the Bridge card's Connect wallet opens the Privy connect-only modal; the mock wallet is a detected
  // EIP-6963 extension there.
  await card(page).getByRole("button", { name: "Connect wallet" }).click();
  await expect(privyModal(page)).toBeVisible({ timeout: 30000 });
  await privyModal(page)
    .getByRole("button", { name: /G7 Mock Wallet/ })
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 30000 });
  await expect(card(page).locator(".recipient")).toContainText(
    /0x[0-9a-fA-F]{40}/,
  );
}
const reviewButton = (page: Page) =>
  card(page).getByRole("button", { name: /Review transfer/ });
const walletButton = (page: Page) =>
  page.getByRole("button", { name: /Review in wallet/ });
async function openReviewAndConfirm(page: Page) {
  await expect(reviewButton(page)).toBeEnabled({ timeout: 30000 });
  await reviewButton(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review the 5 ONE pilot transfer",
  });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel("I reviewed the 5 ONE pilot transaction.").check();
  await dialog
    .getByLabel(
      "I accept the centralized ONEbridge trust model for this pilot.",
    )
    .check();
  await dialog.locator("#pilot-phrase").fill("G7 5 ONE");
  return dialog;
}
const lock = (h: Harness) =>
  JSON.parse(readFileSync(join(h.stateDir, "g7-pilot-lock.json"), "utf8"));

test("new EOA: normal Bridge flow, 5 ONE locked, one wallet request with the reviewed parameters, tracked to Completed", async ({
  page,
}) => {
  const h = await open(page, "ready");
  // normal product screen, small pilot badge, amount locked to 5 ONE, no MAX
  await expect(page.locator("header")).toContainText("Otherbridge");
  const amount = card(page).locator("#pilot-amount");
  await expect(amount).toHaveValue("5");
  await expect(amount).toHaveAttribute("readonly", "");
  await expect(card(page).getByRole("button", { name: "MAX" })).toHaveCount(0);
  await expect(card(page)).toContainText("Balance: 10 ONE");
  await expect(card(page)).toContainText(
    "One transaction · 5 ONE · no approval",
  );
  await connect(page);
  await expect(card(page)).toContainText("0.18 ONE");
  await expect(card(page)).toContainText("5.18075931 ONE");
  await expect(card(page)).toContainText("5 CROSS");
  await page.screenshot({
    path: `${SHOTS}/product-pilot-bridge-dark-desktop.png`,
    fullPage: true,
  });
  await expect(reviewButton(page)).toBeEnabled({ timeout: 30000 });
  await reviewButton(page).click();
  const dialog = page.getByRole("dialog", {
    name: "Review the 5 ONE pilot transfer",
  });
  for (const text of [
    "You pay",
    "5 ONE",
    "0.18 ONE",
    "Estimated gas",
    "5.18075931 ONE",
    "5 CROSS",
    EOA,
    "same wallet",
    "None",
  ])
    await expect(dialog).toContainText(text);
  // safety details stay behind an expandable section
  const details = dialog.locator("details");
  await expect(details).not.toHaveAttribute("open", "");
  await details.locator("summary").click();
  for (const text of [
    "Runtime pins",
    "0x2827865ad5330faf855af8b743c701ae9c818034",
    "0xac7b8ffed19d670930b8caa0693189b33454e8d8",
    "Reserve",
    "Firewall",
    "RPC consensus",
    "Authority",
    "Calldata hash",
    "Intent digest",
    "re-verified in this browser ✓",
  ])
    await expect(details).toContainText(text);
  const button = walletButton(page);
  await expect(button).toBeDisabled();
  await dialog.getByLabel("I reviewed the 5 ONE pilot transaction.").check();
  await expect(button).toBeDisabled();
  await dialog
    .getByLabel(
      "I accept the centralized ONEbridge trust model for this pilot.",
    )
    .check();
  await expect(button).toBeDisabled();
  await dialog.locator("#pilot-phrase").fill("g7 5 one");
  await expect(button).toBeDisabled();
  await dialog.locator("#pilot-phrase").fill("G7 5 ONE");
  await expect(button).toBeEnabled();
  await expect(dialog).toContainText("One transaction · 5 ONE · no approval");
  expect(await sends(page)).toHaveLength(0);
  await page.screenshot({
    path: `${SHOTS}/product-pilot-review-dark-desktop.png`,
    fullPage: true,
  });
  await button.click();
  await expect(card(page)).toContainText("Completed", { timeout: 60000 });
  const sent = await sends(page);
  expect(sent).toHaveLength(1);
  const params = (sent[0].params as Record<string, string>[])[0];
  expect(Object.keys(params).sort()).toEqual(
    [
      "chainId",
      "data",
      "from",
      "gas",
      "maxFeePerGas",
      "maxPriorityFeePerGas",
      "to",
      "value",
    ].sort(),
  );
  // exactly 5 ONE + 0.18 ONE although the wallet holds 10 ONE; recipient = the new EOA
  expect(params).toMatchObject({
    from: EOA,
    to: PROXY,
    value: "0x47e30e8e20860000",
    chainId: "0x956d7",
  });
  expect(params.data.slice(0, 10)).toBe("0x5fd262de");
  expect(params.data).toContain(EOA.slice(2));
  expect(params.data).not.toContain(OLD_EOA.slice(2));
  for (const c of await calls(page)) expect(ALLOWED.has(c.method)).toBe(true);
  await expect(page.locator(".bridge-card li").last()).toContainText(
    "Completed",
  );
  await expect(card(page)).toContainText(
    `exactly 5 CROSS delivered to 0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c`,
    {
      timeout: 30000,
    },
  );
  expect(lock(h)).toMatchObject({
    state: "G7_PASS",
    hashSource: "wallet",
    txHash: "0x" + "ab".repeat(32),
  });
  expect(lock(h).tx).toEqual(params);
  await page.screenshot({
    path: `${SHOTS}/product-pilot-completed-dark-desktop.png`,
    fullPage: true,
  });
  // no retry after a reload either
  await page.reload();
  await expect(card(page)).toContainText("Completed", { timeout: 60000 });
  await expect(
    card(page).getByRole("button", { name: /Review transfer/ }),
  ).toHaveCount(0);
  expect(await sends(page)).toHaveLength(0);
});

test("old EOA is not authorized: execution closed", async ({ page }) => {
  await open(page, "ready", { accounts: [OLD_EOA] });
  await connect(page);
  await expect(card(page)).toContainText(
    "This wallet is not authorized for the G7 pilot.",
  );
  await expect(reviewButton(page)).toBeDisabled();
  expect(await sends(page)).toHaveLength(0);
});

test("amount cannot be changed and there is no MAX", async ({ page }) => {
  await open(page, "ready");
  const amount = card(page).locator("#pilot-amount");
  await amount.focus();
  await page.keyboard.press("End");
  await page.keyboard.type("0");
  await page.keyboard.press("Backspace");
  await expect(amount).toHaveValue("5");
  await expect(card(page).getByRole("button", { name: "MAX" })).toHaveCount(0);
});

test("wrong chain: separate Switch to ONEchain step, then a fresh check; never sent in the same click", async ({
  page,
}) => {
  const h = await open(page, "ready", { chainId: "0x38" });
  await connect(page);
  await expect(reviewButton(page)).toBeDisabled();
  const switchButton = card(page).getByRole("button", {
    name: "Switch to ONEchain",
  });
  await expect(switchButton).toBeVisible();
  await switchButton.click();
  await expect(switchButton).toHaveCount(0, { timeout: 15000 });
  await expect
    .poll(
      () =>
        readFileSync(
          join(h.stateDir, "session-journal.jsonl"),
          "utf8",
        ).includes('"kind":"refresh"'),
      {
        timeout: 30000,
      },
    )
    .toBe(true);
  expect((await calls(page)).map((c) => c.method)).toContain(
    "wallet_switchEthereumChain",
  );
  expect(await sends(page)).toHaveLength(0);
  await expect(reviewButton(page)).toBeEnabled({ timeout: 30000 });
});

test("wallet rejection: USER_REJECTED, stop, no retry", async ({ page }) => {
  const h = await open(page, "ready", { send: "reject" });
  await connect(page);
  await openReviewAndConfirm(page);
  await walletButton(page).click();
  await expect(page.getByRole("dialog")).toContainText(
    "You rejected the transaction in your wallet",
    { timeout: 60000 },
  );
  expect(await sends(page)).toHaveLength(1);
  expect(lock(h).state).toBe("USER_REJECTED");
  await expect(walletButton(page)).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(reviewButton(page)).toBeDisabled();
  await expect(card(page)).toContainText(
    "The pilot is stopped; there is no retry.",
  );
});

test("provider error: MANUAL_REVIEW_REQUIRED, stop", async ({ page }) => {
  const h = await open(page, "ready", { send: "error" });
  await connect(page);
  await openReviewAndConfirm(page);
  await walletButton(page).click();
  await expect(page.getByRole("dialog")).toContainText(
    "Manual review required",
    { timeout: 60000 },
  );
  expect(await sends(page)).toHaveLength(1);
  expect(lock(h).state).toBe("MANUAL_REVIEW_REQUIRED");
});

test("duplicate click still makes exactly one wallet request", async ({
  page,
}) => {
  await open(page, "ready", { send: "hang" });
  await connect(page);
  await openReviewAndConfirm(page);
  await walletButton(page).dblclick();
  await page.waitForTimeout(500);
  await walletButton(page)
    .click({ force: true })
    .catch(() => undefined);
  await expect(page.getByRole("dialog")).toContainText(
    "Confirm in your wallet",
    { timeout: 60000 },
  );
  await page.waitForTimeout(1500);
  expect(await sends(page)).toHaveLength(1);
});

test("network fee above 0.18 ONE: OWNER_REAPPROVAL_REQUIRED, no wallet request possible", async ({
  page,
}) => {
  await open(page, "fee-above-bound");
  await connect(page);
  await expect(card(page)).toContainText("Owner re-approval required");
  await expect(reviewButton(page)).toBeDisabled();
  expect(await sends(page)).toHaveLength(0);
});

test("runtime drift: route review required, no wallet request possible", async ({
  page,
}) => {
  await open(page, "drift");
  await connect(page);
  await expect(card(page)).toContainText("Route review required");
  await expect(reviewButton(page)).toBeDisabled();
  expect(await sends(page)).toHaveLength(0);
});

test("light theme and mobile layout of the pilot Bridge card; local-only server envelope", async ({
  page,
}) => {
  const h = await open(page, "ready");
  await connect(page);
  await page.getByRole("button", { name: "Appearance" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: `${SHOTS}/product-pilot-bridge-light-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card(page)).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
  await page.screenshot({
    path: `${SHOTS}/product-pilot-bridge-light-mobile.png`,
    fullPage: true,
  });
  await reviewButton(page).click();
  await page.screenshot({
    path: `${SHOTS}/product-pilot-review-light-mobile.png`,
    fullPage: true,
  });
  // local-only envelope of the product launcher
  const port = Number(new URL(h.origin).port);
  const raw = (
    headers: Record<string, string>,
    path = "/g7-pilot/api/state",
    method = "POST",
  ) =>
    new Promise<number>((resolve, reject) => {
      const r = request(
        { host: "127.0.0.1", port, path, method, headers, agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      r.on("error", reject);
      r.end("{}");
    });
  expect(await raw({ host: `localhost:${port}` }, "/", "GET")).toBe(421);
  expect(
    await raw({ host: `evil.example:${port}` }, "/g7-pilot/api/state"),
  ).toBe(421);
  expect(
    await raw({
      host: `127.0.0.1:${port}`,
      origin: "http://evil.example",
      "content-type": "application/json",
    }),
  ).toBe(403);
  expect(
    await raw({
      host: `127.0.0.1:${port}`,
      origin: h.origin,
      "content-type": "application/json",
    }),
  ).toBe(401);
  expect(
    await raw(
      { host: `127.0.0.1:${port}`, origin: h.origin },
      "/g7-pilot/api/state",
      "OPTIONS",
    ),
  ).toBe(405);
});
