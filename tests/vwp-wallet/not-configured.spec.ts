// VWP G09: a build with no wallet layer configured (no Privy App ID and no RainbowKit flag) says exactly that. Before
// G09 it answered "Wallet connection is temporarily unavailable.", which presents a missing setting as an outage.
// Nothing loads, nothing leaves the machine, and every read-only surface keeps working.
import { test, expect } from "@playwright/test";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const NOT_SET_UP =
  "Wallet connection is not set up in this build. Read-only features, quotes and public-address scans still work.";

test("VWP-W6 no wallet layer configured: an honest 'not set up' notice, no wallet code or third-party request, read-only app keeps working", async ({
  page,
}) => {
  const foreign: string[] = [];
  const scripts: string[] = [];
  await page.context().route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || /^(data|blob):/.test(url))
      return route.fallback();
    foreign.push(url);
    return route.abort();
  });
  page.on("request", (r) => {
    if (r.resourceType() === "script") scripts.push(r.url());
  });
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("otherbridge.language", "en");
  });
  await page.goto("/bridge");
  const wallet = page.locator("header .wallet-button");
  await expect(wallet).toHaveText("Connect wallet");
  await wallet.click();
  const notice = page.locator('.notice.error[role="alert"]');
  await expect(notice).toContainText(NOT_SET_UP);
  await expect(notice).not.toContainText("temporarily unavailable");
  await expect(page.locator("#privy-modal-content")).toHaveCount(0);
  await page.screenshot({
    path: `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results"}/vwp-w6-not-configured.png`,
  });
  // Read-only surfaces keep working: the Portfolio address scan form and the Swap instrument render.
  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  await expect(page.locator("h1")).toContainText("Portfolio");
  await page.getByRole("link", { name: "Swap", exact: true }).click();
  await expect(page.getByTestId("swap-intelligence")).toBeVisible();
  expect(foreign).toEqual([]);
  expect(
    scripts.filter((s) => /privy|walletconnect|rainbow|wagmi/i.test(s)),
  ).toEqual([]);
});

test("VWP-W6b Turkish: the same notice in the visitor's language", async ({
  page,
}) => {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "tr", url: ORIGIN }]);
  await page.addInitScript(() => {
    if (window === window.top)
      localStorage.setItem("otherbridge.language", "tr");
  });
  await page.goto("/swap");
  await page.locator("header .wallet-button").click();
  await expect(page.locator('.notice.error[role="alert"]')).toContainText(
    "Bu sürümde cüzdan bağlantısı yapılandırılmamış.",
  );
});
