import type { Page } from "@playwright/test";
import { test, expect, fillRecipient } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { locales, type Locale } from "../../src/i18n/config";
import { loadDictionary } from "../../src/i18n/messages";
import { publicBrandDenylist } from "../../src/content/public-labels";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote } from "../../src/routing/normalize";
import { CROSS } from "../../src/core/model";
const base = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-2"}/i18n`;
async function setup(page: Page, locale: Locale, theme = "dark") {
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  const record = {
    schema: 1,
    id: "i18n-isolated-visual-record",
    mode: "mainnet-readonly",
    route: "one-native-to-bsc-cross",
    config: "1",
    sourceChain: 612055,
    destinationChain: 56,
    account: "0x3333333333333333333333333333333333333333",
    recipient: "0x3333333333333333333333333333333333333333",
    sourceAsset: "native:ONE",
    token: CROSS,
    amount: "12000000000000000000",
    expected: "12000000000000000000",
    sourceHash: `0x${"a".repeat(64)}`,
    destinationHash: `0x${"b".repeat(64)}`,
    state: "TRACKING_UNAVAILABLE",
    updatedAt: Date.now(),
  };
  await page.addInitScript(
    ({ locale, theme, record }) => {
      // V1.9: test setup belongs to the app document only, never to third-party/opaque subframes.
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
      localStorage.setItem("otherbridge.history.v1", JSON.stringify([record]));
    },
    { locale, theme, record },
  );
  const catalog = fixtureCatalog(),
    calls: unknown[] = [];
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
      status: 422,
      json: { error: "SYNTHETIC_CATALOG_UNAVAILABLE" },
    }),
  );
  await page.route("**/api/bridge", (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({
        json: { mode: "mainnet-readonly", submission: false },
      });
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === "health")
      return route.fulfill({
        json: {
          mode: "mainnet-readonly",
          status: "blocked",
          observedAt: Date.now(),
          reasons: [
            "SOURCE_BUILD_MATCH_UNVERIFIED",
            "DESTINATION_BUILD_MATCH_UNVERIFIED",
            "RESERVE_UNKNOWN",
          ],
          limits: {
            minimum: "5000000000000000000",
            maximumBound: "913571641965111153887911413",
            conservativeReserveBound: "913571641965111153887911413",
            reserveVerified: false,
            paused: false,
          },
        },
      });
    if (body.action === "track")
      return route.fulfill({
        json: {
          kind: "chain",
          observedAt: Date.now(),
          record: { ...body.record, state: "TRACKING_UNAVAILABLE" },
          evidence: {
            policy: {
              sourceContract: "0xb81d6e000000000000000000000000000000c0de",
              destinationContract: "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5",
              sourceConfirmations: 1,
              destinationConfirmations: 1,
              finality: "node-finalized",
            },
          },
        },
      });
    return route.fulfill({
      status: 422,
      json: { error: "MAINNET_WRITE_DISABLED" },
    });
  });
  await page.route("**/api/routing", (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    if (body.action === "catalog") return route.fulfill({ json: catalog });
    if (body.action === "connections")
      return route.fulfill({
        json: [
          {
            from: body.source,
            to: body.destination,
            sourceAssets: [
              catalog.networks.find((n) => n.id === body.source)!.nativeAsset,
            ],
            destinationAssets: [
              catalog.networks.find((n) => n.id === body.destination)!
                .nativeAsset,
            ],
            provider: "routing-core",
            executable: false,
          },
        ],
      });
    if (body.action === "quote") {
      const quote = normalizeQuote(
        fixtureQuote(body.input),
        body.input,
        catalog,
      );
      quote.warnings.push("SYNTHETIC_TEST_ONLY");
      quote.steps.unshift({
        ...quote.steps[0],
        id: "synthetic-protocol-step",
        tool: "feeCollection",
        toolName: "Route service fee",
        type: "protocol",
        catalogBound: false,
        destinationAsset: quote.steps[0].sourceAsset,
        amount: "0",
        expected: "0",
        minimum: "0",
        duration: 0,
      });
      return route.fulfill({ json: [quote] });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
  return { record, calls };
}
async function check(page: Page, locale: Locale, name: string, capture = true) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  const text = await page.evaluate(() => document.body.textContent ?? "");
  expect(text).not.toMatch(publicBrandDenylist);
  const productText = await page.evaluate(() => {
    const body = document.body.cloneNode(true) as HTMLElement;
    body
      .querySelectorAll("script,style")
      .forEach((element) => element.remove());
    return body.textContent ?? "";
  });
  expect(productText).not.toMatch(
    /MISSING_KEY|LOCALE_NOT_LOADED|INVALID_INTERPOLATION|\{count\}|ui\.[a-zA-Z]+|product\.[a-zA-Z]+/,
  );
  const technical = await page
    .locator(
      'code, .network-id, input[name="sourceHash"], #routing-sender, #routing-recipient',
    )
    .evaluateAll((elements) =>
      elements.map((element) => ({
        text: element.textContent,
        direction: getComputedStyle(element).direction,
      })),
    );
  expect(technical.every((entry) => entry.direction === "ltr")).toBe(true);
  await mkdir(`${base}/screenshots`, { recursive: true });
  await mkdir(`${base}/texts`, { recursive: true });
  await writeFile(`${base}/texts/${name}.txt`, text);
  if (capture)
    await page.screenshot({
      path: `${base}/screenshots/${name}.png`,
      fullPage: !(await page.locator("dialog[open]").count()),
    });
  return {
    locale,
    name,
    width: await page.evaluate(() => innerWidth),
    technical,
  };
}
async function review(page: Page, locale: Locale) {
  const d = await loadDictionary(locale);
  await page
    .getByRole("button", { name: d.ui.selectSourceNetwork, exact: true })
    .click();
  await page.locator("#network-search").fill("Ethereum");
  await page.locator('.network-picker [data-chain="1"]').click();
  await page
    .getByRole("button", { name: d.ui.selectDestinationNetwork, exact: true })
    .click();
  await page.locator("#network-search").fill("Base");
  await page.locator('.network-picker [data-chain="8453"]').click();
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await page.locator("#routing-amount").fill("0.01");
  await page
    .locator("#routing-sender")
    .fill("0x3333333333333333333333333333333333333333");
  await fillRecipient(page, "0x3333333333333333333333333333333333333333");
  await page.getByRole("button", { name: d.ui.readRoute, exact: true }).click();
  await page
    .getByRole("button", { name: d.ui.reviewRoute, exact: true })
    .click();
  await expect(page.locator(".routing-review[open]")).toBeVisible();
  await expect(page.locator(".routing-review .primary")).toBeDisabled();
  await expect(
    page.locator(".routing-review .expected-amounts"),
  ).toHaveAttribute("dir", "ltr");
  expect(
    await page
      .locator(".routing-review .expected-amounts")
      .evaluate((element) => getComputedStyle(element).direction),
  ).toBe("ltr");
  await expect(page.locator(".routing-review")).toContainText(
    d.ui.syntheticUITestQuoteNotLive,
  );
}
for (const locale of locales)
  test(`locale smoke ${locale.id}: all critical surfaces, SSR, keys and no writes`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    const { calls, record } = await setup(page, locale.id),
      errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const receipts = [];
    const response = await page.goto("/bridge");
    expect(response?.status()).toBe(200);
    expect(await response?.text()).toContain(`lang="${locale.id}"`);
    expect(await response?.text()).toContain(`dir="${locale.dir}"`);
    await expect(page.locator("html")).toHaveAttribute("lang", locale.id);
    await expect(page.locator("html")).toHaveAttribute("dir", locale.dir);
    const d = await loadDictionary(locale.id);
    await expect(page.locator(".intro")).toContainText(d.product.subtitle);
    // V1.11: the reserve accounting-bound warning lives in the route-health "Safety details".
    await page.locator(".health-card details.disclosure > summary").click();
    await expect(page.locator(".health-card")).toContainText(
      d.product.boundNote,
    );
    receipts.push(
      await check(page, locale.id, `${locale.id}-bridge-1440-dark`),
    );
    await page
      .getByRole("button", { name: d.ui.selectSourceNetwork, exact: true })
      .click();
    await expect(page.locator(".network-picker[open]")).toBeVisible();
    receipts.push(
      await check(page, locale.id, `${locale.id}-network-selector`),
    );
    await page.keyboard.press("Escape");
    await review(page, locale.id);
    receipts.push(await check(page, locale.id, `${locale.id}-eth-base-review`));
    await page.keyboard.press("Escape");
    for (const path of [
      "/activity",
      `/activity/${record.id}`,
      "/help",
      "/about",
      "/settings",
    ]) {
      await page.goto(path);
      await page.locator("h1").waitFor();
      if (path === "/help")
        await page
          .locator(".faq details")
          .evaluateAll((elements) =>
            elements.forEach((element) => element.setAttribute("open", "")),
          );
      receipts.push(
        await check(
          page,
          locale.id,
          `${locale.id}-${path.replaceAll("/", "-")}`,
        ),
      );
    }
    await page.locator(".preferences .language-entry").click();
    await expect(page.locator(".language-picker[open]")).toBeVisible();
    await expect(
      page.locator(".language-picker[open] .language-list button"),
    ).toHaveCount(24);
    receipts.push(
      await check(page, locale.id, `${locale.id}-language-selector`),
    );
    await page.keyboard.press("Escape");
    expect(errors).toEqual([]);
    expect(
      calls.every(
        (call) =>
          !["sign", "approve", "broadcast", "deploy", "submit"].includes(
            (call as { action: string }).action,
          ),
      ),
    ).toBe(true);
    await writeFile(
      `${base}/${locale.id}-smoke.json`,
      JSON.stringify(
        {
          locale,
          errors,
          calls,
          receipts,
          note: "Synthetic read-only fixtures only; no live liquidity or payout claim",
        },
        null,
        2,
      ),
    );
  });
for (const locale of ["tr", "en", "es", "ru", "ar", "zh-CN", "ja"] as const)
  for (const theme of ["dark", "light"])
    test(`visual matrix ${locale} ${theme}: 360 390 768 1440`, async ({
      page,
    }) => {
      test.setTimeout(60000);
      await setup(page, locale, theme);
      const receipts = [];
      for (const width of [360, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 1100 });
        await page.goto("/bridge");
        await page.locator("h1").waitFor();
        receipts.push(
          await check(page, locale, `${locale}-bridge-${width}-${theme}`),
        );
        const axe = await new AxeBuilder({ page }).analyze();
        await writeFile(
          `${base}/axe-${locale}-${width}-${theme}.json`,
          JSON.stringify(axe),
        );
        expect(axe.violations).toEqual([]);
      }
      await writeFile(
        `${base}/visual-${locale}-${theme}.json`,
        JSON.stringify(receipts, null, 2),
      );
    });
for (const locale of ["ar", "fa", "he", "ur"] as const)
  for (const width of [360, 1440])
    test(`RTL ${locale} ${width}: selectors review activity/detail bidi focus`, async ({
      page,
    }) => {
      test.setTimeout(60000);
      await page.setViewportSize({ width, height: 1100 });
      const { record } = await setup(page, locale);
      await page.goto("/bridge");
      const d = await loadDictionary(locale),
        receipts = [];
      receipts.push(await check(page, locale, `${locale}-rtl-${width}-bridge`));
      const trigger = page.getByRole("button", {
        name: d.ui.selectSourceNetwork,
        exact: true,
      });
      await trigger.click();
      await expect(page.locator("#network-search")).toBeFocused();
      receipts.push(
        await check(page, locale, `${locale}-rtl-${width}-network-selector`),
      );
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
      await review(page, locale);
      receipts.push(await check(page, locale, `${locale}-rtl-${width}-review`));
      await page.keyboard.press("Escape");
      await page.goto(`/activity/${record.id}`);
      await expect(page.locator(".timeline li")).toHaveCount(3);
      await expect(
        page.locator(".address").first().locator("button"),
      ).toBeVisible();
      receipts.push(
        await check(page, locale, `${locale}-rtl-${width}-activity-detail`),
      );
      await page
        .getByRole("button", { name: d.product.language, exact: true })
        .click();
      receipts.push(
        await check(page, locale, `${locale}-rtl-${width}-language-selector`),
      );
      await page.keyboard.press("Escape");
      await writeFile(
        `${base}/rtl-${locale}-${width}.json`,
        JSON.stringify(receipts, null, 2),
      );
    });
test("language selection is keyboard accessible, persists for SSR, and long copy wraps", async ({
  page,
}) => {
  await setup(page, "en");
  await page.goto("/bridge");
  const entry = page.getByRole("button", { name: "Language", exact: true });
  await entry.focus();
  await page.keyboard.press("Enter");
  await page.locator("#header-language-search").fill("العربية");
  await expect(
    page.locator(".language-picker[open] .language-list button"),
  ).toHaveCount(1);
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
  await expect(page.locator(".header .language-entry")).toBeFocused();
  const response = await page.reload();
  expect(await response?.text()).toContain('lang="ar"');
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.setViewportSize({ width: 360, height: 1100 });
  await page
    .locator(".mode-note,.notice,.under-button,.data-row span,nav a")
    .evaluateAll((elements) =>
      elements.forEach((element) => {
        element.textContent = (element.textContent ?? "").repeat(3);
      }),
    );
  await check(page, "ar", "long-copy-stress-360");
});
