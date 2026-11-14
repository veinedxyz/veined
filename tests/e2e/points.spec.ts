import { mkdir } from "node:fs/promises";
import type { APIRequestContext, Page } from "@playwright/test";
import { expect, privyModal, test } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
import { fixtureAccount } from "../../src/points/fixtures";
import { displayPoints } from "../../src/points/format";
import { resolvePolicy } from "../../src/points/policy";
// V1.22 weekly points, targeted E2E against the isolated simulation server (VEINED_POINTS_SIMULATION=1, admin
// principals generated for this run only; see the run's launcher). Serial and stateful: week 1 privacy, admin
// settlement with four-eyes, week 2 publication. SYNTHETIC_TEST_ONLY: simulated verifier, no wallet signatures.
const OPS = process.env.PTS_E2E_OPS_TOKEN;
const OWNER = process.env.PTS_E2E_OWNER_TOKEN;
if (!OPS || !OWNER)
  throw Error(
    "points E2E requires PTS_E2E_OPS_TOKEN and PTS_E2E_OWNER_TOKEN (run launcher)",
  );
const evidence = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results"}/points`;
const ATLAS = fixtureAccount("atlas");
const NUMERIC_KEYS =
  /units|weight|rank|amount|total|points|score|share|denominator/i;
const keysOf = (value: unknown): string[] =>
  value && typeof value === "object"
    ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
        k,
        ...keysOf(v),
      ])
    : [];

async function english(page: Page, withWallet = false) {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "en", url: ORIGIN }]);
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", "en");
    const csp: string[] = [];
    (window as unknown as { __csp: string[] }).__csp = csp;
    document.addEventListener("securitypolicyviolation", (e) =>
      csp.push(`${e.violatedDirective} ${e.blockedURI}`),
    );
  });
  if (withWallet)
    await page.addInitScript(installWalletDoubles, {
      wallets: ["metamask" as const],
      account: ATLAS,
      chainId: "0x7a69",
      doubles: WALLET_DOUBLES,
    });
}
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page)
    .getByRole("button", { name: /^MetaMask$/ })
    .first()
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
  await expect(page.locator("header .wallet-button")).toContainText(
    `${ATLAS.slice(0, 6)}`,
  );
}
function recordPointsResponses(page: Page) {
  const bodies: unknown[] = [];
  page.on("response", async (res) => {
    if (new URL(res.url()).pathname === "/api/points")
      bodies.push({
        status: res.status(),
        body: await res.json().catch(() => null),
      });
  });
  return bodies;
}
const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
// Direct API calls carry the exact app Origin like the browser does (the origin guard refuses anything else).
const post = (
  request: APIRequestContext,
  path: string,
  data: unknown,
  headers: Record<string, string> = {},
) => request.post(path, { headers: { origin: ORIGIN, ...headers }, data });
const admin = (request: APIRequestContext, token: string, body: unknown) =>
  post(request, "/api/admin/points", body, {
    authorization: `Bearer ${token}`,
  });
/** gf1 G07: "+7 days" moves the simulated clock by exactly one week from wherever the run starts. The simulated season 1
 *  starts on this week's Monday 00:00 Istanbul, and a season can be calculated only once it has closed AND its
 *  finality grace has passed (closes + graceSeconds, 6 h in the draft policy). A run that starts on Monday between
 *  00:00 and 06:00 Istanbul therefore lands inside that grace and the operator is refused (SEASON_NOT_CLOSED). The
 *  run moves the simulated clock on to exactly the moment calculation opens (+ 60 s), read from the server's own
 *  clock, schedule and policy; it never changes a product rule and never waits for a convenient wall clock. */
async function untilSettlementOpens(
  request: APIRequestContext,
  season: number,
) {
  const res = await admin(request, OPS!, { action: "dashboard", season });
  expect(res.status()).toBe(200);
  const d = (await res.json()) as {
    now: string;
    config: { policyVersion: string };
    season: { endsAt: string };
  };
  const grace = resolvePolicy(d.config.policyVersion).policy.finality
    .graceSeconds;
  const opens = Date.parse(d.season.endsAt) + grace * 1000 + 60_000;
  const behind = Math.ceil((opens - Date.parse(d.now)) / 1000);
  if (behind > 0) {
    const moved = await admin(request, OPS!, {
      action: "sim-clock",
      advanceSeconds: Math.max(60, behind),
    });
    expect(moved.status()).toBe(200);
  }
  return behind > 0 ? behind : 0;
}
/** Provisional live-season figures as the admin sees them: exact units, weights and their display forms. */
async function provisional(request: APIRequestContext) {
  const res = await admin(request, OPS!, { action: "dashboard" });
  expect(res.status()).toBe(200);
  const accounts = (await res.json()).accounts as {
    totalUnits: string;
    activityWeight: string;
    taskWeight: string;
  }[];
  const units = accounts.map((a) => a.totalUnits).filter((v) => v !== "0");
  const weights = accounts
    .flatMap((a) => [a.activityWeight, a.taskWeight])
    .filter((v) => v !== "0");
  return { units, weights, shown: units.map((u) => displayPoints(u, "en")) };
}
const values = (value: unknown): string[] =>
  value && typeof value === "object"
    ? Object.values(value as Record<string, unknown>).flatMap(values)
    : typeof value === "number" || typeof value === "string"
      ? [String(value)]
      : [];
/** No live figure in any form: raw units anywhere in the HTML/SSR/API, exact weights or points as API values or
 *  as number tokens of the rendered page text. */
async function expectNoLiveFigures(
  page: Page,
  request: APIRequestContext,
  bodies: unknown[],
) {
  const live = await provisional(request);
  expect(live.units.length).toBeGreaterThan(3);
  const ssr = await (await request.get("/points")).text();
  const html = await page.content();
  for (const text of [html, ssr, JSON.stringify(bodies)])
    for (const u of live.units) expect(text).not.toContain(u);
  expect(ssr).not.toMatch(/totalUnits|activityWeight|denominator/);
  const apiValues = new Set(bodies.flatMap(values));
  for (const v of [...live.units, ...live.weights])
    expect(apiValues.has(v)).toBe(false);
  const tokens = new Set(
    (await page.locator("main").innerText()).match(/\d[\d,.]*/g) ?? [],
  );
  for (const v of [...live.weights, ...live.shown])
    expect(tokens.has(v)).toBe(false);
  for (const b of bodies)
    expect(keysOf(b).filter((k) => NUMERIC_KEYS.test(k))).toEqual([]);
}
const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
// The only accepted report is the deliberately blocked Privy embedded-wallet frame (same rule as V19-11).
const cspViolations = async (page: Page) =>
  (
    await page.evaluate(() => (window as unknown as { __csp: string[] }).__csp)
  ).filter((v) => !v.startsWith("frame-src https://auth.privy.io"));

test.describe.configure({ mode: "serial" });
test.beforeAll(async () => mkdir(evidence, { recursive: true }));

test("P1 week 1: countdown only — no leaderboard, balance, rank or weight anywhere", async ({
  page,
  request,
}) => {
  await english(page);
  const bodies = recordPointsResponses(page);
  await page.goto("/points?weekly=archive");
  // gf1 G06: the page leads with the user's own lifetime points, not active until the owner sets the policy: no
  // number, no pool, no public ranking. The weekly seasons follow as their own section.
  await expect(
    page.getByRole("heading", { level: 1, name: "Points" }),
  ).toBeVisible();
  const lifetime = page.getByTestId("points-lifetime");
  await expect(lifetime).toHaveAttribute(
    "data-policy-state",
    "PENDING_OWNER_POLICY",
  );
  await expect(page.getByTestId("points-lifetime-total")).toHaveText(
    "Not active yet",
  );
  await expect(lifetime).toContainText(
    "There are no sign-up or welcome points.",
  );
  await expect(page.getByTestId("points-lifetime-sample")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { level: 2, name: "Weekly seasons" }),
  ).toBeVisible();
  await expect(page.locator("main")).not.toContainText("200,000");
  await expect(page.locator("main")).not.toContainText("Leaderboard");
  await expect(
    page.getByRole("heading", {
      level: 2,
      name: "Published results",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByRole("timer")).toBeVisible();
  await expect(page.getByText("Season 1 closes in").first()).toBeVisible();
  await expect(page.getByText("This week stays private")).toBeVisible();
  await expect(page.getByText("No published results yet")).toBeVisible();
  await expect(page.locator("main table")).toHaveCount(0);
  await expectNoLiveFigures(page, request, bodies);
  expect(await cspViolations(page)).toEqual([]);
  await page.screenshot({
    path: `${evidence}/p1-week1-hidden-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(page.getByRole("timer")).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({
    path: `${evidence}/p1-week1-hidden-mobile.png`,
    fullPage: true,
  });
});

test("P2 connected wallet: referral code, invitees and tasks, but the live season stays private", async ({
  page,
  request,
}) => {
  await english(page, true);
  const bodies = recordPointsResponses(page);
  await page.goto("/points?weekly=archive");
  await connect(page);
  await expect(
    page.getByText("Season 1: private until published"),
  ).toBeVisible();
  const code = page
    .locator("main")
    .getByText(/^[0-9A-HJKMNP-TV-Z]{8}$/)
    .first();
  await expect(code).toBeVisible();
  await expect(page.getByText("Accounts you invited")).toBeVisible();
  await expect(page.locator("main li bdi", { hasText: "…" })).toHaveCount(2);
  await expect(page.getByRole("button", { name: "Copy link" })).toBeVisible();
  await expectNoLiveFigures(page, request, bodies);
  expect(await cspViolations(page)).toEqual([]);
  await page.screenshot({
    path: `${evidence}/p2-week1-connected.png`,
    fullPage: true,
  });
});

test("P3 invitation link is remembered in this browser only and removed from the address bar", async ({
  page,
  request,
}) => {
  await english(page);
  const res = await post(request, "/api/points", {
    action: "referral-code",
    account: ATLAS,
  });
  const { code } = await res.json();
  await page.goto(`/points?weekly=archive&ref=${code}`);
  await expect(
    page.getByText(`Invitation code ${code} is saved in this browser.`, {
      exact: false,
    }),
  ).toBeVisible();
  // The invitation code leaves the address bar; the archive view (G12 H05) stays.
  expect(new URL(page.url()).search).toBe("?weekly=archive");
  expect(
    await page.evaluate(() => localStorage.getItem("veined.points.invite")),
  ).toBe(code);
});

test("P4 admin: bad tokens are rejected; the operator sees provisional projections and explanations", async ({
  page,
}) => {
  await english(page);
  await page.goto("/admin/points");
  await expect(
    page.getByRole("heading", { name: "Points administration" }),
  ).toBeVisible();
  await page
    .getByLabel("Admin token")
    .fill("vpa.ops-a.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Token rejected.")).toBeVisible();
  await page.getByLabel("Admin token").fill(OPS!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(
    page.getByText("Accounts and provisional ranking"),
  ).toBeVisible();
  await expect(page.getByText("200,000").first()).toBeVisible();
  await expect(
    page.getByText("Preview only: nothing is awarded until finalization.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explain" }).first().click();
  await expect(
    page.getByText("Why this account receives these points", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Approve and finalize" }),
  ).toHaveCount(0);
  expect(await cspViolations(page)).toEqual([]);
  await page.screenshot({
    path: `${evidence}/p4-admin-operator.png`,
    fullPage: true,
  });
});

test("P5 settlement: operator calculates after close; a different approver finalizes and publishes", async ({
  page,
  request,
}) => {
  await english(page);
  await page.goto("/admin/points");
  await page.getByLabel("Admin token").fill(OPS!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("button", { name: "+7 days" }).click();
  await expect(page.getByText("Done: sim-clock")).toBeVisible();
  // Deterministic on any weekday and hour (gf1 G07): past season 1's finality grace before calculating.
  await untilSettlementOpens(request, 1);
  await page.getByRole("combobox", { name: "Season" }).selectOption("1");
  await expect(page.locator("select").first()).toHaveValue("1");
  await page.getByRole("button", { name: "Calculate" }).click();
  await expect(page.getByText("Done: calculate")).toBeVisible();
  await expect(page.getByText("REVIEW_PENDING").first()).toBeVisible();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.getByLabel("Admin token").fill(OWNER!);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("combobox", { name: "Season" }).selectOption("1");
  await page.getByRole("button", { name: "Approve and finalize" }).click();
  await expect(page.getByText("Done: finalize")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Done: publish")).toBeVisible();
  await expect(page.getByText("PUBLISHED").first()).toBeVisible();
  await page.screenshot({
    path: `${evidence}/p5-admin-published.png`,
    fullPage: true,
  });
});

test("P6 week 2 shows finalized week 1 only; week 2 stays private; mobile fits", async ({
  page,
  request,
}) => {
  await english(page, true);
  await page.goto("/points?weekly=archive");
  await connect(page);
  await expect(
    page.getByRole("heading", { name: "Season 1 results" }),
  ).toBeVisible();
  await expect(page.getByText("Season 2 closes in").first()).toBeVisible();
  // gf1 G06: the published season keeps the user's own result; other accounts' rankings, the weekly pool and the
  // participant count are not shown (the server's published data is unchanged).
  await expect(page.locator("main table")).toHaveCount(0);
  // The own result is the account's own points, without a rank (review M5).
  await expect(page.getByText(/^Your result: \d/)).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Your position");
  await expect(page.locator("main")).not.toContainText(/#\d/);
  await expect(page.locator("main")).not.toContainText("Leaderboard");
  await expect(page.locator("main")).not.toContainText("200,000");
  await expect(page.locator("main")).not.toContainText("Weekly pool");
  await expect(
    page.getByText("Season 2: private until published"),
  ).toBeVisible();
  expect(
    (
      await post(request, "/api/points", { action: "leaderboard", season: 2 })
    ).status(),
  ).toBe(404);
  expect(
    (
      await post(request, "/api/points", { action: "leaderboard", season: 1 })
    ).status(),
  ).toBe(200);
  expect(await cspViolations(page)).toEqual([]);
  await page.screenshot({
    path: `${evidence}/p6-week2-published-desktop.png`,
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Season 1 results" }),
  ).toBeVisible();
  expect(await noOverflow(page)).toBe(true);
  await page.screenshot({
    path: `${evidence}/p6-week2-published-mobile.png`,
    fullPage: true,
  });
});
