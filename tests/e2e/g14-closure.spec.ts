// G14 CLOSURE — the owner canary panel in the real Bridge review dialog, in the DELIVERED (disarmed) build.
// SYNTHETIC_TEST_ONLY (tests/fixtures/routing; account 0x3333…3333). The panel must state the truth — implementation
// present, activation disabled, no owner-approved record — render NO step control, make NO canary request to the
// server and NO wallet request; the real server must refuse every canary signing-path action with 403.
import type { Page } from "@playwright/test";
import { test, expect, fillRecipient } from "./fixtures";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote } from "../../src/routing/normalize";
import { reviewBridgeRoute } from "../../src/execution/server/review";
import type { Catalog, QuoteInput } from "../../src/routing/model";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import tr from "../../src/i18n/locales/tr.json" with { type: "json" };

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

test("G14-C-E1 the canary panel states implementation present, activation disabled, no owner record — and offers no step", async ({
  page,
}) => {
  const calls = await setup(page);
  const dialog = await openReview(page);
  const panel = dialog.getByTestId("execution-review");
  await panel.locator("summary").click();
  await expect(panel.getByTestId("execution-checks")).toBeVisible();
  const canary = panel.getByTestId("execution-canary");
  await expect(canary).toContainText(en.g14.c.title);
  const status = canary.getByTestId("canary-status");
  await expect(
    status.locator("[data-canary='implementation']"),
  ).toHaveAttribute("data-value", "PRESENT");
  await expect(status.locator("[data-canary='activation']")).toHaveAttribute(
    "data-value",
    "DISABLED",
  );
  await expect(status.locator("[data-canary='owner-record']")).toHaveAttribute(
    "data-value",
    "ABSENT",
  );
  await expect(status).toContainText(en.g14.c.implemented);
  await expect(status).toContainText(en.g14.c.inactive);
  await expect(status).toContainText(en.g14.c.noRecord);
  await expect(canary).toContainText(en.g14.c.closed);
  // No step control of any kind exists in this build.
  for (const id of [
    "canary-review-button",
    "canary-step-button",
    "canary-rereview-button",
    "canary-refresh",
  ])
    await expect(canary.getByTestId(id)).toHaveCount(0);
  await expect(canary.getByRole("button")).toHaveCount(0);
  // The panel never asks the server about the canary in this build (only the G13 review was requested).
  expect(calls).toEqual(["review"]);
});

test("G14-C-E2 Turkish copy of the disarmed canary state", async ({ page }) => {
  await setup(page, "tr");
  const dialog = await openReview(page, "tr");
  const panel = dialog.getByTestId("execution-review");
  await panel.locator("summary").click();
  const canary = panel.getByTestId("execution-canary");
  await expect(canary).toContainText(tr.g14.c.implemented);
  await expect(canary).toContainText(tr.g14.c.inactive);
  await expect(canary).toContainText(tr.g14.c.noRecord);
  await expect(canary.getByRole("button")).toHaveCount(0);
});

test("G14-C-E3 the real server: canary status says DISABLED / ABSENT; every canary signing-path action is 403 with nothing signable", async ({
  page,
}) => {
  const origin = new URL(
    process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3100",
  ).origin;
  const post = (data: unknown) =>
    page.request.post(`${origin}/api/execution`, {
      headers: { origin, "content-type": "application/json" },
      data,
    });
  const s = await post({ action: "canary-status" });
  expect(s.status()).toBe(200);
  expect(await s.json()).toMatchObject({
    implementation: "PRESENT",
    activation: "DISABLED",
    ownerRecord: "ABSENT",
    wiring: false,
    gate: { state: "CLOSED" },
  });
  const rv = await post({
    action: "canary-review",
    account: PARTY,
    chainId: "8453",
    amount: "5000000",
  });
  expect(rv.status()).toBe(200);
  expect((await rv.json()).review).toBeNull();
  const H32 = "a".repeat(32),
    H64 = "c".repeat(64),
    record = "canary-e2e-0001";
  for (const body of [
    { action: "canary-authorize", session: H64, record, trustedGesture: true },
    { action: "canary-prepare", session: H64, record, token: {} },
    {
      action: "canary-confirm",
      session: H64,
      record,
      step: "SEND",
      review: H64,
      attempt: H32,
      digest: H64,
    },
    {
      action: "canary-record",
      session: H64,
      kind: "requested",
      ref: { record, action: "SEND", attempt: H32, digest: H64, request: H32 },
    },
    { action: "canary-track", session: H64, record },
  ]) {
    const r = await post(body);
    expect(r.status(), body.action).toBe(403);
    const text = await r.text();
    expect(JSON.parse(text).error).toBe("WRITE_DISABLED");
    expect(text).not.toMatch(/transaction|"data":"0x|preparation|nonce/i);
  }
});
