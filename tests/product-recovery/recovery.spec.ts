import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { writeFileSync, mkdirSync } from "node:fs";
import { setup, connect, quote, calls } from "../visual-restoration/helpers";
const dir = "../evidence/portfolio-regression";
mkdirSync(dir, { recursive: true });
const address = "0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c";
const refs = [
  {
    chainId: "8453",
    hash: "0x556980061d955e7426c29c95ca14ce83e6aa00b34b544d4e12b7da352232c90e",
    kind: "Swap",
  },
  {
    chainId: "8453",
    hash: "0x8f828b066f924e6154101bba490bd6d29d42bd06ad3808675f1f46ab7ebde45b",
    kind: "Bridge",
  },
  {
    chainId: "42161",
    hash: "0x7b28bc8f945fcf7188177178791ec373afee4933b41353f50fe29927f9d1199a",
    kind: "Destination settlement",
  },
  {
    chainId: "8453",
    hash: "0x2c08e019681554c6c9fe2c86f342732416514d489ef7ca5d5bb8681ad32dc7f8",
    kind: "Approval",
  },
  {
    chainId: "8453",
    hash: "0xbf8a3253b032e55b53241d61fc0e061c145d5c0cce6bf95ed9885278f93f21a6",
    kind: "Approval",
  },
];
async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${dir}/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}
function review(lane: string, sufficient: boolean, blocked: boolean) {
  return {
    reviewId: "synthetic-policy",
    ready: !blocked,
    step: sufficient ? (lane === "swap" ? "SWAP" : "EXECUTE") : "APPROVE",
    amountIn: lane === "swap" ? "1000000" : "5000000",
    quoteOut: "550000000000000",
    amountOutMinimum: "547250000000000",
    effectiveOutput: "4980000",
    minimumOut: "4900000",
    feeTotal: "20000",
    costBps: 40,
    slippageBps: 50,
    priceImpactBps: 5,
    expiresAt: Date.now() + 120000,
    balances: {
      usdc: "50000000",
      allowance: sufficient ? "10000000" : "0",
      eth: "1000000000000000",
      native: "1000000000000000",
    },
    ...(sufficient ? { reusedAllowance: "10000000" } : {}),
    gas: {
      worstCaseTotalWei: "2000000000000",
      l1FeeWei: "1000000000",
      budgetWei: "17700000000000",
    },
    problems: blocked ? ["SPENDER_NOT_VERIFIED"] : [],
    guardian: {
      level: blocked ? "BLOCK" : "CLEAR",
      findings: blocked ? ["SPENDER_NOT_VERIFIED"] : [],
      digest: "0x" + "a".repeat(64),
    },
  };
}
for (const width of [1440, 390]) {
  for (const lane of ["swap", "bridge"]) {
    test(`${lane} ${width}: simple view, details, CLEAR/BLOCK and existing/missing allowance`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await setup(page, { expiry: 120000 });
      await page.goto(`/${lane}`);
      await expect(page.locator("section.manual-wallet .primary")).toHaveCount(
        1,
      );
      await expect(page.getByLabel("Advanced details")).toHaveJSProperty(
        "open",
        false,
      );
      await expect(page.getByLabel("Provider comparison")).toBeHidden();
      await shot(page, `${lane}-${width}-simple-disconnected`);
      await connect(page);
      await quote(page).click();
      await expect(page.getByLabel("Guardian review")).toContainText(
        "Guardian CLEAR",
      );
      await expect(page.getByLabel("Guardian review")).toContainText(
        "Permission needed",
      );
      await shot(page, `${lane}-${width}-clear-missing-allowance`);
      await page
        .getByText("Details · route, fees & transaction", { exact: true })
        .click();
      await expect(page.getByLabel("Provider comparison")).toBeVisible();
      await shot(page, `${lane}-${width}-details-open`);
      let blocked = false;
      await page.route("**/api/manual-wallet*", (route) =>
        route.request().method() === "POST" &&
        route.request().postDataJSON().action === "review"
          ? route.fulfill({ json: { review: review(lane, true, blocked) } })
          : route.fallback(),
      );
      await quote(page).click();
      await expect(page.getByLabel("Guardian review")).toContainText(
        "No additional approval requested",
      );
      await expect(
        page.getByRole("button", {
          name: `Prepare exact ${lane}`,
          exact: true,
        }),
      ).toBeEnabled();
      await page
        .getByText("Details · route, fees & transaction", { exact: true })
        .click();
      await shot(page, `${lane}-${width}-existing-allowance`);
      await page
        .getByText("Details · route, fees & transaction", { exact: true })
        .click();
      blocked = true;
      await quote(page).click();
      await expect(page.getByLabel("Guardian review")).toContainText(
        "STOP · Guardian BLOCK",
      );
      await expect(page.getByLabel("Guardian review")).toContainText(
        "could not be verified",
      );
      await expect(
        page.getByRole("button", { name: /Prepare exact/ }),
      ).toHaveCount(0);
      await page
        .getByText("Details · route, fees & transaction", { exact: true })
        .click();
      await shot(page, `${lane}-${width}-guardian-block`);
      await page
        .getByText("Security details · Ask Guardian", { exact: true })
        .click();
      await expect(page.locator(".mw-security-details")).toContainText(
        "SPENDER_NOT_VERIFIED",
      );
      await shot(page, `${lane}-${width}-security-open`);
      expect(
        (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
      ).toEqual([]);
    });
  }
  test(`Portfolio ${width}: explicit real scan, provider failure/recovery, address identity`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await setup(page, { realApi: true, account: address });
    await page.unroute("**/api/routing");
    const posted: unknown[] = [];
    page.on("request", (r) => {
      if (r.url().endsWith("/api/portfolio") && r.method() === "POST")
        posted.push(r.postDataJSON());
    });
    if (width === 1440) {
      await page.goto("/swap");
      await connect(page);
      await page.locator('a[href="/portfolio"]').first().click();
      await expect(page.locator(".scan-primary [title]")).toHaveAttribute(
        "title",
        address,
      );
      await expect(
        page.getByLabel(
          "Automatically scan and refresh this address while Portfolio is open",
        ),
      ).not.toBeChecked();
    } else {
      await page.goto("/portfolio");
      await page
        .getByRole("textbox", { name: "evm Source address", exact: true })
        .fill(address);
    }
    await expect(
      page.getByRole("button", { name: "Scan balances", exact: true }),
    ).toBeEnabled();
    expect(posted).toHaveLength(0);
    let fail = true;
    await page.route("**/api/portfolio", (r) => {
      if (fail) {
        fail = false;
        return r.fulfill({
          status: 503,
          json: {
            error: "PROVIDER_UNAVAILABLE",
            requestId: "synthetic-outage",
          },
        });
      }
      return r.fallback();
    });
    await page
      .getByRole("button", { name: "Scan balances", exact: true })
      .click();
    await expect(page.locator(".portfolio-connect")).toContainText(
      "PROVIDER_UNAVAILABLE",
    );
    await expect(page.getByTestId("portfolio-summary")).toHaveCount(0);
    await shot(page, `portfolio-${width}-provider-failure`);
    const response = page.waitForResponse(
      (r) => r.url().endsWith("/api/portfolio") && r.status() === 200,
    );
    await page
      .getByRole("button", { name: "Scan balances", exact: true })
      .click();
    expect((await response).status()).toBe(200);
    await expect(page.getByTestId("portfolio-summary")).toBeVisible();
    await expect(
      page.locator(
        '[data-holding-chain="8453"][data-token="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"]',
      ),
    ).toBeVisible();
    expect(JSON.stringify(posted)).toContain(address);
    await expect(page.locator(".scan-button")).toBeEnabled({
      timeout: 60000,
    });
    await shot(page, `portfolio-${width}-real-scan`);
    const proof = await page.request.post("/api/portfolio", {
      headers: { Origin: "http://127.0.0.1:3470" },
      data: {
        identity: { evm: address },
        consent: true,
        priority: ["8453", "42161"],
      },
    });
    expect(proof.status()).toBe(200);
    const body = await proof.text();
    writeFileSync(`${dir}/portfolio-${width}-live.json`, body);
    expect(body).toContain('"balance":"3995526"');
    expect(body).toContain('"balance":"551076565643201"');
    expect(body).toContain('"balance":"4980490"');
    if (width === 1440) {
      await page.evaluate(() =>
        (
          window as unknown as {
            __wallets: { rabby: { setAccounts: (a: string[]) => void } };
          }
        ).__wallets.rabby.setAccounts([
          "0x2222222222222222222222222222222222222222",
        ]),
      );
      await expect(page.getByTestId("portfolio-summary")).toHaveCount(0);
      await expect(
        page.getByLabel(
          "Automatically scan and refresh this address while Portfolio is open",
        ),
      ).not.toBeChecked();
    }
    expect(
      (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
    ).toEqual([]);
  });
  test(`Activity and Scan ${width}: five real imports, failure recovery, wrong address rejection`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await setup(page);
    await page.goto("/activity");
    const panel = page.getByLabel("Verified wallet activity");
    await expect(panel.locator(".va-row")).toHaveCount(0);
    await panel.getByLabel("Activity wallet address").fill(address);
    await panel
      .getByLabel("Transaction hash", { exact: true })
      .fill(refs[0].hash);
    await panel.getByRole("checkbox").check();
    let fail = true;
    await page.route("**/api/activity", (r) => {
      if (fail) {
        fail = false;
        return r.fulfill({
          status: 503,
          json: {
            error: "VERIFICATION_UNAVAILABLE",
            requestId: "synthetic-outage",
            sources: [
              { operator: "base-coinbase", code: "PROVIDER_UNAVAILABLE" },
            ],
          },
        });
      }
      return r.fallback();
    });
    await panel
      .getByRole("button", { name: "Verify transaction", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("base-coinbase");
    await expect(panel.locator(".va-row")).toHaveCount(0);
    await shot(page, `activity-${width}-provider-failure`);
    const replies: unknown[] = [];
    page.on("response", async (r) => {
      if (r.url().endsWith("/api/activity") && r.ok())
        replies.push(await r.json());
    });
    for (const [i, ref] of refs.entries()) {
      await panel.getByLabel("Transaction network").selectOption(ref.chainId);
      await panel
        .getByLabel("Transaction hash", { exact: true })
        .fill(ref.hash);
      await panel
        .getByRole("button", { name: "Verify transaction", exact: true })
        .click();
      await expect(panel.locator(".va-row")).toHaveCount(i + 1);
      await expect(panel.locator(`a[href$="${ref.hash}"]`)).toBeVisible();
    }
    await expect(panel).toContainText(
      "Source and destination receipts match this Across deposit.",
    );
    writeFileSync(
      `${dir}/activity-${width}-live.json`,
      JSON.stringify(replies, null, 2),
    );
    await shot(page, `activity-${width}-five-real-transactions`);
    const axe = await new AxeBuilder({ page })
      .include(".verified-activity")
      .analyze();
    writeFileSync(
      `${dir}/activity-${width}-axe.json`,
      JSON.stringify(axe.violations, null, 2),
    );
    expect(axe.violations).toEqual([]);
    await panel
      .getByLabel("Activity wallet address")
      .fill("0x3333333333333333333333333333333333333333");
    await panel.getByRole("checkbox").check();
    await panel
      .getByRole("button", { name: "Verify transaction", exact: true })
      .click();
    await expect(panel.getByRole("alert")).toContainText("not involved");
    await expect(panel.locator(".va-row")).toHaveCount(0);
    await shot(page, `activity-${width}-wrong-address`);
    await page.evaluate((address) => {
      const key = `veined:verified-imports:v1:${address.toLowerCase()}`;
      const saved = JSON.parse(localStorage.getItem(key) ?? "[]");
      saved[0] = {
        ...saved[0],
        address: "0x3333333333333333333333333333333333333333",
        url: "https://evil.invalid",
        method: "eth_sendTransaction",
      };
      localStorage.setItem(key, JSON.stringify(saved));
    }, address);
    await page.goto("/scan");
    const scan = page.getByLabel("Verified wallet activity");
    await expect(scan.locator(".va-row")).toHaveCount(0);
    await scan.getByLabel("Activity wallet address").fill(address);
    await scan.getByRole("checkbox").check();
    await scan
      .getByRole("button", { name: "Verify saved imports", exact: true })
      .click();
    await expect(scan.locator(".va-row")).toHaveCount(5);
    await shot(page, `scan-${width}-verified-saved-imports`);
    expect(
      (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
    ).toEqual([]);
  });
}
