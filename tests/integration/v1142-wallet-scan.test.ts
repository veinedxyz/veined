import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
// The app route prices through the routing upstream; in this suite it reads the simulator's prices (no network).
const prices = vi.hoisted(() => ({
  read: null as
    null | ((path: string, params: Record<string, string>) => Promise<unknown>),
}));
vi.mock("../../src/adapters/routing-core", async (importOriginal) => {
  const m =
    await importOriginal<typeof import("../../src/adapters/routing-core")>();
  return {
    ...m,
    upstreamRead: (path: string, params: Record<string, string>) =>
      prices.read
        ? prices.read(path, params)
        : Promise.reject(Error("NO_PRICE_IN_TEST")),
  };
});
import {
  buildWalletWorld,
  seedWalletProfile,
  WALLET_FAILURES,
  type WalletProfile,
} from "../fixtures/wallet-sim";
import { walletEconomics } from "../fixtures/wallet-economics";
import {
  scanPortfolio,
  identityScope,
  FIRST_PAGE_CHAIN_BUDGET_MS,
  type ScanOptions,
  type WalletEvent,
} from "../../src/portfolio/service";
import {
  SelfHostedPortfolioProvider,
  clearPortfolioPriceCacheForTests,
} from "../../src/data/portfolio/provider";
import { clearWalletCachesForTests } from "../../src/data/portfolio/chain-cache";
import { encodeContinuation } from "../../src/data/portfolio/scheduler";
import {
  applyWalletLine,
  emptyProgress,
  parseWalletLine,
  progressiveResult,
  type ProgressLine,
} from "../../src/portfolio/stream";
import {
  portfolioSchema,
  type PortfolioResult,
} from "../../src/portfolio/model";
import type { RpcTransport } from "../../src/data/rpc/transport";
import { setDataPlaneForTests } from "../../src/data/plane";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { POST as portfolioPost } from "../../src/app/api/portfolio/route";
import { routingCore } from "../../src/adapters/routing-core";
import { NativePortfolioProvider } from "../../src/portfolio/providers";
// V1.14.2 progressive multi-wave wallet scan on the deterministic multichain simulator (SYNTHETIC_TEST_ONLY). Fast
// latency; the slow class answers in 100 ms here and the timeout class never answers, so every outcome is exact and
// timing-independent.
const OPTS = {
  concurrency: 8,
  deadlineMs: 15000,
  perChainMs: 1200,
  maxChains: 2000,
} satisfies ScanOptions;
const WAVES = { waves: true, maxConcurrency: 16 } satisfies ScanOptions;
function world(profile: WalletProfile = "multichain") {
  const ww = buildWalletWorld({ latencyMs: 4, perItemMs: 0, jitter: 0 });
  const seeded = seedWalletProfile(ww, profile);
  for (const id of WALLET_FAILURES.slow)
    for (const e of ww.endpoints.filter((x) => x.chainId === id))
      ww.world.net.behavior.get(e.url)!.latencyMs = 100;
  return { ww, seeded };
}
type World = ReturnType<typeof world>;
function counting(inner: RpcTransport) {
  const log: { chainId: string }[] = [];
  const transport: RpcTransport = (endpoint, body, options) => {
    log.push({ chainId: endpoint.chainId });
    return inner(endpoint, body, options);
  };
  return { log, transport };
}
async function scan(
  { ww, seeded }: World,
  options: ScanOptions,
  transport: RpcTransport = ww.world.net.transport,
  wallet = seeded.wallet,
) {
  const plane = ww.plane(transport, seeded.store);
  return scanPortfolio(
    { evm: wallet },
    ww.catalog,
    undefined,
    [
      new SelfHostedPortfolioProvider(
        plane,
        ww.catalog,
        ww.priceRead,
        undefined,
        seeded.extraTokens,
      ),
    ],
    options,
  );
}
const fresh = () => {
  clearPortfolioPriceCacheForTests();
  clearWalletCachesForTests();
};
beforeEach(fresh);
describe("V1.14.2 final economic output equals the accepted single-order scan", () => {
  for (const profile of [
    "multichain",
    "indexed",
    "longtail",
    "obscure-erc20",
    "zero",
    "native-only",
  ] as const)
    it(`${profile}: same holdings, values, allocation, coverage and DeFi coverage`, async () => {
      const before = await scan(world(profile), {
        ...OPTS,
        priority: ["8453"],
      });
      fresh();
      const w = world(profile);
      const after = await scan(w, {
        ...OPTS,
        ...WAVES,
        priority: ["8453"],
        hints: { recent: ["56", "1", "295"] },
      });
      const a = walletEconomics(before),
        b = walletEconomics(after);
      expect(b.holdingsDigest).toBe(a.holdingsDigest);
      expect(b.coverageDigest).toBe(a.coverageDigest);
      expect(b.defiDigest).toBe(a.defiDigest);
      expect(b.digest).toBe(a.digest);
      // Discovery oracle of the profile: every expected nonzero holding is present.
      const found = new Set(
        after.holdings
          .filter((h) => BigInt(h.balance) > 0n)
          .map((h) => `${h.chainId}:${h.address.toLowerCase()}`),
      );
      for (const id of w.seeded.expected) expect(found).toContain(id);
    }, 30000);
});
describe("V1.14.2 progressive stream", () => {
  it("plan first, native fast path before its network, one line per network, provisional == final", async () => {
    const events: WalletEvent[] = [];
    const final = await scan(world(), {
      ...OPTS,
      ...WAVES,
      priority: ["8453"],
      onEvent: (e) => events.push(e),
    });
    expect(events[0].type).toBe("plan");
    const lines = events.filter(
      (e): e is ProgressLine => e.type !== "scheduler",
    );
    // Every streamed unit passes the strict wire schema.
    for (const l of lines) expect(() => parseWalletLine(l)).not.toThrow();
    const plan = lines[0] as Extract<ProgressLine, { type: "plan" }>;
    const chainLines = lines.filter((l) => l.type === "chain");
    expect(chainLines.map((l) => l.chainId).sort()).toEqual(
      plan.chains.map((c) => c.chainId).sort(),
    );
    const firstChainAt = new Map<string, number>();
    lines.forEach((l, i) => {
      if (l.type === "chain") firstChainAt.set(l.chainId, i);
    });
    lines.forEach((l, i) => {
      if (l.type === "native")
        expect(i).toBeLessThan(firstChainAt.get(l.chainId)!);
    });
    expect(lines.some((l) => l.type === "native")).toBe(true);
    // The connected chain is wave 0 and its native balance is the first meaningful asset.
    expect(plan.chains[0]).toMatchObject({
      chainId: "8453",
      wave: 0,
      // The profile imported an exact token on the connected chain: both reasons explain it, current chain first.
      reasons: [
        "CURRENT_CHAIN",
        "KNOWN_TOKEN",
        "HIGH_CONFIDENCE_PORTFOLIO_CHAIN",
        "GENERAL_PRIORITY",
      ],
    });
    const firstAsset = lines.find((l) => l.type === "native");
    expect(firstAsset).toMatchObject({ chainId: "8453" });
    const fp = lines.find((l) => l.type === "firstPage")!;
    expect(fp).toBeTruthy();
    expect(lines.findIndex((l) => l.type === "defiReady")).toBeGreaterThan(0);
    // Reconstruct the provisional view from the stream: it equals the final round (no double count, no loss).
    let p = emptyProgress(1);
    for (const l of lines) p = applyWalletLine(p, l);
    const view = progressiveResult(p)!;
    const key = (r: PortfolioResult) =>
      r.holdings
        .map(
          (h) =>
            `${h.chainId}:${h.address.toLowerCase()}:${h.balance}:${h.usd}`,
        )
        .sort();
    expect(key(view)).toEqual(key(final));
    const states = (r: PortfolioResult) =>
      Object.fromEntries(r.coverage.map((c) => [c.chainId, c.state]));
    expect(states(view)).toEqual(states(final));
    expect(view.coverageSummary).toEqual(final.coverageSummary);
    const receipt = events.find((e) => e.type === "scheduler");
    expect(receipt?.type === "scheduler" && receipt.receipt.chains.length).toBe(
      plan.chains.length,
    );
  }, 30000);
  it("network failure matrix: failures are FAILED, never checked zero; other networks still answer", async () => {
    const events: WalletEvent[] = [];
    const r = await scan(world(), {
      ...OPTS,
      ...WAVES,
      onEvent: (e) => events.push(e),
    });
    const cov = new Map(r.coverage.map((c) => [c.chainId, c]));
    for (const id of [
      ...WALLET_FAILURES.timeout,
      ...WALLET_FAILURES.down,
      ...WALLET_FAILURES.rateLimited,
      ...WALLET_FAILURES.wrongChain,
      ...WALLET_FAILURES.malformed,
    ]) {
      expect(cov.get(id)).toMatchObject({ state: "FAILED", native: "FAILED" });
      expect(r.holdings.some((h) => h.chainId === id)).toBe(false);
    }
    // Accepted V1.14.1 semantics (unchanged): a wrong-chain endpoint fails the network as RPC_UNAVAILABLE.
    expect(cov.get("80094")!.reason).toBe("RPC_UNAVAILABLE");
    // No Multicall3: native only, tokens honestly unchecked; one endpoint down: failover answers.
    expect(cov.get("43114")).toMatchObject({
      native: "CHECKED",
      tokens: "NOT_CHECKED",
    });
    expect(cov.get("42161")!.native).toBe("CHECKED");
    expect(r.coverageSummary.checked).toBe(147);
    expect(r.coverageSummary.failed).toBe(7);
    expect(r.coverageSummary.pending).toBe(0);
    const failedLines = events.filter(
      (e) => e.type === "chain" && e.coverage.state === "FAILED",
    );
    expect(failedLines).toHaveLength(7);
  }, 30000);
  it("a slow first-page network is deferred to the background wave after repeated overruns — still scanned", async () => {
    const w = world("multichain");
    // Gnosis (a high-confidence first-page network) becomes slower than the first-page chain budget.
    for (const e of w.ww.endpoints.filter((x) => x.chainId === "100"))
      w.ww.world.net.behavior.get(e.url)!.latencyMs =
        FIRST_PAGE_CHAIN_BUDGET_MS + 200;
    const plans: Extract<WalletEvent, { type: "plan" }>[] = [];
    const pages: Extract<WalletEvent, { type: "firstPage" }>[] = [];
    let last: PortfolioResult | undefined;
    for (let i = 0; i < 3; i++) {
      clearPortfolioPriceCacheForTests();
      last = await scan(w, {
        ...OPTS,
        ...WAVES,
        perChainMs: 7000,
        onEvent: (e) => {
          if (e.type === "plan") plans.push(e);
          if (e.type === "firstPage") pages.push(e);
        },
      });
    }
    const gnosis = (n: number) =>
      plans[n].chains.find((c) => c.chainId === "100")!;
    expect(gnosis(0).wave).toBe(2);
    expect(gnosis(2)).toMatchObject({ wave: 4 });
    expect(gnosis(2).reasons[0]).toBe("DEFERRED_TO_BACKGROUND_SLOW_CHAIN");
    // The first page never waited for it beyond the chain budget, and the network is still answered.
    expect(
      pages[0].reason === "CHAIN_BUDGET" ||
        pages[0].outstanding.includes("100"),
    ).toBe(true);
    expect(pages[2].outstanding).not.toContain("100");
    expect(last!.coverage.find((c) => c.chainId === "100")!.native).toBe(
      "CHECKED",
    );
    expect(last!.holdings.some((h) => h.chainId === "100" && h.native)).toBe(
      true,
    );
    // With user evidence (previous nonzero) the quarantined network is still read early (wave 1), but it no longer
    // holds the first page.
    clearPortfolioPriceCacheForTests();
    await scan(w, {
      ...OPTS,
      ...WAVES,
      perChainMs: 7000,
      hints: { recent: ["100", "1"] },
      onEvent: (e) => {
        if (e.type === "plan") plans.push(e);
        if (e.type === "firstPage") pages.push(e);
      },
    });
    const recent = plans[3].chains.find((c) => c.chainId === "100")!;
    expect(recent.wave).toBe(1);
    expect(recent.reasons[0]).toBe("RECENT_NONZERO");
    expect(recent.reasons).toContain("DEFERRED_TO_BACKGROUND_SLOW_CHAIN");
    expect(plans[3].firstPage.chains).toBe(
      plans[3].chains.filter((c) => c.wave <= 2).length - 1,
    );
    expect(pages[3].outstanding).not.toContain("100");
    expect(pages[3].reason).not.toBe("CHAIN_BUDGET");
  }, 60000);
});
describe("V1.14.2 identity-safe cache and single-flight", () => {
  it("two concurrent scans of the same wallet share chain reads; another wallet shares nothing", async () => {
    const w = world();
    const one = counting(w.ww.world.net.transport);
    await scan(w, { ...OPTS, ...WAVES }, one.transport);
    const single = one.log.length;
    fresh();
    const two = counting(w.ww.world.net.transport);
    const [a, b] = await Promise.all([
      scan(w, { ...OPTS, ...WAVES }, two.transport),
      scan(w, { ...OPTS, ...WAVES }, two.transport),
    ]);
    // One data plane per scan here (two transports objects would be two planes): reads are shared per plane, so
    // the second scan of the same plane only joins. Each scan uses its own plane above, so compare per plane below.
    expect(walletEconomics(a).digest).toBe(walletEconomics(b).digest);
    fresh();
    const shared = counting(w.ww.world.net.transport);
    const plane = w.ww.plane(shared.transport, w.seeded.store);
    const provider = () =>
      new SelfHostedPortfolioProvider(
        plane,
        w.ww.catalog,
        w.ww.priceRead,
        undefined,
        w.seeded.extraTokens,
      );
    const [x, y] = await Promise.all([
      scanPortfolio(
        { evm: w.seeded.wallet },
        w.ww.catalog,
        undefined,
        [provider()],
        { ...OPTS, ...WAVES },
      ),
      scanPortfolio(
        { evm: w.seeded.wallet },
        w.ww.catalog,
        undefined,
        [provider()],
        { ...OPTS, ...WAVES },
      ),
    ]);
    expect(walletEconomics(x).digest).toBe(walletEconomics(y).digest);
    // Failed networks are never cached or joined into a zero: both scans still report them FAILED.
    expect(x.coverageSummary.failed).toBe(7);
    expect(y.coverageSummary.failed).toBe(7);
    expect(shared.log.length).toBeLessThan(single * 1.5);
    // A different wallet on the same plane reads everything itself.
    const before = shared.log.length;
    const otherWallet = "0x00000000000000000000000000000000000f00d1";
    const z = await scanPortfolio(
      { evm: otherWallet },
      w.ww.catalog,
      undefined,
      [provider()],
      { ...OPTS, ...WAVES },
    );
    expect(shared.log.length - before).toBeGreaterThan(single * 0.8);
    expect(z.holdings.some((h) => BigInt(h.balance) > 0n)).toBe(false);
  }, 60000);
});
describe("V1.14.2 non-EVM identities and denial-of-service bounds", () => {
  it("non-EVM identities keep their accepted catalog-only coverage (never checked zero)", async () => {
    const identity = {
      evm: "",
      solana: "So11111111111111111111111111111111111111112",
      bitcoin: ["bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"],
    };
    const run = async (options: ScanOptions) => {
      const w = world("zero");
      const plane = w.ww.plane(w.ww.world.net.transport, w.seeded.store);
      return scanPortfolio(
        { ...identity, evm: w.seeded.wallet },
        w.ww.catalog,
        undefined,
        [new SelfHostedPortfolioProvider(plane, w.ww.catalog, w.ww.priceRead)],
        options,
      );
    };
    const before = await run(OPTS);
    fresh();
    const after = await run({ ...OPTS, ...WAVES });
    expect(walletEconomics(after).coverageDigest).toBe(
      walletEconomics(before).coverageDigest,
    );
    const cov = new Map(after.coverage.map((c) => [c.chainId, c]));
    expect(cov.get("bitcoin")).toMatchObject({
      state: "CATALOG_ONLY",
      native: "UNSUPPORTED",
      reason: "UNSUPPORTED_ECOSYSTEM",
    });
    expect(cov.get("1151111081099710")?.state).toBe("CATALOG_ONLY");
    expect(after.coverageSummary.checked).toBe(before.coverageSummary.checked);
  }, 30000);
  it("a refresh storm is bounded: repeated scans inside the TTL reuse exact network results; failures are re-read", async () => {
    const w = world();
    const c = counting(w.ww.world.net.transport);
    const plane = w.ww.plane(c.transport, w.seeded.store);
    const once = () =>
      scanPortfolio(
        { evm: w.seeded.wallet },
        w.ww.catalog,
        undefined,
        [
          new SelfHostedPortfolioProvider(
            plane,
            w.ww.catalog,
            w.ww.priceRead,
            undefined,
            w.seeded.extraTokens,
          ),
        ],
        { ...OPTS, ...WAVES },
      );
    const first = await once();
    const single = c.log.length;
    const coverageDigests = [];
    for (let i = 0; i < 5; i++)
      coverageDigests.push(walletEconomics(await once()).coverageDigest);
    const extra = c.log.length - single;
    // Far below five full scans: only never-cached failures and networks whose read set changed are read again —
    // the accepted per-scan price budget makes up to eight more routable networks price-eligible per scan, which
    // is a different exact read (the cache key carries price eligibility), never a reused one.
    expect(extra).toBeLessThan(single * 0.5);
    const failed = new Set(
      first.coverage.filter((x) => x.state === "FAILED").map((x) => x.chainId),
    );
    const routable = new Set(
      w.ww.catalog.networks.filter((n) => n.mainnet).map((n) => n.id),
    );
    for (const r of c.log.slice(single))
      expect(failed.has(r.chainId) || routable.has(r.chainId)).toBe(true);
    for (const d of coverageDigests)
      expect(d).toBe(walletEconomics(first).coverageDigest);
    // An explicit refresh reads again (fresh) — still one bounded scan.
    const before = c.log.length;
    await scanPortfolio(
      { evm: w.seeded.wallet },
      w.ww.catalog,
      undefined,
      [
        new SelfHostedPortfolioProvider(
          plane,
          w.ww.catalog,
          w.ww.priceRead,
          undefined,
          w.seeded.extraTokens,
        ),
      ],
      { ...OPTS, ...WAVES, fresh: true },
    );
    expect(c.log.length - before).toBeGreaterThan(single * 0.8);
    expect(c.log.length - before).toBeLessThan(single * 1.3);
  }, 60000);
});
describe("V1.14.2 continuation binding", () => {
  it("pending networks continue with a bound cursor that cannot move to another wallet", async () => {
    const w = world();
    // Deterministic pending set, independent of host speed: the timeout class never answers within the 1.2 s round
    // deadline, and its per-network timeout (5 s) is longer than the round, so it ends PENDING (never FAILED).
    const first = await scan(w, {
      ...OPTS,
      ...WAVES,
      deadlineMs: 1200,
      perChainMs: 5000,
    });
    expect(first.coverageSummary.pending).toBeGreaterThan(0);
    const pendingIds = first.coverage
      .filter((c) => c.state === "PENDING")
      .map((c) => c.chainId);
    for (const id of WALLET_FAILURES.timeout) expect(pendingIds).toContain(id);
    expect(first.continuation).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/);
    const other = "0x00000000000000000000000000000000000f00d1";
    await expect(
      scan(
        w,
        { ...OPTS, ...WAVES, continuation: first.continuation },
        undefined,
        other,
      ),
    ).rejects.toThrow("CONTINUATION_SCOPE_MISMATCH");
    const legacy = encodeContinuation(
      identityScope({ evm: w.seeded.wallet }),
      first.coverage.filter((c) => c.state === "PENDING").map((c) => c.chainId),
    )!;
    await expect(
      scan(w, { ...OPTS, ...WAVES, continuation: legacy }),
    ).rejects.toThrow("INVALID_CONTINUATION");
    const [body, tag] = first.continuation!.split(".");
    await expect(
      scan(w, { ...OPTS, ...WAVES, continuation: `${body}x.${tag}` }),
    ).rejects.toThrow("INVALID_CONTINUATION");
    const events: WalletEvent[] = [];
    const second = await scan(w, {
      ...OPTS,
      ...WAVES,
      continuation: first.continuation,
      onEvent: (e) => events.push(e),
    });
    const plan = events.find((e) => e.type === "plan");
    expect(plan?.type === "plan" && plan.continued).toBe(true);
    // A continued round re-reads only the narrowed pending set, never a new network.
    const pending = new Set(
      first.coverage.filter((c) => c.state === "PENDING").map((c) => c.chainId),
    );
    expect(
      plan?.type === "plan" && plan.chains.every((c) => pending.has(c.chainId)),
    ).toBe(true);
    expect(second.coverage.every((c) => pending.has(c.chainId))).toBe(true);
    expect(events.some((e) => e.type === "firstPage")).toBe(false);
  }, 60000);
});
describe("V1.14.2 app route (NDJSON stream, JSON compatibility, shared flight, hostile input)", () => {
  const origin = "http://127.0.0.1:3100";
  const post = (body: unknown, accept = "application/json") =>
    portfolioPost(
      new NextRequest(`${origin}/api/portfolio`, {
        method: "POST",
        headers: {
          origin,
          host: "127.0.0.1:3100",
          "content-type": "application/json",
          accept,
        },
        body: JSON.stringify(body),
      }) as unknown as Request,
    );
  let w: World;
  beforeEach(() => {
    setAppLimiterForTests(new MemoryRateLimiter());
    w = world();
    // Route timings are fixed (7 s per chain): the timeout class answers fast-failing here instead.
    for (const id of WALLET_FAILURES.timeout)
      for (const e of w.ww.endpoints.filter((x) => x.chainId === id))
        w.ww.world.net.behavior.get(e.url)!.failNext = Number.MAX_SAFE_INTEGER;
    setDataPlaneForTests(w.ww.plane(w.ww.world.net.transport, w.seeded.store));
    prices.read = w.ww.priceRead;
    vi.spyOn(routingCore, "listNetworks").mockResolvedValue(w.ww.catalog);
    vi.spyOn(
      NativePortfolioProvider.prototype,
      "discoverActivity",
    ).mockResolvedValue([]);
  });
  afterEach(() => {
    setDataPlaneForTests(undefined);
    setAppLimiterForTests(undefined);
    prices.read = null;
    vi.restoreAllMocks();
  });
  const readLines = async (r: Response) =>
    (await r.text())
      .split("\n")
      .filter(Boolean)
      .map((l) => parseWalletLine(JSON.parse(l)));
  it("streams validated progress lines and a final result line; JSON clients get the same round", async () => {
    const body = {
      identity: { evm: w.seeded.wallet },
      consent: true,
      priority: ["8453"],
    };
    const r = await post(body, "application/x-ndjson, application/json");
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/x-ndjson");
    expect(r.headers.get("cache-control")).toBe("private, no-store");
    const lines = await readLines(r);
    expect(lines[0].type).toBe("plan");
    const last = lines.at(-1)!;
    expect(last.type).toBe("result");
    const result = last.type === "result" ? last.result : undefined;
    expect(
      portfolioSchema.parse(result).coverageSummary.planned,
    ).toBeGreaterThan(150);
    expect(
      last.type === "result" && last.receipt?.chains.length,
    ).toBeGreaterThan(100);
    expect(lines.filter((l) => l.type === "chain").length).toBe(154);
    fresh();
    const json = await post(body);
    expect(json.headers.get("content-type")).toContain("application/json");
    const plain = portfolioSchema.parse(await json.json());
    expect(walletEconomics(plain).holdingsDigest).toBe(
      walletEconomics(result!).holdingsDigest,
    );
  }, 60000);
  it("many tabs: ten identical concurrent requests are one bounded scan", async () => {
    const body = { identity: { evm: w.seeded.wallet }, consent: true };
    const spy = vi.spyOn(
      SelfHostedPortfolioProvider.prototype,
      "discoverActivity",
    );
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        post(body, i % 2 ? "application/x-ndjson" : "application/json"),
      ),
    );
    expect(responses.every((r) => r.status === 200)).toBe(true);
    await Promise.all(responses.map((r) => r.text()));
    expect(spy).toHaveBeenCalledTimes(1);
  }, 60000);
  it("two identical concurrent requests share one scan; the second replays the same lines", async () => {
    const body = { identity: { evm: w.seeded.wallet }, consent: true };
    const spy = vi.spyOn(
      SelfHostedPortfolioProvider.prototype,
      "discoverActivity",
    );
    const [a, b] = await Promise.all([
      post(body, "application/x-ndjson"),
      post(body, "application/x-ndjson"),
    ]);
    const [la, lb] = await Promise.all([readLines(a), readLines(b)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(lb.map((l) => l.type)).toEqual(la.map((l) => l.type));
    expect(JSON.stringify(lb.at(-1))).toBe(JSON.stringify(la.at(-1)));
  }, 60000);
  it("rejects hostile input with an HTTP status before any stream starts", async () => {
    const ndjson = "application/x-ndjson";
    const base = { identity: { evm: w.seeded.wallet }, consent: true };
    expect((await post({ ...base, continuation: "!!" }, ndjson)).status).toBe(
      422,
    );
    expect(
      (await post({ ...base, continuation: "a".repeat(40001) }, ndjson)).status,
    ).toBe(422);
    expect(
      (
        await post(
          { identity: { evm: "0x" + "1".repeat(4000) }, consent: true },
          ndjson,
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await post(
          {
            ...base,
            hints: {
              recent: Array.from({ length: 25 }, (_, i) => String(i + 1)),
            },
          },
          ndjson,
        )
      ).status,
    ).toBe(422);
    expect(
      (await post({ ...base, hints: { context: ["1"], extra: 1 } }, ndjson))
        .status,
    ).toBe(422);
    expect((await post({ ...base, fresh: false }, ndjson)).status).toBe(422);
    expect(
      (await post({ ...base, rpcUrl: "https://evil.test" }, ndjson)).status,
    ).toBe(422);
    const legacy = encodeContinuation(identityScope({ evm: w.seeded.wallet }), [
      "1",
    ])!;
    const r = await post({ ...base, continuation: legacy }, ndjson);
    expect(r.status).toBe(422);
    expect((await r.json()).error).toBe("INVALID_CONTINUATION");
  }, 30000);
});
