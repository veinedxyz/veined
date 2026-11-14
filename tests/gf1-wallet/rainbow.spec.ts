// gf1 G02: the RainbowKit EVM connect layer in a real browser against its own dev server (rainbowkit build flag, no
// Privy App ID). SYNTHETIC_TEST_ONLY keyless EIP-6963 doubles; no signature, approval or broadcast is possible.
// Asserts the required state changes (connect, account change, chain change, wrong network, wallet-side disconnect,
// user disconnect, reconnect, change wallet, rejected, missing provider, multiple wallets), lazy loading and hydration
// cleanliness, no auto-reconnect after reload, one modal under repeated clicks, execution-closed semantics, zero
// third-party requests, keyboard focus return, and RTL/phone fit.
import { mkdirSync, writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect } from "@playwright/test";
import { fixtureCatalog } from "../fixtures/routing";
import { installDoubles, WALLET_DOUBLES, type DoubleConfig } from "./doubles";

const ORIGIN = process.env.OTHERBRIDGE_E2E_ORIGIN ?? "http://127.0.0.1:3126";
const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const ALLOWED_WALLET_METHODS = new Set([
  "eth_requestAccounts",
  "eth_accounts",
  "eth_chainId",
  "net_version",
  "wallet_requestPermissions",
  "wallet_getPermissions",
  "wallet_revokePermissions",
]);

async function setup(
  page: Page,
  options: Partial<Omit<DoubleConfig, "doubles">> & { locale?: string } = {},
) {
  const foreign: string[] = [];
  const consoleErrors: string[] = [];
  await page.context().route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || /^(data|blob):/.test(url))
      return route.fallback();
    foreign.push(url);
    return route.abort();
  });
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  const locale = options.locale ?? "en";
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: locale, url: ORIGIN }]);
  await page.addInitScript((l) => {
    if (window === window.top) localStorage.setItem("otherbridge.language", l);
  }, locale);
  if (options.wallets?.length)
    await page.addInitScript(installDoubles, {
      wallets: options.wallets,
      account: options.account ?? A,
      chainId: options.chainId ?? "0x1",
      connect: options.connect ?? "accept",
      doubles: WALLET_DOUBLES,
    });
  return { foreign, consoleErrors };
}
const header = (page: Page) => page.locator("header .wallet-button");
const modal = (page: Page) => page.locator("[data-rk] [role='dialog']");
const option = (page: Page, rdns: string) =>
  page.locator(`[data-testid='rk-wallet-option-${rdns}']`);
const walletCalls = (page: Page) =>
  page.evaluate(
    () =>
      (window as unknown as { __walletCalls: { method: string }[] })
        .__walletCalls ?? [],
  );
const wallets = (page: Page, key: string, call: string, arg?: unknown) =>
  page.evaluate(
    ([k, c, a]) =>
      (
        window as unknown as {
          __wallets: Record<string, Record<string, (v?: unknown) => void>>;
        }
      ).__wallets[k as string][c as string](a),
    [key, call, arg] as const,
  );
async function connect(page: Page, rdns: string) {
  await header(page).click();
  await expect(modal(page)).toBeVisible();
  await option(page, rdns).click();
  await expect(header(page)).toHaveClass(/is-connected/);
}

test("RK-1 lazy, hydration-clean layer; several injected wallets are offered; picking one connects through the accepted session", async ({
  page,
}) => {
  const { foreign, consoleErrors } = await setup(page, {
    wallets: ["metamask", "rabby"],
  });
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  // Nothing of the layer exists before the user asks for a wallet.
  await expect(page.locator("[data-rk]")).toHaveCount(0);
  expect(await walletCalls(page)).toEqual([]);
  await header(page).click();
  await expect(modal(page)).toBeVisible();
  await expect(option(page, "io.metamask")).toBeVisible();
  await expect(option(page, "io.rabby")).toBeVisible();
  await expect(modal(page)).toContainText("MetaMask");
  await expect(modal(page)).toContainText("Rabby Wallet");
  // No WalletConnect / QR / mobile options without an owner-supplied project id.
  await expect(modal(page)).not.toContainText(/WalletConnect|Scan with/i);
  await option(page, "io.metamask").click();
  await expect(header(page)).toHaveClass(/is-connected/);
  await expect(header(page).locator(".wallet-name")).toHaveText("MetaMask");
  await expect(header(page).locator(".wallet-address")).toHaveText(
    /^0x1111.*1111$/,
  );
  await expect(header(page).locator(".wallet-chain")).toContainText("#1");
  await expect(modal(page)).toHaveCount(0);
  // Only connection/read methods ever reached the wallet; the shell still says execution is closed.
  const methods = (await walletCalls(page)).map((c) => c.method);
  expect(methods.filter((m) => !ALLOWED_WALLET_METHODS.has(m))).toEqual([]);
  await expect(page.locator(".shell-status")).toContainText("Execution closed");
  expect(foreign).toEqual([]);
  expect(
    consoleErrors.filter((e) =>
      /hydrat|did not match|Content Security/i.test(e),
    ),
  ).toEqual([]);
});

test("RK-2 account change, chain change and an unsupported network re-bind with live reads", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask"] });
  await page.goto("/app");
  await connect(page, "io.metamask");
  await wallets(page, "metamask", "setAccounts", [B]);
  await expect(header(page).locator(".wallet-address")).toHaveText(
    /^0x2222.*2222$/,
  );
  await wallets(page, "metamask", "setChain", "0x38");
  await expect(header(page).locator(".wallet-chain")).toContainText("BSC");
  // A network VEINED does not route on still binds honestly (shown by id), and nothing switches by itself.
  await wallets(page, "metamask", "setChain", "0x539");
  await expect(header(page).locator(".wallet-chain")).toContainText("#1337");
  const methods = (await walletCalls(page)).map((c) => c.method);
  expect(methods).not.toContain("wallet_switchEthereumChain");
  expect(methods.filter((m) => !ALLOWED_WALLET_METHODS.has(m))).toEqual([]);
});

test("RK-3 a wallet-side disconnect or lock ends the session", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask"] });
  await page.goto("/app");
  await connect(page, "io.metamask");
  await wallets(page, "metamask", "setAccounts", []);
  await expect(header(page)).not.toHaveClass(/is-connected/);
  await expect(header(page)).toContainText("Connect wallet");
});

test("RK-4 user disconnect, reconnect with another wallet, and change wallet", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask", "rabby"] });
  await page.goto("/app");
  await connect(page, "io.metamask");
  await header(page).click();
  await page.getByRole("button", { name: "Disconnect" }).click();
  await expect(header(page)).not.toHaveClass(/is-connected/);
  await connect(page, "io.rabby");
  await expect(header(page).locator(".wallet-name")).toHaveText("Rabby Wallet");
  await header(page).click();
  await page.getByRole("button", { name: "Change wallet" }).click();
  await expect(modal(page)).toBeVisible();
  await option(page, "io.metamask").click();
  await expect(header(page).locator(".wallet-name")).toHaveText("MetaMask");
});

test("RK-5 a rejected request leaves no session; closing the modal returns focus to the wallet button", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask"], connect: "reject" });
  await page.goto("/app");
  await header(page).focus();
  await page.keyboard.press("Enter");
  await expect(modal(page)).toBeVisible();
  await option(page, "io.metamask").click();
  await expect(modal(page)).toContainText(/retry/i);
  await expect(header(page)).not.toHaveClass(/is-connected/);
  await page.keyboard.press("Escape");
  await expect(modal(page)).toHaveCount(0);
  await expect(header(page)).toBeFocused();
  await expect(header(page)).toContainText("Connect wallet");
});

test("RK-6 no injected wallet: the modal opens without a fabricated option and nothing leaves the machine", async ({
  page,
}) => {
  const { foreign } = await setup(page);
  await page.goto("/app");
  await header(page).click();
  await expect(modal(page)).toBeVisible();
  await expect(page.locator("[data-testid^='rk-wallet-option-']")).toHaveCount(
    0,
  );
  await expect(header(page)).not.toHaveClass(/is-connected/);
  await page.keyboard.press("Escape");
  expect(foreign).toEqual([]);
});

test("RK-7 a reload starts disconnected even though the wallet remembers the site; repeated clicks open one modal", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask"] });
  await page.goto("/app");
  await connect(page, "io.metamask");
  await page.reload();
  await expect(page.locator("main h1").first()).toBeVisible();
  await page.waitForTimeout(800);
  await expect(header(page)).not.toHaveClass(/is-connected/);
  // Five clicks in one task (the modal would intercept real pointer clicks after the first one).
  await header(page).evaluate((button: HTMLElement) => {
    for (let i = 0; i < 5; i++) button.click();
  });
  await expect(modal(page)).toBeVisible();
  await page.waitForTimeout(500);
  await expect(modal(page)).toHaveCount(1);
});

test("RK-8 execution stays closed: Swap and Bridge never ask the wallet to sign or send", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask"], chainId: "0x38" });
  await page.goto("/app");
  await connect(page, "io.metamask");
  for (const path of ["/swap", "/bridge", "/portfolio"]) {
    await page.locator(`.main-nav a[href='${path}']`).click();
    await expect(page.locator("main").first()).toBeVisible();
    await expect(header(page)).toHaveClass(/is-connected/);
  }
  const methods = (await walletCalls(page)).map((c) => c.method);
  expect(methods.filter((m) => /sign|send/i.test(m))).toEqual([]);
  await expect(page.locator(".shell-status")).toContainText("Execution closed");
});

test("RK-9 Arabic phone: the modal card fits the viewport, wallet icons sit in their frames, no sideways scroll", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask", "rabby"], locale: "ar" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/app");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await header(page).click();
  await expect(modal(page)).toBeVisible();
  // ([role=dialog] is RainbowKit's full-screen backdrop layer, deliberately larger than the viewport.)
  for (const target of [
    page.locator("#rk_connect_title"),
    option(page, "io.metamask"),
    option(page, "io.rabby"),
  ]) {
    const box = (await target.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(390 + 1);
  }
  // Regression (RainbowKit RTL offset, fixed in rainbow-theme.css): each icon covers its 28 px frame exactly.
  for (const rdns of ["io.metamask", "io.rabby"]) {
    const [frame, img] = await option(page, rdns)
      .locator("img")
      .evaluate((el) =>
        [el.parentElement!, el].map((e) => {
          const r = e.getBoundingClientRect();
          return [Math.round(r.x), Math.round(r.width)];
        }),
      );
    expect(img, rdns).toEqual(frame);
  }
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBe(true);
  await option(page, "io.rabby").click();
  await expect(header(page)).toHaveClass(/is-connected/);
});

test("RK-10 a malicious EIP-6963 icon cannot inject markup: cool mode stays off, no injected handler runs", async ({
  page,
}) => {
  await setup(page, { wallets: ["metamask"] });
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const payload =
      'data:image/svg+xml,x"><img src=x onerror="window.__pwned=1">';
    const provider = {
      async request() {
        throw Object.assign(new Error("User rejected the request."), {
          code: 4001,
        });
      },
      on() {},
      removeListener() {},
    };
    const announce = () =>
      window.dispatchEvent(
        new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze({
            info: {
              uuid: "00000000-0000-4000-8000-0000000000ff",
              name: "Evil Wallet",
              icon: payload,
              rdns: "test.evil",
            },
            provider,
          }),
        }),
      );
    window.addEventListener("eip6963:requestProvider", announce);
    announce();
  });
  await page.goto("/app");
  await header(page).click();
  await expect(option(page, "test.evil")).toBeVisible();
  await option(page, "test.evil").hover();
  await page.mouse.down();
  await page.mouse.up();
  await page.waitForTimeout(600);
  expect(
    await page.evaluate(() => document.getElementById("_rk_coolMode")),
  ).toBeNull();
  expect(
    await page.evaluate(
      () => (window as unknown as { __pwned?: number }).__pwned,
    ),
  ).toBeUndefined();
  expect(await page.locator("[onerror]").count()).toBe(0);
  await expect(header(page)).not.toHaveClass(/is-connected/);
});

// G14 closure (C / W-2): RK-11 — the wallet is on Linea (0xe708) when the owner connects. With the connect-chain
// guard applied in the wallet layer (layer.tsx) the wallet receives ZERO wallet_switchEthereumChain, ZERO
// wallet_addEthereumChain and ZERO signing / sending requests; the header shows the connected account on the
// unsupported network by its id. The call record is written before asserting (OTHERBRIDGE_EVIDENCE_ROOT).
test("RK-11 connecting while the wallet is on Linea 0xe708 asks for no network switch, add, signature or send", async ({
  page,
}) => {
  const foreign: string[] = [];
  await page.context().route("**/*", (route) => {
    const url = route.request().url();
    if (url.startsWith(ORIGIN) || /^(data|blob):/.test(url))
      return route.fallback();
    foreign.push(url);
    return route.abort();
  });
  await page.route("**/api/routing", (route) =>
    route.fulfill({ json: fixtureCatalog() }),
  );
  await page
    .context()
    .addCookies([{ name: "otherbridge.locale", value: "en", url: ORIGIN }]);
  await page.addInitScript(installDoubles, {
    wallets: ["rabby"],
    account: A,
    chainId: "0xe708",
    connect: "accept",
    doubles: WALLET_DOUBLES,
  } as DoubleConfig);
  await page.goto("/app");
  await expect(page.locator("main h1").first()).toBeVisible();
  await header(page).click();
  await expect(modal(page)).toBeVisible();
  await page.locator("[data-testid='rk-wallet-option-io.rabby']").click();
  await expect(header(page)).toHaveClass(/is-connected/);
  await expect(header(page).locator(".wallet-chain")).toContainText("#59144");
  // Give the layer time to do anything it would do after the pick.
  await page.waitForTimeout(1500);
  const methods = (await walletCalls(page)).map((c) => c.method);
  const count = (re: RegExp) => methods.filter((m) => re.test(m)).length;
  const record = {
    at: new Date().toISOString(),
    walletChainAtConnect: "0xe708",
    methods,
    wallet_switchEthereumChain: count(/^wallet_switchEthereumChain$/),
    wallet_addEthereumChain: count(/^wallet_addEthereumChain$/),
    signOrSend: count(/sign|send/i),
    headerText: (await header(page).innerText()).replace(/\s+/g, " "),
    foreignRequests: foreign,
  };
  const root = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
  if (root) {
    mkdirSync(root, { recursive: true });
    writeFileSync(
      `${root}/rk11-record.json`,
      JSON.stringify(record, null, 1) + "\n",
    );
  }
  expect(record.wallet_switchEthereumChain).toBe(0);
  expect(record.wallet_addEthereumChain).toBe(0);
  expect(record.signOrSend).toBe(0);
  expect(foreign).toEqual([]);
  // The unsupported network blocks the financial action: Bridge keeps its send closed and never asks the wallet.
  await page.goto("/bridge");
  await expect(page.locator("main h1").first()).toBeVisible();
  const after = (await walletCalls(page)).map((c) => c.method);
  expect(
    after.filter((m) =>
      /sign|send|switchEthereumChain|addEthereumChain/i.test(m),
    ),
  ).toEqual([]);
});
