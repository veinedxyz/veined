// G12 H06 — VEINED Scan in the real product on SYNTHETIC data only (tests/fixtures; nothing is live): the two kinds of
// source stay apart (previews saved in this browser, checked read-only against a transfer the user attached; and an
// ecosystem feed that is honestly NOT connected and shows no rows), search and filter, the bound status read (a
// transfer that does not match its preview stays unverified), the labelled synthetic layout demo, navigation,
// languages incl. RTL, phone, axe. Read-only: no signature, no transaction, nothing sent through VEINED.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect } from "./fixtures";
import {
  fixtureCatalog,
  fixtureInput,
  fixtureQuote,
} from "../fixtures/routing";
import { normalizeQuote, normalizeStatus } from "../../src/routing/normalize";
import type { RoutePreview } from "../../src/routing/history";

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g12";
const HASH = `0x${"a".repeat(64)}`;
const KEY = "otherbridge:routing-previews:v1";

/** Two saved previews in the shape the product writes (savePreview): Ethereum -> Base with a hash attached, and
 * Ethereum -> Arbitrum without one. */
function previews(): RoutePreview[] {
  const catalog = fixtureCatalog();
  const make = (destination: string, id: string, hash?: string) => {
    const input = fixtureInput("eth", destination);
    const q = normalizeQuote(fixtureQuote(input), input, catalog);
    const name = (chain: string) =>
      catalog.networks.find((n) => n.id === chain)!.name;
    return {
      id,
      provider: "routing-core",
      source: input.source,
      destination: input.destination,
      sourceName: name(input.source),
      destinationName: name(input.destination),
      sourceAsset: input.sourceAsset,
      destinationAsset: input.destinationAsset,
      sourceAddress: input.sourceAddress,
      destinationAddress: input.destinationAddress,
      amount: input.amount,
      expected: q.expected,
      minimum: q.minimum,
      binding: q.binding,
      observedAt: Date.now() - 60_000,
      expiresAt: Date.now() - 30_000,
      ...(hash ? { sourceHash: hash } : {}),
      slippage: input.slippage,
      preference: input.preference,
      generation: input.generation,
      walletRevision: input.walletRevision,
      steps: q.steps.map((s) => ({
        tool: s.tool,
        source: s.sourceAsset.chainId,
        destination: s.destinationAsset.chainId,
      })),
      state: "QUOTE_PREVIEW",
    } as RoutePreview;
  };
  return [make("bas", "preview-base", HASH), make("arb", "preview-arb")];
}

async function setup(
  page: Page,
  options: {
    locale?: string;
    theme?: "dark" | "light";
    stored?: RoutePreview[];
    /** The transfer the route source reports for the hash: "match" binds to the preview, "other" does not. */
    transfer?: "match" | "other";
  } = {},
) {
  const locale = options.locale ?? "en";
  await page.context().addCookies([
    {
      name: "otherbridge.locale",
      value: locale,
      url: "http://127.0.0.1:3100",
    },
  ]);
  await page.addInitScript(
    ({ locale, theme, key, stored }) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
      if (stored) localStorage.setItem(key, stored);
    },
    {
      locale,
      theme: options.theme ?? "dark",
      key: KEY,
      stored: options.stored ? JSON.stringify(options.stored) : "",
    },
  );
  const catalog = fixtureCatalog();
  const calls: { action: string; body: string }[] = [];
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON();
    calls.push({ action: body.action, body: route.request().postData() ?? "" });
    const json = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        contentType: "application/json",
        body: JSON.stringify(data),
      });
    if (body.action === "catalog") return json(catalog);
    if (body.action === "status") {
      const ctx = body.context;
      const token = (chain: string, address: string) => ({
        ...catalog.networks.find((n) => n.id === chain)!.nativeAsset,
        address,
      });
      return json(
        normalizeStatus(
          {
            status: "DONE",
            substatus: "COMPLETED",
            fromAddress: ctx.sourceAddress,
            // A transfer to another recipient is not the previewed transfer.
            toAddress:
              options.transfer === "other"
                ? "0x9999999999999999999999999999999999999999"
                : ctx.destinationAddress,
            sending: {
              txHash: body.hash,
              chainId: ctx.source,
              amount: ctx.amount,
              token: token(ctx.source, ctx.sourceAsset),
            },
            receiving: {
              txHash: `0x${"b".repeat(64)}`,
              chainId: ctx.destination,
              amount: ctx.minimum,
              token: token(ctx.destination, ctx.destinationAsset),
            },
          },
          body,
        ),
      );
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  });
  return calls;
}
const axe = async (page: Page) =>
  expect(
    (
      await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze()
    ).violations.map((v) => `${v.id}: ${v.help}`),
  ).toEqual([]);
const noOverflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
async function shot(page: Page, name: string) {
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}

test("G12-SC-E1 an empty Scan is honest: nothing was sent through VEINED, no preview yet, no ecosystem feed and no invented rows", async ({
  page,
}) => {
  const calls = await setup(page);
  await page.goto("/scan");
  await expect(
    page.getByRole("heading", { level: 1, name: "VEINED Scan" }),
  ).toBeVisible();
  await expect(page.getByTestId("scan-not-through-veined")).toContainText(
    "Sending is closed in this build, so nothing here was sent through VEINED.",
  );
  await expect(page.getByTestId("scan-veined")).toContainText(
    "No route preview is saved in this browser yet.",
  );
  await expect(
    page.getByRole("heading", { level: 2, name: "Your saved route previews" }),
  ).toBeVisible();
  await expect(page.getByTestId("scan-veined")).toContainText(
    "They are not transactions.",
  );
  // What leaves the browser is said in full.
  await expect(page.getByTestId("scan-privacy")).toContainText(
    "VEINED's server receives the hash and that preview's details",
  );
  await expect(page.getByTestId("scan-row")).toHaveCount(0);
  await expect(
    page.getByTestId("scan-empty").locator('a[href="/bridge"]'),
  ).toBeVisible();
  const eco = page.getByTestId("scan-ecosystem");
  await expect(eco).toHaveAttribute("data-feed", "BLOCKED_EXTERNAL_INPUT");
  await expect(eco).toContainText("No public activity feed is shown.");
  await expect(page.getByTestId("scan-demo-row")).toHaveCount(0);
  await expect(page.locator("main table")).toHaveCount(0);
  // Reachable from the navigation, under its own name.
  await expect(page.locator('nav a[href="/scan"]').first()).toBeVisible();
  // Only the network catalog was read.
  await page.waitForLoadState("networkidle");
  expect([...new Set(calls.map((c) => c.action))]).toEqual(["catalog"]);
  expect(await noOverflow(page)).toBe(true);
  await axe(page);
});

test("G12-SC-E2 saved previews are listed as previews, never as transactions; search and filter narrow them", async ({
  page,
}) => {
  await setup(page, { stored: previews() });
  await page.goto("/scan");
  const rows = page.getByTestId("scan-row");
  await expect(rows).toHaveCount(2);
  await expect(page.getByTestId("scan-count")).toHaveText("Showing 2 of 2");
  await expect(
    page.getByRole("group", { name: "Filter previews" }),
  ).toBeVisible();
  // What "delivered" rests on is stated under the list.
  await expect(page.getByTestId("scan-basis")).toContainText(
    "VEINED does not check the two networks itself",
  );
  await expect(rows.first()).toContainText("Preview only");
  await expect(rows.filter({ hasText: "Hash attached" })).toHaveCount(1);
  await expect(rows.filter({ hasText: "No hash yet" })).toHaveCount(1);
  await page
    .getByRole("button", { name: "Hash attached", exact: true })
    .click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Base");
  await page.getByRole("button", { name: "No hash yet", exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first()).toContainText("Arbitrum");
  await page.getByRole("button", { name: "All", exact: true }).click();
  const search = page.getByRole("searchbox");
  await search.fill(HASH.slice(0, 12).toUpperCase());
  await expect(rows).toHaveCount(1);
  await expect(page.getByTestId("scan-count")).toHaveText("Showing 1 of 2");
  await search.fill("arbitrum");
  await expect(rows).toHaveCount(1);
  // Review M4: the asset is searchable by its symbol, and the row shows the amounts and the route steps.
  await search.fill("eth");
  await expect(rows).toHaveCount(2);
  await rows.first().locator("summary").click();
  await expect(rows.first().getByTestId("scan-amounts")).toContainText(
    "0.01 ETH",
  );
  await expect(
    rows.first().getByTestId("scan-steps").locator("li"),
  ).toHaveCount(1);
  // Final UX audit: route steps name the networks, never raw chain ids.
  await expect(rows.first().getByTestId("scan-steps")).toContainText(
    /Ethereum → (Base|Arbitrum)/,
  );
  await search.fill("no-such-thing");
  await expect(rows).toHaveCount(0);
  await expect(page.getByTestId("scan-count")).toHaveText("Showing 0 of 2");
  await shot(page, "g12-sc-e2-list");
});

test("G12-SC-E3 a transfer that matches its preview reads as delivered; one that does not match stays unverified", async ({
  page,
}) => {
  const calls = await setup(page, { stored: previews(), transfer: "match" });
  await page.goto("/scan");
  const row = page.getByTestId("scan-row").filter({ hasText: "Hash attached" });
  await row.locator("summary").click();
  await expect(row).toContainText("No current verified observation");
  await row
    .getByRole("button", { name: "Observe status read-only", exact: true })
    .click();
  await expect(row.getByRole("status")).toHaveText("Delivery verified");
  await expect(row).toContainText(`0x${"b".repeat(64)}`);
  // The only thing sent for the check is the status request for that hash.
  const status = calls.filter((c) => c.action === "status");
  expect(status).toHaveLength(1);
  expect(status[0].body).toContain(HASH);
  await shot(page, "g12-sc-e3-verified");
});

test("G12-SC-E3c review M2: a hash attached on this page updates its row without a reload (label and filter follow)", async ({
  page,
}) => {
  await setup(page, { stored: previews(), transfer: "match" });
  await page.goto("/scan");
  const row = page.getByTestId("scan-row").filter({
    has: page.locator("summary strong", { hasText: "Arbitrum" }),
  });
  await expect(row).toHaveAttribute("data-hash", "none");
  await row.locator("summary").click();
  await row.getByLabel("Source transaction hash").fill(`0x${"c".repeat(64)}`);
  await row
    .getByRole("button", { name: "Observe status read-only", exact: true })
    .click();
  await expect(row.getByRole("status")).toHaveText("Delivery verified");
  await expect(row).toHaveAttribute("data-hash", "attached");
  await page.getByRole("button", { name: "No hash yet", exact: true }).click();
  await expect(page.getByTestId("scan-row")).toHaveCount(0);
  await page
    .getByRole("button", { name: "Hash attached", exact: true })
    .click();
  await expect(page.getByTestId("scan-row")).toHaveCount(2);
});

test("G12-SC-E3b a transfer to another recipient is not the previewed transfer: no 'delivered' claim", async ({
  page,
}) => {
  await setup(page, { stored: previews(), transfer: "other" });
  await page.goto("/scan");
  const row = page.getByTestId("scan-row").filter({ hasText: "Hash attached" });
  await row.locator("summary").click();
  await row
    .getByRole("button", { name: "Observe status read-only", exact: true })
    .click();
  await expect(row.getByRole("status")).toHaveText(
    "No current verified observation",
  );
  await expect(row).not.toContainText("Delivery verified");
});

test("G12-SC-E4 the layout demo appears only on request and every invented row is labelled Synthetic", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/scan?demo=synthetic");
  const eco = page.getByTestId("scan-ecosystem");
  await expect(eco).toHaveAttribute("data-feed", "SYNTHETIC");
  await expect(page.getByTestId("scan-demo-note")).toContainText(
    "They are not transactions and not live data.",
  );
  const demo = page.getByTestId("scan-demo-row");
  await expect(demo).toHaveCount(3);
  for (let i = 0; i < 3; i++) {
    await expect(demo.nth(i)).toContainText("Synthetic");
    // An invented row never reads as delivered.
    await expect(demo.nth(i)).not.toContainText("Delivery verified");
  }
  // Synthetic rows never enter the list of real previews.
  await expect(
    page.getByTestId("scan-veined").getByTestId("scan-demo-row"),
  ).toHaveCount(0);
  await expect(page.getByTestId("scan-row")).toHaveCount(0);
  await axe(page);
});

for (const [name, width, locale, theme] of [
  ["phone", 390, "en", "dark"],
  ["rtl", 1440, "ar", "dark"],
  ["light", 1440, "tr", "light"],
] as const)
  test(`G12-SC-E5 ${name}: Scan fits, is localized and axe-clean`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, { locale, theme, stored: previews() });
    await page.goto("/scan");
    await expect(page.getByTestId("scan-row")).toHaveCount(2);
    await page.getByTestId("scan-row").first().locator("summary").click();
    if (locale === "tr")
      await expect(page.getByTestId("scan-not-through-veined")).toContainText(
        "Bu sürümde gönderim kapalıdır",
      );
    if (locale === "ar") {
      await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
      await expect(page.getByTestId("scan-veined")).not.toContainText(
        "Sending is closed",
      );
    }
    expect(await noOverflow(page)).toBe(true);
    await axe(page);
    await shot(page, `g12-sc-e5-${name}`);
  });
