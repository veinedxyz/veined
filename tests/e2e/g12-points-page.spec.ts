// G12 H05 in the real product: the Points page shows the user's own cumulative points only (planned rule: 1 point per
// 100 USD of verified volume, NOT active, no number for a real account); the earlier weekly program is closed and off
// the public page, readable unchanged as an archive with ?weekly=archive; the labelled SAMPLE preview uses the volume
// ledger; the admin sees the read-only volume-policy inspector with every open owner decision. SYNTHETIC_TEST_ONLY.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const OPS = process.env.PTS_E2E_OPS_TOKEN;

async function setup(page: Page, locale = "en") {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript((l) => {
    if (window === window.top) localStorage.setItem("otherbridge.language", l);
  }, locale);
}
async function axe(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);

test("G12-PT-E1 the public Points page: your own points only, the planned 1-per-100-USD rule, not active, no weekly program, no weekly request", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const points: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).pathname === "/api/points")
      points.push(r.postData() ?? "");
  });
  await page.goto("/points");
  const card = page.getByTestId("points-lifetime");
  await expect(card).toHaveAttribute("data-policy", "volume");
  await expect(card).toHaveAttribute(
    "data-policy-state",
    "PENDING_OWNER_POLICY",
  );
  await expect(page.getByTestId("points-lifetime-total")).toHaveText(
    "Not active yet",
  );
  await expect(card).toContainText(
    "Planned rule: 1 point for every 100 USD of your own verified, settled Swap, Trade and Bridge volume.",
  );
  await expect(card).toContainText(
    "Smaller amounts add up toward your next point.",
  );
  await expect(card).toContainText("are not final yet");
  await expect(card).toContainText("not a token");
  // Nothing of the earlier weekly program: no section, countdown, season, pool, ranking or table.
  await expect(page.getByTestId("points-weekly")).toHaveCount(0);
  const main = page.locator("main");
  for (const gone of [
    "Weekly seasons",
    "Season",
    "200,000",
    "Weekly pool",
    "Leaderboard",
  ])
    await expect(main).not.toContainText(gone);
  await expect(main.getByRole("timer")).toHaveCount(0);
  await expect(main.locator("table")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  expect(points).toEqual([]);
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("points-lifetime")).toBeVisible();
  expect(await overflow(page)).toBe(false);
});

test("G12-PT-E2 the earlier weekly program is an archive: opened only with ?weekly=archive, labelled closed, its published results unchanged", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/points?weekly=archive");
  await expect(page.getByTestId("points-lifetime")).toBeVisible();
  const weekly = page.getByTestId("points-weekly");
  await expect(weekly).toBeVisible();
  await expect(page.getByTestId("points-weekly-archived")).toContainText(
    "Archive of the earlier weekly program. It is closed",
  );
  // The archive is not linked from the public page.
  await page.goto("/points");
  await expect(page.locator('a[href*="weekly=archive"]')).toHaveCount(0);
});

test("G12-PT-E3 the labelled SAMPLE shows the volume rule at work and never looks like an account", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/points?lifetimePreview=sample");
  const sample = page.getByTestId("points-lifetime-sample");
  await expect(sample).toContainText("Sample");
  await expect(sample).toContainText(
    "This is not your account and these are not real points.",
  );
  const value = (field: string) => sample.locator(`[data-field="${field}"] dd`);
  // 40 + 60 + 230 USD = 330 USD -> 3 points, 70 USD left to the fourth; invitee's 10 points -> 1 point of commission.
  await expect(value("volume")).toHaveText("$330.00");
  await expect(value("points")).toHaveText("3");
  await expect(value("next")).toHaveText("$70.00");
  await expect(sample.locator('[data-field="next"] dt')).toHaveText(
    "Left to the next point",
  );
  await expect(value("referral")).toHaveText("1");
  await expect(value("pending")).toHaveText("$120.00");
  await expect(value("total")).toHaveText("4");
  // The real card stays without a number.
  await expect(page.getByTestId("points-lifetime-total")).toHaveText(
    "Not active yet",
  );
  await expect(
    page.getByTestId("points-lifetime").getByTestId("points-lifetime-sample"),
  ).toHaveCount(0);
  await axe(page);
});

for (const locale of ["tr", "ar", "de", "ja"] as const)
  test(`G12-PT-E4 ${locale}: the planned rule is translated, fits and is axe-clean`, async ({
    page,
  }) => {
    await setup(page, locale);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/points");
    const card = page.getByTestId("points-lifetime");
    await expect(card).toBeVisible();
    await expect(card).toContainText("100 USD");
    await expect(card).not.toContainText("Planned rule");
    await expect(card).not.toContainText("points.lifetime");
    if (locale === "tr")
      await expect(card).toContainText("her 100 USD'si için 1 puan");
    if (locale === "ar")
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    expect(await overflow(page)).toBe(false);
    await axe(page);
  });

test("G12-PT-E5 the admin sees the read-only volume policy: pending, every open owner decision listed, sample only", async ({
  page,
}) => {
  await setup(page);
  expect(OPS, "PTS_E2E_OPS_TOKEN").toBeTruthy();
  await page.goto("/admin/points");
  await page.getByLabel("Admin token").fill(OPS!);
  await page.getByRole("button", { name: "Sign in" }).click();
  const inspector = page.getByTestId("volume-policy-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("PENDING_OWNER_POLICY");
  await expect(inspector).toContainText("Not active");
  await expect(inspector).toContainText("NOT defended by this build");
  await expect(inspector).toContainText("supersedes the fixed-points draft");
  const missing = page.getByTestId("volume-policy-missing");
  for (const item of [
    "readingConfirmed",
    "eligibility.minVolume",
    "eligibility.dailyCap",
    "eligibility.dailyVolumeCap",
    "abuse.washTradingRule",
    "abuse.sybilSelfReferralRule",
    "verifier.multiLegOperationKey",
    "verifier.priceProvenance",
    "effectiveFrom",
    "retroactivity",
    "legacyWeeklyConversion",
  ])
    await expect(missing).toContainText(item);
  await expect(page.getByTestId("volume-policy-sample-total")).toContainText(
    "4",
  );
});
