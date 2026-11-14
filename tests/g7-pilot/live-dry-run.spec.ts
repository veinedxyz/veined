// LIVE dry run (opt-in): drives an already running `pnpm g7:pilot --dry-run` harness (real read-only mainnet
// preflight) through the whole owner flow up to the final step with a generic recording wallet. Dry-run mode never
// releases the transaction parameters, so no send request can exist; the test asserts that none was made.
// Usage: G7_PILOT_LIVE_DRY_RUN_URL=<printed URL> pnpm g7:pilot:e2e live-dry-run
import { expect, test } from "@playwright/test";
import {
  installMockWallet,
  type MockWalletConfig,
  type WalletCall,
} from "./mock-wallet";

const URL_ = process.env.G7_PILOT_LIVE_DRY_RUN_URL;
const SHOTS = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g7-pilot";
test.skip(
  !URL_,
  "set G7_PILOT_LIVE_DRY_RUN_URL to the URL printed by `pnpm g7:pilot --dry-run`",
);

test("live dry run: fresh mainnet preflight READY, final preflight armable, wallet request suppressed", async ({
  page,
}) => {
  test.setTimeout(180000);
  await page.addInitScript(installMockWallet, {
    accounts: ["0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c"],
    chainId: "0x956d7",
    send: "hash",
    rdns: "test.local.dry-run-wallet",
    isMock: false,
    name: "Dry-run recording wallet",
  } satisfies MockWalletConfig);
  await page.goto(URL_!);
  await expect(page.locator("#mode-badge")).toHaveText("DRY RUN");
  await expect(page.locator("#banner-title")).toContainText("READY", {
    timeout: 120000,
  });
  await expect(page.locator("#local-check")).toHaveText(
    "verified in this browser ✓",
  );
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.locator("#wallet")).toContainText("✓ matches");
  await page.locator("#chk-scope").check();
  await page.locator("#chk-trust").check();
  await page.locator("#phrase").fill("G7 5 ONE");
  await page.screenshot({
    path: `${SHOTS}/g7-pilot-live-dry-run-ready.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", {
      name: "Request wallet confirmation for ONE transaction",
    })
    .click();
  await expect(page.locator("#send-msg")).toContainText(
    /DRY RUN COMPLETE|No wallet request was made/,
    {
      timeout: 120000,
    },
  );
  await page.screenshot({
    path: `${SHOTS}/g7-pilot-live-dry-run-complete.png`,
    fullPage: true,
  });
  await expect(page.locator("#send-msg")).toContainText("DRY RUN COMPLETE");
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
