// LIVE in-product dry run (opt-in): drives an already running `pnpm g7:product-pilot --dry-run` (real read-only
// mainnet preflight for the authorized EOA) through the normal Bridge flow up to the final step with a generic
// recording wallet. Dry-run never releases the transaction parameters, so no send request can exist.
// Usage: G7_PRODUCT_LIVE_DRY_RUN_URL=<printed URL> pnpm g7:product-pilot:e2e product-live-dry-run
import { expect, test, privyModal } from "../e2e/fixtures";
import {
  installMockWallet,
  type MockWalletConfig,
  type WalletCall,
} from "./mock-wallet";

const URL_ = process.env.G7_PRODUCT_LIVE_DRY_RUN_URL;
const SHOTS =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g7-product-pilot";
test.skip(
  !URL_,
  "set G7_PRODUCT_LIVE_DRY_RUN_URL to the URL printed by `pnpm g7:product-pilot --dry-run`",
);

test("live in-product dry run: Bridge → 5 ONE → Review → Review in wallet; final step suppressed", async ({
  page,
}) => {
  test.setTimeout(300000);
  await page.addInitScript(installMockWallet, {
    accounts: ["0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c"],
    chainId: "0x956d7",
    send: "hash",
    rdns: "test.local.dry-run-wallet",
    isMock: false,
    name: "Dry-run recording wallet",
  } satisfies MockWalletConfig);
  await page.goto(URL_!);
  const card = page.locator(".bridge-card");
  await expect(card).toContainText("CONTROLLED PILOT", { timeout: 180000 });
  // V1.9: connect through the Privy connect-only modal (launcher started with the test App ID; the Privy and
  // WalletConnect backends are answered by the deterministic doubles of tests/e2e/fixtures.ts).
  await card.getByRole("button", { name: "Connect wallet" }).click();
  await expect(privyModal(page)).toBeVisible({ timeout: 30000 });
  await privyModal(page)
    .getByRole("button", { name: /Dry-run recording wallet/ })
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 30000 });
  const review = card.getByRole("button", { name: /Review transfer/ });
  await expect(review).toBeEnabled({ timeout: 120000 });
  await expect(card).toContainText("0.18 ONE");
  await page.screenshot({
    path: `${SHOTS}/product-pilot-live-dry-run-bridge.png`,
    fullPage: true,
  });
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
    path: `${SHOTS}/product-pilot-live-dry-run-review.png`,
    fullPage: true,
  });
  await dialog.getByRole("button", { name: /Review in wallet/ }).click();
  await expect(dialog).toContainText(
    /Dry run complete|No wallet request was made/,
    {
      timeout: 120000,
    },
  );
  await expect(dialog).toContainText("Dry run complete");
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __g7Mock: { calls: WalletCall[] } }).__g7Mock
        .calls,
  );
  expect(
    calls.filter((c) => c.method === "eth_send" + "Transaction"),
  ).toHaveLength(0);
  expect(new Set(calls.map((c) => c.method))).toEqual(
    new Set(["eth_accounts", "eth_chainId", "eth_requestAccounts"]),
  );
});
