import { test, expect } from "./fixtures";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const root =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-12/adhoc";
for (const width of [360, 390, 768, 1440])
  for (const theme of ["dark", "light"])
    test(`V112 surfaces ${width} ${theme}: layout, images and accessibility`, async ({
      page,
    }) => {
      test.setTimeout(180000);
      await page.setViewportSize({ width, height: 1000 });
      await page.context().addCookies([
        {
          name: "otherbridge.locale",
          value: "en",
          url: "http://127.0.0.1:3100",
        },
      ]);
      await page.addInitScript(
        ({ theme }) => {
          localStorage.setItem("otherbridge.language", "en");
          localStorage.setItem("otherbridge.theme", theme);
        },
        { theme },
      );
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      for (const [name, path] of [
        ["landing", "/"],
        ["bridge", "/bridge"],
        ["swap", "/swap"],
        ["portfolio", "/portfolio"],
        ["activity", "/activity"],
        ["networks", "/networks"],
        ["help", "/help"],
        ["docs", "/docs"],
      ]) {
        await page.goto(path);
        await expect(page.locator("main").first()).toBeVisible();
        await page.evaluate(
          (theme) => (document.documentElement.dataset.theme = theme),
          theme,
        );
        await page.waitForTimeout(350);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          ),
          `${name} overflow`,
        ).toBe(false);
        const bad = await page.locator("main img").evaluateAll((imgs) =>
          imgs
            .filter((x) => {
              const i = x as HTMLImageElement;
              return i.complete && i.naturalWidth === 0;
            })
            .map((x) => x.getAttribute("src")),
        );
        expect(bad, `${name} broken logos`).toEqual([]);
        const axe = await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze();
        mkdirSync(`${root}/accessibility`, { recursive: true });
        writeFileSync(
          `${root}/accessibility/${name}-${width}-${theme}.json`,
          JSON.stringify(axe, null, 2),
        );
        expect(axe.violations, `${name} axe`).toEqual([]);
        mkdirSync(`${root}/screenshots/after`, { recursive: true });
        await page.screenshot({
          path: `${root}/screenshots/after/${name}-${width}-${theme}.png`,
          fullPage: true,
        });
      }
      expect(errors).toEqual([]);
    });
test("V112 docs keyboard search and mobile navigation", async ({ page }) => {
  await page.goto("/docs");
  await page.keyboard.press("Control+k");
  await expect(page.locator("#docs-search")).toBeFocused();
  await page.locator("#docs-search").fill("fee");
  await expect(page.getByRole("listbox")).toBeVisible();
  await page.keyboard.press("ArrowDown");
  await expect(page.locator("#docs-search")).toHaveAttribute(
    "aria-activedescendant",
    "docs-result-1",
  );
  await page.keyboard.press("Escape");
  await expect(page.locator("#docs-search")).toHaveValue("");
  await page.setViewportSize({ width: 360, height: 900 });
  await expect(page.locator(".dk-mobile-nav summary")).toBeVisible();
  await page.locator(".dk-mobile-nav summary").click();
  await expect(page.locator(".dk-mobile-nav nav a")).toHaveCount(14);
});
test("V112 empty swap centers the trade card and bridge fees stay available", async ({
  page,
}) => {
  await page.addInitScript(() =>
    localStorage.setItem("otherbridge.language", "en"),
  );
  await page.goto("/swap");
  // Measure the loaded canonical form, after the catalog/loading card is replaced by its lazy client chunk.
  await expect(page.getByTestId("swap-intelligence")).toBeVisible();
  await expect(page.locator(".swap-card")).toBeVisible();
  await expect(page.locator(".swap-layout")).toBeVisible();
  await expect(page.locator(".swap-layout")).toHaveClass(/is-unquoted/);
  await expect(page.locator(".swap-layout aside")).toHaveCount(0);
  const box = await page.locator(".swap-card").boundingBox();
  const layout = await page.locator(".swap-layout").boundingBox();
  expect(box).not.toBeNull();
  expect(layout).not.toBeNull();
  expect(box!.width).toBeLessThanOrEqual(661);
  expect(
    Math.abs(box!.x + box!.width / 2 - (layout!.x + layout!.width / 2)),
  ).toBeLessThan(2);
  await page.goto("/bridge");
  await expect(page.locator(".bridge-receive")).toBeVisible();
  await expect(page.locator("details.fees")).not.toHaveAttribute("open", "");
  await page.locator(".fees-head").click();
  await expect(page.locator("details.fees")).toHaveAttribute("open", "");
});
