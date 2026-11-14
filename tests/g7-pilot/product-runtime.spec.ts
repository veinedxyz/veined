// In-product G7 pilot RUNTIME regressions (fixture pilot data, production runtime, recording mock wallet, no send):
// every product route renders in pilot mode without dev tooling, workers, console/CSP errors; the launcher explains
// a busy port and never touches its owner; a repeated start is refused while the first keeps serving; the stop
// command, a dead launch wrapper and session expiry all end the launcher cleanly; a restart with a stale page and
// Privy session keeps the product working.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test, privyModal } from "../e2e/fixtures";
import { newStateDir, runToExit, startHarness, type Harness } from "./harness";
import { installMockWallet, type MockWalletConfig } from "./mock-wallet";
import { osSnapshot } from "../../scripts/g7-pilot/os-probe";
import { probeIdentity } from "../../scripts/g7-pilot/supervisor";

const EOA = "0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c";
const OLD_EOA = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const LAUNCHER = "scripts/g7-product-pilot.ts";
const STOP = "scripts/g7-pilot-stop.ts";
const SHOTS =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results/g7-product-pilot";
const SIGNING =
  /eth_sign|personal_sign|signTypedData|eth_sendRawTransaction|eth_sendTransaction/;
const ROUTES = [
  ["/swap", "swap"],
  ["/portfolio", "portfolio"],
  ["/activity", "activity"],
  ["/networks", "networks"],
  ["/help", "help"],
  ["/bridge", "bridge"],
] as const;

const running: Harness[] = [];
test.afterEach(async () => {
  for (const h of running.splice(0)) {
    h.stop();
    await h.stopped;
  }
});
async function pilot(args: string[] = [], options = {}) {
  const h = await startHarness(
    ["--fixture", "ready", ...args],
    LAUNCHER,
    180000,
    options,
  );
  running.push(h);
  return h;
}
const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as { code?: string }).code === "EPERM";
  }
};
async function until(check: () => boolean | Promise<boolean>, ms: number) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
const journal = (h: Harness) =>
  readFileSync(join(h.stateDir, "session-journal.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
const parse = (output: string[], tag: string) => {
  const line = output.find((l) => l.startsWith(`${tag} `));
  return line ? JSON.parse(line.slice(tag.length + 1)) : null;
};

// The Privy SDK tries to frame its embedded-wallet iframe, which the CSP refuses on purpose (V1.9 boundary).
const EMBEDDED_IFRAME_REFUSED = /^Framing 'https:\/\/auth\.privy\.io\/'/;
async function watch(page: Page, wallet: Partial<MockWalletConfig> = {}) {
  const problems: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error" && !EMBEDDED_IFRAME_REFUSED.test(m.text()))
      problems.push(`console: ${m.text()}`);
  });
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  const requests: string[] = [];
  page.on("request", (r) => requests.push(r.url()));
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      (window as unknown as { __csp: string[] }).__csp.push(
        `${e.violatedDirective} ${e.blockedURI}`,
      ),
    );
  });
  await page.addInitScript(installMockWallet, {
    accounts: [EOA],
    chainId: "0x956d7",
    send: "hash",
    ...wallet,
  } satisfies MockWalletConfig);
  return { problems, requests };
}
const card = (page: Page) => page.locator(".bridge-card");
async function connect(page: Page) {
  await card(page).getByRole("button", { name: "Connect wallet" }).click();
  await expect(privyModal(page)).toBeVisible({ timeout: 30000 });
  await privyModal(page)
    .getByRole("button", { name: /G7 Mock Wallet/ })
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 30000 });
  await expect(card(page).locator(".recipient")).toContainText(
    /0x[0-9a-fA-F]{40}/,
  );
}
async function noSigningNoCsp(page: Page) {
  const calls = await page.evaluate(
    () =>
      (window as unknown as { __g7Mock: { calls: { method: string }[] } })
        .__g7Mock.calls,
  );
  expect(calls.filter((c) => SIGNING.test(c.method))).toEqual([]);
  // The only accepted report is the intentionally refused Privy embedded-wallet iframe (V1.9 boundary).
  expect(
    (
      await page.evaluate(
        () => (window as unknown as { __csp: string[] }).__csp,
      )
    ).filter((v) => !v.startsWith("frame-src https://auth.privy.io")),
  ).toEqual([]);
}
async function noDevTooling(page: Page, requests: string[]) {
  // Production runtime: no Next dev overlay/indicator, no HMR, no dev-only endpoints.
  expect(
    await page.evaluate(
      () =>
        document.querySelectorAll(
          "nextjs-portal, [data-nextjs-toast], [data-nextjs-dialog-overlay], #__next-build-watcher, [data-next-badge-root]",
        ).length,
    ),
  ).toBe(0);
  expect(
    requests.filter((u) =>
      /webpack-hmr|__nextjs_original-stack-frame|_next\/static\/development|__nextjs_launch-editor/.test(
        u,
      ),
    ),
  ).toEqual([]);
}

test("production runtime: every product route renders in pilot mode with one wallet session; back/forward; no dev overlay, worker, console or CSP error", async ({
  page,
}) => {
  test.setTimeout(240000);
  const h = await pilot();
  const runtime = h.startup.runtime as Record<string, unknown>;
  expect(runtime.mode).toBe("next-production");
  expect(runtime.devServer).toBe(false);
  expect(runtime.distDir).toBe(".next-g7-pilot-test");
  const { problems, requests } = await watch(page);
  const t0 = Date.now();
  await page.goto(h.url);
  await expect(card(page)).toContainText(
    "CONTROLLED PILOT · LOCAL ONLY · 5 ONE AUTHORIZED",
    { timeout: 60000 },
  );
  const firstBridgeMs = Date.now() - t0;
  await connect(page);
  const chip = page.locator("header .wallet-button .wallet-address");
  await expect(chip).toBeVisible();
  const address = await chip.textContent();
  const timings: Record<string, number> = { firstBridgeMs };
  for (const [href, name] of ROUTES) {
    const at = Date.now();
    await page.locator(`nav.main-nav a[href="${href}"]`).click();
    await expect(page).toHaveURL(
      new RegExp(`${href === "/bridge" ? "/bridge(#.*)?" : href}$`),
    );
    if (href === "/bridge")
      await expect(card(page)).toContainText("CONTROLLED PILOT");
    else await expect(page.locator("main h1")).toBeVisible();
    timings[`${name}Ms`] = Date.now() - at;
    await expect(chip).toHaveText(address!);
  }
  // Back to Bridge: still the pilot, still authorized, still one session.
  await expect(
    card(page).getByRole("button", { name: /Review transfer/ }),
  ).toBeEnabled({ timeout: 30000 });
  // Browser history across the pilot session.
  await page.goBack();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.locator("main h1")).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/\/networks$/);
  await expect(page.locator("main h1")).toBeVisible();
  await page.goForward();
  await page.goForward();
  await expect(card(page)).toContainText("CONTROLLED PILOT");
  await expect(chip).toHaveText(address!);
  await noDevTooling(page, requests);
  await noSigningNoCsp(page);
  expect(problems).toEqual([]);
  // Browser-independent server facts: one process, no workers/child processes, bounded memory.
  const children = [...(await osSnapshot(null)).processes.values()].filter(
    (p) => p.ppid === h.pid,
  );
  expect(children.map((c) => c.name)).toEqual([]);
  const id = await probeIdentity(Number(new URL(h.origin).port));
  expect(id?.runtime).toBe("next-production");
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(
    `${SHOTS}/product-runtime-routes.json`,
    JSON.stringify(
      {
        timings,
        rssBytes: id?.rssBytes,
        peakRssBytes: id?.peakRssBytes,
        children: children.length,
      },
      null,
      1,
    ),
  );
  await page.screenshot({
    path: `${SHOTS}/product-runtime-bridge-after-routes.png`,
    fullPage: true,
  });
});

test("busy port: a foreign listener is explained and never touched; a repeated start is refused while the first keeps serving; the stop command stops it gracefully", async () => {
  test.setTimeout(240000);
  // 1. Another application holds the port (here: this test process).
  const foreign: Server = createServer((_q, r) => r.end("foreign"));
  await new Promise<void>((r) => foreign.listen(0, "127.0.0.1", r));
  const foreignPort = (foreign.address() as { port: number }).port;
  const stateDir = newStateDir();
  const refused = await runToExit(LAUNCHER, [
    "--fixture",
    "ready",
    "--state-dir",
    stateDir,
    "--port",
    String(foreignPort),
  ]);
  expect(refused.code).toBe(3);
  const owner = parse(refused.output, "G7PILOT_STOPPED");
  expect(owner.status).toBe("PORT_HELD_BY_OTHER_PROCESS");
  expect(owner.pid).toBe(process.pid);
  expect(refused.output.join("\n")).toContain("never stopped by Otherbridge");
  // No session or evidence was created for the refused start; the foreign listener still answers.
  expect(existsSync(join(stateDir, "session-journal.jsonl"))).toBe(false);
  expect(await (await fetch(`http://127.0.0.1:${foreignPort}/`)).text()).toBe(
    "foreign",
  );
  await new Promise<void>((r) => foreign.close(() => r()));
  // 2. Our own pilot runs; a second start on the same port is refused and the first keeps serving.
  const port = await freePort();
  const first = await pilot([], { stateDir, port });
  const again = await runToExit(LAUNCHER, [
    "--fixture",
    "ready",
    "--state-dir",
    stateDir,
    "--port",
    String(port),
  ]);
  expect(again.code).toBe(3);
  const second = parse(again.output, "G7PILOT_STOPPED");
  expect(second.status).toBe("OTHERBRIDGE_PILOT_RUNNING");
  expect(second.identity.pid).toBe(first.pid);
  expect(JSON.stringify(second)).not.toContain("controlToken");
  expect((await probeIdentity(port))?.state).toBe("READY");
  // 3. The stop command proves the instance and stops it gracefully; a second stop finds nothing.
  const stop = await runToExit(STOP, [
    "--port",
    String(port),
    "--state-dir",
    stateDir,
  ]);
  expect(stop.code).toBe(0);
  expect(parse(stop.output, "G7PILOT_STOP").status).toBe("STOPPED_GRACEFULLY");
  expect(await first.stopped).toBe(0);
  expect(existsSync(join(stateDir, `g7-pilot-runtime-${port}.json`))).toBe(
    false,
  );
  expect(journal(first).at(-1)).toMatchObject({
    event: "SHUTDOWN",
    reason: "STOP_COMMAND",
  });
  const none = await runToExit(STOP, [
    "--port",
    String(port),
    "--state-dir",
    stateDir,
  ]);
  expect(parse(none.output, "G7PILOT_STOP").status).toBe("NOT_RUNNING");
});

test("orphan guard: when the launch wrapper dies, the launcher shuts itself down and frees the port", async () => {
  test.setTimeout(240000);
  const port = await freePort();
  const h = await pilot([], { port, wrapped: true });
  const record = JSON.parse(
    readFileSync(join(h.stateDir, `g7-pilot-runtime-${port}.json`), "utf8"),
  );
  expect(record.pid).toBe(h.pid);
  const wrapper = record.watchedAncestors[0].pid as number;
  expect(wrapper).not.toBe(h.pid);
  process.kill(wrapper);
  expect(await until(() => !alive(h.pid), 20000)).toBe(true);
  expect(await probeIdentity(port, 800)).toBeNull();
  expect(existsSync(join(h.stateDir, `g7-pilot-runtime-${port}.json`))).toBe(
    false,
  );
  expect(journal(h).at(-1)).toMatchObject({ event: "SHUTDOWN" });
  expect(journal(h).map((e) => e.event)).toContain("LAUNCH_WRAPPER_EXITED");
  // The port is immediately reusable by a fresh launcher.
  const again = await pilot([], { port });
  expect((await probeIdentity(port))?.pid).toBe(again.pid);
});

test("session expiry: an idle expired session becomes EXPIRED and the launcher stops after the grace period", async () => {
  test.setTimeout(120000);
  const h = await pilot(["--ttl-ms", "6000", "--expiry-grace-ms", "2000"]);
  expect(await h.stopped).toBe(0);
  const events = journal(h);
  expect(events.map((e) => e.event)).toContain("EXPIRED");
  expect(events.at(-1)).toMatchObject({
    event: "SHUTDOWN",
    reason: "SESSION_EXPIRED",
    state: "EXPIRED",
  });
});

test("restart: a stale page and Privy session keep the product working; account change, disconnect and reconnect re-bind the pilot", async ({
  page,
}) => {
  test.setTimeout(240000);
  const port = await freePort();
  const { problems } = await watch(page);
  const a = await pilot([], { port });
  await page.goto(a.url);
  await expect(card(page)).toContainText("CONTROLLED PILOT", {
    timeout: 60000,
  });
  await connect(page);
  await page.locator('nav.main-nav a[href="/swap"]').click();
  await expect(page.locator("main h1")).toBeVisible();
  // The server goes away under the open page, then a fresh session starts on the same origin.
  a.stop();
  await a.stopped;
  running.splice(running.indexOf(a), 1);
  const b = await pilot([], { port });
  expect(b.startup.session).not.toBe(a.startup.session);
  // While no server ran, the open page could not load anything (connection errors, a lazy chunk, Next's
  // built-in error screen): recorded as evidence. From the fresh session on, nothing may fail.
  const whileDown = problems.splice(0);
  mkdirSync(SHOTS, { recursive: true });
  writeFileSync(
    `${SHOTS}/product-runtime-restart-while-down.json`,
    JSON.stringify(whileDown, null, 1),
  );
  await page.goto(b.url);
  await expect(card(page)).toContainText("CONTROLLED PILOT", {
    timeout: 60000,
  });
  // The previously connected wallet is either restored by Privy or offered again; both keep the pilot usable.
  const connectButton = card(page).getByRole("button", {
    name: "Connect wallet",
  });
  if (await connectButton.isVisible()) await connect(page);
  const review = card(page).getByRole("button", { name: /Review transfer/ });
  // Not authorized = no enabled Review button (the card may disable or replace it).
  const enabledReview = card(page).getByRole("button", {
    name: /Review transfer/,
    disabled: false,
  });
  await expect(review).toBeEnabled({ timeout: 30000 });
  await expect(page.getByText(/Local pilot session refused/)).toHaveCount(0);
  // Account change to the superseded EOA: not authorized; back to the pilot EOA: authorized again.
  await page.evaluate(
    (a) =>
      (
        window as unknown as { __g7Mock: { setAccounts(a: string[]): void } }
      ).__g7Mock.setAccounts([a]),
    OLD_EOA,
  );
  await expect(card(page)).toContainText(
    "This wallet is not authorized for the G7 pilot.",
    { timeout: 30000 },
  );
  await expect(enabledReview).toHaveCount(0);
  await page.evaluate(
    (a) =>
      (
        window as unknown as { __g7Mock: { setAccounts(a: string[]): void } }
      ).__g7Mock.setAccounts([a]),
    EOA,
  );
  await expect(review).toBeEnabled({ timeout: 30000 });
  // Disconnect and reconnect through the normal wallet dialog.
  await page.locator("header .wallet-button").click();
  const dialog = page.getByRole("dialog", { name: "Wallet" });
  await dialog.getByRole("button", { name: "Disconnect" }).click();
  await expect(page.locator("header .wallet-button")).toHaveText(
    "Connect wallet",
  );
  await expect(enabledReview).toHaveCount(0);
  await connect(page);
  await expect(review).toBeEnabled({ timeout: 30000 });
  await noSigningNoCsp(page);
  expect(problems).toEqual([]);
});
