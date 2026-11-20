import { expect, type Page } from "@playwright/test";
import {
  installDoubles,
  WALLET_DOUBLES,
  type DoubleConfig,
} from "../gf1-wallet/doubles";
import { fixtureCatalog } from "../fixtures/routing";
const A = "0x1111111111111111111111111111111111111111";
const ORIGIN = "http://127.0.0.1:3470";
export async function setup(
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
export async function connect(page: Page) {
  await page
    .locator("section.manual-wallet")
    .getByRole("button", { name: "Connect Wallet", exact: true })
    .click();
  await page.getByTestId("rk-wallet-option-io.rabby").click();
  await expect(page.locator(".manual-account")).toContainText("Rabby");
}
export const quote = (page: Page) =>
  page
    .getByRole("button", {
      name: /Get live quote & Guardian review|Refresh quote/,
    })
    .first();
export const calls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __walletCalls: { method: string }[] })
        .__walletCalls ?? [],
  );
