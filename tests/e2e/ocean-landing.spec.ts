// Ocean film candidate: the landing page is one descent through the owner's underwater film (01), from the surface at
// the hero to the ocean floor at the closing call. Asserts the promises of that system: one decorative,
// non-interactive stage behind the whole page; the film's frame is a pure function of scroll position (slow, fast,
// reverse, jumps, resize, reload); the film is never played on its own; one silent derivative for the viewport,
// loaded after the page; a still ocean for reduced motion, data saving, missing H.264 and decode failures; clicks
// always reach the page; Points shows only its fixed rules (live week private); RTL mirrors the world; both themes
// are axe-clean and a theme change downloads nothing; no opaque band interrupts the water.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const FILM = "/assets/veined/ocean-film/";
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
}
function filmRequests(page: Page) {
  const seen: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith(FILM)) seen.push(u.pathname);
  });
  return seen;
}
const settle = (page: Page) =>
  page.evaluate(
    () =>
      new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(() => r(null))),
      ),
  );
/** The descent curve (scroll progress → frame), the knots published in ocean-film.ts; evaluated independently here:
 * open water lingers, the arm-morph passage (frames 160–212) is crossed faster, the floor settles last. */
const CURVE: readonly (readonly [number, number])[] = [
  [0, 0],
  [0.7, 160],
  [0.84, 212],
  [1, 239],
];
function descentFrame(progress: number, curve = CURVE): number {
  const p = Math.min(1, Math.max(0, progress));
  for (let i = 1; i < curve.length; i++)
    if (p <= curve[i][0]) {
      const [p0, f0] = curve[i - 1],
        [p1, f1] = curve[i];
      return Math.round(f0 + ((p - p0) / (p1 - p0)) * (f1 - f0));
    }
  return 239;
}
/** The frame the page position asks for (same curve as ocean-film.ts, computed independently here). */
const expectedFrame = (page: Page) =>
  page.evaluate((curve) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    const p = max > 0 ? Math.min(1, Math.max(0, scrollY / max)) : 0;
    for (let i = 1; i < curve.length; i++)
      if (p <= curve[i][0]) {
        const [p0, f0] = curve[i - 1],
          [p1, f1] = curve[i];
        return Math.round(f0 + ((p - p0) / (p1 - p0)) * (f1 - f0));
      }
    return 239;
  }, CURVE);
/** The frame actually decoded: the stage's reported frame and the video's own clock must agree. */
const shownFrame = (page: Page) =>
  page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>(".ocean-stage")!;
    const video = stage.querySelector("video");
    return {
      reported: Number(stage.dataset.frame ?? -1),
      clock: video ? Math.floor(video.currentTime * 24 + 1e-3) : -1,
      paused: video?.paused ?? true,
    };
  });
async function scrollToFraction(page: Page, f: number) {
  await page.evaluate(
    (f) =>
      window.scrollTo(
        0,
        Math.round(f * (document.documentElement.scrollHeight - innerHeight)),
      ),
    f,
  );
  await settle(page);
}
/** After any scroll the film settles on exactly the frame of the position (and is never playing by itself). The
 * position is re-read on every poll, so smooth scrolling that is still under way cannot leave a stale expectation. */
async function expectSynced(page: Page, label: string) {
  let want = -1;
  await expect
    .poll(
      async () => {
        want = await expectedFrame(page);
        const shown = await shownFrame(page);
        return shown.reported === want && shown.clock === want
          ? "synced"
          : `want ${want} reported ${shown.reported} clock ${shown.clock}`;
      },
      { timeout: 15000, message: label },
    )
    .toBe("synced");
  expect((await shownFrame(page)).paused, label).toBe(true);
  return want;
}
async function filmReady(page: Page) {
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(page.locator(".ocean-stage")).toHaveAttribute(
    "data-film",
    "film",
    { timeout: 30000 },
  );
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

test("OL1 one decorative stage: one silent film for this viewport, loaded after the page; hero still first; nothing focusable", async ({
  page,
}) => {
  const seen = filmRequests(page);
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const stage = page.locator(".ocean-stage");
  await expect(stage).toHaveCount(1);
  await expect(stage).toHaveAttribute("aria-hidden", "true");
  await expect(stage).toHaveCSS("pointer-events", "none");
  await expect(stage).toHaveCSS("position", "fixed");
  // The surface still is the server-rendered hero image, eager and high priority.
  const hero = stage.locator(".ocean-still img");
  await expect(hero).toHaveAttribute("loading", "eager");
  await expect(hero).toHaveAttribute("fetchpriority", "high");
  await filmReady(page);
  const video = stage.locator("video");
  await expect(video).toHaveCount(1);
  const props = await video.evaluate((v: HTMLVideoElement) => ({
    muted: v.muted,
    controls: v.controls,
    autoplay: v.autoplay,
    loop: v.loop,
    inline: v.playsInline,
    src: new URL(v.currentSrc).pathname,
  }));
  expect(props).toEqual({
    muted: true,
    controls: false,
    autoplay: false,
    loop: false,
    inline: true,
    src: `${FILM}landing-l1280.mp4`,
  });
  expect(
    await stage.evaluate(
      (el) =>
        el.querySelectorAll("a, button, input, select, [tabindex]").length,
    ),
  ).toBe(0);
  expect(await page.locator("canvas").count()).toBe(0);
  // One film derivative for this viewport, no application film on the marketing page.
  const films = [...new Set(seen.filter((p) => p.endsWith(".mp4")))];
  expect(films).toEqual([`${FILM}landing-l1280.mp4`]);
  // The derivative carries no audio track (no 'soun' handler in its movie header).
  const audio = await page.evaluate(async (url) => {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const text = new TextDecoder("latin1").decode(bytes.subarray(0, 200000));
    const moov = text.indexOf("moov");
    return {
      moov,
      soun: text.indexOf("soun", moov),
      vide: text.indexOf("vide", moov),
    };
  }, `${FILM}landing-l1280.mp4`);
  expect(audio.moov).toBeGreaterThan(0);
  expect(audio.vide).toBeGreaterThan(audio.moov);
  expect(audio.soun).toBe(-1);
});

test("OL2 scroll drives the descent: slow, fast, reverse and jumps land on the exact frame; the film never plays on its own", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await filmReady(page);
  expect(await expectSynced(page, "top")).toBe(0);
  // Slow descent with the wheel: the frame only ever moves forward.
  await page.mouse.move(700, 450);
  let last = 0;
  for (let i = 0; i < 12; i++) {
    await page.mouse.wheel(0, 240);
    await settle(page);
    const f = await expectSynced(page, `wheel down ${i}`);
    expect(f).toBeGreaterThanOrEqual(last);
    last = f;
  }
  expect(last).toBeGreaterThan(0);
  // Reverse: the same journey backwards.
  for (let i = 0; i < 6; i++) {
    await page.mouse.wheel(0, -240);
    await settle(page);
    const f = await expectSynced(page, `wheel up ${i}`);
    expect(f).toBeLessThanOrEqual(last);
    last = f;
  }
  // Depth stops: surface, mid-water, ocean floor, and back.
  for (const f of [0.5, 1, 0.25, 0]) {
    await scrollToFraction(page, f);
    expect(await expectSynced(page, `fraction ${f}`)).toBe(descentFrame(f));
  }
  // Fast scrolling: many positions inside one second, then the frame of the last one exactly.
  await page.evaluate(async () => {
    const max = document.documentElement.scrollHeight - innerHeight;
    for (const f of [0.9, 0.1, 0.8, 0.3, 0.95, 0.05, 0.6, 0.42])
      await new Promise((r) =>
        requestAnimationFrame(() => {
          window.scrollTo(0, Math.round(f * max));
          r(null);
        }),
      );
  });
  expect(await expectSynced(page, "after fast scroll")).toBe(
    descentFrame(0.42),
  );
  // Jumping to sections through the header navigation.
  for (const section of ["#safety", "#bridge", "#portfolio"]) {
    await page.locator(`.mk-nav a[href='/${section}']`).click();
    await expect(page.locator(section)).toBeInViewport();
    await expectSynced(page, `jump ${section}`);
  }
});

test("OL2b resize and reload at a saved scroll position keep the film on the frame of the position", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await filmReady(page);
  await scrollToFraction(page, 0.6);
  await expectSynced(page, "before resize");
  for (const [w, h] of [
    [1100, 900],
    [1920, 1080],
    [1440, 900],
  ] as const) {
    await page.setViewportSize({ width: w, height: h });
    await settle(page);
    await page.evaluate(() => window.dispatchEvent(new Event("resize")));
    await expectSynced(page, `resize ${w}x${h}`);
  }
  const y = await page.evaluate(() => scrollY);
  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toBeAttached();
  // Wherever the browser restores the visitor, the depth matches the position before the film arrives…
  const restored = await page.evaluate(() => scrollY);
  await expect(page.locator(".ocean-stage")).toHaveAttribute(
    "data-film",
    "film",
    { timeout: 30000 },
  );
  // …and the film starts on the frame of the restored position (no detour through the surface).
  const f = await expectSynced(page, `reload at ${restored} (was ${y})`);
  if (restored > 0) expect(f).toBeGreaterThan(0);
});

test("OL3 reduced motion: a still ocean — no film is requested; depth stills follow the visitor", async ({
  page,
}) => {
  const seen = filmRequests(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const stage = page.locator(".ocean-stage");
  await expect(stage).toHaveAttribute("data-mode", "still");
  await expect(stage.locator("video")).toHaveCount(0);
  for (const [f, depth] of [
    [0, "0"],
    [0.33, "1"],
    [0.66, "2"],
    [1, "3"],
  ] as const) {
    await scrollToFraction(page, f);
    await expect(stage).toHaveAttribute("data-depth", depth);
  }
  await expect(stage.locator(".ocean-depth")).toBeVisible();
  await expect
    .poll(() =>
      stage
        .locator(".ocean-depth")
        .evaluate((el) => getComputedStyle(el).backgroundImage),
    )
    .toContain("landing-d3-l1280.webp");
  await page.waitForLoadState("networkidle");
  expect(seen.filter((p) => p.endsWith(".mp4"))).toEqual([]);
});

for (const [width, height] of [
  [360, 780],
  [390, 844],
  [768, 1024],
  [1440, 900],
] as const)
  test(`OL4 ${width}: the page stays on top of the water (clicks, no overflow)`, async ({
    page,
  }) => {
    await setup(page);
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await overflow(page)).toBe(false);
    for (const selector of [
      ".mk-hero .mk-button.is-primary",
      "#points a[href='/points']",
      ".mk-final .mk-button.is-primary",
    ]) {
      const link = page.locator(selector).first();
      await link.scrollIntoViewIfNeeded();
      await settle(page);
      const box = (await link.boundingBox())!;
      const hit = await page.evaluate(
        ([x, y, s]) =>
          document.elementFromPoint(x, y)?.closest("a") ===
          document.querySelector(s),
        [box.x + box.width / 2, box.y + box.height / 2, selector] as const,
      );
      expect(hit, selector).toBe(true);
    }
    expect(await overflow(page)).toBe(false);
  });

test("OL5 Points on the landing states only the lifetime rules: no pool, no ranking, not active yet", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const points = page.locator("#points");
  await expect(points.getByRole("heading", { level: 2 })).toHaveText("Points");
  await expect(points).not.toContainText("200,000");
  await expect(points).toContainText("10%");
  await expect(points).toContainText("Not active yet");
  await expect(points).toContainText("There are no sign-up or welcome points.");
  await expect(points.locator("a[href='/points']")).toBeVisible();
  // No ranking, balance or leaderboard of any week is rendered here. (The accepted privacy sentence itself says
  // "rankings … are not shown", so the check targets rank data, not that word.)
  await expect(
    points.locator("table, ol, [role='table'], [role='row']"),
  ).toHaveCount(0);
  await expect(points).not.toContainText(/leaderboard|\brank\s*#?\d|#\d/i);
  // The only figures are the rules: the section number, 10 % and the planned "1 point for every 100 USD" (G12 H05).
  const text = (await points.innerText()).replace(/\s+/g, " ");
  expect(text).toContain("1 point for every 100 USD");
  expect(
    text
      .replace(/\b10%|\b05\b/g, "")
      .replace("1 point for every 100 USD", "")
      .match(/\d/g),
    text,
  ).toBeNull();
});

test("OL6 RTL mirrors the world so the organism faces the copy", async ({
  page,
}) => {
  await setup(page, "ar");
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator(".ocean-stage .ocean-still")).toHaveCSS(
    "scale",
    "-1 1",
  );
  await filmReady(page);
  await expect(page.locator(".ocean-stage video")).toHaveCSS("scale", "-1 1");
  await scrollToFraction(page, 0.5);
  await expectSynced(page, "rtl middle");
  expect(await overflow(page)).toBe(false);
});

test("OL7 the still ocean also covers decode failure, data saving, slow links and browsers without H.264", async ({
  browser,
}) => {
  const cases: [string, (page: Page) => Promise<void>][] = [
    [
      "decode failure",
      async (page) => {
        await page.route("**/assets/veined/ocean-film/*.mp4", (r) =>
          r.fulfill({ status: 200, contentType: "video/mp4", body: "broken" }),
        );
      },
    ],
    [
      "data saving",
      async (page) => {
        await page.addInitScript(() =>
          Object.defineProperty(navigator, "connection", {
            value: { saveData: true },
            configurable: true,
          }),
        );
      },
    ],
    [
      "slow link",
      async (page) => {
        await page.addInitScript(() =>
          Object.defineProperty(navigator, "connection", {
            value: { saveData: false, effectiveType: "3g" },
            configurable: true,
          }),
        );
      },
    ],
    [
      "no H.264",
      async (page) => {
        await page.addInitScript(() => {
          HTMLMediaElement.prototype.canPlayType = () => "";
        });
      },
    ],
  ];
  for (const [label, arrange] of cases) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    await setup(page);
    await arrange(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const stage = page.locator(".ocean-stage");
    await expect(stage, label).toHaveAttribute("data-mode", "still", {
      timeout: 20000,
    });
    await expect(stage.locator("video"), label).toHaveCount(0);
    await scrollToFraction(page, 1);
    await expect(stage, label).toHaveAttribute("data-depth", "3");
    await context.close();
  }
});

test("OL8 both themes are axe-clean; daylight is the same film under a haze of sunlit water", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await filmReady(page);
  const dark = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(dark.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
  const src = await page
    .locator(".ocean-stage video")
    .evaluate((v: HTMLVideoElement) => v.currentSrc);
  await page.locator(".mk-theme-toggle").click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  const haze = await page
    .locator(".ocean-stage")
    .evaluate((el) => getComputedStyle(el, "::after").backgroundColor);
  expect(haze).toBe("rgba(226, 242, 239, 0.58)");
  expect(
    await page
      .locator(".ocean-stage video")
      .evaluate((v: HTMLVideoElement) => v.currentSrc),
  ).toBe(src);
  await expect(page.locator(".ocean-stage")).toHaveAttribute(
    "data-film",
    "film",
  );
  const day = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(day.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("OL9 a theme change downloads nothing; a phone loads only the portrait derivative", async ({
  page,
}) => {
  const seen = filmRequests(page);
  await setup(page, "en", "light");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await filmReady(page);
  await scrollToFraction(page, 0.5);
  await expectSynced(page, "phone middle");
  await page.waitForLoadState("networkidle");
  const before = [...new Set(seen)];
  expect(before.filter((p) => p.endsWith(".mp4"))).toEqual([
    `${FILM}landing-p456.mp4`,
  ]);
  expect(before.some((p) => /-l(960|1280)\./.test(p))).toBe(false);
  for (let i = 0; i < 2; i++) {
    await page.locator(".mk-theme-toggle").click();
    await settle(page);
  }
  await page.waitForTimeout(400);
  expect([...new Set(seen)].sort()).toEqual(before.sort());
});

for (const [width, height, locale] of [
  [1920, 1080, "en"],
  [1440, 900, "ar"],
  [390, 844, "en"],
] as const)
  test(`OL10 ${width} ${locale}: the water stays behind the whole page and the frame follows every position`, async ({
    page,
  }) => {
    await setup(page, locale);
    await page.setViewportSize({ width, height });
    await page.goto("/");
    await filmReady(page);
    // No section between the hero and the closing call paints an opaque band over the water.
    const opaque = await page.evaluate(() =>
      [
        ...document.querySelectorAll<HTMLElement>(
          ".ocean-landing > section, .ocean-landing > nav",
        ),
      ]
        .filter((el) => {
          const c = getComputedStyle(el).backgroundColor;
          const m = c.match(/[\d.]+/g)?.map(Number) ?? [];
          const alpha = c.startsWith("rgba") ? m[3] : m.length >= 3 ? 1 : 0;
          return c !== "transparent" && alpha >= 0.95;
        })
        .map((el) => el.id || el.className),
    );
    expect(opaque).toEqual([]);
    for (let i = 0; i <= 20; i++) {
      await scrollToFraction(page, i / 20);
      await expectSynced(page, `${width} ${locale} ${i}/20`);
      await expect(page.locator(".ocean-stage video")).toBeInViewport();
    }
  });
