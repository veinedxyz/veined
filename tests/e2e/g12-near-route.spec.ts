// G12 H02: the NEAR Intents route inside Bridge and Swap, as a judge or a new user meets it: connect a wallet →
// choose "To NEAR" → get a signed dry quote → read Guardian's decision → sending stays closed. The 1Click upstream is
// replaced by a REAL recorded signed dry quote (Base native USDC → wNEAR to veinedxyz.near, G11 read-only proof) that
// the real server route re-reviews (intents-verify), so signature, echo, identity and freshness rules run for real.
// SYNTHETIC_TEST_ONLY otherwise (wallet doubles, routing fixtures). Nothing is signed, approved, deposited or sent.
import type { Page, Route } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync } from "node:fs";
import { test, expect, connectWallet } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
import { fixtureCatalog } from "../fixtures/routing";
import recorded from "../fixtures/g12-near-usdc-quote.json" with { type: "json" };

/** A signed 1Click quote as JSON, for deliberate edits in adversarial cases. */
type SignedQuote = {
  quote: Record<string, unknown>;
  quoteRequest: Record<string, unknown>;
} & Record<string, unknown>;

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3100";
const OWNER = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
const SHOTS = process.env.VWP_SHOTS_DIR;
const issued = Date.parse(recorded.response.timestamp);
const SIGNING = [
  "eth_sendTransaction",
  "eth_signTransaction",
  "eth_sign",
  "personal_sign",
  "eth_signTypedData",
  "eth_signTypedData_v3",
  "eth_signTypedData_v4",
  "wallet_sendCalls",
];
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}
async function setup(
  page: Page,
  o: { locale?: string; theme?: string; wallet?: boolean } = {},
) {
  const locale = o.locale ?? "en";
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript(
    ({ locale, theme }) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
    },
    { locale, theme: o.theme ?? "dark" },
  );
  if (o.wallet)
    await page.addInitScript(installWalletDoubles, {
      wallets: ["rabby"] as (keyof typeof WALLET_DOUBLES)[],
      // The checksummed form the recorded quote was signed for (Guardian compares the refund echo exactly).
      account: recorded.request.refundTo,
      chainId: "0x2105",
      doubles: WALLET_DOUBLES,
    });
  await page.route("**/api/routing", (r) =>
    r.fulfill({ json: fixtureCatalog() }),
  );
  await page.route("**/api/assets", (r) => r.fulfill({ json: { assets: [] } }));
}
/** Offline stand-in for 1Click: every dry quote is answered by the server's review of the recorded signed quote. */
async function recordedUpstream(
  page: Page,
  edit?: (response: SignedQuote) => void,
) {
  const bodies: {
    sender: string;
    request: Record<string, string | boolean | number>;
  }[] = [];
  await page.route("**/api/guardian", async (route: Route) => {
    const body = route.request().postDataJSON();
    if (body?.action !== "intents-quote") return route.continue();
    bodies.push(body);
    const response = structuredClone(recorded.response) as SignedQuote;
    edit?.(response);
    const reviewed = await route.fetch({
      postData: JSON.stringify({
        action: "intents-verify",
        request: recorded.request,
        response,
        sender: recorded.request.refundTo,
      }),
    });
    return route.fulfill({
      json: { ...(await reviewed.json()), signed: response },
    });
  });
  return bodies;
}
const nearRoute = (page: Page) => page.getByTestId("near-route");
async function fillRoute(page: Page, o: { refund?: string } = {}) {
  const r = nearRoute(page);
  await r
    .getByTestId("near-route-origin")
    .selectOption(recorded.request.originAsset);
  await r.getByTestId("near-route-amount").fill("5");
  await r.getByRole("radio", { name: /wNEAR/ }).check();
  await r.getByTestId("near-route-recipient").fill("veinedxyz.near");
  if (o.refund) await r.getByTestId("near-route-refund").fill(o.refund);
}
const noOverflow = (page: Page) =>
  page.evaluate(
    () => document.documentElement.scrollWidth <= window.innerWidth + 1,
  );

test("NR-E1 judge flow: connect Rabby → Bridge → To NEAR → signed dry quote → Guardian decision → sending closed, nothing signed", async ({
  page,
}) => {
  await setup(page, { wallet: true });
  const bodies = await recordedUpstream(page);
  await page.goto("/bridge");
  const kinds = page.getByTestId("route-kind");
  await expect(
    kinds.getByRole("button", { name: /Between networks/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await kinds.getByRole("button", { name: /To NEAR/ }).click();
  await expect(page).toHaveURL(/[?&]to=near\b/);
  await expect(nearRoute(page)).toHaveAttribute("data-mode", "bridge");
  await expect(
    nearRoute(page).getByRole("heading", { name: "Send to NEAR" }),
  ).toBeVisible();
  await connectWallet(page, "Rabby Wallet", { label: "Connect wallet" });
  const r = nearRoute(page);
  // The connected wallet is the sender and the refund address; its chain (Base) is preselected.
  await expect(r.getByTestId("near-route-sender")).toContainText(
    "Connected wallet",
  );
  await expect(r.getByTestId("near-route-sender")).toContainText(/0xb6de/i);
  await expect(r.getByTestId("near-route-chain")).toHaveValue("base");
  await expect(r.getByTestId("near-route-refund")).toHaveCount(0);
  // wNEAR is labelled as wrapped, the stablecoins as issued natively on NEAR.
  await expect(
    r.getByRole("radio", { name: /wNEAR/ }).locator(".."),
  ).toContainText("not native NEAR");
  await expect(r.getByTestId("near-route-quote")).toBeDisabled();
  await fillRoute(page);
  await r.getByTestId("near-route-quote").click();
  const result = r.getByTestId("near-route-result");
  await expect(result).toBeVisible();
  expect(bodies).toHaveLength(1);
  expect(bodies[0].sender.toLowerCase()).toBe(OWNER);
  expect(bodies[0].request).toMatchObject({
    dry: true,
    swapType: "EXACT_INPUT",
    originAsset:
      "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    destinationAsset: "nep141:wrap.near",
    amount: "5000000",
    recipient: "veinedxyz.near",
    refundType: "ORIGIN_CHAIN",
  });
  expect(String(bodies[0].request.refundTo).toLowerCase()).toBe(OWNER);
  expect(Object.keys(bodies[0].request)).not.toContain("appFees");
  // The receipt: exact amounts from the signed quote, the provider's own fee, no VEINED fee, refund fee, recipient.
  await expect(r.getByTestId("near-route-untrusted")).toHaveCount(0);
  await expect(result).toContainText("5 USDC");
  await expect(r.getByTestId("near-route-receive")).toContainText(
    "1.390682 wNEAR",
  );
  await expect(result).toContainText("1.376775 wNEAR");
  await expect(r.getByTestId("near-route-fees")).toContainText(
    "NEAR Intents fee 0.2%, included in the quote",
  );
  await expect(r.getByTestId("near-route-fees")).toContainText(
    "VEINED fee: none",
  );
  await expect(result).toContainText("0.0024 USDC");
  await expect(result).toContainText("veinedxyz.near");
  await expect(r.getByTestId("near-route-signature")).toHaveAttribute(
    "data-signature",
    "VALID",
  );
  // The recorded quote is genuine but old: the preview window has ended, Guardian re-reviews it as stale (HOLD).
  await expect(result).toHaveAttribute("data-state", "expired");
  await expect(r.getByTestId("near-route-guardian")).toHaveAttribute(
    "data-level",
    "HOLD",
  );
  await expect(r.getByTestId("near-route-decision")).toHaveAttribute(
    "data-decision",
    "EXPIRED",
  );
  await expect(r.getByTestId("near-route-decision")).toContainText(
    "Expired · get a new quote",
  );
  await expect(r.getByTestId("near-route-expired")).toContainText(
    "Guardian reviewed it again as stale",
  );
  await expect(r).toContainText(
    "A decision about this quote only. Nothing can be sent from this screen.",
  );
  await expect(r.getByTestId("near-route-announce")).toContainText(
    "Quote received. Guardian: Expired",
  );
  await expect(r.getByTestId("near-route-quote")).toHaveText("Get a new quote");
  // Sending is closed: the only send control is disabled and no deposit address exists anywhere.
  const closed = r.getByTestId("near-route-closed");
  await expect(closed.getByRole("button")).toBeDisabled();
  await expect(closed).toContainText("NEAR Intents created no deposit address");
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __walletCalls: { method: string }[] })
        .__walletCalls,
  );
  expect(calls.filter((c) => SIGNING.includes(c.method))).toEqual([]);
  await shot(page, "nr-e1-bridge-to-near");
});

test("NR-E2 freshness: a quote is live with a countdown, then fails closed at expiry (server re-review, HOLD, re-quote)", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(issued + 15_000) });
  await setup(page);
  await recordedUpstream(page);
  await page.goto("/bridge?to=near");
  const r = nearRoute(page);
  await expect(r).toBeVisible();
  // Without a wallet the refund address is typed (public only) and checked for the source chain's format.
  await fillRoute(page, { refund: "veinedxyz.near" });
  await expect(r.getByTestId("near-route-quote")).toBeDisabled();
  await expect(r).toContainText("Enter a valid Base address.");
  await r.getByTestId("near-route-refund").fill(recorded.request.refundTo);
  await r.getByTestId("near-route-quote").click();
  const result = r.getByTestId("near-route-result");
  await expect(result).toHaveAttribute("data-state", "live");
  await expect(r.getByTestId("near-route-validity")).toContainText(/\d+ s/);
  await expect(r.getByTestId("near-route-quote")).toHaveText("Get NEAR quote");
  const verify = page.waitForRequest(
    (q) =>
      q.url().endsWith("/api/guardian") &&
      q.postDataJSON()?.action === "intents-verify",
  );
  await page.clock.fastForward("02:00");
  await verify;
  await expect(result).toHaveAttribute("data-state", "expired");
  await expect(r.getByTestId("near-route-validity")).toContainText("Expired");
  await expect(r.getByTestId("near-route-guardian")).toHaveAttribute(
    "data-level",
    "HOLD",
  );
  await expect(result).toContainText("Get a new quote.");
  // Changing the route clears the shown quote (it was signed for other inputs).
  await r.getByTestId("near-route-amount").fill("6");
  await expect(result).toHaveCount(0);
});

test("NR-E2b expiry never brings back an earlier Clear: a skewed-clock re-review or a failed one still reads Expired", async ({
  page,
}) => {
  await page.clock.install({ time: new Date(issued + 15_000) });
  await setup(page);
  let recheck: "clear" | "fail" = "clear";
  // SYNTHETIC_TEST_ONLY: the server's real review of the recorded quote, presented as a fresh Clear (as a server whose
  // clock lags would answer), to prove the browser fails closed whatever the re-review says.
  const clear = async (route: Route) => {
    const reviewed = await route.fetch({
      postData: JSON.stringify({
        action: "intents-verify",
        request: recorded.request,
        response: recorded.response,
        sender: recorded.request.refundTo,
      }),
    });
    const json = await reviewed.json();
    json.verdict.level = "CLEAR";
    json.verdict.steps = [];
    json.verdict.findings = json.verdict.findings.filter(
      (f: { code: string }) => f.code !== "ROUTE_STALE",
    );
    return json;
  };
  await page.route("**/api/guardian", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action === "intents-quote")
      return route.fulfill({
        json: { ...(await clear(route)), signed: recorded.response },
      });
    if (body?.action === "intents-verify")
      return recheck === "fail"
        ? route.fulfill({ status: 502, json: { error: "UNAVAILABLE" } })
        : route.fulfill({ json: await clear(route) });
    return route.continue();
  });
  await page.goto("/bridge?to=near");
  const r = nearRoute(page);
  await fillRoute(page, { refund: recorded.request.refundTo });
  for (const mode of ["clear", "fail"] as const) {
    recheck = mode;
    await page.clock.setSystemTime(new Date(issued + 15_000));
    await r
      .getByTestId("near-route-amount")
      .fill(mode === "clear" ? "5" : "5.0");
    await r.getByTestId("near-route-quote").click();
    const result = r.getByTestId("near-route-result");
    await expect(result).toHaveAttribute("data-state", "live");
    await expect(r.getByTestId("near-route-decision")).toHaveAttribute(
      "data-decision",
      "ALLOW",
    );
    // The countdown never exceeds the two-minute window, whatever the clocks say.
    const seconds = Number(
      (await r.getByTestId("near-route-validity").innerText()).match(/\d+/)![0],
    );
    expect(seconds).toBeLessThanOrEqual(120);
    await page.clock.fastForward("02:01");
    await expect(result).toHaveAttribute("data-state", "expired");
    await expect(r.getByTestId("near-route-decision")).toHaveAttribute(
      "data-decision",
      "EXPIRED",
    );
    await expect(r.getByTestId("near-route-guardian")).toHaveCount(0);
    await expect(r.getByTestId("near-route-expired")).toHaveText(
      "This quote expired. Get a new quote.",
    );
    await expect(r.getByTestId("near-route-decision")).not.toContainText(
      "Clear",
    );
  }
});

test("NR-E6 a wallet connected after the route opened moves it to the wallet's network (until the user picks one)", async ({
  page,
}) => {
  await setup(page);
  await page.addInitScript(installWalletDoubles, {
    wallets: ["rabby"] as (keyof typeof WALLET_DOUBLES)[],
    account: recorded.request.refundTo,
    chainId: "0xa4b1",
    doubles: WALLET_DOUBLES,
  });
  await page.goto("/bridge?to=near");
  const r = nearRoute(page);
  await expect(r.getByTestId("near-route-chain")).toHaveValue("base");
  await connectWallet(page, "Rabby Wallet", { label: "Connect wallet" });
  await expect(r.getByTestId("near-route-chain")).toHaveValue("arb");
  await expect(r.getByTestId("near-route-origin")).toHaveValue(
    "nep141:arb.omft.near",
  );
  await expect(r.getByTestId("near-route-sender")).toBeVisible();
});

test("NR-E3 a quote that does not match the request is blocked; upstream errors and bad inputs never show a quote", async ({
  page,
}) => {
  await setup(page);
  let mode: "redirect" | "rejected" | "down" | "limited" = "redirect";
  await page.route("**/api/guardian", async (route) => {
    const body = route.request().postDataJSON();
    if (body?.action !== "intents-quote") return route.continue();
    if (mode === "rejected")
      return route.fulfill({
        status: 422,
        json: { error: "INTENTS_REJECTED" },
      });
    if (mode === "down")
      return route.fulfill({
        status: 502,
        json: { error: "INTENTS_UNAVAILABLE" },
      });
    if (mode === "limited")
      return route.fulfill({ status: 429, json: { error: "RATE_LIMITED" } });
    const response = structuredClone(recorded.response) as SignedQuote;
    response.quoteRequest.recipient = "veinedxyz-rewards.near";
    const reviewed = await route.fetch({
      postData: JSON.stringify({
        action: "intents-verify",
        request: recorded.request,
        response,
        sender: recorded.request.refundTo,
      }),
    });
    return route.fulfill({
      json: { ...(await reviewed.json()), signed: response },
    });
  });
  await page.goto("/bridge?to=near");
  const r = nearRoute(page);
  await fillRoute(page, { refund: recorded.request.refundTo });
  await r.getByTestId("near-route-quote").click();
  await expect(r.getByTestId("near-route-guardian")).toHaveAttribute(
    "data-level",
    "BLOCK",
  );
  await expect(r.getByTestId("near-route-decision")).toHaveAttribute(
    "data-decision",
    "BLOCK",
  );
  await expect(r.getByTestId("near-route-guardian")).toContainText(
    "The signed quote does not match your request",
  );
  // Fail closed: no amounts are shown for a quote signed for something else.
  await expect(r.getByTestId("near-route-untrusted")).toBeVisible();
  await expect(r.getByTestId("near-route-receive")).toHaveCount(0);
  await expect(r.getByTestId("near-route-fees")).toHaveCount(0);
  for (const [m, text] of [
    ["rejected", "NEAR Intents refused this request: there may be no route"],
    ["down", "NEAR Intents did not answer."],
    ["limited", "Too many quotes in a short time."],
  ] as const) {
    mode = m;
    await r
      .getByTestId("near-route-amount")
      .fill(m === "down" ? "7" : m === "limited" ? "8" : "9");
    await r.getByTestId("near-route-quote").click();
    await expect(r.getByTestId("near-route-error")).toContainText(text);
    await expect(r.getByTestId("near-route-result")).toHaveCount(0);
  }
  // Guardian reads the recipient first: a look-alike of intents.near is blocked and no quote is ever requested.
  const quotes: string[] = [];
  page.on("request", (q) => {
    if (
      q.url().endsWith("/api/guardian") &&
      q.postDataJSON()?.action === "intents-quote"
    )
      quotes.push(q.url());
  });
  mode = "redirect";
  await r.getByTestId("near-route-recipient").fill("intents-near.near");
  await r.getByTestId("near-route-quote").click();
  await expect(r.getByTestId("near-route-error")).toHaveAttribute(
    "data-code",
    "RECIPIENT_BLOCKED",
  );
  await expect(r.getByTestId("near-route-recipient-guardian")).toHaveAttribute(
    "data-level",
    "BLOCK",
  );
  await expect(r.getByTestId("near-route-recipient-guardian")).toContainText(
    "Guardian checked the recipient before any quote",
  );
  expect(quotes).toEqual([]);
  // Bad inputs keep the quote button disabled with a reason.
  await r.getByTestId("near-route-recipient").fill("Not An Account!");
  await expect(r).toContainText("Enter a NEAR account, for example name.near.");
  await expect(r.getByTestId("near-route-quote")).toBeDisabled();
  await r.getByTestId("near-route-recipient").fill("veinedxyz.near");
  await r.getByTestId("near-route-amount").fill("0");
  await expect(r.getByTestId("near-route-quote")).toBeDisabled();
  await r.getByTestId("near-route-amount").fill("-1");
  await expect(r.getByTestId("near-route-quote")).toBeDisabled();
  // Solana as the source needs a Solana refund address; an EVM address is refused there.
  await r.getByTestId("near-route-chain").selectOption("sol");
  await r.getByTestId("near-route-amount").fill("1");
  await r.getByTestId("near-route-refund").fill(recorded.request.refundTo);
  await expect(r).toContainText("Enter a valid Solana address.");
  await expect(r.getByTestId("near-route-quote")).toBeDisabled();
});

test("NR-E4 Swap offers the same route as a cross-network swap into a NEAR token, also by direct link", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/swap");
  const kinds = page.getByTestId("route-kind");
  await expect(
    kinds.getByRole("button", { name: /On one network/ }),
  ).toHaveAttribute("aria-pressed", "true");
  await kinds.getByRole("button", { name: /To NEAR/ }).click();
  await expect(nearRoute(page)).toHaveAttribute("data-mode", "swap");
  await expect(
    nearRoute(page).getByRole("heading", { name: "Swap into a NEAR token" }),
  ).toBeVisible();
  await kinds.getByRole("button", { name: /On one network/ }).click();
  await expect(nearRoute(page)).toHaveCount(0);
  await expect(page).not.toHaveURL(/to=near/);
  await page.goto("/swap?to=near");
  await expect(nearRoute(page)).toBeVisible();
});

for (const [name, width, locale, theme] of [
  ["phone", 390, "en", "dark"],
  ["rtl", 1440, "ar", "dark"],
  ["light", 1440, "en", "light"],
] as const)
  test(`NR-E5 ${name}: the NEAR route fits and is axe-clean, before and after a quote`, async ({
    page,
  }) => {
    await setup(page, { locale, theme });
    await recordedUpstream(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto("/bridge?to=near");
    const r = nearRoute(page);
    await expect(r).toBeVisible();
    const axe = () =>
      new AxeBuilder({ page })
        .include("[data-testid=near-route]")
        .include("[data-testid=route-kind]")
        .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
        .analyze();
    expect(await noOverflow(page)).toBe(true);
    expect((await axe()).violations).toEqual([]);
    await r.getByTestId("near-route-origin").selectOption({ index: 1 });
    await r.getByTestId("near-route-amount").fill("5");
    await r.getByRole("radio").first().check();
    await r.getByTestId("near-route-recipient").fill("veinedxyz.near");
    await r.getByTestId("near-route-refund").fill(recorded.request.refundTo);
    await r.getByTestId("near-route-quote").click();
    await expect(r.getByTestId("near-route-result")).toBeVisible();
    await expect(r.getByTestId("near-route-guardian")).toBeVisible();
    // The quote button returns from busy to enabled with a colour transition: measure its settled colours.
    await page.mouse.move(0, 0);
    await r
      .getByTestId("near-route-quote")
      .evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
    expect(await noOverflow(page)).toBe(true);
    expect((await axe()).violations).toEqual([]);
    await shot(page, `nr-e5-${name}`);
  });
