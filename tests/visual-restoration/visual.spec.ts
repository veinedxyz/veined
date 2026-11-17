import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { setup, connect, quote, calls } from "./helpers";
const phase = process.env.VISUAL_PHASE ?? "after";
const dir = `../evidence/${phase}`;
mkdirSync(dir, { recursive: true });
async function shot(page: Page, name: string) {
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.screenshot({ path: `${dir}/${name}.png`, animations: "disabled" });
  await page.screenshot({
    path: `${dir}/${name}-full.png`,
    fullPage: true,
    animations: "disabled",
  });
  if (phase === "after") {
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(page.locator(".mw-simple-layout")).toBeVisible();
    await expect(page.locator(".manual-wallet select:enabled")).toHaveCount(0);
    await expect(page.getByLabel("Exact input")).toHaveAttribute(
      "readonly",
      "",
    );
    const scene = await page.locator(".abyss-still").evaluate((el) => ({
      visibility: getComputedStyle(el).visibility,
      image: getComputedStyle(el).backgroundImage,
    }));
    expect(scene.visibility).toBe("visible");
    expect(scene.image).toContain(
      `/ocean/${name.startsWith("swap") ? "swap" : "bridge"}-`,
    );
    const instrument = await page
      .locator(".mw-instrument")
      .evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(instrument).toMatch(/^rgb\(/);
    if (
      page.viewportSize()!.width === 390 &&
      (await page.getByTestId("guardian-dock-trigger").isVisible())
    ) {
      const dock = await page
        .getByTestId("guardian-dock-trigger")
        .boundingBox();
      const form = await page.locator(".mw-instrument").boundingBox();
      expect(dock!.y + dock!.height).toBeLessThanOrEqual(form!.y);
    }
  }
}
async function marker(page: Page) {
  await page.locator("section.manual-wallet").evaluate((el) => {
    const p = document.createElement("p");
    p.className = "visual-eyebrow";
    p.textContent = "SYNTHETIC UI EVIDENCE · KEYLESS WALLET · NO TRANSACTIONS";
    el.prepend(p);
  });
}
for (const width of [1440, 390])
  for (const lane of ["swap", "bridge"]) {
    test(`${lane} ${width}: disconnected, connected, READY, closed, pending, receipt, warning, error`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      const bodies = await setup(page, { expiry: 120_000 });
      await page.goto(`/${lane}`);
      await expect(quote(page)).toHaveCount(0);
      await marker(page);
      await shot(page, `${lane}-${width}-disconnected`);
      await connect(page);
      await marker(page);
      await shot(page, `${lane}-${width}-connected`);
      await quote(page).click();
      await expect(page.getByLabel("Guardian review")).toContainText("READY");
      await shot(page, `${lane}-${width}-ready`);
      await page
        .getByRole("button", { name: "Prepare exact approval", exact: true })
        .click();
      await expect(
        page.getByLabel("Prepared wallet transaction"),
      ).toContainText("OWNER_RELEASE_REQUIRED");
      await expect(
        page.getByRole("button", { name: "Review & sign in wallet" }),
      ).toBeDisabled();
      await page
        .getByLabel("Prepared wallet transaction")
        .getByRole("checkbox")
        .check();
      await expect(
        page.getByRole("button", { name: "Review & sign in wallet" }),
      ).toBeDisabled();
      await shot(page, `${lane}-${width}-closed`);
      await page
        .getByText("Details · route, fees & transaction", { exact: true })
        .click();
      const track = page.getByRole("button", {
        name: "Check receipts, settlement & balances",
        exact: true,
      });
      await track.click();
      await expect(page.getByLabel("Receipt and settlement")).toContainText(
        "DESTINATION_PENDING",
      );
      await shot(page, `${lane}-${width}-pending`);
      await track.click();
      await expect(page.getByLabel("Receipt and settlement")).toContainText(
        "UNKNOWN",
      );
      await shot(page, `${lane}-${width}-unknown`);
      let mode = "source";
      await page.route("**/api/manual-wallet*", async (r) => {
        if (r.request().method() !== "POST") return r.fallback();
        const b = r.request().postDataJSON();
        if (b.action === "track" && mode === "source")
          return r.fulfill({
            json: {
              tracking: {
                state: lane === "swap" ? "SWAP_PENDING" : "SOURCE_PENDING",
                steps: {
                  APPROVE: {
                    state: "FINAL_SUCCESS",
                    hash: "0x" + "a".repeat(64),
                  },
                  [lane === "swap" ? "SWAP" : "EXECUTE"]: {
                    state: "PENDING",
                    hash: "0x" + "b".repeat(64),
                  },
                },
                allowance: { value: "0", agree: true },
                settlement: null,
              },
            },
          });
        if (b.action === "track" && mode === "receipt")
          return r.fulfill({
            json: {
              tracking: {
                state: "SETTLED_VERIFIED",
                steps: {
                  APPROVE: {
                    state: "FINAL_SUCCESS",
                    hash: "0x" + "a".repeat(64),
                  },
                  [lane === "swap" ? "SWAP" : "EXECUTE"]: {
                    state: "FINAL_SUCCESS",
                    hash: "0x" + "b".repeat(64),
                  },
                },
                settlement: {
                  state: "SETTLED_VERIFIED",
                  code: "SYNTHETIC_UI_ONLY",
                },
                allowance: { value: "0", agree: true },
              },
            },
          });
        if (b.action === "review" && mode === "warning")
          return r.fulfill({
            json: {
              review: {
                reviewId: "synthetic-warning",
                ready: false,
                step: null,
                problems: ["GUARDIAN_WARNING"],
                expiresAt: Date.now() + 30_000,
                gas: {},
                balances: {},
                guardian: {
                  level: "WARNING",
                  findings: [
                    "Quote verification is incomplete. Do not proceed.",
                  ],
                },
              },
            },
          });
        if (b.action === "review" && mode === "error")
          return r.fulfill({
            status: 409,
            json: { error: "MANUAL_REQUEST_FAILED" },
          });
        return r.fallback();
      });
      await track.click();
      await expect(page.getByLabel("Receipt and settlement")).toContainText(
        lane === "swap" ? "SWAP_PENDING" : "SOURCE_PENDING",
      );
      await shot(page, `${lane}-${width}-source-pending`);
      mode = "receipt";
      await track.click();
      await expect(page.getByLabel("Receipt and settlement")).toContainText(
        "SETTLED_VERIFIED",
      );
      await shot(page, `${lane}-${width}-receipt`);
      mode = "warning";
      await quote(page).click();
      await expect(page.getByLabel("Guardian review")).toContainText("WARNING");
      await expect(
        page.getByRole("button", { name: /^Prepare exact/ }),
      ).toHaveCount(0);
      await shot(page, `${lane}-${width}-warning`);
      mode = "error";
      await quote(page).click();
      await expect(
        page.locator("section.manual-wallet").getByRole("alert"),
      ).toContainText("STOP");
      await shot(page, `${lane}-${width}-error`);
      expect(
        (await calls(page)).filter((c) => /send|sign/i.test(c.method)),
      ).toEqual([]);
      expect(bodies.filter((b) => b.action === "claim")).toHaveLength(0);
      if (phase === "after") {
        const a11y = await new AxeBuilder({ page })
          .include("section.manual-wallet")
          .analyze();
        writeFileSync(
          `${dir}/${lane}-${width}-axe.json`,
          JSON.stringify(a11y.violations, null, 2),
        );
        expect(a11y.violations).toEqual([]);
      }
    });
  }
if (phase === "after")
  for (const lane of ["swap", "bridge"])
    for (const width of [1440, 390])
      for (const mode of ["light", "rtl", "reduced-motion"]) {
        test(`${lane} ${width} ${mode}`, async ({ page }) => {
          await page.setViewportSize({
            width,
            height: width === 390 ? 844 : 1000,
          });
          await setup(page);
          if (mode === "rtl")
            await page.context().addCookies([
              {
                name: "otherbridge.locale",
                value: "ar",
                url: "http://127.0.0.1:3470",
              },
            ]);
          if (mode === "light")
            await page.addInitScript(() =>
              localStorage.setItem("otherbridge.theme", "light"),
            );
          if (mode === "reduced-motion")
            await page.emulateMedia({ reducedMotion: "reduce" });
          await page.goto(`/${lane}`);
          await expect(
            page
              .locator("section.manual-wallet")
              .getByRole("button", { name: "Connect Wallet", exact: true }),
          ).toBeVisible();
          if (mode === "light")
            await page.evaluate(
              () => (document.documentElement.dataset.theme = "light"),
            );
          if (mode === "rtl")
            await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
          await marker(page);
          await shot(page, `${lane}-${width}-${mode}`);
          const a11y = await new AxeBuilder({ page })
            .include("section.manual-wallet")
            .analyze();
          writeFileSync(
            `${dir}/${lane}-${width}-${mode}-axe.json`,
            JSON.stringify(a11y.violations, null, 2),
          );
          expect(a11y.violations).toEqual([]);
          expect(
            (await calls(page)).filter((c) => /send|sign/i.test(c.method)),
          ).toEqual([]);
        });
      }
