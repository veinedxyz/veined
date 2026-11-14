// gf1 G05 "Tide" visual layer: page titles sit on the water (no framed band), the Overview flow is one surface with
// four stations, content cards carry no drop shadow while the Swap instrument stays the one framed, opaque object,
// financial figures sit on opaque surfaces, and every destination stays axe-clean in dark and light, LTR and RTL,
// desktop and phone, with no sideways scroll. The navigation arm still holds the selected destination.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const APP = [
  "/app",
  "/portfolio",
  "/activity",
  "/networks",
  "/help",
  "/points",
  "/guardian",
];

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
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
async function axe(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
/** The page heading's own frame: border widths, shadow and background of the band itself. */
const heading = (page: Page) =>
  page
    .locator("main .page-heading")
    .first()
    .evaluate((e) => {
      const s = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const h1 = e.querySelector("h1")!.getBoundingClientRect();
      return {
        border: ["Top", "Right", "Bottom", "Left"].map((k) =>
          parseFloat(s.getPropertyValue(`border-${k.toLowerCase()}-width`)),
        ),
        shadow: s.boxShadow,
        left: r.left,
        right: r.right,
        h1: { left: h1.left, right: h1.right, height: h1.height },
      };
    });

for (const [locale, theme, width] of [
  ["en", "dark", 1440],
  ["en", "light", 1440],
  ["ar", "dark", 1440],
  ["en", "dark", 390],
] as const)
  test(`GF1-G5-V1 ${locale} ${theme} ${width}: page titles sit on the water, no framed band, no sideways scroll, axe-clean`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    await setup(page, locale, theme);
    await page.setViewportSize({ width, height: 900 });
    for (const path of APP.slice(1)) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      const h = await heading(page);
      expect(h.border, path).toEqual([0, 0, 0, 0]);
      expect(h.shadow, path).toBe("none");
      expect(h.h1.height).toBeGreaterThan(20);
      // RTL: the title starts at the inline start (right).
      if (locale === "ar") expect(h.right - h.h1.right).toBeLessThan(40);
      else expect(h.h1.left - h.left).toBeLessThan(40);
      expect(await overflow(page), path).toBe(false);
      await axe(page);
    }
  });

// VWP G08 (Almanac): the G05 shared surface became one ruled set on open water. The intent is unchanged and checked
// more strictly: four stations under one rule, and no station is its own card (no frame, no fill, no corner).
test("GF1-G5-V2 Overview: the flow is one ruled set with four stations, none of them a card; every step keeps its content and links", async ({
  page,
}) => {
  await setup(page);
  for (const width of [1440, 1100, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/app");
    const steps = page.locator(".overview-flow-steps");
    await expect(steps).toBeVisible();
    const s = await steps.evaluate((e) => {
      const cs = getComputedStyle(e);
      const sides = (x: CSSStyleDeclaration) =>
        ["Top", "Right", "Bottom", "Left"].filter(
          (k) =>
            parseFloat(x.getPropertyValue(`border-${k.toLowerCase()}-width`)) >
              0 &&
            x.getPropertyValue(`border-${k.toLowerCase()}-style`) !== "none",
        ).length;
      return {
        border: parseFloat(cs.borderTopWidth),
        radius: parseFloat(cs.borderTopLeftRadius),
        frameSides: sides(cs),
        gap: cs.rowGap,
        items: [...e.children].map((li) => {
          const l = getComputedStyle(li);
          return {
            radius: parseFloat(l.borderTopLeftRadius),
            bg: l.backgroundColor,
            image: l.backgroundImage,
            frameSides: sides(l),
          };
        }),
      };
    });
    // One rule above the set; the set itself is not a framed box.
    expect(s.border).toBeGreaterThan(0);
    expect(s.radius).toBe(0);
    expect(s.frameSides).toBeLessThan(4);
    expect(s.gap).toBe("0px");
    expect(s.items).toHaveLength(4);
    for (const item of s.items) {
      expect(item.radius).toBe(0);
      expect(item.frameSides).toBeLessThan(4);
      expect(item.bg).toBe("rgba(0, 0, 0, 0)");
      expect(item.image).toBe("none");
    }
    await expect(steps.locator("li")).toHaveCount(4);
    await expect(steps.getByRole("link", { name: "Swap" })).toBeVisible();
    await expect(steps.getByRole("link", { name: "Bridge" })).toBeVisible();
    await expect(
      steps.getByRole("link", { name: "Ask Guardian" }),
    ).toBeVisible();
    await expect(steps.locator("[data-closed]")).toBeVisible();
    expect(await overflow(page)).toBe(false);
  }
  await axe(page);
});

for (const theme of ["dark", "light"] as const)
  test(`GF1-G5-V3 ${theme}: depth without shadows: content cards carry no drop shadow; the Swap instrument is the one framed, opaque object`, async ({
    page,
  }) => {
    await setup(page, "en", theme);
    await page.setViewportSize({ width: 1440, height: 900 });
    for (const path of ["/app", "/portfolio", "/points", "/networks"]) {
      await page.goto(path);
      await expect(page.locator("main h1").first()).toBeVisible();
      const dropped = await page.evaluate(() =>
        [...document.querySelectorAll("main .card, main .overview-tool")]
          .map((e) => getComputedStyle(e).boxShadow)
          .filter(
            (s) =>
              s !== "none" && !/^rgba?\([^)]*\) 0px 1px 0px 0px inset$/.test(s),
          ),
      );
      expect(dropped, path).toEqual([]);
    }
    await page.goto("/swap");
    // The Swap instrument itself (its section carries both the card classes and this test id).
    const card = page.locator(".swap-card[data-testid='swap-intelligence']");
    await expect(card).toBeVisible();
    await page.waitForLoadState("networkidle");
    // Read once the instrument is settled (a node replaced while hydrating reads as empty styles).
    await expect
      .poll(() =>
        card.evaluate((e) => parseFloat(getComputedStyle(e).borderTopWidth)),
      )
      .toBeGreaterThan(0);
    const c = await card.evaluate((e) => {
      const s = getComputedStyle(e);
      return { shadow: s.boxShadow, bg: s.backgroundColor };
    });
    // At least one outer shadow layer (not only the inset top light).
    expect(
      c.shadow
        .split(/,(?![^(]*\))/)
        .some((l) => !/inset/.test(l) && /\d+px \d+px \d+px/.test(l)),
      c.shadow,
    ).toBe(true);
    // Figures never sit on see-through glass: the instrument's own colour is fully opaque.
    expect(c.bg).toMatch(/^rgb\(/);
  });

test("GF1-G5-V4 the navigation arm still holds the selected destination and never takes a click", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/networks");
  // The selected destination (the rail's "More" toggle, hidden on wide screens, is also marked for phones).
  const active = page.locator(".main-nav a.nav-link.active");
  await expect(active).toHaveCount(1);
  await expect(active).toHaveAttribute("href", "/networks");
  const arm = active.locator(".nav-arm").first();
  await expect(arm).toHaveAttribute("aria-hidden", "true");
  expect(await arm.evaluate((e) => getComputedStyle(e).pointerEvents)).toBe(
    "none",
  );
  await page.locator(".main-nav a[href='/help']").click();
  await expect(page).toHaveURL(/\/help$/);
});

test("GF1-G5-V5 nothing jumps while a page loads: Guardian on a phone and Networks on a wide screen stay under 0.1 layout shift", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(() => {
    (window as unknown as { __cls: number }).__cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as (PerformanceEntry & {
        value: number;
        hadRecentInput: boolean;
      })[])
        if (!e.hadRecentInput)
          (window as unknown as { __cls: number }).__cls += e.value;
    }).observe({ type: "layout-shift", buffered: true });
  });
  for (const [path, width, height] of [
    ["/guardian", 390, 844],
    ["/networks", 1440, 900],
    ["/points", 390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    await page.goto(path);
    await expect(page.locator("main h1").first()).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(800);
    const cls = await page.evaluate(
      () => (window as unknown as { __cls: number }).__cls,
    );
    expect(cls, `${path} ${width}`).toBeLessThan(0.1);
  }
});

/** Worst case (10th percentile) contrast of an element's text against what is really behind it: the element is shot
 * with its own text made transparent and the pixels are read in the page's canvas (no extra dependency). */
async function textContrast(page: Page, selector: string) {
  const el = page.locator(selector).first();
  await el.scrollIntoViewIfNeeded();
  const color = await el.evaluate((e) => getComputedStyle(e).color);
  const box = (await el.boundingBox())!;
  // The text and any image inside it (a title's logo is not its backdrop) are hidden for the shot, then restored.
  const hide = (on: boolean) =>
    el.evaluate((e, hidden) => {
      (e as HTMLElement).style.color = hidden ? "transparent" : "";
      for (const m of e.querySelectorAll<HTMLElement | SVGElement>("img, svg"))
        m.style.visibility = hidden ? "hidden" : "";
    }, on);
  await hide(true);
  const png = await page.screenshot({ clip: box, animations: "disabled" });
  await hide(false);
  return page.evaluate(
    async ([b64, col]) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      const lin = (v: number) => {
        const x = v / 255;
        return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
      };
      const lum = (r: number, g: number, b: number) =>
        0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      const m = col.match(/[\d.]+/g)!.map(Number);
      // The text colour may be translucent: blend it over each backdrop pixel before comparing (G05 review m-A).
      const a = m.length > 3 ? m[3] : 1;
      const ratios: number[] = [];
      for (let i = 0; i < d.length; i += 4 * 5) {
        const lb = lum(d[i], d[i + 1], d[i + 2]);
        const lt = lum(
          a * m[0] + (1 - a) * d[i],
          a * m[1] + (1 - a) * d[i + 1],
          a * m[2] + (1 - a) * d[i + 2],
        );
        const [hi, lo] = lt > lb ? [lt, lb] : [lb, lt];
        ratios.push((hi + 0.05) / (lo + 0.05));
      }
      ratios.sort((a, b) => a - b);
      return ratios[Math.floor(ratios.length * 0.1)];
    },
    [png.toString("base64"), color] as const,
  );
}

for (const [theme, width, locale] of [
  ["light", 1440, "en"],
  ["dark", 1440, "en"],
  ["light", 390, "en"],
  ["light", 1100, "de"],
  ["dark", 390, "en"],
] as const)
  test(`GF1-G5-V6 ${theme} ${width} ${locale}: titles, ledes and heading pills over the film keep WCAG AA contrast (pixel-sampled, worst 10%)`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    await setup(page, locale, theme);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width, height: 900 });
    for (const path of [
      "/portfolio",
      "/activity",
      "/networks",
      "/help",
      "/points",
      "/guardian",
      "/bridge",
    ]) {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      const head = path === "/bridge" ? "main .intro" : "main .page-heading";
      await expect(page.locator(`${head} h1`).first()).toBeVisible();
      // Large titles need 3:1, body-size ledes 4.5:1 (WCAG 2.1 AA 1.4.3). Measured values go to the run log.
      const title = await textContrast(page, `${head} h1`);
      console.log(
        `CONTRAST ${theme} ${width} ${path} title ${title.toFixed(2)}`,
      );
      expect(title, `${theme} ${width} ${path} title`).toBeGreaterThanOrEqual(
        3,
      );
      const lede =
        path === "/bridge" ? "main .intro p" : "main .page-heading .page-lede";
      if (await page.locator(lede).count()) {
        const body = await textContrast(page, lede);
        console.log(
          `CONTRAST ${theme} ${width} ${path} lede ${body.toFixed(2)}`,
        );
        expect(body, `${theme} ${width} ${path} lede`).toBeGreaterThanOrEqual(
          4.5,
        );
      }
      // Everything on the heading's meta row (eyebrow and pills; G05 review m-B): small text, 4.5:1.
      const pills = page.locator(`${head} .page-meta > *`);
      for (let i = 0; i < (await pills.count()); i++) {
        const pill = await textContrast(
          page,
          `${head} .page-meta > * >> nth=${i}`,
        );
        console.log(
          `CONTRAST ${theme} ${width} ${locale} ${path} pill${i} ${pill.toFixed(2)}`,
        );
        expect(
          pill,
          `${theme} ${width} ${locale} ${path} pill ${i}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });
