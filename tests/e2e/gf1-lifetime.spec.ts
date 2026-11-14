// gf1 G06 lifetime personal points (owner's new direction), isolated engineering only: the Points page leads with the
// user's own points, which are not active until the owner sets the policy (no number, no pool, no public ranking);
// a labelled SAMPLE preview shows the layout with invented numbers; the landing states the new rules without a pool;
// the admin sees a read-only policy inspector with the decisions still missing. SYNTHETIC_TEST_ONLY data.
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

test("GF1-G6-L1 Points leads with your own points, not active yet: no number, no pool, no public ranking", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/points");
  await expect(
    page.getByRole("heading", { level: 1, name: "Points" }),
  ).toBeVisible();
  const card = page.getByTestId("points-lifetime");
  await expect(card).toHaveAttribute(
    "data-policy-state",
    "PENDING_OWNER_POLICY",
  );
  await expect(
    card.getByRole("heading", { name: "Your points" }),
  ).toBeVisible();
  await expect(page.getByTestId("points-lifetime-total")).toHaveText(
    "Not active yet",
  );
  // The card states rules, never a figure: the only digits are the 10% rule and the planned rule's "1 point for
  // every 100 USD" (G12 H05).
  const text = (await card.innerText()).replace(/\s+/g, " ");
  expect(text).toContain("1 point for every 100 USD");
  expect(
    text
      .replace(/\b10%/g, "")
      .replace("1 point for every 100 USD", "")
      .match(/\d/g),
    text,
  ).toBeNull();
  for (const rule of [
    "There are no sign-up or welcome points.",
    "Your points are private: there is no public ranking.",
  ])
    await expect(card).toContainText(rule);
  await expect(card).toContainText("not a token");
  await expect(page.getByTestId("points-lifetime-sample")).toHaveCount(0);
  // G12 H05: the earlier weekly program is not part of the public page any more; no pool, no table of other accounts
  // anywhere.
  await expect(page.getByTestId("points-weekly")).toHaveCount(0);
  const main = page.locator("main");
  await expect(main).not.toContainText("200,000");
  await expect(main).not.toContainText("Weekly pool");
  await expect(main).not.toContainText("Leaderboard");
  await expect(main.locator("table")).toHaveCount(0);
  await axe(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByTestId("points-lifetime")).toBeVisible();
  expect(await overflow(page)).toBe(false);
});

test("GF1-G6-L2 the SAMPLE preview is labelled, computed in this browser and never looks like an account", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // Every API request, by method, path and body (the Points API carries its data in the body). The page is loaded
  // once: the shared Points rate limit is a product rule, so the test does not spend it on a second load.
  const requests: { key: string; body: string }[] = [];
  page.on("request", (r) => {
    const url = new URL(r.url());
    if (!url.pathname.startsWith("/api/")) return;
    const body = r.postData() ?? "";
    let action = "";
    try {
      action = String(JSON.parse(body).action ?? "");
    } catch {}
    requests.push({ key: `${r.method()} ${url.pathname} ${action}`, body });
  });
  await page.goto("/points?lifetimePreview=sample");
  const sample = page.getByTestId("points-lifetime-sample");
  await expect(sample).toBeVisible();
  await expect(sample).toContainText("Sample");
  await expect(sample).toContainText(
    "This is not your account and these are not real points.",
  );
  // G12 H05 sample (1 point per 100 USD of verified volume, 10% referral). The sample account: 40 + 60 USD swaps and
  // a 230 USD bridge = 330 USD -> 3 points and 70 USD left to the fourth; its invitee's 1,000 USD -> 10 points -> 1 point
  // of commission; a 120 USD swap that is not final yet is shown apart and not counted.
  const facts = Object.fromEntries(
    await sample
      .locator("dl > div")
      .evaluateAll((rows) =>
        rows.map((r) => [
          r.querySelector("dt")!.textContent!.trim(),
          r.querySelector("dd")!.textContent!.trim(),
        ]),
      ),
  );
  expect(facts).toEqual({
    "Verified volume counted": "$330.00",
    "Points from volume": "3",
    "Left to the next point": "$70.00",
    Referrals: "1",
    "Pending, not final yet": "$120.00",
    "Sample total": "4",
  });
  // The sample is not inside the "Your points" card (a crop of the card cannot carry a sample figure).
  await expect(
    page.getByTestId("points-lifetime").getByTestId("points-lifetime-sample"),
  ).toHaveCount(0);
  // The real card still says the program is not active, and the preview asked nothing of the server.
  await expect(page.getByTestId("points-lifetime-total")).toHaveText(
    "Not active yet",
  );
  // The preview asks the server for nothing: the Points API sees only the page's usual public projections for a
  // visitor without a wallet (as P1 records), and no request path or body carries the preview.
  await expect(page.getByTestId("points-weekly")).toHaveCount(0);
  await page.waitForLoadState("networkidle");
  // G12 H05: without the archive the public page does not request the weekly projections at all.
  expect(requests.filter((r) => r.key.startsWith("POST /api/points "))).toEqual(
    [],
  );
  expect(
    requests.filter((r) => /lifetime|sample/i.test(`${r.key} ${r.body}`)),
  ).toEqual([]);
  await axe(page);
});

test("GF1-G6-L3 five languages incl. RTL: the lifetime card is translated (the i18n gate covers all 24)", async ({
  page,
}) => {
  test.setTimeout(120_000);
  // The card needs no server data (L5), so the weekly API is answered here without the server: five page loads must
  // not spend the shared Points rate limit (60 per minute) that the weekly tests in the same run rely on.
  let served = 0;
  await page.route("**/api/points", (route) => {
    served++;
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "POINTS_UNAVAILABLE" }),
    });
  });
  for (const locale of ["tr", "ar", "ja", "de", "he"]) {
    await setup(page, locale);
    await page.goto("/points");
    const card = page.getByTestId("points-lifetime");
    await expect(card).toBeVisible();
    await expect(card).not.toContainText("points.lifetime");
    if (locale === "ar" || locale === "he")
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  }
  // G12 H05: the public page shows your own points only and does not request the weekly projections at all.
  expect(served).toBe(0);
});

test("GF1-G6-L4 the landing states the new rules without a pool; the admin sees a read-only policy inspector", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  const points = page.locator("#points");
  await expect(points.getByRole("heading", { level: 2 })).toHaveText("Points");
  await expect(points).toContainText("Not active yet");
  await expect(points).toContainText("10%");
  await expect(points).not.toContainText("200,000");
  // The harness always provides the run-only operator token (no skip path).
  expect(OPS, "PTS_E2E_OPS_TOKEN").toBeTruthy();
  await page.goto("/admin/points");
  await page.getByLabel("Admin token").fill(OPS!);
  await page.getByRole("button", { name: "Sign in" }).click();
  const inspector = page.getByTestId("lifetime-policy-inspector");
  await expect(inspector).toBeVisible();
  await expect(inspector).toContainText("PENDING_OWNER_POLICY");
  await expect(page.getByTestId("lifetime-policy-missing")).toContainText(
    "rate.SWAP",
  );
  await expect(page.getByTestId("lifetime-policy-sample-total")).toContainText(
    "31",
  );
});

test("GF1-G6-L5 your points stay on the page when the weekly service is unavailable", async ({
  page,
}) => {
  await setup(page);
  await page.route("**/api/points", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "POINTS_UNAVAILABLE" }),
    }),
  );
  await page.goto("/points?weekly=archive");
  await expect(page.getByTestId("points-lifetime")).toBeVisible();
  await expect(page.getByTestId("points-lifetime-total")).toHaveText(
    "Not active yet",
  );
  await expect(page.getByRole("button", { name: "Try again" })).toBeVisible();
  await axe(page);
});

test("GF1-G6-L6 your points are one node from loading to loaded; the weekly seasons are their own section", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  // The weekly API is held until the loading state has been seen, then answered by the server as usual.
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  await page.route("**/api/points", async (route) => {
    await held;
    await route.continue();
  });
  await page.goto("/points?weekly=archive");
  const card = page.getByTestId("points-lifetime");
  await expect(card).toBeVisible();
  await expect(page.locator("[aria-busy='true']")).toBeVisible();
  const node = await card.elementHandle();
  const before = await card.boundingBox();
  release();
  const weekly = page.getByRole("region", { name: "Weekly seasons" });
  await expect(
    weekly.getByRole("heading", { name: "Published results", exact: true }),
  ).toBeVisible();
  // Same node, same width (no remount, no layout jump: review-2 n2), and outside the weekly section (review-2 mn9).
  expect(await node!.evaluate((n) => n.isConnected)).toBe(true);
  expect((await card.boundingBox())!.width).toBe(before!.width);
  await expect(weekly.getByTestId("points-lifetime")).toHaveCount(0);
  await expect(weekly.getByRole("timer")).toBeVisible();
  await axe(page);
});
