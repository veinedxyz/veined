// Abyssal Intelligence candidate: the shared underwater field and the octopus navigation. SYNTHETIC_TEST_ONLY doubles
// (fixtures.ts); no wallet signature, approval or broadcast. Asserts the promises of the visual system: one decorative,
// non-interactive world behind every surface; only the art for the current orientation is requested (ocean film
// candidate: the owner's living-ocean film and its still, the same in both themes); navigation is never gated by the
// field; labels are never covered; reduced motion, forced colours, RTL, keyboard and touch keep working; no canvas or
// WebGL anywhere in the shell. Ocean film: one persistent film loops behind every route, never restarts on
// navigation, pauses while hidden and never takes an input.
import type { Page, Request } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import { fixtureCatalog } from "../fixtures/routing";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const SCENES = [
  ["/app", "overview"],
  ["/swap", "swap"],
  ["/bridge", "bridge"],
  ["/portfolio", "portfolio"],
  ["/points", "points"],
  ["/activity", "activity"],
  ["/networks", "networks"],
  ["/help", "help"],
] as const;
async function setup(page: Page, locale = "en", theme = "dark") {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript(
    ([l, th]) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", l);
      localStorage.setItem("otherbridge.theme", th);
    },
    [locale, theme] as const,
  );
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
}
function artRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (r: Request) => {
    const u = new URL(r.url());
    if (
      u.pathname.startsWith("/assets/veined/ocean/") ||
      u.pathname.startsWith("/assets/veined/ocean-film/")
    )
      seen.push(u.pathname);
  });
  return seen;
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
const rect = (page: Page, selector: string) =>
  page
    .locator(selector)
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    });

test("AB1 one decorative field per route; scene follows client navigation without delaying it", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  const field = page.locator(".abyss");
  await expect(field).toHaveCount(1);
  await expect(field).toHaveAttribute("aria-hidden", "true");
  await expect(field).toHaveCSS("pointer-events", "none");
  expect(
    await field.evaluate(
      (el) =>
        el.querySelectorAll("a, button, input, select, [tabindex]").length,
    ),
  ).toBe(0);
  // No canvas or WebGL context exists anywhere in the shell.
  expect(await page.locator("canvas").count()).toBe(0);
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const [href, scene] of SCENES) {
    const started = Date.now();
    await nav.locator(`a[href='${href}']`).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(field).toHaveAttribute("data-scene", scene);
    await expect(nav.locator(`a[href='${href}']`)).toHaveAttribute(
      "aria-current",
      "page",
    );
    // The arm draw (≈0.7 s) is feedback only: the route is current long before it could finish.
    expect(Date.now() - started).toBeLessThan(15000);
  }
  // Motion is finite: every running animation (scene arrival, nerve draw) ends, so nothing loops forever.
  expect(
    await page.evaluate(() =>
      document
        .getAnimations()
        .some((a) => a.effect?.getTiming().iterations === Infinity),
    ),
  ).toBe(false);
  expect(await overflow(page)).toBe(false);
});

for (const [width, height, size] of [
  [1440, 900, "l1280"],
  [390, 844, "p456"],
] as const)
  for (const theme of ["dark", "light"] as const)
    test(`AB2 ${width} ${theme}: only this orientation's film and its still are requested (the same in both themes)`, async ({
      page,
    }) => {
      const seen = artRequests(page);
      await setup(page, "en", theme);
      await page.setViewportSize({ width, height });
      await page.goto("/swap");
      await expect(page.getByTestId("swap-intelligence")).toBeVisible();
      await expect(page.locator(".abyss")).toHaveAttribute(
        "data-film",
        "playing",
        { timeout: 30000 },
      );
      await page.waitForTimeout(800);
      const poster = `app-poster-${size}`;
      expect([...new Set(seen)].sort()).toEqual(
        [
          `/assets/veined/ocean-film/${poster}.webp`,
          `/assets/veined/ocean-film/app-${size}.mp4`,
        ].sort(),
      );
      const loaded = await page.evaluate(async (url) => {
        const img = new Image();
        img.src = url;
        await img.decode();
        return img.naturalWidth;
      }, `/assets/veined/ocean-film/${poster}.webp`);
      expect(loaded).toBeGreaterThan(0);
      // Same film, silent and decorative, in both themes.
      const film = await page
        .locator(".abyss video")
        .evaluate((v: HTMLVideoElement) => ({
          muted: v.muted,
          loop: v.loop,
          controls: v.controls,
          inline: v.playsInline,
          playing: !v.paused,
        }));
      expect(film).toEqual({
        muted: true,
        loop: true,
        controls: false,
        inline: true,
        playing: true,
      });
    });

test("AB3 rail arm marks the active destination without covering any label (1440, 1100, RTL)", async ({
  page,
}) => {
  await setup(page);
  for (const width of [1440, 1100]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/bridge");
    await expect(page.locator("main").first()).toBeVisible();
    const active = page.locator(".main-nav .nav-link.active");
    await expect(active).toHaveAttribute("href", "/bridge");
    await expect(active.locator(".nav-arm-tip")).toHaveCSS("opacity", "0.9");
    await expect(
      page.locator(".main-nav a.nav-link:not(.active) .nav-arm-tip").first(),
    ).toHaveCSS("opacity", "0");
    for (const link of await page.locator(".main-nav a.nav-link").all()) {
      const tip = await link
        .locator(".nav-arm-tip")
        .evaluate((el) => el.getBoundingClientRect().toJSON());
      const label = await link
        .locator(".nav-label")
        .evaluate((el) => el.getBoundingClientRect().toJSON());
      const overlapX =
        Math.min(tip.right, label.right) - Math.max(tip.left, label.left);
      const overlapY =
        Math.min(tip.bottom, label.bottom) - Math.max(tip.top, label.top);
      expect(overlapX <= 0 || overlapY <= 0, await link.innerText()).toBe(true);
    }
  }
  await setup(page, "ar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/swap");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  const arm = page.locator(".main-nav .nav-link.active .nav-arm");
  await expect(arm).toHaveCSS("scale", "-1 1");
  await expect(page.locator(".abyss-stage")).toHaveCSS("scale", "-1 1");
  expect(await overflow(page)).toBe(false);
});

test.describe("touch", () => {
  test.use({ hasTouch: true });
  test("AB4 phones: the coiled tip marks the active tab above its label; tabs stay 44 px touch targets", async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/portfolio");
    await expect(page.locator("main").first()).toBeVisible();
    const active = page.locator(".main-nav .nav-primary .nav-link.active");
    await expect(active).toHaveAttribute("href", "/portfolio");
    await expect(active.locator(".nav-arm-reach")).toBeHidden();
    await expect(active.locator(".nav-arm-tip")).toHaveCSS("opacity", "0.9");
    const tip = await active
      .locator(".nav-arm-tip")
      .evaluate((el) => el.getBoundingClientRect().toJSON());
    const label = await rect(
      page,
      ".main-nav .nav-primary .nav-link.active .nav-label",
    );
    expect(tip.bottom).toBeLessThanOrEqual(label.y + 1);
    for (const tab of await page
      .locator(".main-nav .nav-primary .nav-link")
      .all()) {
      const box = (await tab.boundingBox())!;
      expect(box.height).toBeGreaterThanOrEqual(44);
      expect(box.width).toBeGreaterThanOrEqual(44);
    }
    await page.getByRole("button", { name: "More" }).tap();
    await expect(page.locator(".nav-secondary .nav-arm").first()).toBeHidden();
    await page.locator(".main-nav a[href='/points']").tap();
    await expect(page).toHaveURL(/\/points$/);
    await expect(page.locator(".abyss")).toHaveAttribute(
      "data-scene",
      "points",
    );
    expect(await overflow(page)).toBe(false);
  });
});

test("AB5 keyboard: every destination is reachable with Tab and Enter, focus stays visible", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  const links = page.locator(".main-nav a.nav-link");
  await page.locator("header a[href='/']").focus();
  // Every rail destination (ten with /guardian and, since G12 H06, /scan) is walked; gc1 owner order: Points is the
  // last one.
  const count = await links.count();
  expect(count).toBe(10);
  for (let i = 0; i < count; i++) {
    const link = links.nth(i);
    await page.keyboard.press("Tab");
    await expect(link).toBeFocused();
    const outline = await link.evaluate(
      (el) => getComputedStyle(el).outlineStyle,
    );
    expect(outline).toBe("solid");
  }
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/points$/);
  await expect(page.locator(".abyss")).toHaveAttribute("data-scene", "points");
});

test("AB6 reduced motion: a still ocean — no film, no fade, no transition; the rail arm rests", async ({
  page,
}) => {
  const seen = artRequests(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/swap");
  await expect(page.getByTestId("swap-intelligence")).toBeVisible();
  const field = page.locator(".abyss");
  await expect(field).toHaveAttribute("data-mode", "still");
  await expect(field.locator("video")).toHaveCount(0);
  await expect(field.locator(".abyss-still")).toBeVisible();
  await expect(page.locator(".abyss-stage")).toHaveCSS(
    "animation-name",
    "none",
  );
  await expect(
    page.locator(".main-nav .nav-link.active .nav-arm-tip"),
  ).toHaveCSS("transition-duration", "0s");
  await page.locator(".main-nav a[href='/bridge']").click();
  await expect(field).toHaveAttribute("data-scene", "bridge");
  await expect(field.locator(".abyss-glow")).toHaveCSS(
    "transition-duration",
    "0s",
  );
  await expect(field.locator("video")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(seen.filter((p) => p.endsWith(".mp4"))).toEqual([]);
});

test("AB7 forced colours and light theme keep a usable, axe-clean shell", async ({
  page,
}) => {
  await setup(page, "en", "light");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  await page.emulateMedia({ forcedColors: "active" });
  await expect(page.locator(".abyss")).toBeHidden();
  await expect(page.locator(".main-nav .nav-arm").first()).toBeHidden();
  await expect(
    page.getByRole("navigation", { name: "Main navigation" }),
  ).toBeVisible();
});

test("AB8 every destination opens with a window band; the execution-closed banner stays opaque and above the fold", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const href of [
    "/portfolio",
    "/points",
    "/activity",
    "/networks",
    "/help",
  ]) {
    await page.goto(href);
    const band = page.locator("main .page-heading").first();
    await expect(band).toBeVisible();
    expect((await band.boundingBox())!.height, href).toBeGreaterThanOrEqual(
      150,
    );
  }
  await page.goto("/bridge");
  expect(
    (await page.locator("main .intro").first().boundingBox())!.height,
  ).toBeGreaterThanOrEqual(150);
  for (const theme of ["dark", "light"] as const)
    for (const [width, height] of [
      [390, 844],
      [720, 450],
    ] as const) {
      await setup(page, "en", theme);
      await page.setViewportSize({ width, height });
      await page.goto("/app");
      const banner = page.locator(".overview-status");
      await expect(banner).toBeVisible();
      const box = (await banner.boundingBox())!;
      expect(box.y + box.height, `${theme} ${width}`).toBeLessThanOrEqual(
        height,
      );
      // Any colour syntax: rgb()/rgba(), color(srgb … / a) or oklab(… / a); opaque means alpha 1.
      const alpha = await banner.evaluate((el) => {
        const c = getComputedStyle(el).backgroundColor;
        if (c.includes("/")) return Number(c.split("/")[1].replace(")", ""));
        if (c.startsWith("rgba(")) return Number(c.slice(5, -1).split(",")[3]);
        return 1;
      });
      expect(alpha, `${theme} ${width}`).toBe(1);
    }
});

test("AB9 the film never takes the visitor's input: typing is untouched and the instrument is always on top", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/swap");
  await expect(page.getByTestId("swap-intelligence")).toBeVisible();
  const field = page.locator(".abyss");
  await expect(field).toHaveAttribute("data-film", "playing", {
    timeout: 30000,
  });
  // Decorative: no part of the field can be a pointer target or a focus stop.
  expect(
    await page.evaluate(() =>
      [...document.querySelectorAll(".abyss, .abyss *")].every(
        (el) => getComputedStyle(el).pointerEvents === "none",
      ),
    ),
  ).toBe(true);
  expect(
    await field.evaluate(
      (el) =>
        el.querySelectorAll(
          "a, button, input, select, video[controls], [tabindex]",
        ).length,
    ),
  ).toBe(0);
  await page.locator("#meta-amount").first().fill("1.5");
  await expect(page.locator("#meta-amount").first()).toHaveValue("1.5");
  // Controls and figures sit above the water at every point of the instrument.
  for (const selector of [".swap-reverse", "#meta-amount", ".swap-card"]) {
    const box = (await page.locator(selector).first().boundingBox())!;
    expect(
      await page.evaluate(
        ([x, y]) => document.elementFromPoint(x, y)?.closest(".abyss") === null,
        [box.x + box.width / 2, box.y + box.height / 2] as const,
      ),
      selector,
    ).toBe(true);
  }
  // The instrument card is opaque: the film can never show through a figure.
  const alpha = await page
    .locator(".swap-card")
    .first()
    .evaluate((el) => {
      const c = getComputedStyle(el).backgroundColor;
      if (c.includes("/")) return Number(c.split("/")[1].replace(")", ""));
      if (c.startsWith("rgba(")) return Number(c.slice(5, -1).split(",")[3]);
      return 1;
    });
  expect(alpha).toBeGreaterThanOrEqual(0.95);
});

test("AB10 one persistent film behind every route: it keeps playing through navigation, loops and rests while hidden", async ({
  page,
}) => {
  const seen = artRequests(page);
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app");
  const field = page.locator(".abyss");
  await expect(field).toHaveAttribute("data-film", "playing", {
    timeout: 30000,
  });
  type Marked = HTMLVideoElement & {
    __mark?: number;
    __last?: number;
    __wrapped?: boolean;
  };
  const film = page.locator(".abyss video");
  // Mark the element (a remount would lose the mark) and watch its clock wrap at the end of the loop.
  await film.evaluate((v: Marked) => {
    v.__mark = 1;
    v.__last = v.currentTime;
    v.addEventListener("timeupdate", () => {
      if (v.currentTime + 1 < (v.__last ?? 0)) v.__wrapped = true;
      v.__last = v.currentTime;
    });
  });
  const nav = page.getByRole("navigation", { name: "Main navigation" });
  for (const [href, scene] of SCENES.slice(1)) {
    await nav.locator(`a[href='${href}']`).click();
    await expect(field).toHaveAttribute("data-scene", scene);
    const state = await film.evaluate((v: Marked) => ({
      mark: v.__mark ?? 0,
      paused: v.paused,
    }));
    expect(state, href).toEqual({ mark: 1, paused: false });
  }
  await expect(film).toHaveCount(1);
  // It loops: the clock wraps past the end of the 8 s film and keeps playing.
  await expect
    .poll(() => film.evaluate((v: Marked) => v.__wrapped === true), {
      timeout: 20000,
    })
    .toBe(true);
  expect(await film.evaluate((v: Marked) => !v.paused && !v.ended)).toBe(true);
  // A hidden tab does not decode the film; it resumes when the visitor returns.
  const visibility = (hidden: boolean) =>
    page.evaluate((hidden) => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => hidden,
      });
      document.dispatchEvent(new Event("visibilitychange"));
    }, hidden);
  await visibility(true);
  await expect.poll(() => film.evaluate((v: Marked) => v.paused)).toBe(true);
  await visibility(false);
  await expect.poll(() => film.evaluate((v: Marked) => v.paused)).toBe(false);
  // One film for the whole visit: navigation never requested another derivative.
  expect([...new Set(seen.filter((p) => p.endsWith(".mp4")))]).toEqual([
    "/assets/veined/ocean-film/app-l1280.mp4",
  ]);
});
