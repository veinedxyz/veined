// G13 Phase 3: the owner-signed execution check inside the real Bridge review dialog, on SYNTHETIC data only
// (tests/fixtures/routing; account 0x3333…3333). The server review is computed by the real reviewBridgeRoute from the
// page's own quote input (its read-only dependencies are the synthetic fixtures). Read-only: no wallet, no signature,
// no transaction; the dialog's send button stays disabled.
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { test, expect, fillRecipient } from "./fixtures";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote } from "../../src/routing/normalize";
import { reviewBridgeRoute } from "../../src/execution/server/review";
import type { Catalog, QuoteInput } from "../../src/routing/model";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import tr from "../../src/i18n/locales/tr.json" with { type: "json" };

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g13";
const PARTY = "0x3333333333333333333333333333333333333333";
const dict = { en, tr } as const;

async function setup(
  page: Page,
  locale: keyof typeof dict = "en",
  review: "ok" | "fail" = "ok",
) {
  await page.addInitScript((locale) => {
    if (window !== window.top) return;
    localStorage.setItem("otherbridge.language", locale);
    localStorage.setItem("otherbridge.theme", "dark");
  }, locale);
  const catalog: Catalog = {
    ...fixtureCatalog(),
    generation: "1800000000000-g13review0001",
  };
  const executionCalls: string[] = [];
  await page.route("**/api/catalog", (r) =>
    r.fulfill({
      status: 422,
      json: { error: "SYNTHETIC_CATALOG_UNAVAILABLE" },
    }),
  );
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON();
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (body.action === "catalog") return json(catalog);
    if (body.action === "connections") {
      const f = catalog.networks.find((n) => n.id === body.source)!,
        t = catalog.networks.find((n) => n.id === body.destination)!;
      return json([
        {
          from: f.id,
          to: t.id,
          sourceAssets: [f.nativeAsset],
          destinationAssets: [t.nativeAsset],
          provider: "routing-core",
          executable: false,
        },
      ]);
    }
    if (body.action === "quote") {
      const q = normalizeQuote(
        fixtureQuote(body.input as QuoteInput),
        body.input,
        catalog,
      );
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return json([q]);
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  });
  await page.route("**/api/execution", async (route) => {
    const body = route.request().postDataJSON();
    executionCalls.push(String(body?.action));
    if (review === "fail")
      return route.fulfill({
        status: 503,
        json: { error: "PROVIDER_UNAVAILABLE" },
      });
    const r = await reviewBridgeRoute(
      { input: body.input, wallet: body.wallet },
      {
        now: () => Date.now(),
        catalog: async () => catalog,
        quotes: async (input) => [
          normalizeQuote(fixtureQuote(input), input, catalog),
        ],
        evidence: () => null,
        balances: async () => ["50000000000000000"],
        allowance: async () => "0",
      },
    );
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(r),
    });
  });
  await page.goto("/bridge");
  return executionCalls;
}
async function openReview(page: Page, locale: keyof typeof dict = "en") {
  const ui = dict[locale].ui;
  for (const [role, search, id] of [
    ["selectSourceNetwork", "Ethereum", "1"],
    ["selectDestinationNetwork", "Base", "8453"],
  ] as const) {
    await page.getByRole("button", { name: ui[role], exact: true }).click();
    await page.locator("#network-search").fill(search);
    await page.locator(`.network-picker [data-chain="${id}"]`).click();
    await expect(page.locator("dialog.network-picker")).toHaveCount(0);
  }
  await page.locator("#routing-amount").fill("0.01");
  await page.locator("#routing-sender").fill(PARTY);
  await fillRecipient(page, PARTY);
  await page.getByRole("button", { name: ui.readRoute, exact: true }).click();
  await expect(page.locator(".trade-output bdi")).toBeVisible();
  await page.getByRole("button", { name: ui.reviewRoute }).click();
  const dialog = page.locator("dialog.routing-review");
  await expect(dialog).toBeVisible();
  return dialog;
}
async function shot(page: Page, name: string) {
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("G13-X-E1 the server's execution check reads in plain words, every check is listed, sending stays closed", async ({
  page,
}) => {
  const calls = await setup(page);
  const dialog = await openReview(page);
  const panel = dialog.getByTestId("execution-review");
  await expect(panel).toContainText(en.g13.x.title);
  await expect(panel).toContainText(en.g13.x.closed);
  expect(calls).toEqual([]); // nothing is asked before the owner opens the check
  await panel.locator("summary").click();
  await expect(panel.getByTestId("execution-checks").locator("li")).toHaveCount(
    13,
  );
  await expect(panel).toContainText(`${en.g13.x.send}0.01 ETH`);
  await expect(panel.getByTestId("execution-recipient")).toContainText(
    en.g13.x.self,
  );
  await expect(panel.getByTestId("execution-approval")).toHaveText(
    en.g13.x.noApproval,
  );
  await expect(panel).toContainText(en.g13.x.veinedFee);
  await expect(panel.locator('[data-check="QUOTE"]')).toHaveAttribute(
    "data-status",
    "FAIL",
  );
  await expect(panel.locator('[data-check="QUOTE"]')).toContainText(
    "DRY_QUOTE_NOT_EXECUTABLE",
  );
  await expect(panel.locator('[data-check="SIMULATION"]')).toHaveAttribute(
    "data-status",
    "UNKNOWN",
  );
  await expect(panel.locator('[data-status="UNKNOWN"]').first()).toContainText(
    en.g13.x.status.UNKNOWN,
  );
  await expect(panel.getByTestId("execution-gate")).toContainText(
    en.g13.x.gateClosed,
  );
  await expect(panel.getByTestId("execution-gate")).toContainText(
    "NO_OWNER_APPROVED_CANARY",
  );
  await expect(
    dialog.getByRole("button", { name: en.ui.sendingDisabled }),
  ).toBeDisabled();
  expect(calls).toEqual(["review"]);
  await expect(panel.locator("button")).toHaveCount(0);
  await shot(page, "g13-x-e1-execution-review");
});

test("G13-X-E2 a failed server check says so and never shows a result", async ({
  page,
}) => {
  await setup(page, "en", "fail");
  const dialog = await openReview(page);
  const panel = dialog.getByTestId("execution-review");
  await panel.locator("summary").click();
  await expect(panel.getByRole("alert")).toHaveText(en.g13.x.failed);
  await expect(panel.getByTestId("execution-checks")).toHaveCount(0);
});

test("G13-X-E3 Turkish copy", async ({ page }) => {
  await setup(page, "tr");
  const dialog = await openReview(page, "tr");
  const panel = dialog.getByTestId("execution-review");
  await panel.locator("summary").click();
  await expect(panel).toContainText(tr.g13.x.checks);
  await expect(panel.locator('[data-check="GUARDIAN"]')).toContainText(
    tr.g13.x.check.GUARDIAN,
  );
  await expect(panel.getByTestId("execution-gate")).toContainText(
    tr.g13.x.gateClosed,
  );
  await shot(page, "g13-x-e3-execution-review-tr");
});

test("G13-X-E4 the real server reports the gate CLOSED and refuses every write action", async ({
  page,
}) => {
  const origin = new URL(
    process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3100",
  ).origin;
  const g = await page.request.get(`${origin}/api/execution`);
  expect(g.status()).toBe(200);
  expect(await g.json()).toMatchObject({
    state: "CLOSED",
    open: false,
    platformFeeBps: 0,
  });
  const w = await page.request.post(`${origin}/api/execution`, {
    headers: { origin, "content-type": "application/json" },
    data: { action: "send", transaction: { to: PARTY, data: "0x" } },
  });
  expect(w.status()).toBe(403);
  expect(await w.json()).toMatchObject({ error: "WRITE_DISABLED" });
});
