// gf1 G01 Guardian-first information architecture. SYNTHETIC_TEST_ONLY: no wallet, no signature, no broadcast.
// Asserts: Guardian is a primary destination visually ahead of Swap and Bridge on the rail and the phone tab bar,
// every destination stays one click away, the Overview states the product flow (connect → choose → Guardian review →
// the user's own next step) with honest states and a neutral decision legend, the active-item arm never blocks or
// covers its label, rests under reduced motion, mirrors in RTL, and the pages stay axe-clean in both themes.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import { fixtureCatalog } from "../fixtures/routing";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const PRIMARY = ["/app", "/guardian", "/swap", "/bridge", "/portfolio"];
// G12 H06: VEINED Scan joins the secondary destinations, after Activity.
const SECONDARY = ["/activity", "/scan", "/networks", "/help", "/points"];
async function setup(page: Page, locale = "en", theme = "dark") {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript(
    ([l, t]) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", l);
      localStorage.setItem("otherbridge.theme", t);
    },
    [locale, theme],
  );
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const hrefs = (page: Page, selector: string) =>
  page
    .locator(selector)
    .evaluateAll((els) => els.map((el) => el.getAttribute("href")));

test("GF1-IA1 desktop rail: Guardian sits ahead of Swap and Bridge, every destination is one click away, the arm never blocks", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  expect(await hrefs(page, ".main-nav .nav-primary a.nav-link")).toEqual(
    PRIMARY,
  );
  expect(await hrefs(page, ".main-nav .nav-secondary a.nav-link")).toEqual(
    SECONDARY,
  );
  const guardian = page.locator(".main-nav a[href='/guardian']");
  const swap = page.locator(".main-nav a[href='/swap']");
  const bridge = page.locator(".main-nav a[href='/bridge']");
  const g = (await guardian.boundingBox())!;
  expect(g.y).toBeLessThan((await swap.boundingBox())!.y);
  expect(g.y).toBeLessThan((await bridge.boundingBox())!.y);
  for (const href of [...PRIMARY, ...SECONDARY]) {
    await page.locator(`.main-nav a[href='${href}']`).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    const active = page.locator(".main-nav a.nav-link.active");
    await expect(active).toHaveCount(1);
    await expect(active).toHaveAttribute("href", href);
    await expect(active).toHaveAttribute("aria-current", "page");
    // The arm is decoration: hidden from assistive technology, never a pointer target, never over the label.
    const arm = active.locator(".nav-arm");
    await expect(arm).toHaveAttribute("aria-hidden", "true");
    await expect(arm).toHaveCSS("pointer-events", "none");
    const tip = (await active.locator(".nav-arm-tip").boundingBox())!;
    const label = (await active.locator(".nav-label").boundingBox())!;
    const overlapX =
      Math.min(tip.x + tip.width, label.x + label.width) -
      Math.max(tip.x, label.x);
    const overlapY =
      Math.min(tip.y + tip.height, label.y + label.height) -
      Math.max(tip.y, label.y);
    expect(overlapX <= 0 || overlapY <= 0, href).toBe(true);
    // A click at the label's centre reaches the link itself (nothing decorative sits on top of it).
    const hit = await page.evaluate(
      ([x, y]) =>
        document.elementFromPoint(x, y)?.closest("a")?.getAttribute("href"),
      [label.x + label.width / 2, label.y + label.height / 2],
    );
    expect(hit).toBe(href);
  }
  await expect(
    page.locator(".main-nav a.nav-link.active .nav-arm-tip"),
  ).toHaveCSS("opacity", "0.9");
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  for (const width of [360, 390])
    test(`GF1-IA2 phone ${width}: five tabs with Guardian second, 44 px targets, More keeps the rest, no overflow`, async ({
      page,
    }) => {
      await setup(page);
      await page.setViewportSize({ width, height: 844 });
      await page.goto("/app");
      await expect(page.locator("main h1").first()).toBeVisible();
      const tabs = page.locator(".main-nav .nav-primary .nav-link");
      await expect(tabs).toHaveCount(5);
      expect(await hrefs(page, ".main-nav .nav-primary a.nav-link")).toEqual(
        PRIMARY,
      );
      for (const tab of await tabs.all()) {
        const box = (await tab.boundingBox())!;
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.y + box.height).toBeGreaterThan(844 - 80);
      }
      await tabs.nth(1).tap();
      await expect(page).toHaveURL(/\/guardian$/);
      await expect(tabs.nth(1)).toHaveAttribute("aria-current", "page");
      await expect(tabs.nth(1).locator(".nav-arm-tip")).toHaveCSS(
        "opacity",
        "0.9",
      );
      const more = page.getByRole("button", { name: "More" });
      await more.tap();
      for (const href of SECONDARY)
        await expect(
          page.locator(`.main-nav .nav-secondary a[href='${href}']`),
        ).toBeVisible();
      await page.locator(".main-nav a[href='/help']").tap();
      await expect(page).toHaveURL(/\/help$/);
      for (const path of ["/app", "/guardian"]) {
        await page.goto(path);
        await expect(page.locator("main").first()).toBeVisible();
        await page.waitForTimeout(300);
        expect(await overflow(page), path).toBe(false);
      }
    });
});

test("GF1-IA3 Overview: Guardian is the first action and one honest flow — connect, choose, Guardian review, your next step", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  const hero = page.locator(".overview-welcome");
  await expect(hero.locator("h1")).toHaveText("Check before you move.");
  const actions = hero.locator(".overview-welcome-actions a");
  expect(
    await actions.evaluateAll((a) => a.map((x) => x.getAttribute("href"))),
  ).toEqual(["/guardian", "/swap", "/bridge"]);
  await expect(actions.first()).toHaveClass(/primary-link/);
  await expect(actions.first()).toHaveText("Ask Guardian");
  // The honest status stays first under the hero; the flow follows it.
  await expect(page.locator(".overview-status")).toContainText(
    "sending is disabled",
  );
  const flow = page.locator(".overview-flow");
  await expect(flow.locator("h2")).toHaveText("How VEINED works");
  const steps = flow.locator("ol > li");
  expect(
    await steps.evaluateAll((li) => li.map((x) => x.getAttribute("data-step"))),
  ).toEqual(["connect", "choose", "guardian", "next"]);
  await expect(steps.nth(0).locator(".overview-flow-state")).toHaveText(
    "Not connected",
  );
  await expect(
    steps.nth(0).locator(".overview-flow-state"),
  ).not.toHaveAttribute("data-done", /.*/);
  await expect(steps.nth(2)).toContainText(
    "No decision is permission to move funds.",
  );
  const legend = steps.nth(2).locator(".overview-flow-decisions > span");
  await expect(legend).toHaveText([
    "Allowed",
    "Allowed with a warning",
    "Verify first",
    "Blocked",
  ]);
  // Neutral legend: every decision name has the same colour (no green "safe" signal).
  const colours = await legend.evaluateAll((els) =>
    els.map((el) => getComputedStyle(el).color),
  );
  expect(new Set(colours).size).toBe(1);
  await expect(steps.nth(3).locator(".overview-flow-state")).toContainText(
    "Execution closed",
  );
  await expect(page.locator(".overview")).not.toContainText(/\bsafe\b/i);
  // Power users keep direct Swap and Bridge access.
  await steps.nth(1).locator("a[href='/bridge']").click();
  await expect(page).toHaveURL(/\/bridge$/);
  await page.goBack();
  await steps.nth(2).locator("a[href='/guardian']").click();
  await expect(page).toHaveURL(/\/guardian$/);
});

test("GF1-IA4 RTL (ar): rail on the right, Guardian ahead of Swap, the flow and the arm mirror", async ({
  page,
}) => {
  await setup(page, "ar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const rail = (await page.locator("header.header").boundingBox())!;
  expect(Math.round(rail.x + rail.width)).toBe(1440);
  expect(await hrefs(page, ".main-nav .nav-primary a.nav-link")).toEqual(
    PRIMARY,
  );
  await expect(page.locator(".main-nav .nav-link.active .nav-arm")).toHaveCSS(
    "scale",
    "-1 1",
  );
  const steps = page.locator(".overview-flow ol > li");
  const first = (await steps.nth(0).boundingBox())!;
  const second = (await steps.nth(1).boundingBox())!;
  expect(first.x).toBeGreaterThan(second.x);
  expect(await overflow(page)).toBe(false);
  await page.setViewportSize({ width: 390, height: 844 });
  const tabs = page.locator(".main-nav .nav-primary .nav-link");
  expect((await tabs.first().boundingBox())!.x).toBeGreaterThan(
    (await tabs.last().boundingBox())!.x,
  );
  expect(await overflow(page)).toBe(false);
});

test("GF1-IA5 reduced motion: the arm rests (no transition) on the Guardian destination", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/guardian");
  const tip = page.locator(".main-nav .nav-link.active .nav-arm-tip");
  await expect(tip).toHaveCSS("transition-duration", "0s");
  await expect(tip).toHaveCSS("opacity", "0.9");
});

for (const [locale, theme] of [
  ["en", "dark"],
  ["en", "light"],
  ["ar", "dark"],
] as const)
  test(`GF1-IA6 axe ${locale} ${theme}: Overview and Guardian have no WCAG 2.1 AA violations`, async ({
    page,
  }) => {
    await setup(page, locale, theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const path of ["/app", "/guardian"]) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      await page.waitForTimeout(400);
      const result = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
      expect(
        result.violations.map((v) => `${path} ${v.id}: ${v.help}`),
      ).toEqual([]);
    }
  });
