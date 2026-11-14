// gf1 G03 Guardian for first-time users. SYNTHETIC_TEST_ONLY: the real /api/guardian route with VEINED's local
// registry (on-chain lookups off for E2E); nothing is signed, approved, quoted or sent. Asserts: "Ask Guardian" is the
// main mode and Inspect the advanced one; the five guided starts sit on the first screen (desktop and phone) and each
// completes with taps only; every decision reads as one plain sentence whose next step is only stated when it is
// really available, with the technical record collapsed below (decision, checks, policy, digest, answer time,
// sources, limits); WARN / ESCALATE / BLOCK keep their enforcement; a forged client verdict is refused by the server;
// Inspect and Agent Gate stay reachable; a page's own route review is told apart from a server review, and a re-shown
// draft review keeps its own time and draft policy; 24 languages with the honest typed-language note, RTL, reduced
// motion, keyboard (focus follows a used guided start) and axe.
import type { Locator, Page, Request } from "@playwright/test";
import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { test, expect } from "./fixtures";
import { fixtureCatalog, fixtureQuote } from "../fixtures/routing";
import { normalizeQuote } from "../../src/routing/normalize";
import type { QuoteInput } from "../../src/routing/model";
import { wallet } from "../fixtures/swap";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const BURN = "0x000000000000000000000000000000000000dEaD";
// G12 H01 (F1): Circle's native USDC on Base is registered now; WETH on Base (a real predeploy) is not.
const WETH_BASE = "0x4200000000000000000000000000000000000006";
const LOCALES = [
  "tr",
  "en",
  "es",
  "pt-BR",
  "fr",
  "de",
  "it",
  "nl",
  "pl",
  "ru",
  "uk",
  "ar",
  "fa",
  "he",
  "ur",
  "zh-CN",
  "zh-TW",
  "ja",
  "ko",
  "hi",
  "bn",
  "id",
  "vi",
  "th",
];
const RTL = ["ar", "fa", "he", "ur"];
const GUIDED = ["swap", "bridge", "token", "address", "quote"];
const text = (locale: string) => {
  const json = JSON.parse(
    readFileSync(`src/i18n/locales/${locale}.json`, "utf8"),
  ) as Record<string, unknown>;
  return (path: string) =>
    path
      .split(".")
      .reduce<unknown>(
        (o, k) => (o as Record<string, unknown>)?.[k],
        json,
      ) as string;
};
const en = text("en");

async function setup(page: Page, locale = "en") {
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript((l) => {
    if (window === window.top) localStorage.setItem("otherbridge.language", l);
  }, locale);
  await page.route("**/api/catalog", (route) =>
    route.fulfill({ status: 422, json: { error: "SYNTHETIC_UNAVAILABLE" } }),
  );
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
  const requests: Request[] = [];
  page.on("request", (r) => requests.push(r));
  return requests;
}
/** Bridge route fixtures (catalog, native-asset connections, deterministic quotes), as in the gc1 Bridge context test. */
async function bridgeRouting(page: Page) {
  const catalog = fixtureCatalog();
  await page.route("**/api/routing", async (route) => {
    const body = route.request().postDataJSON() ?? {};
    if (!body.action || body.action === "catalog")
      return route.fulfill({ json: catalog });
    if (body.action === "connections") {
      const f = catalog.networks.find((n) => n.id === body.source)!,
        t = catalog.networks.find((n) => n.id === body.destination)!;
      return route.fulfill({
        json: [
          {
            from: f.id,
            to: t.id,
            sourceAssets: [f.nativeAsset],
            destinationAssets: [t.nativeAsset],
            provider: "routing-core",
            executable: false,
          },
        ],
      });
    }
    if (body.action === "quote") {
      const input = body.input as QuoteInput;
      return route.fulfill({
        json: [normalizeQuote(fixtureQuote(input), input, catalog)],
      });
    }
    return route.fulfill({ status: 422, json: { error: "INVALID_REQUEST" } });
  });
}
async function snap(page: Page, name: string, fullPage = false) {
  await page.screenshot({
    path: test.info().outputPath(`${name}.png`),
    fullPage,
  });
}
const overflow = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1);
async function axe(page: Page) {
  const r = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(r.violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
}
async function ask(chat: Locator, value: string) {
  const input = chat.getByTestId("guardian-chat-input");
  await input.fill(value);
  await input.press("Enter");
}
const lastReply = (chat: Locator) =>
  chat.locator(".gchat-msg.is-guardian").last();
const chip = (chat: Locator, id: string) =>
  chat.locator(`.gchat-chips .gchat-chip[data-chip='${id}']`);
const guardianBodies = (requests: Request[]) =>
  requests
    .filter((r) => r.url().endsWith("/api/guardian") && r.method() === "POST")
    .map((r) => r.postDataJSON() as { action: string });
function sameOriginOnly(requests: Request[]) {
  const foreign = requests
    .map((r) => r.url())
    .filter((u) => !u.startsWith("data:") && !u.startsWith("blob:"))
    .filter((u) => new URL(u).origin !== new URL(ORIGIN).origin);
  expect(foreign).toEqual([]);
}
/** The technical record of a server review: collapsed until asked for; then the decision, checks, policy (and the
 * chat-draft policy for drafts), digest, the time the answer arrived (within the test's own window, and not before
 * `notBefore` when the answer was held back), what Guardian used and what it did not check. Returns that time. */
async function technical(
  scope: Locator,
  decision: string,
  from: number,
  level: string,
  opts: { notBefore?: number; draft?: boolean } = {},
) {
  const tech = scope.getByTestId("guardian-tech").last();
  await expect(tech).toHaveAttribute("data-origin", "server");
  await expect(tech).not.toHaveAttribute("open", "");
  await expect(tech.locator("dl")).toBeHidden();
  await tech.locator("summary").click();
  await expect(tech).toHaveAttribute("open", "");
  await expect(tech).toContainText(`${decision} · ${level}`);
  await expect(tech).toContainText("Policy");
  await expect(tech).toContainText("g1.2026-11");
  await expect(tech.locator(".gchat-tech-digest")).toHaveText(
    /^[0-9a-f]{12,}$/,
  );
  const when = Date.parse(
    (await tech.locator("time").getAttribute("datetime")) ?? "",
  );
  expect(when).toBeGreaterThanOrEqual(from - 1000);
  expect(when).toBeLessThanOrEqual(Date.now() + 1000);
  if (opts.notBefore !== undefined)
    expect(when).toBeGreaterThanOrEqual(opts.notBefore);
  if (opts.draft) {
    await expect(tech).toContainText(en("gf.g3.tech.draftPolicy"));
    await expect(tech).toContainText("c1.2026-11");
  }
  await expect(tech).toContainText(en("gf.g3.tech.answered"));
  await expect(tech).toContainText(en("gf.g3.tech.sources"));
  await expect(tech).toContainText(en("gf.g3.tech.limits"));
  return when;
}

test("GF1-G3-E1 first screen: Ask Guardian is the main mode, five guided starts are visible without scrolling, nothing is requested before the user acts", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/guardian");
  await expect(page.getByRole("tab", { name: "Ask Guardian" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  // The tag is part of the tab's name, separated by a space ("Inspect Advanced").
  const inspectTab = page.getByRole("tab", {
    name: "Inspect Advanced",
    exact: true,
  });
  await expect(inspectTab).toHaveAttribute("aria-selected", "false");
  await expect(inspectTab.locator(".guardian-mode-tag")).toHaveText("Advanced");
  const start = page.getByTestId("guardian-guided-start");
  await expect(start.getByRole("heading", { level: 3 })).toHaveText(
    "Start here",
  );
  await expect(start).toContainText("Nothing is signed or sent.");
  const cards = start.locator("[data-guided-start]");
  expect(
    await cards.evaluateAll((els) =>
      els.map((e) => (e as HTMLElement).dataset.guidedStart),
    ),
  ).toEqual(GUIDED);
  for (const id of GUIDED) {
    const card = start.locator(`[data-guided-start='${id}']`);
    await expect(card).toHaveAccessibleName(en(`gf.g3.start.${id}`));
    await expect(card).toHaveAccessibleDescription(en(`gf.g3.start.${id}Body`));
    const box = (await card.boundingBox())!;
    expect(box.y + box.height, id).toBeLessThanOrEqual(900);
  }
  // The introduction (the King Octopus) follows the conversation instead of pushing it below the fold.
  const hero = page.getByTestId("guardian-hero");
  const chatBox = (await page.getByTestId("guardian-chat").boundingBox())!;
  expect((await hero.boundingBox())!.y).toBeGreaterThan(
    chatBox.y + chatBox.height,
  );
  await expect(hero.locator("img.king-hero")).toBeVisible();
  await page.waitForLoadState("networkidle");
  expect(guardianBodies(requests)).toEqual([]);
  await snap(page, "gf1-g3-first-screen");
  await axe(page);
  expect(await overflow(page)).toBe(false);
  sameOriginOnly(requests);
});

test("GF1-G3-E2 guided swap, tap only: Guardian asks step by step, the draft reads in one plain sentence, the technical record is collapsed and dated", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/guardian");
  const chat = page.getByTestId("guardian-chat");
  await page.locator("[data-guided-start='swap']").click();
  // The guided start is the user's own turn: it leaves the conversation as soon as the user acts.
  await expect(chat.locator(".gchat-msg.is-user p").last()).toHaveText(
    "Prepare a swap",
  );
  await expect(page.getByTestId("guardian-guided-start")).toHaveCount(0);
  await expect(lastReply(chat)).toContainText(
    "Which token do you want to use?",
  );
  await chip(chat, "pay-ETH").click();
  await expect(lastReply(chat)).toContainText("How much ETH?");
  await expect(chip(chat, "amt-0.01")).toBeVisible();
  await expect(chip(chat, "reset")).toBeVisible();
  // Nothing has been reviewed yet: questions are answered locally.
  expect(guardianBodies(requests)).toEqual([]);
  await chip(chat, "amt-0.1").click();
  await expect(lastReply(chat)).toContainText("From which network?");
  await chip(chat, "source-ethereum").click();
  await expect(lastReply(chat)).toContainText(
    "Which token do you want to receive?",
  );
  // The review's answer is held back 1.5 s: the record's time must be when the answer arrived, not when it was asked.
  await page.route("**/api/guardian", async (route) => {
    await new Promise((r) => setTimeout(r, 1500));
    await route.continue();
  });
  const from = Date.now();
  await chip(chat, "receive-USDC").click();
  const card = chat.getByTestId("guardian-draft").last();
  await expect(card).toHaveAttribute("data-decision", "ALLOW");
  await expect(card).toHaveAttribute("data-kind", "swap");
  await expect(card).toContainText("0.1 ETH");
  const plain = card.getByTestId("guardian-plain");
  await expect(plain).toHaveAttribute("data-decision", "ALLOW");
  await expect(plain).toContainText("Guardian found nothing wrong here.");
  await expect(plain).toContainText("This is not permission to move funds.");
  await expect(
    card.getByRole("button", { name: "Open in Swap" }),
  ).toBeEnabled();
  await technical(card, "ALLOW", from, "Clear", {
    notBefore: from + 1400,
    draft: true,
  });
  expect(guardianBodies(requests).map((b) => b.action)).toEqual(["chat-draft"]);
  await snap(page, "gf1-g3-guided-swap");
  await axe(page);
  sameOriginOnly(requests);
});

test("GF1-G3-E3 guided token and address checks: a verified token is explained, the burn-address example is blocked, both with their technical record", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/guardian");
  const chat = page.getByTestId("guardian-chat");
  await page.locator("[data-guided-start='token']").click();
  await expect(lastReply(chat)).toContainText("Which token?");
  await chip(chat, "check-USDC").click();
  await expect(lastReply(chat)).toContainText("On which network is USDC?");
  let from = Date.now();
  await chip(chat, "check-ethereum").click();
  let reply = lastReply(chat);
  await expect(reply).toContainText(
    "USDC on Ethereum is curated in VEINED's registry.",
  );
  await expect(reply.getByTestId("guardian-plain")).toHaveAttribute(
    "data-decision",
    "ALLOW",
  );
  await technical(reply, "ALLOW", from, "Clear");
  await page.getByRole("button", { name: "New conversation" }).click();
  // A new conversation starts from the guided starts again.
  await expect(page.getByTestId("guardian-guided-start")).toBeVisible();
  await page.locator("[data-guided-start='address']").click();
  await expect(lastReply(chat)).toContainText("Paste the address");
  from = Date.now();
  await chip(chat, "x-burn").click();
  reply = lastReply(chat);
  await expect(reply.locator('[data-code="RECIPIENT_BURN"]')).toBeVisible();
  const plain = reply.getByTestId("guardian-plain");
  await expect(plain).toHaveAttribute("data-decision", "BLOCK");
  await expect(plain).toContainText("Do not continue");
  await technical(reply, "BLOCK", from, "Blocked");
  await snap(page, "gf1-g3-guided-address-block");
  await axe(page);
});

test("GF1-G3-E4 WARN, ESCALATE and BLOCK are understandable and still enforced: the next step is stated only when it is really possible", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/guardian");
  const chat = page.getByTestId("guardian-chat");
  // WARN with an unregistered contract: no "you can still open it" — the card says why it cannot be opened here.
  await ask(chat, "send 10 WETH from Base to Ethereum");
  await expect(lastReply(chat)).toContainText(
    "VEINED's verified registry has no token called WETH on Base.",
  );
  await ask(chat, WETH_BASE);
  let card = chat.getByTestId("guardian-draft").last();
  await expect(card).toHaveAttribute("data-decision", "WARN");
  let plain = card.getByTestId("guardian-plain");
  await expect(plain).toHaveText(en("gf.g3.plain.WARN"));
  await expect(plain).not.toContainText(en("gf.g3.next.WARN"));
  await expect(card).toContainText(en("guardian.chat.draft.unknownDecimals"));
  await expect(
    card.getByRole("button", { name: "Open in Bridge" }),
  ).toBeDisabled();
  // ESCALATE: stop and verify; opening waits for the user's acknowledgement.
  await ask(chat, "bridge 50000 USDT from Ethereum to Polygon");
  await expect(chat.getByTestId("guardian-draft")).toHaveCount(2);
  card = chat.getByTestId("guardian-draft").last();
  await expect(card).toHaveAttribute("data-decision", "ESCALATE");
  plain = card.getByTestId("guardian-plain");
  await expect(plain).toContainText(en("gf.g3.plain.ESCALATE"));
  await expect(plain).toContainText(en("gf.g3.next.ESCALATE"));
  await expect(card.locator('[data-code="DRAFT_LARGE_AMOUNT"]')).toBeVisible();
  const open = card.getByRole("button", { name: "Open in Bridge" });
  await expect(open).toBeDisabled();
  await card.getByLabel("I have read Guardian's warnings").check();
  await expect(open).toBeEnabled();
  // BLOCK: cannot be opened, and the plain sentence says so.
  await ask(chat, `send 10 USDT from Ethereum to Arbitrum to ${BURN}`);
  await expect(chat.getByTestId("guardian-draft")).toHaveCount(3);
  card = chat.getByTestId("guardian-draft").last();
  await expect(card).toHaveAttribute("data-decision", "BLOCK");
  plain = card.getByTestId("guardian-plain");
  await expect(plain).toContainText(en("gf.g3.plain.BLOCK"));
  await expect(plain).toContainText(en("gf.g3.next.BLOCK"));
  await expect(card.locator('[data-code="RECIPIENT_BURN"]')).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Open in Bridge" }),
  ).toBeDisabled();
  // Asked again, Guardian re-shows the same server review: same digest, the draft's own review time and draft policy.
  await card.getByTestId("guardian-tech").locator("summary").click();
  const reviewedAt = await card
    .getByTestId("guardian-tech")
    .locator("time")
    .getAttribute("datetime");
  expect(reviewedAt).toBeTruthy();
  await ask(chat, "Why is this route blocked?");
  const again = lastReply(chat);
  await expect(again.getByTestId("guardian-chat-context")).toHaveAttribute(
    "data-digest",
    (await card
      .getByTestId("guardian-draft-verdict")
      .getAttribute("data-digest"))!,
  );
  const reTech = again.getByTestId("guardian-tech");
  await expect(reTech).toHaveAttribute("data-origin", "server");
  await reTech.locator("summary").click();
  await expect(reTech.locator("time")).toHaveAttribute("datetime", reviewedAt!);
  await expect(reTech).toContainText("c1.2026-11");
  await snap(page, "gf1-g3-decisions");
  await axe(page);
});

test("GF1-G3-E5 source-side enforcement: the decision comes from the server; a forged client verdict is refused and the same draft stays BLOCK", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/guardian");
  const result = await page.evaluate(async (burn) => {
    const draft = {
      kind: "bridge",
      source: "ethereum",
      destination: "arbitrum",
      pay: { symbol: "USDT" },
      receive: { symbol: "USDT" },
      amount: "10",
      recipient: burn,
    };
    const post = (body: unknown) =>
      fetch("/api/guardian", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }).then(async (r) => ({ status: r.status, json: await r.json() }));
    return {
      forged: await post({
        action: "chat-draft",
        draft: { ...draft, verdict: { level: "CLEAR", findings: [] } },
      }),
      decided: await post({ action: "chat-draft", draft, decision: "ALLOW" }),
      honest: await post({ action: "chat-draft", draft }),
    };
  }, BURN);
  expect(result.forged).toEqual({
    status: 422,
    json: { error: "INVALID_REQUEST" },
  });
  expect(result.decided).toEqual({
    status: 422,
    json: { error: "INVALID_REQUEST" },
  });
  expect(result.honest.status).toBe(200);
  expect(result.honest.json.decision).toBe("BLOCK");
  expect(result.honest.json.draft.executable).toBe(false);
});

test("GF1-G3-E6 guided 'Explain a quote' is honest on a page without a quote and leads to Swap or Bridge", async ({
  page,
}) => {
  const requests = await setup(page);
  await page.goto("/guardian");
  const chat = page.getByTestId("guardian-chat");
  await page.locator("[data-guided-start='quote']").click();
  const reply = lastReply(chat);
  await expect(reply).toContainText(en("guardian.chat.r.quoteGuide"));
  await expect(reply).toContainText(en("guardian.chat.r.noQuotePage"));
  await expect(chip(chat, "go-swap")).toBeVisible();
  await expect(chip(chat, "go-bridge")).toBeVisible();
  // Explaining asks nothing of any provider.
  expect(guardianBodies(requests)).toEqual([]);
  await chip(chat, "go-bridge").click();
  await expect(page).toHaveURL(/\/bridge$/);
});

test("GF1-G3-E7 Inspect and Agent Gate stay one click away", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/guardian");
  await page.getByRole("tab", { name: /^Inspect/ }).click();
  const inspect = page.getByTestId("guardian-inspect");
  await expect(inspect).toBeVisible();
  await inspect.getByRole("button", { name: "Fake USDC", exact: true }).click();
  await expect(page.getByTestId("guardian-inspect-result")).toHaveAttribute(
    "data-level",
    "BLOCK",
  );
  await page.getByRole("tab", { name: "Ask Guardian" }).click();
  await expect(page.getByTestId("guardian-guided-start")).toBeVisible();
  await page.getByTestId("guardian-advanced").locator("summary").click();
  await expect(
    page
      .getByTestId("guardian-agent")
      .getByRole("button", { name: "Replay a compromised agent" }),
  ).toBeVisible();
});

test("GF1-G3-E8 phone: the guided starts begin on the first screen (heading and first card fully above the tab bar) and a guided bridge completes with taps only", async ({
  page,
}) => {
  await setup(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/guardian");
  const first = page.locator("[data-guided-start='swap']");
  await expect(first).toBeVisible();
  const bar = (await page.locator(".main-nav").boundingBox())!;
  const box = (await first.boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(bar.y);
  const heading = (await page
    .getByTestId("guardian-guided-start")
    .locator("h3")
    .boundingBox())!;
  expect(heading.y).toBeGreaterThanOrEqual(0);
  expect(heading.y + heading.height).toBeLessThanOrEqual(bar.y);
  await snap(page, "gf1-g3-phone-first-screen");
  expect(await overflow(page)).toBe(false);
  await axe(page);
  const chat = page.getByTestId("guardian-chat");
  await page.locator("[data-guided-start='bridge']").click();
  await chip(chat, "pay-ETH").click();
  await chip(chat, "amt-0.01").click();
  await chip(chat, "source-ethereum").click();
  await expect(lastReply(chat)).toContainText("To which network?");
  const from = Date.now();
  await chip(chat, "destination-base").click();
  const card = chat.getByTestId("guardian-draft").last();
  await expect(card).toHaveAttribute("data-decision", "ALLOW");
  await expect(card).toHaveAttribute("data-kind", "bridge");
  await expect(card.getByTestId("guardian-plain")).toContainText(
    en("gf.g3.next.ALLOW"),
  );
  await technical(card, "ALLOW", from, "Clear");
  await expect(
    card.getByRole("button", { name: "Open in Bridge" }),
  ).toBeEnabled();
  await snap(page, "gf1-g3-phone-guided-bridge");
  expect(await overflow(page)).toBe(false);
  await axe(page);
});

test("GF1-G3-E9 keyboard and reduced motion: a guided start is a real button; the page works without animation", async ({
  page,
}) => {
  await setup(page);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/guardian");
  const card = page.locator("[data-guided-start='token']");
  await card.focus();
  await expect(card).toBeFocused();
  await page.keyboard.press("Enter");
  const chat = page.getByTestId("guardian-chat");
  await expect(lastReply(chat)).toContainText("Which token?");
  // The used guided start leaves the page; keyboard focus moves to Guardian's first suggestion, never to the body.
  await expect(chip(chat, "check-USDC")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(chip(chat, "check-USDT")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(lastReply(chat)).toContainText("On which network is USDT?");
  expect(
    await page.evaluate(
      () =>
        document
          .querySelector("[data-testid='guardian-chat']")!
          .getAnimations({ subtree: true }).length,
    ),
  ).toBe(0);
});

test("GF1-G3-E10 24 languages: the modes and guided starts are translated, typed understanding is honestly limited to English and Turkish, structured starts work everywhere", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.route("**/api/catalog", (route) =>
    route.fulfill({ status: 422, json: { error: "SYNTHETIC_UNAVAILABLE" } }),
  );
  await page.goto("/guardian");
  for (const locale of LOCALES) {
    const t = text(locale);
    await page
      .context()
      .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
    await page.evaluate(
      (l) => localStorage.setItem("otherbridge.language", l),
      locale,
    );
    await page.goto("/guardian");
    await expect(page.locator("html"), locale).toHaveAttribute(
      "dir",
      RTL.includes(locale) ? "rtl" : "ltr",
    );
    const tabs = page.getByRole("tab");
    await expect(tabs.first(), locale).toHaveText(t("guardian.chat.title"));
    await expect(tabs.nth(1).locator(".guardian-mode-tag"), locale).toHaveText(
      t("gf.g3.advanced"),
    );
    const start = page.getByTestId("guardian-guided-start");
    await expect(start.locator("h3"), locale).toHaveText(
      t("gf.g3.start.title"),
    );
    for (const id of GUIDED)
      await expect(
        start.locator(`[data-guided-start='${id}'] strong`),
        `${locale} ${id}`,
      ).toHaveText(t(`gf.g3.start.${id}`));
    const note = page
      .getByTestId("guardian-chat")
      .locator(`.gchat-note[data-note="guardian.chat.languageNote"]`);
    if (locale === "en" || locale === "tr")
      await expect(note, locale).toHaveCount(0);
    else await expect(note, locale).toHaveText(t("guardian.chat.languageNote"));
    expect(
      await page.locator("main").innerText(),
      `${locale} raw keys`,
    ).not.toMatch(/gf\.g3\.|guardian\.chat\./);
  }
  // A structured start is language-independent: Japanese completes the guided token check.
  const ja = text("ja");
  const chat = page.getByTestId("guardian-chat");
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "ja", url: ORIGIN }]);
  await page.evaluate(() => localStorage.setItem("otherbridge.language", "ja"));
  await page.goto("/guardian");
  await page.locator("[data-guided-start='token']").click();
  await chip(chat, "check-USDC").click();
  await chip(chat, "check-ethereum").click();
  const plain = lastReply(chat).getByTestId("guardian-plain");
  await expect(plain).toHaveAttribute("data-decision", "ALLOW");
  await expect(plain).toHaveText(ja("gf.g3.plain.ALLOW"));
  await expect(lastReply(chat).getByTestId("guardian-tech")).toContainText(
    ja("gf.g3.tech.title"),
  );
  await snap(page, "gf1-g3-ja-guided-token");
  await axe(page);
});

test("GF1-G3-E11 a page's own route review is told apart: on Bridge, the assistant's technical record says the review ran in this browser on the page's route, with its own limits", async ({
  page,
}) => {
  await setup(page);
  await bridgeRouting(page);
  await page.goto("/bridge");
  for (const [role, search, id] of [
    ["Select source network", "Ethereum", "1"],
    ["Select destination network", "Base", "8453"],
  ]) {
    await page.getByRole("button", { name: role }).click();
    await page.locator("#network-search").fill(search);
    await page.locator(`.network-picker [data-chain="${id}"]`).click();
    await expect(page.locator("dialog.network-picker")).toHaveCount(0);
  }
  await page.locator("#routing-amount").fill("0.01");
  await page.locator("#routing-sender").fill(wallet);
  await page.locator(".trade-parties .toggle input[type=checkbox]").check();
  await page.locator("#routing-recipient").fill(BURN);
  await page.getByRole("button", { name: "Read route", exact: true }).click();
  await expect(page.getByTestId("guardian-bridge")).toHaveAttribute(
    "data-level",
    "BLOCK",
  );
  await page.getByTestId("guardian-dock-trigger").click();
  const panel = page.getByTestId("guardian-dock-panel");
  await panel
    .getByRole("button", { name: "Why is this route blocked?" })
    .click();
  const reply = lastReply(panel);
  await expect(reply.getByTestId("guardian-chat-context")).toHaveAttribute(
    "data-digest",
    (await page.getByTestId("guardian-bridge").getAttribute("data-digest"))!,
  );
  await expect(reply.getByTestId("guardian-plain")).toHaveAttribute(
    "data-decision",
    "BLOCK",
  );
  const tech = reply.getByTestId("guardian-tech");
  await expect(tech).toHaveAttribute("data-origin", "page");
  await tech.locator("summary").click();
  await expect(tech).toContainText(en("gf.g3.tech.shown"));
  await expect(tech).toContainText(en("gf.g3.tech.sourcesPage"));
  await expect(tech).toContainText(en("gf.g3.tech.limitsPage"));
  // Never the server-review wording for a review that ran in the browser.
  await expect(tech).not.toContainText(en("gf.g3.tech.sources"));
  await expect(tech).not.toContainText(en("gf.g3.tech.limits"));
  await expect(tech).not.toContainText(en("gf.g3.tech.answered"));
  await snap(page, "gf1-g3-page-verdict-origin");
  await axe(page);
});
