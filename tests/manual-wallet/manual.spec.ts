import { test, expect, type Page } from "@playwright/test";
import {
  installDoubles,
  WALLET_DOUBLES,
  type DoubleConfig,
} from "../gf1-wallet/doubles";
import { fixtureCatalog } from "../fixtures/routing";
const A = "0x1111111111111111111111111111111111111111",
  B = "0x2222222222222222222222222222222222222222";
const ORIGIN = "http://127.0.0.1:3470";
async function setup(
  page: Page,
  options: {
    chain?: string;
    reject?: boolean;
    missing?: boolean;
    expiry?: number;
    realApi?: boolean;
    account?: string;
  } = {},
) {
  const bodies: Record<string, unknown>[] = [];
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "en", url: ORIGIN }]);
  await page.context().route("**/*", (r) => {
    const u = r.request().url();
    return u.startsWith(ORIGIN) || u.startsWith("data:")
      ? r.fallback()
      : r.abort();
  });
  await page.route("**/api/routing", (r) =>
    r.fulfill({ json: fixtureCatalog() }),
  );
  if (!options.missing)
    await page.addInitScript(installDoubles, {
      wallets: ["rabby"],
      account: options.account ?? A,
      chainId: options.chain ?? "0x2105",
      connect: options.reject ? "reject" : "accept",
      doubles: WALLET_DOUBLES,
    } as DoubleConfig);
  if (!options.realApi)
    await page.route("**/api/manual-wallet*", async (route) => {
      const req = route.request();
      if (req.method() === "GET")
        return route.fulfill({
          json: { csrf: "synthetic-csrf", released: false },
        });
      const b = req.postDataJSON();
      bodies.push(b);
      const isSwap = b.lane === "SWAP";
      const tx = {
        chainId: "0x2105",
        from: b.account,
        to: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
        value: "0x0",
        data:
          "0x095ea7b3" +
          "0".repeat(24) +
          "2626664c2603336e57b271c5c0b26f421741e481" +
          (isSwap ? "f4240" : "4c4b40").padStart(64, "0"),
        gas: "0x186a0",
        maxFeePerGas: "0x5f5e100",
        maxPriorityFeePerGas: "0x0",
      };
      if (b.action === "review")
        return route.fulfill({
          json: {
            review: {
              reviewId: "r1",
              route: isSwap ? "base-usdc-weth-univ3-max1" : "bridge-8453-42161",
              ready: true,
              step: "APPROVE",
              problems: [],
              block: "57860000",
              readAt: Date.now(),
              expiresAt: Date.now() + (options.expiry ?? 20_000),
              amountIn: isSwap ? "1000000" : "5000000",
              quoteOut: "550000000000000",
              amountOutMinimum: "547250000000000",
              slippageBps: 50,
              effectiveOutput: "4980000",
              minimumOut: "4900000",
              costBps: 40,
              balances: {
                usdc: "50000000",
                allowance: "0",
                eth: "1000000000000000",
                native: "1000000000000000",
              },
              gas: {
                worstCaseTotalWei: "2000000000000",
                budgetWei: "17700000000000",
              },
              guardian: {
                level: "CLEAR",
                digest: "0x" + "a".repeat(64),
                findings: [],
              },
              pins: { set: "synthetic-test-only", problems: [] },
              attestation: { synthetic: true },
            },
          },
        });
      if (b.action === "prepare")
        return route.fulfill({
          json: {
            preparation: {
              id: "a".repeat(64),
              reviewId: "r1",
              lane: b.lane,
              step: "APPROVE",
              transaction: tx,
              expiresAt: Date.now() + 20_000,
              serverTime: Date.now(),
              released: false,
            },
          },
        });
      if (b.action === "track")
        return route.fulfill({
          json: {
            tracking: {
              state:
                bodies.filter((x) => x.action === "track").length === 1
                  ? "DESTINATION_PENDING"
                  : "UNKNOWN",
              allowance: { value: "0", agree: true },
              settlement: null,
            },
          },
        });
      return route.fulfill({
        status: 409,
        json: { error: "OWNER_RELEASE_REQUIRED" },
      });
    });
  return bodies;
}
async function connect(page: Page) {
  await page
    .locator("section.manual-wallet")
    .getByRole("button", { name: "Connect Wallet", exact: true })
    .click();
  await page.getByTestId("rk-wallet-option-io.rabby").click();
  await expect(page.locator(".manual-account")).toContainText("Rabby");
}
const quote = (page: Page) =>
  page.getByRole("button", {
    name: "Get live quote & Guardian review",
    exact: true,
  });
const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __walletCalls: { method: string }[] })
        .__walletCalls ?? [],
  );
test("Rabby connection, live-review UI and exact approval preparation stop before manual signature", async ({
  page,
}) => {
  const bodies = await setup(page);
  await page.goto("/swap");
  await expect(quote(page)).toHaveCount(0);
  await connect(page);
  await quote(page).click();
  await expect(page.getByRole("status")).toContainText("READY");
  await page.getByRole("button", { name: "Prepare exact approval" }).click();
  await expect(page.getByLabel("Prepared wallet transaction")).toContainText(
    "Approve exactly 1 USDC",
  );
  await expect(page.getByLabel("Prepared wallet transaction")).toContainText(
    "OWNER_RELEASE_REQUIRED",
  );
  await expect(
    page.getByRole("button", { name: "Review & sign in wallet" }),
  ).toBeDisabled();
  expect(bodies.map((b) => b.action)).toEqual(["review", "prepare"]);
  expect(
    (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../evidence/swap-pre-sign.png",
    fullPage: true,
  });
});
test("wrong network never switches on connect; separate Base switch invalidates the session", async ({
  page,
}) => {
  await setup(page, { chain: "0x1" });
  await page.goto("/swap");
  await connect(page);
  await expect(quote(page)).toHaveCount(0);
  expect(
    (await calls(page)).filter(
      (c) => c.method === "wallet_switchEthereumChain",
    ),
  ).toHaveLength(0);
  await page
    .getByRole("button", { name: "Switch to Base", exact: true })
    .click();
  await expect(quote(page)).toBeEnabled();
  await expect(page.locator(".manual-account")).toContainText("8453");
});
test("account change removes the old quote and the next review binds the new account", async ({
  page,
}) => {
  const bodies = await setup(page);
  await page.goto("/swap");
  await connect(page);
  await quote(page).click();
  await expect(page.getByLabel("Guardian review")).toBeVisible();
  await page.evaluate(
    (address) =>
      (
        window as unknown as {
          __wallets: { rabby: { setAccounts: (a: string[]) => void } };
        }
      ).__wallets.rabby.setAccounts([address]),
    B,
  );
  await expect(page.locator(".manual-account [title]")).toHaveAttribute(
    "title",
    B,
  );
  await expect(page.getByLabel("Guardian review")).toHaveCount(0);
  await quote(page).click();
  await expect(page.getByLabel("Guardian review")).toBeVisible();
  expect(bodies.at(-1)?.account).toBe(B);
});
test("expired quote disables preparation without retry", async ({ page }) => {
  const bodies = await setup(page, { expiry: 1200 });
  await page.goto("/swap");
  await connect(page);
  await quote(page).click();
  await expect(
    page
      .locator(".mw-instrument")
      .getByRole("button", { name: "Refresh quote", exact: true }),
  ).toBeVisible({ timeout: 5000 });
  await expect(
    page.getByRole("button", { name: "Prepare exact approval" }),
  ).toHaveCount(0);
  expect(bodies).toHaveLength(1);
});
test("rejected connection and missing provider cannot reach quote or signature", async ({
  page,
}) => {
  await setup(page, { reject: true });
  await page.goto("/bridge");
  await page
    .locator("section.manual-wallet")
    .getByRole("button", { name: "Connect Wallet", exact: true })
    .click();
  await page.getByTestId("rk-wallet-option-io.rabby").click();
  await expect(quote(page)).toHaveCount(0);
  expect(
    (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
  ).toEqual([]);
});
test("Bridge preparation and repeated read-only tracking preserve PENDING and UNKNOWN", async ({
  page,
}) => {
  const bodies = await setup(page);
  await page.goto("/bridge");
  await connect(page);
  await quote(page).click();
  await page.getByRole("button", { name: "Prepare exact approval" }).click();
  await expect(page.getByLabel("Prepared wallet transaction")).toContainText(
    "Approve exactly 5 USDC",
  );
  await page
    .getByText("Details · route, fees & transaction", { exact: true })
    .click();
  await page
    .getByRole("button", { name: "Check receipts, settlement & balances" })
    .click();
  await expect(page.getByLabel("Receipt and settlement")).toContainText(
    "DESTINATION_PENDING",
  );
  await page
    .getByRole("button", { name: "Check receipts, settlement & balances" })
    .click();
  await expect(page.getByLabel("Receipt and settlement")).toContainText(
    '"state": "UNKNOWN"',
  );
  expect(bodies.filter((b) => b.action === "claim")).toHaveLength(0);
  expect(
    (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
  ).toEqual([]);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({
    path: "../evidence/bridge-pre-sign.png",
    fullPage: true,
  });
});
test("real production API refuses cross-origin, wrong chain, unsupported route and activation attempts", async ({
  request,
}) => {
  const session = await request.get(ORIGIN + "/api/manual-wallet");
  expect(session.status()).toBe(200);
  const { csrf } = await session.json();
  const headers = {
    origin: ORIGIN,
    "x-manual-csrf": csrf,
    "content-type": "application/json",
  };
  for (const body of [
    { action: "review", lane: "SWAP", account: A, chainId: 1 },
    { action: "review", lane: "OTHER", account: A, chainId: 8453 },
    {
      action: "claim",
      lane: "SWAP",
      account: A,
      chainId: 8453,
      released: true,
    },
  ]) {
    const res = await request.post(ORIGIN + "/api/manual-wallet", {
      headers,
      data: body,
    });
    expect(res.status()).toBe(409);
  }
  const attack = await request.post(ORIGIN + "/api/manual-wallet", {
    headers: { ...headers, origin: "https://untrusted.invalid" },
    data: { action: "review", lane: "SWAP", account: A, chainId: 8453 },
  });
  expect((await attack.json()).error).toBe("MANUAL_ORIGIN_REFUSED");
});
test("missing EVM provider cannot connect or request a quote", async ({
  page,
}) => {
  const bodies = await setup(page, { missing: true });
  await page.goto("/swap");
  await page
    .locator("section.manual-wallet")
    .getByRole("button", { name: "Connect Wallet", exact: true })
    .click();
  await expect(page.locator("[data-rk] [role=dialog]")).toBeVisible();
  await expect(page.getByTestId("rk-wallet-option-io.rabby")).toHaveCount(0);
  await expect(quote(page)).toHaveCount(0);
  expect(bodies).toHaveLength(0);
});
for (const proof of [
  { lane: "swap", address: "0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c" },
  { lane: "bridge", address: "0x7284D41b5b852F2bd4c99bDf95043D84452d299C" },
]) {
  test(`read-only real ${proof.lane} quote and preparation with a keyless public-address provider`, async ({
    page,
  }) => {
    await setup(page, { realApi: true, account: proof.address });
    const actions: string[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/manual-wallet") && r.method() === "POST")
        actions.push(r.postDataJSON().action);
    });
    await page.goto("/" + proof.lane);
    await connect(page);
    await quote(page).click();
    await expect(page.getByLabel("Guardian review")).toContainText(
      "READY · Guardian",
      { timeout: 45_000 },
    );
    await page.getByRole("button", { name: "Prepare exact approval" }).click();
    await expect(page.getByLabel("Prepared wallet transaction")).toContainText(
      "OWNER_RELEASE_REQUIRED",
    );
    await expect(
      page.getByRole("button", { name: "Review & sign in wallet" }),
    ).toBeDisabled();
    expect(actions).toEqual(["review", "prepare"]);
    expect(
      (await calls(page)).filter((c) => /send|sign/i.test(c.method)),
    ).toEqual([]);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.screenshot({
      path: `../evidence/real-${proof.lane}-pre-sign.png`,
      fullPage: true,
    });
  });
}
