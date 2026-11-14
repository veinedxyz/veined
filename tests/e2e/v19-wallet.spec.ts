// V1.9 Privy connect-only wallet layer in the real product (local-test mode). The REAL Privy SDK runs against
// deterministic Privy/WalletConnect doubles (./fixtures) and EIP-6963 wallet doubles (./privy-mock): no App ID,
// no third-party network, no real wallet, no signature, no transaction.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { test, expect, privyModal } from "./fixtures";
import {
  installWalletDoubles,
  mockPrivyBackend,
  WALLET_DOUBLES,
} from "./privy-mock";

const evidence = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/v19"}/screenshots`;
const A = "0x3333333333333333333333333333333333333333";
const B = "0x4444444444444444444444444444444444444444";
const ALLOWED_THIRD_PARTY = new Set([
  "auth.privy.io",
  "explorer-api.walletconnect.com",
  "verify.walletconnect.org",
  "verify.walletconnect.com",
  "pulse.walletconnect.org",
]);
const SIGNING = /sign|sendRaw|eth_sendTransaction/i;

async function setup(
  page: Page,
  options: {
    locale?: string;
    theme?: "dark" | "light";
    wallets?: (keyof typeof WALLET_DOUBLES)[];
    chainId?: string;
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
    ({ locale, theme }) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", theme);
      const csp: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = csp;
      document.addEventListener("securitypolicyviolation", (e) =>
        csp.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    },
    { locale, theme: options.theme ?? "dark" },
  );
  await page.addInitScript(installWalletDoubles, {
    wallets: options.wallets ?? ["metamask", "rabby", "phantom", "coinbase"],
    account: A,
    chainId: options.chainId ?? "0x7a69",
    doubles: WALLET_DOUBLES,
  });
}
const walletCalls = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __walletCalls: { wallet: string; method: string; params: unknown }[];
        }
      ).__walletCalls,
  );
const cspViolations = (page: Page) =>
  page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);
const headerWallet = (page: Page) => page.locator("header .wallet-button");
async function openModal(page: Page, label = "Connect wallet") {
  await page.getByRole("button", { name: label, exact: true }).first().click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
}
async function connect(page: Page, name: string | RegExp, label?: string) {
  await openModal(page, label);
  await privyModal(page).getByRole("button", { name }).first().click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
}
test.beforeAll(async () => mkdir(evidence, { recursive: true }));

test("V19-01 Connect wallet opens the Privy connect-only modal: MetaMask, Rabby, Phantom, Coinbase with their logos", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  await expect(headerWallet(page)).toHaveText("Connect wallet");
  await openModal(page);
  const modal = privyModal(page);
  await expect(modal).toContainText("VEINED never creates or holds a wallet");
  for (const name of [
    "MetaMask",
    "Rabby Wallet",
    "Phantom",
    "Coinbase Wallet",
  ]) {
    const option = modal.getByRole("button", { name }).first();
    await expect(option).toBeVisible();
    // every option carries a real logo (bundled official mark or the wallet's own EIP-6963 image), never a glyph
    await expect(option.locator("img, svg").first()).toBeVisible();
  }
  // connect-only: no email, phone, social or passkey entry, no embedded-wallet creation
  await expect(modal).not.toContainText(
    /email|phone|google|apple|passkey|create a wallet/i,
  );
  await page.screenshot({ path: `${evidence}/v19-modal-desktop-dark.png` });
  expect(await walletCalls(page)).toEqual(
    expect.not.arrayContaining([
      expect.objectContaining({ method: expect.stringMatching(SIGNING) }),
    ]),
  );
});

for (const [name, label] of [
  ["metamask", "MetaMask"],
  ["rabby", "Rabby Wallet"],
  ["phantom", "Phantom"],
  ["coinbase", "Coinbase Wallet"],
] as const) {
  test(`V19-02 ${label}: connect-only (no signature), header shows icon/name/short address/network, disconnect`, async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/bridge");
    await connect(page, new RegExp(`^${label}$`));
    await expect(headerWallet(page)).toContainText("0x3333…3333");
    await expect(headerWallet(page)).toContainText("#31337");
    await expect(headerWallet(page).locator(".wallet-name")).toHaveText(label);
    await expect(headerWallet(page).locator(".wallet-icon")).toBeVisible();
    const calls = await walletCalls(page);
    expect(calls.filter((c) => SIGNING.test(c.method))).toEqual([]);
    expect(
      calls.some(
        (c) => c.wallet === name && c.method === "eth_requestAccounts",
      ),
    ).toBe(true);
    // only the chosen wallet was asked for access
    expect(
      calls
        .filter((c) => c.method === "eth_requestAccounts")
        .map((c) => c.wallet),
    ).toEqual([name]);
    await headerWallet(page).click();
    const dialog = page.getByRole("dialog", { name: "Wallet" });
    await expect(dialog).toContainText(label);
    await expect(dialog).toContainText(A);
    await expect(
      dialog.getByRole("button", { name: "Change wallet" }),
    ).toBeVisible();
    await page.screenshot({ path: `${evidence}/v19-connected-${name}.png` });
    await dialog.getByRole("button", { name: "Disconnect" }).click();
    await expect(headerWallet(page)).toHaveText("Connect wallet");
    expect(
      (await walletCalls(page)).filter((c) => SIGNING.test(c.method)),
    ).toEqual([]);
  });
}

test("V19-03 modal close/reopen keeps the full list and restores focus to the trigger", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  const trigger = headerWallet(page);
  await trigger.focus();
  await page.keyboard.press("Enter");
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await page.keyboard.press("Escape");
  await expect(privyModal(page)).toBeHidden();
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveText("Connect wallet");
  await trigger.click();
  await expect(privyModal(page)).toBeVisible();
  for (const name of ["MetaMask", "Rabby Wallet", "Phantom", "Coinbase Wallet"])
    await expect(
      privyModal(page).getByRole("button", { name }).first(),
    ).toBeVisible();
  await expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
});

test("V19-04 one session for Bridge, Swap, Portfolio and Activity; Change wallet replaces it", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  await connect(page, /^MetaMask$/);
  await expect(page.getByText("100 ONE").first()).toBeVisible();
  await page.getByRole("link", { name: "Swap", exact: true }).click();
  await expect(page).toHaveURL(/\/swap$/);
  await expect(headerWallet(page)).toContainText("0x3333…3333");
  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  // V1.11: "My wallet" scans the connected session (no address field to fill).
  await expect(page.locator('[data-scan-mode="wallet"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".scan-primary.is-wallet code")).toHaveAttribute(
    "title",
    A,
  );
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(headerWallet(page)).toContainText("MetaMask");
  // Change wallet: a new explicit choice replaces the session everywhere
  await headerWallet(page).click();
  await page
    .getByRole("dialog", { name: "Wallet" })
    .getByRole("button", { name: "Change wallet" })
    .click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page)
    .getByRole("button", { name: /^Rabby Wallet$/ })
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
  await expect(headerWallet(page).locator(".wallet-name")).toHaveText(
    "Rabby Wallet",
  );
  await page.getByRole("link", { name: "Portfolio", exact: true }).click();
  // V1.11: "My wallet" scans the connected session (no address field to fill).
  await expect(page.locator('[data-scan-mode="wallet"]')).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(page.locator(".scan-primary.is-wallet code")).toHaveAttribute(
    "title",
    A,
  );
});

test("V19-05 account and chain changes re-bind the session (new identity), never keep the old account", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  await connect(page, /^MetaMask$/);
  await page.evaluate(
    (b) =>
      (
        window as unknown as {
          __wallets: Record<string, { setAccounts: (a: string[]) => void }>;
        }
      ).__wallets.metamask.setAccounts([b]),
    B,
  );
  await expect(headerWallet(page)).toContainText("0x4444…4444");
  await page.evaluate(() =>
    (
      window as unknown as {
        __wallets: Record<string, { setChain: (c: string) => void }>;
      }
    ).__wallets.metamask.setChain("0x38"),
  );
  await expect(headerWallet(page)).toContainText("BSC");
  await expect(
    page.getByRole("button", { name: "Switch to source" }).first(),
  ).toBeVisible();
  // the chain switch is its own user action, through the adapter's trusted registry only
  await page.getByRole("button", { name: "Switch to source" }).first().click();
  await expect(headerWallet(page)).toContainText("#31337");
  const switches = (await walletCalls(page)).filter(
    (c) => c.method === "wallet_switchEthereumChain",
  );
  expect(switches.map((c) => c.params)).toEqual([[{ chainId: "0x7a69" }]]);
  await page.evaluate(() =>
    (
      window as unknown as {
        __wallets: Record<string, { disconnect: () => void }>;
      }
    ).__wallets.metamask.disconnect(),
  );
  await expect(headerWallet(page)).toHaveText("Connect wallet");
});

test("V19-06 disconnect clears the session but keeps local history", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/bridge");
  await connect(page, /^MetaMask$/);
  await page.getByLabel("Amount to send", { exact: true }).fill("1");
  await page.getByRole("button", { name: "Calculate fees" }).click();
  await page.getByRole("button", { name: "Review transfer" }).click();
  await page
    .getByRole("dialog", { name: "Check your transfer" })
    .getByRole("button", { name: "Run local scenario" })
    .click();
  await expect(page).toHaveURL(/\/activity\/[a-z0-9-]+/);
  const ids = () =>
    page.evaluate(() =>
      (
        JSON.parse(localStorage.getItem("otherbridge.history.v1") ?? "[]") as {
          id: string;
          account: string;
        }[]
      ).map((r) => `${r.id}:${r.account}`),
    );
  const before = await ids();
  expect(before).toHaveLength(1);
  expect(before[0]).toContain(A);
  await headerWallet(page).click();
  await page
    .getByRole("dialog", { name: "Wallet" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  await expect(headerWallet(page)).toHaveText("Connect wallet");
  // the record may advance (local tracking) but is never removed by a disconnect
  expect(await ids()).toEqual(before);
  await page.getByRole("link", { name: "Activity", exact: true }).click();
  await expect(page.getByRole("link", { name: /1 ONE → CROSS/ })).toBeVisible();
});

test("V19-07 Privy outage: 'Wallet connection is temporarily unavailable.', no injected fallback, read-only app keeps working", async ({
  page,
}) => {
  test.setTimeout(90000);
  await mockPrivyBackend(page, { outage: true });
  await setup(page);
  await page.goto("/bridge");
  await headerWallet(page).click();
  await expect(page.locator('.notice.error[role="alert"]')).toContainText(
    "Wallet connection is temporarily unavailable.",
    { timeout: 40000 },
  );
  await expect(privyModal(page)).toHaveCount(0);
  const calls = await walletCalls(page);
  expect(calls.filter((c) => c.method === "eth_requestAccounts")).toEqual([]);
  // read-only surfaces still work
  await page.getByRole("link", { name: "Networks", exact: true }).click();
  await expect(page.locator("h1")).toBeVisible();
  await page.screenshot({ path: `${evidence}/v19-privy-unavailable.png` });
});

for (const width of [360, 390]) {
  test(`V19-08 mobile ${width}: modal and connected header fit without horizontal overflow`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await setup(page);
    await page.goto("/bridge");
    await openModal(page);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/v19-modal-mobile-${width}.png`,
    });
    await privyModal(page)
      .getByRole("button", { name: /^MetaMask$/ })
      .click();
    await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
    await expect(headerWallet(page)).toContainText("0x3333…3333");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/v19-connected-mobile-${width}.png`,
      fullPage: true,
    });
  });
}

test("V19-09 light theme: VEINED-themed modal and connected header; axe on the connected page", async ({
  page,
}) => {
  await setup(page, { theme: "light" });
  await page.goto("/bridge");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await openModal(page);
  await page.screenshot({ path: `${evidence}/v19-modal-desktop-light.png` });
  await privyModal(page)
    .getByRole("button", { name: /^Phantom$/ })
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
  await expect(headerWallet(page)).toContainText("Phantom");
  await page.screenshot({
    path: `${evidence}/v19-connected-desktop-light.png`,
    fullPage: true,
  });
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
});

for (const locale of ["ar", "fa", "he", "ur"]) {
  test(`V19-10 RTL ${locale}: connect button, Privy modal and connected header`, async ({
    page,
  }) => {
    await setup(page, { locale });
    await page.goto("/bridge");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const header = headerWallet(page);
    const label = (await header.innerText()).trim();
    expect(label.length).toBeGreaterThan(0);
    await header.click();
    await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: `${evidence}/v19-modal-${locale}.png` });
    await privyModal(page)
      .getByRole("button", { name: /^MetaMask$/ })
      .click();
    await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
    await expect(header).toContainText("0x3333…3333");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `${evidence}/v19-connected-${locale}.png`,
      fullPage: true,
    });
  });
}

test("V19-11 network inventory and CSP: only Privy/WalletConnect origins, no wallet data to Privy, embedded-wallet iframe blocked", async ({
  page,
  privy,
}) => {
  await setup(page);
  await page.goto("/bridge");
  expect(privy.requests).toEqual([]);
  await connect(page, /^MetaMask$/);
  await headerWallet(page).click();
  await page
    .getByRole("dialog", { name: "Wallet" })
    .getByRole("button", { name: "Disconnect" })
    .click();
  const hosts = [...new Set(privy.requests.map((r) => r.host))].sort();
  for (const host of hosts) expect(ALLOWED_THIRD_PARTY.has(host)).toBe(true);
  for (const r of privy.requests) {
    expect(r.url).not.toContain(A.slice(2));
    expect((r.body ?? "").toLowerCase()).not.toContain(A.slice(2));
    expect(r.body ?? "").not.toMatch(/MetaMask|balance|portfolio|amount|31337/);
  }
  const violations = await cspViolations(page);
  expect(
    violations.filter((v) => !v.startsWith("frame-src https://auth.privy.io")),
  ).toEqual([]);
  await writeFile(
    `${evidence}/../v19-network-inventory.json`,
    JSON.stringify(
      { hosts, requests: privy.requests, cspViolations: violations },
      null,
      1,
    ),
  );
});
