import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { setup, connect, calls } from "../visual-restoration/helpers";
const root = "../evidence/screenshots";
mkdirSync(root, { recursive: true });
const address = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
const hash =
  "0x556980061d955e7426c29c95ca14ce83e6aa00b34b544d4e12b7da352232c90e";
for (const proof of [
  { lane: "swap", account: address },
  { lane: "bridge", account: "0x7284d41b5b852f2bd4c99bdf95043d84452d299c" },
]) {
  test(`real read-only ${proof.lane}: one CTA prepares live quote without a wallet send`, async ({
    page,
  }) => {
    await setup(page, { realApi: true, account: proof.account });
    const observed: unknown[] = [];
    page.on("response", async (r) => {
      if (
        r.url().endsWith("/api/manual-wallet") &&
        r.request().method() === "POST"
      ) {
        try {
          observed.push({
            action: r.request().postDataJSON().action,
            status: r.status(),
            body: await r.json(),
          });
        } catch {}
      }
    });
    await page.goto(`/${proof.lane}`);
    await connect(page);
    await expect(page.getByLabel("Guardian review")).toContainText(
      "READY · Guardian",
      { timeout: 45000 },
    );
    await page.locator(".mw-main-action").click();
    await expect(
      page.getByRole("status").filter({ hasText: "Ready for owner review" }),
    ).toBeVisible();
    expect(
      (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
    ).toEqual([]);
    await shot(page, `real-${proof.lane}-single-cta`);
    writeFileSync(
      `../evidence/real-${proof.lane}-api-profile.json`,
      JSON.stringify(
        { keylessPublicAddressProvider: true, readOnly: true, observed },
        null,
        2,
      ),
    );
  });
}
async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(100);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `${root}/${name}.png`,
    fullPage: true,
    animations: "disabled",
  });
}
for (const width of [1440, 390])
  for (const lane of ["swap", "bridge"]) {
    test(`${lane} ${width}: one action, no checkbox, optional details, closed financial gate`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const bodies = await setup(page, { expiry: 120000 });
      await page.goto(`/${lane}`);
      await expect(page.locator(".mw-main-action")).toHaveCount(1);
      await expect(
        page.locator('.manual-wallet input[type="checkbox"]'),
      ).toHaveCount(0);
      await expect(page.locator(".mw-simple-notes")).toHaveCount(0);
      await shot(page, `${lane}-${width}-disconnected`);
      await connect(page);
      await expect(page.getByLabel("Guardian review")).toContainText(
        "Guardian CLEAR",
      );
      const started = Date.now();
      await page.locator(".mw-main-action").dblclick();
      await expect(
        page.getByRole("status").filter({ hasText: "Ready for owner review" }),
      ).toBeVisible();
      expect(bodies.filter((b) => b.action === "prepare")).toHaveLength(1);
      expect(bodies.filter((b) => b.action === "claim")).toHaveLength(0);
      writeFileSync(
        `../evidence/${lane}-${width}-local-preparation-timing.json`,
        JSON.stringify({
          synthetic: true,
          durationMs: Date.now() - started,
          realWalletPrompt: false,
          financialRelease: false,
        }),
      );
      await expect(page.getByLabel("Guardian review")).toContainText(
        "Two on-chain transactions",
      );
      await shot(page, `${lane}-${width}-single-action`);
      await page
        .getByText("Details · route, fees & transaction", { exact: true })
        .click();
      await expect(page.getByLabel("Provider comparison")).toBeVisible();
      await shot(page, `${lane}-${width}-details`);
      expect(
        (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
      ).toEqual([]);
      const results = await new AxeBuilder({ page })
        .include("section.manual-wallet")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(results.violations).toEqual([]);
    });
  }
test("Guardian HOLD and BLOCK cannot prepare from the primary action", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/manual-wallet", async (route) => {
    const req = route.request();
    if (req.method() !== "POST" || req.postDataJSON().action !== "review")
      return route.fallback();
    return route.fulfill({
      json: {
        review: {
          reviewId: "blocked",
          ready: false,
          step: "APPROVE",
          expiresAt: Date.now() + 120000,
          guardian: { level: "HOLD", findings: ["SPENDER_NOT_VERIFIED"] },
          problems: ["SPENDER_NOT_VERIFIED"],
          balances: { allowance: "0" },
          gas: {},
        },
      },
    });
  });
  await page.goto("/swap");
  await connect(page);
  await expect(page.getByLabel("Guardian review")).toContainText(
    "Guardian HOLD",
  );
  await expect(page.locator(".mw-main-action")).toBeDisabled();
  expect(
    (await calls(page)).filter((c) => /sign|send/i.test(c.method)),
  ).toEqual([]);
});
for (const width of [1440, 390])
  test(`Scan ${width}: first five imports, address isolation, chain filter, live hash RPC`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    await setup(page, { realApi: true });
    await page.goto("/scan");
    await expect(page.getByRole("form", { name: "Scan search" })).toBeVisible();
    await shot(page, `scan-${width}-search`);
    await page
      .getByLabel("Transaction hash or public wallet address", { exact: true })
      .fill(address);
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".sc-record")).toHaveCount(5);
    await expect(page.locator(".sc-origin").first()).toContainText(
      "Historical import",
    );
    await shot(page, `scan-${width}-wallet-history`);
    await page.getByLabel("Scan network").selectOption("42161");
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".sc-record")).toHaveCount(1);
    await page
      .getByLabel("Transaction hash or public wallet address", { exact: true })
      .fill("0x" + "1".repeat(40));
    await page.getByRole("button", { name: "Search", exact: true }).click();
    await expect(page.locator(".sc-record")).toHaveCount(0);
    await page.getByLabel("Scan network").selectOption("8453");
    await page
      .getByLabel("Transaction hash or public wallet address", { exact: true })
      .fill(hash);
    const response = page.waitForResponse(
      (r) =>
        r.url().endsWith("/api/scan") &&
        r.request().postDataJSON().refresh === true,
    );
    const started = Date.now();
    await page.getByRole("button", { name: "Search", exact: true }).click();
    const r = await response;
    const b = await r.json();
    writeFileSync(
      `../evidence/live-hash-${width}.json`,
      JSON.stringify(
        { status: r.status(), durationMs: Date.now() - started, ...b },
        null,
        2,
      ),
    );
    expect(r.status()).toBe(200);
    await expect(page.locator(".sc-record")).toHaveCount(1);
    await expect(page.locator(".sc-details")).toContainText(
      "allnodes-publicnode",
    );
    await shot(page, `scan-${width}-real-hash`);
    const axe = await new AxeBuilder({ page })
      .include(".scan-center")
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(axe.violations).toEqual([]);
  });
test("mobile RTL and reduced motion remain usable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page
    .context()
    .addCookies([
      { name: "otherbridge.locale", value: "ar", url: "http://127.0.0.1:3470" },
    ]);
  for (const path of ["swap", "bridge", "scan"]) {
    await page.goto(`/${path}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await shot(page, `${path}-390-rtl`);
  }
});
test("Activity connects explicitly and never shows another address’s imported history", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/activity");
  await expect(page.getByText("Connect to view your activity")).toBeVisible();
  await expect(page.locator(".sc-record")).toHaveCount(0);
});
