// G7 pilot harness E2E with a recording mock wallet (fixture data, no network). Proves the page makes exactly one
// send-transaction request, only after the owner's click with both checkboxes + the exact phrase, with exactly the
// reviewed parameters; that dry-run never makes it; that rejection/error/wrong account/wrong chain stop; that the
// chain switch is a separate step followed by a full preflight refresh; and that nothing can be retried.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { startHarness, type Harness } from "./harness";
import {
  installMockWallet,
  type MockWalletConfig,
  type WalletCall,
} from "./mock-wallet";

const EOA = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
const PROXY = "0xb81d6e000000000000000000000000000000c0de";
const CROSS = "0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510";
const SEND = "eth_send" + "Transaction";
const ALLOWED = new Set([
  "eth_accounts",
  "eth_chainId",
  "eth_requestAccounts",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  SEND,
]);
const SHOTS = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g7-pilot";
const BUTTON = "Request wallet confirmation for ONE transaction";

let harness: Harness | null = null;
test.afterEach(() => {
  harness?.stop();
  harness = null;
});

async function open(
  page: Page,
  args: string[],
  wallet: Partial<MockWalletConfig> = {},
) {
  harness = await startHarness(args);
  await page.addInitScript(installMockWallet, {
    accounts: [EOA],
    chainId: "0x956d7",
    send: "hash",
    ...wallet,
  } satisfies MockWalletConfig);
  await page.goto(harness.url);
  return harness;
}
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __g7Mock: { calls: WalletCall[] } }).__g7Mock
        .calls,
  );
const sends = async (page: Page) =>
  (await calls(page)).filter((c) => c.method === SEND);
async function connect(page: Page) {
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.locator("#wallet")).toContainText("✓ matches");
}
async function confirmAll(page: Page) {
  await page.locator("#chk-scope").check();
  await page.locator("#chk-trust").check();
  await page.locator("#phrase").fill("G7 5 ONE");
}
const lock = (h: Harness) =>
  JSON.parse(readFileSync(join(h.stateDir, "g7-pilot-lock.json"), "utf8"));

test("real: one owner click => exactly one wallet request with the exact reviewed parameters => G7 PASS", async ({
  page,
}) => {
  const h = await open(page, ["--owner-approved", "--fixture", "ready"]);
  await expect(page.locator("#banner-title")).toContainText("READY");
  await expect(page.locator("#local-check")).toHaveText(
    "verified in this browser ✓",
  );
  await expect(page.locator("#mode-badge")).toHaveText(
    "REAL · OWNER-APPROVED · FIXTURE TEST",
  );
  // full addresses and amounts on the final screen
  const review = page.locator("#review");
  for (const text of [
    EOA,
    PROXY,
    CROSS,
    "5 ONE",
    "0.18 ONE",
    "5.18 ONE",
    "151862",
    "5.18075931 ONE",
    "5 CROSS",
    "0x5fd262de",
  ])
    await expect(review).toContainText(text);
  await expect(page.locator("#trust")).toContainText("2-of-3");
  await expect(page.locator("#trust")).toContainText(
    "0x22c1522276855b028c31a731ba10d125811af37c",
  );
  const button = page.getByRole("button", { name: BUTTON });
  await expect(button).toBeDisabled();
  await connect(page);
  await expect(button).toBeDisabled();
  await page.locator("#chk-scope").check();
  await expect(button).toBeDisabled();
  await page.locator("#chk-trust").check();
  await expect(button).toBeDisabled();
  await page.locator("#phrase").fill("g7 5 one");
  await expect(button).toBeDisabled();
  await page.locator("#phrase").fill("G7 5 ONE ");
  await expect(button).toBeDisabled();
  await page.locator("#phrase").fill("G7 5 ONE");
  await expect(button).toBeEnabled();
  expect(await sends(page)).toHaveLength(0);
  await page.screenshot({
    path: `${SHOTS}/g7-pilot-ready-confirmed.png`,
    fullPage: true,
  });
  const reviewedTx = await page.locator("#txparams").textContent();

  await button.click();
  await expect(page.locator("#send-msg")).toContainText(
    "Transaction hash from the wallet",
    { timeout: 30000 },
  );
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
  expect(params).toMatchObject({
    from: EOA,
    to: PROXY,
    value: "0x47e30e8e20860000",
    chainId: "0x956d7",
    gas: "0x25136",
  });
  expect(reviewedTx).toContain(params.data);
  expect(lock(h).tx).toEqual(params);
  for (const c of await calls(page)) expect(ALLOWED.has(c.method)).toBe(true);
  // the wallet request happened only after the fresh final preflight (owner click), never before
  const journal = readFileSync(
    join(h.stateDir, "session-journal.jsonl"),
    "utf8",
  );
  expect(journal).toContain('"event":"ARMABLE"');
  expect(journal).toContain('"event":"ARMED"');

  await expect(page.locator("#banner-title")).toContainText("G7 PASS", {
    timeout: 30000,
  });
  await expect(page.locator("#track")).toContainText("BridgeFinalized");
  await expect(button).toBeDisabled();
  await page.screenshot({
    path: `${SHOTS}/g7-pilot-g7-pass.png`,
    fullPage: true,
  });
  // reload: no second request can ever be made
  await page.reload();
  await expect(page.locator("#banner-title")).toContainText("G7 PASS");
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
  expect(await sends(page)).toHaveLength(0); // fresh page, and the server never re-releases the parameters
  expect(lock(h)).toMatchObject({
    state: "G7_PASS",
    hashSource: "wallet",
    txHash: "0x" + "ab".repeat(32),
  });
});

test("dry-run: the whole flow is verified but no wallet send request is ever made", async ({
  page,
}) => {
  const h = await open(page, ["--fixture", "ready"]);
  await expect(page.locator("#mode-badge")).toHaveText(
    "DRY RUN · FIXTURE TEST",
  );
  await connect(page);
  await confirmAll(page);
  await page.getByRole("button", { name: BUTTON }).click();
  await expect(page.locator("#send-msg")).toContainText("DRY RUN COMPLETE", {
    timeout: 30000,
  });
  await expect(page.locator("#txparams")).toContainText(
    "the wallet request was suppressed",
  );
  expect(await sends(page)).toHaveLength(0);
  expect(existsSync(join(h.stateDir, "g7-pilot-lock.json"))).toBe(false);
  await page.screenshot({
    path: `${SHOTS}/g7-pilot-dry-run-complete.png`,
    fullPage: true,
  });
});

test("wallet rejects => USER_REJECTED, stop, no retry (also after reload)", async ({
  page,
}) => {
  const h = await open(page, ["--owner-approved", "--fixture", "ready"], {
    send: "reject",
  });
  await connect(page);
  await confirmAll(page);
  await page.getByRole("button", { name: BUTTON }).click();
  await expect(page.locator("#banner-title")).toContainText("USER_REJECTED", {
    timeout: 30000,
  });
  expect(await sends(page)).toHaveLength(1);
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
  await expect(page.locator("#chk-scope")).toBeDisabled();
  expect(lock(h).state).toBe("USER_REJECTED");
  await page.reload();
  await expect(page.locator("#banner-title")).toContainText("USER_REJECTED");
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
});

test("provider error => MANUAL_REVIEW_REQUIRED, stop, no retry", async ({
  page,
}) => {
  const h = await open(page, ["--owner-approved", "--fixture", "ready"], {
    send: "error",
  });
  await connect(page);
  await confirmAll(page);
  await page.getByRole("button", { name: BUTTON }).click();
  await expect(page.locator("#banner-title")).toContainText(
    "MANUAL_REVIEW_REQUIRED",
    { timeout: 30000 },
  );
  expect(await sends(page)).toHaveLength(1);
  expect(lock(h).state).toBe("MANUAL_REVIEW_REQUIRED");
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
});

test("wallet never answers => ARMED; a reload can never produce a second request", async ({
  page,
}) => {
  await open(page, ["--owner-approved", "--fixture", "ready"], {
    send: "hang",
  });
  await connect(page);
  await confirmAll(page);
  await page.getByRole("button", { name: BUTTON }).click();
  await expect(page.locator("#send-msg")).toContainText(
    "Waiting for YOUR confirmation",
    { timeout: 30000 },
  );
  expect(await sends(page)).toHaveLength(1);
  await page.reload();
  await expect(page.locator("#banner-title")).toContainText(
    "One-shot wallet request released",
  );
  await expect(page.locator("#chk-scope")).toBeDisabled();
  await expect(page.locator("#connect")).toBeDisabled();
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
  expect(await sends(page)).toHaveLength(0);
});

test("wrong wallet account => STOP, the button never enables", async ({
  page,
}) => {
  await open(page, ["--owner-approved", "--fixture", "ready"], {
    accounts: ["0x1111111111111111111111111111111111111111"],
  });
  await page.getByRole("button", { name: "Connect wallet" }).click();
  await expect(page.locator("#wallet")).toContainText("NOT the approved EOA");
  await confirmAll(page);
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
  expect(await sends(page)).toHaveLength(0);
});

test("wrong chain => separate switch step, then a full preflight refresh; never sent in the same click", async ({
  page,
}) => {
  await open(page, ["--owner-approved", "--fixture", "ready"], {
    chainId: "0x38",
  });
  await connect(page).catch(() => undefined);
  await expect(page.locator("#wallet")).toContainText("not ONEchain");
  await confirmAll(page);
  const button = page.getByRole("button", { name: BUTTON });
  await expect(button).toBeDisabled();
  const before = await page.locator("#summary").textContent();
  expect(before).toContain("· initial ·");
  await page
    .getByRole("button", { name: "Switch wallet network to ONEchain (612055)" })
    .click();
  await expect(page.locator("#wallet")).toContainText("✓ ONEchain 612055");
  await expect(page.locator("#summary")).toContainText("· refresh ·", {
    timeout: 15000,
  });
  // confirmations were reset by the network change: a new, separate owner click is required
  await expect(page.locator("#chk-scope")).not.toBeChecked();
  await expect(button).toBeDisabled();
  expect((await calls(page)).map((c) => c.method)).toContain(
    "wallet_switchEthereumChain",
  );
  expect(await sends(page)).toHaveLength(0);
  await confirmAll(page);
  await expect(button).toBeEnabled();
});

test("startup bound exceeded => OWNER_REAPPROVAL_REQUIRED, no wallet request possible", async ({
  page,
}) => {
  await open(page, ["--owner-approved", "--fixture", "fee-above-bound"]);
  await expect(page.locator("#banner-title")).toContainText(
    "OWNER_REAPPROVAL_REQUIRED",
  );
  await expect(page.locator("#banner-reasons")).toContainText(
    "NETWORK_FEE_ABOVE_0_18_ONE",
  );
  await expect(page.locator("#connect")).toBeDisabled();
  await expect(page.locator("#chk-scope")).toBeDisabled();
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
  expect(await sends(page)).toHaveLength(0);
});

test("final fresh quote changed the transaction => no request, re-review required, then one request", async ({
  page,
}) => {
  await open(page, ["--owner-approved", "--fixture", "final-intent-changed"]);
  await connect(page);
  await confirmAll(page);
  await expect(page.locator("#review")).toContainText("0.18 ONE");
  await page.getByRole("button", { name: BUTTON }).click();
  await expect(page.locator("#send-msg")).toContainText(
    "changed the transaction",
    { timeout: 30000 },
  );
  expect(await sends(page)).toHaveLength(0);
  await expect(page.locator("#review")).toContainText("0.17 ONE");
  await expect(page.locator("#phrase")).toHaveValue("");
  await confirmAll(page);
  await page.getByRole("button", { name: BUTTON }).click();
  await expect(page.locator("#send-msg")).toContainText(
    "Transaction hash from the wallet",
    { timeout: 30000 },
  );
  const sent = await sends(page);
  expect(sent).toHaveLength(1);
  expect((sent[0].params as Record<string, string>[])[0].value).toBe(
    "0x" + (517n * 10n ** 16n).toString(16),
  );
});

test("fixture mode refuses every non-mock wallet identity", async ({
  page,
}) => {
  await open(page, ["--owner-approved", "--fixture", "ready"], {
    rdns: "io.metamask",
    isMock: false,
    name: "MetaMask",
  });
  await expect(page.locator("#provider")).toContainText(
    "waiting for the test mock wallet",
  );
  await confirmAll(page);
  await expect(page.getByRole("button", { name: BUTTON })).toBeDisabled();
  expect(await calls(page)).toHaveLength(0);
});

test("the page without the session token cannot use the API", async ({
  page,
}) => {
  harness = await startHarness(["--owner-approved", "--fixture", "ready"]);
  await page.goto(harness.origin + "/");
  await expect(page.locator("#banner-title")).toHaveText(
    "Missing session token",
  );
  const status = await page.evaluate(async () => {
    const r = await fetch("/api/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return r.status;
  });
  expect(status).toBe(401);
});
