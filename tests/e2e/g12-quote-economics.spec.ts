// G12 H03: the quote-economics notice in the real Bridge on SYNTHETIC quotes only (tests/fixtures/routing; nothing is
// live): F2 (an estimate above the amount sent is named, never silently shown as a gain; an implausible one is called
// implausible), F3 (costs out of proportion to the amount make the route "too small", never a normal route), and no
// notice at all for an ordinary quote. Read-only: no signature, no transaction.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect, fillRecipient } from "./fixtures";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote } from "../../src/routing/normalize";
import type { QuoteInput } from "../../src/routing/model";
import en from "../../src/i18n/locales/en.json" with { type: "json" };
import ar from "../../src/i18n/locales/ar.json" with { type: "json" };
import tr from "../../src/i18n/locales/tr.json" with { type: "json" };

const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g12";
type Raw = ReturnType<typeof fixtureQuote>;
// The network buttons and the read button are found by their accessible names in the page's language.
const labels = (locale: string) => {
  const ui = ({ en, ar, tr } as Record<string, typeof en>)[locale].ui;
  return {
    source: ui.selectSourceNetwork,
    destination: ui.selectDestinationNetwork,
    read: ui.readRoute,
  };
};
type Labels = ReturnType<typeof labels>;

async function setup(
  page: Page,
  mutate: (raw: Raw) => void,
  options: { locale?: string; theme?: "dark" | "light" } = {},
) {
  const locale = options.locale ?? "en";
  await page.addInitScript(
    ({ locale, theme }) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
    },
    { locale, theme: options.theme ?? "dark" },
  );
  const catalog = fixtureCatalog();
  await page.route("**/api/catalog", (route) =>
    route.fulfill({
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
      const input = body.input as QuoteInput;
      const raw = fixtureQuote(input);
      mutate(raw);
      const q = normalizeQuote(raw, input, catalog);
      q.warnings.push("SYNTHETIC_TEST_ONLY");
      return json([q]);
    }
    return json({ error: "INVALID_REQUEST" }, 422);
  });
  await page.goto("/bridge");
}
async function select(
  page: Page,
  role: "source" | "destination",
  search: string,
  id: string,
  l: Labels,
) {
  await page.getByRole("button", { name: l[role], exact: true }).click();
  await page.locator("#network-search").fill(search);
  await page.locator(`.network-picker [data-chain="${id}"]`).click();
  await expect(page.locator("dialog.network-picker")).toHaveCount(0);
}
async function quote(page: Page, locale = "en") {
  const l = labels(locale);
  await select(page, "source", "Ethereum", "1", l);
  await select(page, "destination", "Base", "8453", l);
  await expect(page.getByTestId("multichain-form")).toBeVisible();
  await page.locator("#routing-amount").fill("0.01");
  await page
    .locator("#routing-sender")
    .fill("0x3333333333333333333333333333333333333333");
  await fillRecipient(page, "0x3333333333333333333333333333333333333333");
  await page.getByRole("button", { name: l.read, exact: true }).click();
  await expect(page.locator(".trade-output bdi")).toBeVisible();
}
const notice = (page: Page) => page.getByTestId("quote-economics").first();
async function shot(page: Page, name: string) {
  mkdirSync(`${root}/screenshots`, { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
}
// 0.01 ETH sent (1e16 wei). The shared fixture's output amount is not to scale with its dollar values, so the cost
// cases first set an output that is: 0.009983 ETH worth $29.95 (the amount sent is then worth $30).
const ordinary = (raw: Raw) => {
  raw.estimate.toAmount = "9983000000000000";
  raw.estimate.toAmountMin = "9933000000000000";
};
const F2 = (raw: Raw) => {
  // The recorded F2 ratio: 5 -> 5.007450 (+14.9 bps), minimum below the input.
  raw.estimate.toAmount = "10014900000000000";
  raw.estimate.toAmountMin = "9964800000000000";
  raw.estimate.toAmountUSD = "30.04";
};

test("G12-QE-E1 an ordinary quote shows no economics notice", async ({
  page,
}) => {
  await setup(page, () => {});
  await quote(page);
  await expect(page.getByTestId("guardian-bridge")).toBeVisible();
  await expect(page.getByTestId("quote-economics")).toHaveCount(0);
});

test("G12-QE-E2 F2: an estimate above the amount sent is named with its size; the quote's own numbers stay as reported", async ({
  page,
}) => {
  await setup(page, F2);
  await quote(page);
  const n = notice(page);
  await expect(n).toHaveAttribute("data-surplus", "NOTICE");
  await expect(n).toHaveAttribute("data-cost", "OK");
  await expect(n).toContainText("The estimate is 0.14% more than you send.");
  await expect(n).toContainText(
    "The minimum the route states is below what you send.",
  );
  // Not corrected, not hidden: the expected amount is shown exactly as the route reported it.
  await expect(page.locator(".trade-output bdi")).toHaveText("0.010014");
  await shot(page, "g12-qe-e2-surplus");
});

test("G12-QE-E3 F2: an estimate far above the amount sent is called implausible", async ({
  page,
}) => {
  await setup(page, (raw) => {
    raw.estimate.toAmount = "10300000000000000";
    raw.estimate.toAmountMin = "10250000000000000";
    raw.estimate.toAmountUSD = "30.9";
  });
  await quote(page);
  const n = notice(page);
  await expect(n).toHaveAttribute("data-surplus", "IMPLAUSIBLE");
  await expect(n).toContainText("That is not a plausible result.");
  await expect(n).toContainText("3%");
});

test("G12-QE-E4 F3: costs out of proportion to the amount make the route 'too small', with the share stated", async ({
  page,
}) => {
  await setup(page, (raw) => {
    ordinary(raw);
    raw.estimate.gasCosts[0].amountUSD = "6";
  });
  await quote(page);
  const n = notice(page);
  await expect(n).toHaveAttribute("data-cost", "UNECONOMIC");
  await expect(n).toHaveAttribute("data-surplus", "NONE");
  await expect(n).toContainText("This amount is too small for this route.");
  await expect(n).toContainText("20.");
});

test("G12-QE-E5 F3: costs above the amount itself are stated as such", async ({
  page,
}) => {
  await setup(page, (raw) => {
    ordinary(raw);
    raw.estimate.gasCosts[0].amountUSD = "45";
  });
  await quote(page);
  const n = notice(page);
  await expect(n).toHaveAttribute("data-cost", "SEVERE");
  await expect(n).toContainText(
    "The costs are higher than the amount you send.",
  );
  await shot(page, "g12-qe-e5-severe");
});

for (const [name, width, locale, theme] of [
  ["phone", 390, "en", "dark"],
  ["rtl", 1440, "ar", "dark"],
  ["light", 1440, "tr", "light"],
] as const)
  test(`G12-QE-E6 ${name}: the notice fits, is localized and axe-clean`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page, F2, { locale, theme });
    await quote(page, locale);
    const n = notice(page);
    await n.scrollIntoViewIfNeeded();
    await expect(n).toBeVisible();
    if (locale === "tr")
      await expect(n).toContainText("Bu sayıları kontrol edin");
    if (locale === "ar") await expect(n).not.toContainText("estimate");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
          .analyze()
      ).violations,
    ).toEqual([]);
    await shot(page, `g12-qe-e6-${name}`);
  });
