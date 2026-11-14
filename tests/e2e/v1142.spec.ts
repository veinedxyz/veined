// V1.14.2 progressive wallet scan in the browser: shell → first asset → first page → background coverage → final
// round, account switch / disconnect isolation, DeFi start gate, accessibility and RTL. The wallet API answers through
// a fetch-level NDJSON double whose lines are released by the test (so every progressive state is observable);
// wallet data is a SYNTHETIC FIXTURE and no wallet session signs or sends anything.
import type { Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { mkdirSync, writeFileSync } from "node:fs";
import { test, expect, privyModal } from "./fixtures";
import { installWalletDoubles, WALLET_DOUBLES } from "./privy-mock";
import { fixtureCatalog, sender } from "../fixtures/routing";
import { coverage, holding } from "../fixtures/portfolio";
import { normalizeActive } from "../../src/catalog/model";
import { summarize } from "../../src/data/core/coverage";
import type { ChainCoverage, Holding } from "../../src/portfolio/model";
const root =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "evidence/otherbridge-v1-14-2/adhoc";
const OTHER = "0x4444444444444444444444444444444444444444";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const SIGNING =
  /eth_sendTransaction|eth_sendRawTransaction|personal_sign|eth_sign|signTypedData|wallet_sendCalls|wallet_grantPermissions/;
type Step = { gate?: string; delayMs?: number; line: unknown };
const LARGE = "0x5555555555555555555555555555555555555555";
const usdc = (balance: string, usd: number): Holding =>
  holding("1", balance, usd, {
    address: USDC,
    symbol: "USDC",
    name: "USD Coin",
    decimals: 6,
    native: false,
    routable: true,
    metadataVerified: true,
    discovery: "curated",
  });
// One synthetic progressive round: priority networks 1 / 8453 / 42161 (waves 0-2), background 56 / 137 / 10, and a
// catalog-only network. `tag` makes the balances of one identity distinguishable from another's.
function round(tag: "A" | "B"): Step[] {
  const a = tag === "A";
  const plan = {
    type: "plan",
    v: 1,
    continued: false,
    chains: [
      { chainId: "1", wave: 0, reasons: ["CURRENT_CHAIN", "GENERAL_PRIORITY"] },
      {
        chainId: "8453",
        wave: 2,
        reasons: ["HIGH_CONFIDENCE_PORTFOLIO_CHAIN", "GENERAL_PRIORITY"],
      },
      {
        chainId: "42161",
        wave: 2,
        reasons: ["HIGH_CONFIDENCE_PORTFOLIO_CHAIN", "GENERAL_PRIORITY"],
      },
      { chainId: "56", wave: 3, reasons: ["GENERAL_PRIORITY"] },
      { chainId: "137", wave: 3, reasons: ["GENERAL_PRIORITY"] },
      { chainId: "10", wave: 4, reasons: ["LONG_TAIL"] },
    ],
    coverage: [coverage("4663", "CATALOG_ONLY", { reason: "NO_VETTED_RPC" })],
    firstPage: { chains: 3, deadlineMs: 5000, chainBudgetMs: 2000 },
    defiChains: ["1", "8453", "42161"],
  };
  const eth = holding(
    "1",
    a ? "2000000000000000000" : "100000000000000000",
    a ? 5600 : 280,
  );
  const chain = (id: string, holdings: Holding[], c: ChainCoverage) => ({
    type: "chain",
    chainId: id,
    wave: plan.chains.find((x) => x.chainId === id)!.wave,
    holdings,
    coverage: c,
  });
  const c1 = coverage("1", "PARTIAL", {
    tier: "CURATED_BALANCE_SCAN",
    tokens: "CURATED",
    observedBlock: "100",
    headBlock: "100",
  });
  const c8453 = coverage("8453", "NATIVE_ONLY");
  const c42161 = coverage("42161", "NATIVE_ONLY");
  const c56 = coverage("56", "NATIVE_ONLY");
  const c137 = coverage("137", "FAILED");
  const c10 = coverage("10", "NATIVE_ONLY");
  const base8453 = holding("8453", "500000000000000000", 1400);
  const bsc = holding("56", "300000000000000000", a ? 180 : 18);
  const rows1 = a ? [eth, usdc("1500000000", 1500)] : [eth];
  const final = [c1, c8453, c42161, c56, c137, c10, plan.coverage[0]];
  const holdings = [...rows1, ...(a ? [base8453] : []), bsc];
  return [
    { line: plan },
    { gate: "native", line: { type: "native", chainId: "1", holding: eth } },
    { gate: "page", line: chain("1", rows1, c1) },
    { line: chain("8453", a ? [base8453] : [], c8453) },
    { line: chain("42161", [], c42161) },
    {
      line: {
        type: "firstPage",
        reason: "WAVES_SETTLED",
        elapsedMs: 900,
        included: ["1", "8453", "42161"],
        outstanding: [],
      },
    },
    {
      line: {
        type: "defiReady",
        reason: "DEFI_CHAINS_SETTLED",
        elapsedMs: 900,
      },
    },
    { gate: "background", line: chain("56", [bsc], c56) },
    { line: chain("137", [], { ...c137, observedAt: Date.now() }) },
    { line: chain("10", [], c10) },
    {
      gate: "final",
      line: {
        type: "result",
        result: {
          state: "PARTIAL",
          holdings,
          coverage: final,
          coverageSummary: summarize(final),
          continuation: null,
          dataPlane: "AVAILABLE",
          source: "otherbridge-data-plane",
          observedAt: Date.now(),
          revision: `synthetic-v1142-${tag}`,
          synthetic: true,
        },
      },
    },
  ];
}
// A realistic round: 150 planned networks answering one by one over ~2.3 s (the fixture's natural cadence), native
// balances on twenty of them. Measures render coalescing (flushes), long tasks and the final reconciliation.
function largeRound(): Step[] {
  const catalog = fixtureCatalog()
    .networks.filter((n) => n.mainnet && n.ecosystem === "EVM")
    .map((n) => n.id);
  const ids = [
    ...catalog,
    ...Array.from({ length: 150 - catalog.length }, (_, i) =>
      String(910000 + i),
    ),
  ];
  const funded = new Set(catalog.slice(0, 20));
  const usd = (i: number) => 100 + i * 10;
  const plan = {
    type: "plan",
    v: 1,
    continued: false,
    chains: ids.map((chainId, i) => ({
      chainId,
      wave: i < 30 ? 2 : i < 62 ? 3 : 4,
      reasons: [i < 62 ? "GENERAL_PRIORITY" : "LONG_TAIL"],
    })),
    coverage: [],
    firstPage: { chains: 30, deadlineMs: 5000, chainBudgetMs: 2000 },
    defiChains: [],
  };
  const holdings: Holding[] = [];
  const cov: ChainCoverage[] = [];
  const steps: Step[] = [{ line: plan }];
  ids.forEach((id, i) => {
    const h = funded.has(id)
      ? [holding(id, "1000000000000000000", usd(i))]
      : [];
    const c = coverage(id, "NATIVE_ONLY");
    holdings.push(...h);
    cov.push(c);
    if (h.length && i < 30)
      steps.push({
        delayMs: 5,
        line: { type: "native", chainId: id, holding: h[0] },
      });
    steps.push({
      delayMs: 15,
      line: {
        type: "chain",
        chainId: id,
        wave: plan.chains[i].wave,
        holdings: h,
        coverage: c,
      },
    });
    if (i === 29)
      steps.push({
        line: {
          type: "firstPage",
          reason: "WAVES_SETTLED",
          elapsedMs: 450,
          included: ids.slice(0, 30),
          outstanding: [],
        },
      });
  });
  steps.push({
    line: {
      type: "result",
      result: {
        state: "PARTIAL",
        holdings,
        coverage: cov,
        coverageSummary: summarize(cov),
        continuation: null,
        dataPlane: "AVAILABLE",
        source: "otherbridge-data-plane",
        observedAt: Date.now(),
        revision: "synthetic-v1142-large",
        synthetic: true,
      },
    },
  });
  return steps;
}
async function setup(
  page: Page,
  options: { locale?: string; wallet?: boolean } = {},
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
    ({ locale, scripts }) => {
      if (window !== window.top) return;
      localStorage.setItem("otherbridge.language", locale);
      localStorage.setItem("otherbridge.theme", "dark");
      const csp: string[] = [];
      (window as unknown as { __csp: string[] }).__csp = csp;
      document.addEventListener("securitypolicyviolation", (e) =>
        csp.push(`${e.violatedDirective} ${e.blockedURI}`),
      );
      // Fetch-level NDJSON double for the wallet scan route only (DeFi and everything else use the network mocks).
      const opened = new Set<string>();
      const waiters = new Map<string, (() => void)[]>();
      const state = {
        requests: [] as unknown[],
        delivered: [] as string[],
        open(gate: string) {
          opened.add(gate);
          for (const w of waiters.get(gate) ?? []) w();
          waiters.delete(gate);
        },
      };
      (window as unknown as { __ws: typeof state }).__ws = state;
      // Render census: long main-thread tasks while a progressive scan streams.
      const longTasks: number[] = [];
      (window as unknown as { __longTasks: number[] }).__longTasks = longTasks;
      try {
        new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            longTasks.push(Math.round(e.duration));
        }).observe({ type: "longtask", buffered: true });
      } catch {
        /* unsupported */
      }
      const original = window.fetch.bind(window);
      window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        if (!/\/api\/portfolio$/.test(new URL(url, location.href).pathname))
          return original(input, init);
        const body = JSON.parse(String(init?.body ?? "{}"));
        state.requests.push(body);
        const wallet = String(body.identity?.evm ?? "").toLowerCase();
        const steps = scripts[wallet] ?? [];
        const encoder = new TextEncoder();
        let controller!: ReadableStreamDefaultController<Uint8Array>;
        let aborted = false;
        const stream = new ReadableStream<Uint8Array>({
          start: (c) => void (controller = c),
        });
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          try {
            controller.error(new DOMException("Aborted", "AbortError"));
          } catch {
            /* closed */
          }
        });
        void (async () => {
          for (const step of steps) {
            if (step.gate && !opened.has(step.gate))
              await new Promise<void>((r) =>
                waiters.set(step.gate!, [
                  ...(waiters.get(step.gate!) ?? []),
                  r,
                ]),
              );
            if (step.delayMs)
              await new Promise((r) => setTimeout(r, step.delayMs));
            if (aborted) return;
            state.delivered.push(
              `${wallet}:${(step.line as { type: string }).type}`,
            );
            controller.enqueue(
              encoder.encode(JSON.stringify(step.line) + "\n"),
            );
          }
          if (!aborted) controller.close();
        })();
        return new Response(stream, {
          status: 200,
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      };
    },
    {
      locale,
      scripts: {
        [sender]: round("A"),
        [OTHER]: round("B"),
        [LARGE]: largeRound(),
      } as Record<string, Step[]>,
    },
  );
  if (options.wallet)
    await page.addInitScript(installWalletDoubles, {
      wallets: ["metamask"] as (keyof typeof WALLET_DOUBLES)[],
      account: sender,
      chainId: "0x1",
      doubles: WALLET_DOUBLES,
    });
  const catalog = fixtureCatalog();
  await page.route("**/api/routing", (r) => r.fulfill({ json: catalog }));
  await page.route("**/api/catalog", (r) =>
    r.fulfill({
      json: normalizeActive(
        catalog.networks
          .filter((n) => n.mainnet)
          .map((n, i) => ({ name: n.name, chainId: n.id, tvl: 1e9 / (i + 1) })),
        catalog,
        Date.now(),
        "SYNTHETIC_TEST_ONLY",
      ),
    }),
  );
  await page.route("**/api/assets", (r) => r.fulfill({ json: { assets: [] } }));
  const defi: { wallet: string; held?: string[] }[] = [];
  await page.route("**/api/portfolio/defi", (r) => {
    defi.push(r.request().postDataJSON());
    return r.fulfill({ status: 503, json: { error: "SYNTHETIC_NOT_CHECKED" } });
  });
  const writes: string[] = [];
  page.on("request", (r) => {
    if (SIGNING.test(r.postData() ?? "")) writes.push(r.url());
  });
  return { defi, writes };
}
const ws = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __ws: {
            requests: {
              identity: { evm: string };
              priority?: string[];
              hints?: unknown;
            }[];
            delivered: string[];
          };
        }
      ).__ws,
  );
const open = (page: Page, gate: string) =>
  page.evaluate(
    (g) =>
      (window as unknown as { __ws: { open(g: string): void } }).__ws.open(g),
    gate,
  );
const measures = (page: Page) =>
  page.evaluate(() =>
    Object.fromEntries(
      performance
        .getEntriesByType("measure")
        .filter((m) => m.name.startsWith("otherbridge:"))
        .map((m) => [m.name.slice(12), Math.round(m.duration)]),
    ),
  );
async function shot(page: Page, name: string) {
  mkdirSync(root + "/screenshots", { recursive: true });
  await page.screenshot({
    path: `${root}/screenshots/${name}.png`,
    fullPage: true,
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
async function axe(page: Page) {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
}
test("V1142 watch address: shell, first asset, first page, background coverage and the final round", async ({
  page,
}) => {
  const env = await setup(page);
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  // Shell: the plan renders at once — every planned network PENDING, never empty; the phase names the first page.
  const progress = page.getByTestId("scan-progress");
  await expect(progress).toContainText("Scanning 3 priority networks…");
  const summary = page.getByTestId("portfolio-summary");
  await expect(summary).toBeVisible();
  await expect(page.getByTestId("scan-progress-counts")).toContainText(
    "0 assets found · 0/6 networks checked",
  );
  await expect(page.locator('[data-chain="1"]')).toHaveCount(0);
  await shot(page, "v1142-shell-1440");
  // First meaningful asset: the native fast path, before the network's token reads finish.
  await open(page, "native");
  await expect(page.locator('[data-chain="1"]')).toBeVisible();
  await expect(summary.locator(".summary-value")).toHaveText("$5,600.00");
  // No DeFi request before the DeFi start trigger.
  expect(env.defi).toHaveLength(0);
  await axe(page);
  // First page: the priority networks settle; the phase moves to the background and DeFi starts with exact held ids.
  await open(page, "page");
  await expect(progress).toContainText("Scanning remaining networks…");
  await expect(page.getByTestId("scan-progress-counts")).toContainText(
    "3 assets found · 3/6 networks checked",
  );
  await expect(summary.locator(".summary-value")).toHaveText("$8,500.00");
  await expect.poll(() => env.defi.length).toBe(1);
  expect(env.defi[0].wallet.toLowerCase()).toBe(sender);
  expect(env.defi[0].held).toEqual([`1:${USDC}`]);
  await expect(page.getByTestId("coverage-sentence")).toHaveAttribute(
    "aria-live",
    "off",
  );
  await shot(page, "v1142-first-page-1440");
  await axe(page);
  // Background coverage: a failed network is FAILED, never zero; pending networks are never listed as empty.
  await open(page, "background");
  await expect(page.locator('[data-chain="56"]')).toBeVisible();
  await expect(page.getByTestId("scan-progress-counts")).toContainText(
    "4 assets found · 5/6 networks checked",
  );
  // Final round replaces every provisional line (no double count): same totals, phase gone, coverage announced.
  await open(page, "final");
  await expect(progress).toHaveCount(0);
  await expect(summary.locator(".summary-value")).toHaveText("$8,680.00");
  await expect(page.getByTestId("coverage-sentence")).toHaveAttribute(
    "aria-live",
    "polite",
  );
  await expect(page.getByTestId("coverage-sentence")).toContainText(
    "VEINED checked 5 networks.",
  );
  await expect(page.getByTestId("still-checking")).toHaveCount(0);
  const m = await measures(page);
  for (const k of [
    "walletShellReadyMs",
    "firstMeaningfulAssetMs",
    "firstPageCompleteMs",
    "fullWalletCoverageMs",
    "walletFirstResultMs",
  ])
    expect(m[k], k).toBeGreaterThanOrEqual(0);
  expect(m.walletShellReadyMs).toBeLessThanOrEqual(m.firstMeaningfulAssetMs);
  expect(m.firstMeaningfulAssetMs).toBeLessThanOrEqual(m.firstPageCompleteMs);
  expect(m.firstPageCompleteMs).toBeLessThanOrEqual(m.fullWalletCoverageMs);
  // Render census: progressive renders are coalesced (at most one per streamed line, milestones included).
  const flushes = await page.evaluate(
    () => performance.getEntriesByName("otherbridge:walletFlush").length,
  );
  expect(flushes).toBeGreaterThan(0);
  expect(flushes).toBeLessThanOrEqual(10);
  // Watch mode sends no connected-chain priority and no previous-scan hints on the first scan.
  const sent = (await ws(page)).requests[0];
  expect(sent.priority).toBeUndefined();
  expect(sent.hints).toBeUndefined();
  await shot(page, "v1142-final-1440");
  await axe(page);
  expect(env.writes).toEqual([]);
  // A refresh of the same identity sends its previous nonzero networks as order-only hints.
  await page.getByRole("button", { name: "Check again", exact: true }).click();
  await expect.poll(async () => (await ws(page)).requests.length).toBe(2);
  const refresh = (await ws(page)).requests[1] as {
    hints?: { recent: string[] };
    fresh?: boolean;
  };
  expect(refresh.hints?.recent).toEqual(["1", "8453", "56"]);
  expect(refresh.fresh).toBe(true);
});
async function connect(page: Page) {
  await page
    .getByRole("button", { name: "Connect wallet", exact: true })
    .first()
    .click();
  await expect(privyModal(page)).toBeVisible({ timeout: 20000 });
  await privyModal(page)
    .getByRole("button", { name: /^MetaMask$/ })
    .first()
    .click();
  await expect(privyModal(page)).toBeHidden({ timeout: 20000 });
}
test("V1142 account switch mid-stream: the previous account never streams into the new one", async ({
  page,
}) => {
  const env = await setup(page, { wallet: true });
  await page.goto("/portfolio");
  await connect(page);
  await expect(page.getByTestId("scan-progress")).toContainText(
    "Scanning 3 priority networks…",
    { timeout: 20000 },
  );
  await open(page, "native");
  const summary = page.getByTestId("portfolio-summary");
  await expect(summary.locator(".summary-value")).toHaveText("$5,600.00");
  // Switch accounts while account A's round is still streaming.
  await page.evaluate(
    (b) =>
      (
        window as unknown as {
          __wallets: Record<string, { setAccounts: (a: string[]) => void }>;
        }
      ).__wallets.metamask.setAccounts([b]),
    OTHER,
  );
  await expect
    .poll(async () =>
      (await ws(page)).requests.at(-1)?.identity.evm?.toLowerCase(),
    )
    .toBe(OTHER);
  const first = (await ws(page)).requests[0];
  expect(first.priority).toEqual(["1"]);
  // B's round: releasing every gate also releases A's (aborted) script — none of A's lines may render.
  await open(page, "page");
  await open(page, "background");
  await open(page, "final");
  await expect(page.getByTestId("scan-progress")).toHaveCount(0);
  await expect(summary.locator(".summary-value")).toHaveText("$298.00");
  await expect(page.locator(`[data-token="${USDC}"]`)).toHaveCount(0);
  await expect(page.locator('[data-chain="8453"]')).toHaveCount(0);
  const delivered = (await ws(page)).delivered;
  // A's stream was aborted with the account switch: its later lines were never even delivered.
  expect(
    delivered.filter((d) => d.startsWith(sender) && d.endsWith(":result")),
  ).toEqual([]);
  // DeFi ran for B only.
  expect(env.defi.every((d) => d.wallet.toLowerCase() === OTHER)).toBe(true);
  const m = await measures(page);
  expect(m.fullWalletCoverageMs).toBeGreaterThanOrEqual(0);
  await shot(page, "v1142-account-switch-1440");
  expect(env.writes).toEqual([]);
});
test("V1142 disconnect mid-stream: no late merge, watch mode stays usable", async ({
  page,
}) => {
  const env = await setup(page, { wallet: true });
  await page.goto("/portfolio");
  await connect(page);
  await expect(page.getByTestId("scan-progress")).toBeVisible({
    timeout: 20000,
  });
  await open(page, "native");
  await expect(page.locator('[data-chain="1"]')).toBeVisible();
  await page.evaluate(() =>
    (
      window as unknown as {
        __wallets: Record<
          string,
          { setAccounts: (a: string[]) => void; disconnect: () => void }
        >;
      }
    ).__wallets.metamask.setAccounts([]),
  );
  await expect(page.locator('[data-scan-mode="watch"]')).toHaveAttribute(
    "aria-pressed",
    "true",
    { timeout: 20000 },
  );
  await open(page, "page");
  await open(page, "background");
  await open(page, "final");
  await page.waitForTimeout(400);
  await expect(page.getByTestId("portfolio-summary")).toHaveCount(0);
  await expect(page.getByTestId("scan-progress")).toHaveCount(0);
  expect(env.defi).toHaveLength(0);
  // Watch mode remains separately usable after the disconnect.
  await page.locator('input[aria-label^="evm "]').fill(OTHER);
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await expect(
    page.getByTestId("portfolio-summary").locator(".summary-value"),
  ).toHaveText("$298.00");
  expect(env.writes).toEqual([]);
});
test("V1142 render census: 150 streamed networks are coalesced into few renders and reconcile exactly", async ({
  page,
}) => {
  await setup(page);
  await page.goto("/portfolio");
  await page.locator('input[aria-label^="evm "]').fill(LARGE);
  const started = Date.now();
  await page
    .getByRole("button", { name: "Scan balances", exact: true })
    .click();
  await expect(page.getByTestId("scan-progress")).toBeVisible();
  await expect(page.getByTestId("scan-progress")).toHaveCount(0, {
    timeout: 20000,
  });
  const elapsed = Date.now() - started;
  // 20 funded networks at 100 + 10·i USD (i = 0..19).
  const expected = Array.from({ length: 20 }, (_, i) => 100 + i * 10).reduce(
    (a, b) => a + b,
    0,
  );
  await expect(
    page.getByTestId("portfolio-summary").locator(".summary-value"),
  ).toHaveText("$" + expected.toLocaleString("en-US") + ".00");
  const census = await page.evaluate(() => ({
    flushes: performance
      .getEntriesByName("otherbridge:walletFlush")
      .map((e) => Math.round(e.startTime)),
    measures: Object.fromEntries(
      performance
        .getEntriesByType("measure")
        .filter((m) => m.name.startsWith("otherbridge:"))
        .map((m) => [m.name.slice(12), Math.round(m.duration)]),
    ),
    longTasks: (window as unknown as { __longTasks: number[] }).__longTasks,
    lines: (window as unknown as { __ws: { delivered: string[] } }).__ws
      .delivered.length,
  }));
  // 170+ streamed lines, coalesced: at most one render per 200 ms window plus the milestones.
  expect(census.lines).toBeGreaterThan(170);
  expect(census.flushes.length).toBeGreaterThanOrEqual(3);
  expect(census.flushes.length).toBeLessThanOrEqual(
    Math.ceil(elapsed / 200) + 6,
  );
  expect(census.measures.firstMeaningfulAssetMs).toBeLessThan(
    census.measures.fullWalletCoverageMs,
  );
  mkdirSync(root, { recursive: true });
  writeFileSync(
    `${root}/render-census.json`,
    JSON.stringify(
      {
        kind: "SYNTHETIC_TEST_ONLY browser render census (dev server, Chromium)",
        networks: 150,
        streamedLines: census.lines,
        elapsedMs: elapsed,
        flushes: census.flushes.length,
        flushIntervalsMs: census.flushes
          .slice(1)
          .map((t, i) => t - census.flushes[i]),
        measures: census.measures,
        longTasks: {
          count: census.longTasks.length,
          maxMs: Math.max(0, ...census.longTasks),
          all: census.longTasks,
        },
      },
      null,
      1,
    ),
  );
});
test("V1142 RTL: the progressive phase line is translated, right-to-left and accessible", async ({
  page,
}) => {
  await setup(page, { locale: "ar" });
  await page.goto("/portfolio");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await page.locator('input[aria-label^="evm "]').fill(sender);
  await page.locator(".scan-button").click();
  const progress = page.getByTestId("scan-progress");
  await expect(progress).toContainText("جارٍ فحص");
  await open(page, "native");
  await open(page, "page");
  await expect(progress).toContainText("الشبكات المتبقية");
  await shot(page, "v1142-rtl-ar-first-page-1440");
  await axe(page);
  await open(page, "background");
  await open(page, "final");
  await expect(progress).toHaveCount(0);
});
