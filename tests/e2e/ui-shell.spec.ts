// V1.22 UX candidate: application shell, navigation and Swap instrument. SYNTHETIC_TEST_ONLY doubles (fixtures.ts);
// no wallet signature, approval or broadcast. Asserts layout invariants the redesign promises: every destination
// reachable in every locale without a wrapping header, a narrow-screen tab bar with an accessible "More" sheet,
// honest execution-closed state, readable amounts, one primary action, no horizontal overflow and axe-clean pages.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect, readOnlyAddress } from "./fixtures";
import { fixtureCatalog } from "../fixtures/routing";
import { wallet } from "../fixtures/swap";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const DESTINATIONS = [
  "/app",
  "/swap",
  "/bridge",
  "/portfolio",
  "/points",
  "/guardian",
  "/activity",
  "/networks",
  "/help",
];
async function setup(page: Page, locale = "en") {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript((l) => {
    if (window === window.top) localStorage.setItem("otherbridge.language", l);
  }, locale);
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
async function axe(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}

test("UX1 desktop rail: every destination is a direct link, the active one is marked, the top bar never wraps", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/swap");
  await expect(page.getByTestId("swap-intelligence")).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const href of DESTINATIONS)
    await expect(nav.locator(`a[href='${href}']`)).toBeVisible();
  await expect(nav.locator("a[href='/swap']")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(nav.locator(".nav-more")).toBeHidden();
  const bar = await page.locator(".header-actions").boundingBox();
  expect(bar!.height).toBeLessThanOrEqual(61);
  await expect(page.locator(".shell-status")).toContainText("Execution closed");
  // The rail sits at the inline start and the content does not run underneath it.
  const rail = await page.locator("header.header").boundingBox();
  const main = await page.locator("main").boundingBox();
  expect(rail!.x).toBe(0);
  expect(main!.x).toBeGreaterThanOrEqual(rail!.width - 1);
  expect(await overflow(page)).toBe(false);
});

for (const locale of ["fr", "ru", "uk", "nl", "ja", "bn", "id", "th", "de"])
  test(`UX2 long locale ${locale}: rail labels stay inside the rail and the top bar keeps one row`, async ({
    page,
  }) => {
    await setup(page, locale);
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto("/app");
    await expect(page.locator("main h1").first()).toBeVisible();
    const rail = (await page.locator("header.header").boundingBox())!;
    for (const link of await page
      .locator(".main-nav .nav-link:visible")
      .all()) {
      const box = (await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(rail.x);
      expect(box.x + box.width).toBeLessThanOrEqual(rail.x + rail.width + 1);
      expect(box.height).toBeLessThanOrEqual(64);
    }
    expect(
      (await page.locator(".header-actions").boundingBox())!.height,
    ).toBeLessThanOrEqual(61);
    expect(await overflow(page)).toBe(false);
  });

test("UX3 narrow screens: tab bar, More sheet (keyboard, outside click, navigation) and touch targets", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  const tabs = nav.locator(".nav-primary .nav-link");
  // gf1 (Guardian-first): Overview, Guardian, Swap, Bridge and Portfolio are the tabs, in that order; Points is in "More".
  await expect(tabs).toHaveCount(5);
  expect(
    await tabs.evaluateAll((els) => els.map((el) => el.getAttribute("href"))),
  ).toEqual(["/app", "/guardian", "/swap", "/bridge", "/portfolio"]);
  for (const tab of await tabs.all()) {
    const box = (await tab.boundingBox())!;
    expect(box.height).toBeGreaterThanOrEqual(44);
    expect(box.width).toBeGreaterThanOrEqual(44);
    // The bar is fixed to the bottom edge of the viewport.
    expect(box.y + box.height).toBeGreaterThan(844 - 80);
  }
  const more = nav.getByRole("button", { name: "More" });
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(nav.locator("a[href='/points']")).toBeHidden();
  await more.click();
  await expect(more).toHaveAttribute("aria-expanded", "true");
  for (const href of ["/points", "/activity", "/networks", "/help"])
    await expect(nav.locator(`a[href='${href}']`)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toBeFocused();
  await more.click();
  await page.locator("main h1").first().click();
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await more.click();
  await nav.locator("a[href='/points']").click();
  await expect(page).toHaveURL(/\/points$/);
  await expect(more).toHaveAttribute("aria-expanded", "false");
  await expect(more).toHaveClass(/active/);
  for (const path of ["/swap", "/bridge", "/points", "/portfolio"]) {
    await page.goto(path);
    await expect(page.locator("main").first()).toBeVisible();
    await page.waitForTimeout(300);
    expect(await overflow(page), path).toBe(false);
  }
});

test("UX4 RTL: the rail moves to the inline start (right) and the tab bar mirrors", async ({
  page,
}) => {
  await setup(page, "ar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("main h1").first()).toBeVisible();
  const rail = (await page.locator("header.header").boundingBox())!;
  expect(Math.round(rail.x + rail.width)).toBe(1440);
  expect(await overflow(page)).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.locator(".main-nav .nav-primary .nav-link");
  const first = (await tabs.first().boundingBox())!;
  const last = (await tabs.last().boundingBox())!;
  expect(first.x).toBeGreaterThan(last.x);
  expect(await overflow(page)).toBe(false);
});

for (const width of [1440, 390])
  test(`UX5 Swap instrument ${width}: readable amount, one primary action, visible quote facts, execution closed`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/swap");
    const card = page.getByTestId("swap-intelligence");
    await expect(card).toBeVisible();
    const size = await card
      .locator("#meta-amount")
      .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(size).toBeGreaterThanOrEqual(28);
    await expect(card.locator(".execution-status")).toContainText(
      "Execution closed",
    );
    await expect(card.locator(".primary:visible")).toHaveCount(1);
    await card.getByRole("button", { name: /^Destination token/ }).click();
    await page.locator("#token-search").fill("USDC");
    await page.getByRole("option").filter({ hasText: "USDC" }).first().click();
    await (await readOnlyAddress(card)).fill(wallet);
    await card.locator("#meta-amount").fill("0.01");
    await card
      .getByRole("button", { name: "Compare providers", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: /Uniswap · V3/ }),
    ).toBeVisible();
    // After a quote the only primary action is Review; comparing again is secondary.
    await expect(card.locator(".primary:visible")).toHaveCount(1);
    await expect(card.locator(".primary:visible")).toHaveText("Review Swap");
    const facts = card.locator(".swap-facts");
    await expect(facts).toBeVisible();
    await expect(facts).toContainText("Minimum received");
    await expect(facts).toContainText("Price impact");
    await expect(facts).toContainText("VEINED fee");
    await expect(facts).toContainText("Estimated network fee");
    // The reverse control is a real, named button between the two legs.
    const reverse = card.getByRole("button", { name: "Reverse tokens" });
    const pay = (await card
      .locator(".trade-amount-box")
      .first()
      .boundingBox())!;
    const rev = (await reverse.boundingBox())!;
    expect(rev.y + rev.height / 2).toBeGreaterThan(pay.y + pay.height - 30);
    expect(rev.height).toBeGreaterThanOrEqual(40);
    expect(await overflow(page)).toBe(false);
    await axe(page);
    await card
      .getByRole("button", { name: "Review Swap", exact: true })
      .click();
    const dialog = page.locator(".review-dialog[open]");
    await expect(dialog).toContainText(
      "Execution closed — route verified for review",
    );
    await expect(dialog).toContainText("Minimum received:");
    await expect(
      dialog.getByRole("button", { name: /sign|approve|confirm swap/i }),
    ).toHaveCount(0);
    await axe(page);
  });

test("UX6 overview and points pages are axe-clean in the new shell (desktop and mobile)", async ({
  page,
}) => {
  await setup(page);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    for (const path of ["/app", "/bridge", "/points"]) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await page.waitForTimeout(400);
      await axe(page);
    }
  }
});

test("UX7 reduced motion: the More sheet appears without animation", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await page.getByRole("button", { name: "More" }).click();
  const animation = await page
    .locator("#nav-more-panel")
    .evaluate((el) => getComputedStyle(el).animationName);
  expect(animation).toBe("none");
});

for (const locale of ["ru", "ja", "de", "uk", "bn"])
  test(`UX8 ${locale} at 360 px: the top bar and tab bar fit without horizontal overflow`, async ({
    page,
  }) => {
    await setup(page, locale);
    await page.setViewportSize({ width: 360, height: 800 });
    for (const path of ["/bridge", "/swap", "/app", "/points"]) {
      await page.goto(path);
      await expect(page.locator("main").first()).toBeVisible();
      await page.waitForTimeout(300);
      expect(await overflow(page), `${locale} ${path}`).toBe(false);
      const bar = (await page.locator("header.header").boundingBox())!;
      expect(bar.height, `${locale} ${path}`).toBeLessThanOrEqual(64);
    }
  });

test("UX9 RTL bridge: source → destination reads correctly (no double mirroring) and chevrons point down", async ({
  page,
}) => {
  await setup(page, "ar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/bridge");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  // Route rows are isolated LTR: the source chip is on the left and the arrow is not mirrored.
  const identity = page.locator(".route-card .route-identity").first();
  await expect(identity).toBeVisible();
  const chips = identity.locator(":scope > *:not(svg)");
  const first = (await chips.first().boundingBox())!;
  const last = (await chips.last().boundingBox())!;
  expect(first.x).toBeLessThan(last.x);
  await expect(chips.first()).toContainText("ONEchain");
  expect(
    await identity
      .locator("svg.flip-rtl")
      .first()
      .evaluate((el) => getComputedStyle(el).transform),
  ).toBe("none");
  // The From/To arrow follows the reading direction: From is on the right, the arrow points left.
  const from = (await page
    .locator(".route-pair .network-box")
    .first()
    .boundingBox())!;
  const to = (await page
    .locator(".route-pair .network-box")
    .last()
    .boundingBox())!;
  expect(from.x).toBeGreaterThan(to.x);
  expect(
    await page
      .locator(".route-pair .direction-arrow .icon")
      .evaluate((el) => getComputedStyle(el).rotate),
  ).toBe("90deg");
  // Disclosure chevrons keep their downward drawing (right + bottom borders) in RTL.
  const chevron = await page
    .locator(".route-side .disclosure > summary")
    .first()
    .evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return [s.borderRightWidth, s.borderLeftWidth];
    });
  // Chrome rounds the 1.5 px stroke to device pixels; only the edge choice matters.
  expect(parseFloat(chevron[0])).toBeGreaterThan(0);
  expect(chevron[1]).toBe("0px");
});
