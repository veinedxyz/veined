// V1.9 production checks of the Privy wallet layer (next start on 127.0.0.1:3101, local-test mode, no real wallet).
//   no-app-id : the normal build without NEXT_PUBLIC_PRIVY_APP_ID — strict V1.5 CSP, Connect wallet reports
//               "Wallet connection is temporarily unavailable.", zero third-party requests, no injected request.
//   app-id    : a build with the TEST-ONLY App ID — strict nonce CSP with exact Privy/WalletConnect origins; the real
//               SDK (mocked Privy/WalletConnect backend) opens, connects MetaMask without any signature, disconnects;
//               the only CSP violation allowed is the blocked embedded-wallet iframe.
// Usage: node --experimental-transform-types --import ./scripts/ts-hooks.mjs scripts/production-v19.ts <mode> <outDir>
import { chromium } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import assert from "node:assert/strict";
import {
  installWalletDoubles,
  mockPrivyBackend,
  mockWalletConnectRelay,
  WALLET_DOUBLES,
} from "../tests/e2e/privy-mock";

const [mode, out] = process.argv.slice(2);
const WALLETS: (keyof typeof WALLET_DOUBLES)[] = [
  "metamask",
  "rabby",
  "phantom",
  "coinbase",
];
if (mode !== "no-app-id" && mode !== "app-id")
  throw new Error("mode: no-app-id | app-id");
mkdirSync(out, { recursive: true });
const base = "http://127.0.0.1:3101";
const child = spawn(
  process.execPath,
  [
    "scripts/next-pinned.mjs",
    "start",
    "--hostname",
    "127.0.0.1",
    "--port",
    "3101",
  ],
  {
    env: {
      ...process.env,
      OTHERBRIDGE_MODE: "local-test",
      OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION: "false",
    },
  },
);
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const result: Record<string, unknown> = { mode, at: new Date().toISOString() };
try {
  for (let i = 0; i < 160; i++) {
    try {
      if ((await fetch(base)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  // V1.11: the app (and its wallet layer) lives at /bridge; "/" is the public landing.
  const csp =
    (await fetch(`${base}/bridge`)).headers.get("content-security-policy") ??
    "";
  result.csp = csp.replace(/nonce-[A-Za-z0-9+/=]+/g, "nonce-N");
  assert(
    !/unsafe-inline|unsafe-eval|\*/.test(csp),
    "production CSP must stay strict",
  );
  assert(csp.includes("style-src-attr 'none'"));
  if (mode === "no-app-id") {
    assert(/connect-src 'self';/.test(csp) && csp.includes("frame-src 'none'"));
    assert(!/privy|walletconnect/.test(csp));
  } else {
    assert(
      csp.includes("https://auth.privy.io") &&
        !/frame-src[^;]*auth\.privy\.io/.test(csp),
    );
  }
  const browser = await chromium.launch();
  for (const theme of ["dark", "light"] as const) {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    await context.addCookies([
      { name: "otherbridge.locale", value: "en", url: base },
    ]);
    const privy = await mockPrivyBackend(context);
    await mockWalletConnectRelay(context);
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));
    await page.addInitScript((t) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.theme", t);
      const v: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = v;
      document.addEventListener("securitypolicyviolation", (e) =>
        v.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
    }, theme);
    await page.addInitScript(installWalletDoubles, {
      wallets: WALLETS,
      account: "0x3333333333333333333333333333333333333333",
      chainId: "0x7a69",
      doubles: WALLET_DOUBLES,
    });
    // The landing page never loads the wallet layer (no Privy/WalletConnect request).
    await page.goto(`${base}/`, { waitUntil: "networkidle" });
    assert.equal(privy.requests.length, 0, "no third-party request on landing");
    await page.goto(`${base}/bridge`, { waitUntil: "networkidle" });
    assert.equal(
      privy.requests.length,
      0,
      "no third-party request before Connect wallet",
    );
    const header = page.locator("header .wallet-button");
    await header.click();
    const entry: Record<string, unknown> = {};
    if (mode === "no-app-id") {
      await page
        .locator('.notice.error[role="alert"]')
        .filter({ hasText: "Wallet connection is temporarily unavailable." })
        .waitFor({ timeout: 15000 });
      await page.waitForTimeout(1500);
      assert.equal(await page.locator("#privy-modal-content").count(), 0);
      await page.screenshot({
        path: `${out}/no-app-id-unavailable-${theme}.png`,
      });
    } else {
      const modal = page.locator("#privy-modal-content");
      await modal.waitFor({ state: "visible", timeout: 30000 });
      await page.waitForTimeout(800);
      await page.screenshot({ path: `${out}/app-id-modal-${theme}.png` });
      await modal.getByRole("button", { name: /^MetaMask$/ }).click();
      await modal.waitFor({ state: "hidden", timeout: 30000 });
      entry.connectedHeader = (await header.innerText()).replace(/\s+/g, " ");
      assert.match(String(entry.connectedHeader), /MetaMask.*0x3333…3333/);
      await page.screenshot({ path: `${out}/app-id-connected-${theme}.png` });
      await header.click();
      await page
        .getByRole("dialog", { name: "Wallet" })
        .getByRole("button", { name: "Disconnect" })
        .click();
      assert.equal((await header.innerText()).trim(), "Connect wallet");
    }
    const calls = await page.evaluate(() =>
      (
        window as unknown as {
          __walletCalls: { method: string; wallet: string }[];
        }
      ).__walletCalls.map((c) => `${c.wallet}:${c.method}`),
    );
    const violations = await page.evaluate(
      () => (window as unknown as { __csp: string[] }).__csp,
    );
    entry.walletCalls = calls;
    entry.thirdParty = privy.requests.map((r) => `${r.method} ${r.url}`);
    entry.cspViolations = violations;
    entry.pageErrors = errors;
    assert(
      !calls.some((c) => /sign|sendTransaction|sendRaw/i.test(c)),
      "no signing or send request",
    );
    if (mode === "no-app-id") {
      assert.equal(
        privy.requests.length,
        0,
        "missing App ID never contacts Privy/WalletConnect",
      );
      assert(
        !calls.some((c) => c.endsWith("eth_requestAccounts")),
        "no injected fallback",
      );
      assert.deepEqual(violations, []);
    } else {
      assert.deepEqual(
        violations.filter(
          (v) => !v.startsWith("frame-src https://auth.privy.io"),
        ),
        [],
      );
    }
    assert.deepEqual(errors, []);
    result[theme] = entry;
    await context.close();
  }
  await browser.close();
  result.pass = true;
} catch (e) {
  result.pass = false;
  result.error = String((e as Error).stack ?? e).slice(0, 2000);
  process.exitCode = 1;
} finally {
  child.kill();
  writeFileSync(`${out}/server.log`, log);
  writeFileSync(`${out}/result.json`, JSON.stringify(result, null, 1));
  console.log(
    JSON.stringify({ mode, pass: result.pass, error: result.error }, null, 1),
  );
}
