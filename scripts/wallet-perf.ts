// V1.14.2 wallet-scan / first-paint performance harness (read-only; never signs or sends a transaction). It drives the
// Portfolio client flow at the server boundary with the route's exact options: the first wallet round, then
// continuation rounds until every planned network has an answer, and (optionally) the DeFi rounds the client starts.
// Only stable public APIs are used — scanPortfolio(identity, catalog, signal, providers, options) and scanDefi — plus
// one optional progressive hook (`options.onEvent`), which code without progressive events simply never calls. The
// identical harness therefore measures the accepted V1.14.1 code (before) and the V1.14.2 code (after).
//   fixture <profile> <out.json> [runs] [--watch] [--defi]   deterministic multichain simulator (SYNTHETIC_TEST_ONLY)
//   oracle <out.json>                                         final economic digests of every fixture profile (cold+warm)
//   live <out.json> [runs] [--defi]                           real read-only public RPC, one public treasury address
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem, freemem } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { decodeFunctionData, type Hex } from "viem";
import { DataPlane, fallbackRegistry } from "../src/data/plane";
import { httpsTransport, type RpcTransport } from "../src/data/rpc/transport";
import { multicall3Abi, SELECTORS } from "../src/data/evm/erc20";
import { MULTICALL3 } from "../src/data/evm/multicall";
import { scanPortfolio } from "../src/portfolio/service";
import {
  mergePortfolio,
  type Holding,
  type PortfolioIdentity,
  type PortfolioProvider,
  type PortfolioResult,
} from "../src/portfolio/model";
import { SelfHostedPortfolioProvider } from "../src/data/portfolio/provider";
import { NativePortfolioProvider } from "../src/portfolio/providers";
import { scanDefi, clearScanStateForTests } from "../src/defi/scanner";
import type { Catalog } from "../src/routing/model";
import { walletEconomics } from "../tests/fixtures/wallet-economics";
import {
  buildWalletWorld,
  failureOf,
  seedWalletProfile,
  WALLET_PROFILES,
  type WalletProfile,
} from "../tests/fixtures/wallet-sim";
process.env.OTHERBRIDGE_DATA_LOG = "off";
const unhandled: string[] = [];
process.on("unhandledRejection", (e) =>
  unhandled.push(String((e as Error)?.message ?? e).slice(0, 80)),
);
const argv = process.argv.slice(2);
const mode = argv[0];
// fixture <profile> <out.json> ...; oracle|live <out.json> ...
const profileArg = mode === "fixture" ? argv[1] : undefined;
const [outFile, ...rest] = argv.slice(mode === "fixture" ? 2 : 1);
if (!mode || !outFile)
  throw Error(
    "USAGE: wallet-perf.ts <fixture <profile>|oracle|live> <out.json> ...",
  );
if (profileArg && !(WALLET_PROFILES as readonly string[]).includes(profileArg))
  throw Error("UNKNOWN_PROFILE");
// Request phase by async context: DeFi rounds run inside `inDefi`, so concurrent wallet and DeFi requests are
// attributed exactly (a global flag cannot separate overlapping pipelines).
const phaseStore = new AsyncLocalStorage<"defi">();
const inDefi = <T>(f: () => Promise<T>) => phaseStore.run("defi", f);
const currentPhase = (): "wallet" | "defi" => phaseStore.getStore() ?? "wallet";
const r1 = (n: number) => Math.round(n * 10) / 10;
// Aave V3 Ethereum Collector: a public protocol treasury contract from a pinned official source (the V1.14.1 live
// address); never an identified person.
const LIVE_WALLET = "0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c";
const WALLET_CONTINUE = 15;
// The route's exact options (src/app/api/portfolio/route.ts, V1.11 → V1.14.2 unchanged).
const ROUTE = {
  concurrency: 8,
  deadlineMs: 18000,
  perChainMs: 7000,
  maxChains: 2000,
} as const;
// V1.14.2 route additions (the multi-wave progressive scan and its adaptive hard maximum); V1.14.1 ignores them.
const ROUTE_V1142 = { waves: true, maxConcurrency: 16 } as const;
const context = () => ({
  node: process.version,
  platform: process.platform,
  cpu: cpus()[0]?.model?.trim(),
  logicalCpus: cpus().length,
  totalMemGb: +(totalmem() / 2 ** 30).toFixed(1),
  freeMemGb: +(freemem() / 2 ** 30).toFixed(1),
});
// ---------------------------------------------------------------------------------------------------------------
// Request recording (every HTTP request: chain, endpoint, operator group, methods, timing, outcome).
interface Rec {
  chainId: string;
  host: string;
  group: string;
  kind: "single" | "batch";
  methods: string[];
  aggregates: number;
  inner: number;
  start: number;
  end: number;
  status: string;
  phase: "wallet" | "defi";
}
function recorder(
  inner: RpcTransport,
  log: Rec[],
  t0: () => number,
  phase: () => "wallet" | "defi",
  groupOf: (url: string, endpoint: unknown) => string,
): RpcTransport {
  return async (endpoint, body, options) => {
    const reqs = (Array.isArray(body) ? body : [body]) as {
      method: string;
      params: unknown[];
    }[];
    let aggregates = 0,
      innerCalls = 0;
    for (const r of reqs)
      if (r.method === "eth_call") {
        const p = r.params[0] as { to?: string; data?: string };
        if (
          p?.to?.toLowerCase() === MULTICALL3 &&
          p.data?.startsWith(SELECTORS.aggregate3)
        ) {
          aggregates++;
          try {
            innerCalls += (
              decodeFunctionData({ abi: multicall3Abi, data: p.data as Hex })
                .args[0] as unknown[]
            ).length;
          } catch {
            /* counted as an aggregate only */
          }
        }
      }
    const rec: Rec = {
      chainId: endpoint.chainId,
      host: new URL(endpoint.url).host,
      group: groupOf(endpoint.url, endpoint),
      kind: Array.isArray(body) ? "batch" : "single",
      methods: reqs.map((r) => r.method),
      aggregates,
      inner: innerCalls,
      start: r1(performance.now() - t0()),
      end: -1,
      status: "ok",
      phase: phase(),
    };
    log.push(rec);
    try {
      return await inner(endpoint, body, options);
    } catch (e) {
      rec.status =
        (e as { code?: string }).code ??
        (e instanceof Error ? e.name : "ERROR");
      throw e;
    } finally {
      rec.end = r1(performance.now() - t0());
    }
  };
}
function requestCensus(records: Rec[]) {
  const byMethod: Record<string, number> = {};
  const byStatus: Record<string, number> = {};
  for (const r of records) {
    for (const m of r.methods) byMethod[m] = (byMethod[m] ?? 0) + 1;
    byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
  }
  return {
    httpRequests: records.length,
    rpcItems: records.reduce((a, r) => a + r.methods.length, 0),
    jsonRpcBatches: records.filter((r) => r.kind === "batch").length,
    multicallBatches: records.reduce((a, r) => a + r.aggregates, 0),
    innerCalls: records.reduce((a, r) => a + r.inner, 0),
    rateLimited: byStatus.RATE_LIMITED ?? 0,
    timeouts: byStatus.TIMEOUT ?? 0,
    byStatus,
    byMethod,
  };
}
/** Peak concurrent HTTP requests and peak concurrently active chains (a chain is active between its first request
 * start and its last request end). */
function concurrency(records: Rec[]) {
  const ev: [number, number][] = [];
  for (const r of records) ev.push([r.start, 1], [r.end, -1]);
  ev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0,
    peakHttp = 0;
  for (const [, d] of ev) peakHttp = Math.max(peakHttp, (cur += d));
  const spans = new Map<string, [number, number]>();
  for (const r of records) {
    const s = spans.get(r.chainId);
    spans.set(
      r.chainId,
      s ? [Math.min(s[0], r.start), Math.max(s[1], r.end)] : [r.start, r.end],
    );
  }
  const cev: [number, number][] = [];
  for (const [a, b] of spans.values()) cev.push([a, 1], [b, -1]);
  cev.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let c = 0,
    peakChains = 0;
  for (const [, d] of cev) peakChains = Math.max(peakChains, (c += d));
  return { peakHttpInFlight: peakHttp, peakChainsActive: peakChains };
}
function providerCensus(records: Rec[]) {
  const out: Record<
    string,
    {
      httpRequests: number;
      rpcItems: number;
      errors: number;
      rateLimited: number;
      timeouts: number;
      chains: number;
      meanMs: number;
      maxMs: number;
    }
  > = {};
  const chains = new Map<string, Set<string>>();
  for (const r of records) {
    const g = (out[r.group] ??= {
      httpRequests: 0,
      rpcItems: 0,
      errors: 0,
      rateLimited: 0,
      timeouts: 0,
      chains: 0,
      meanMs: 0,
      maxMs: 0,
    });
    g.httpRequests++;
    g.rpcItems += r.methods.length;
    if (r.status !== "ok") g.errors++;
    if (r.status === "RATE_LIMITED") g.rateLimited++;
    if (r.status === "TIMEOUT") g.timeouts++;
    g.meanMs += r.end - r.start;
    g.maxMs = Math.max(g.maxMs, r1(r.end - r.start));
    const s = chains.get(r.group) ?? new Set();
    s.add(r.chainId);
    chains.set(r.group, s);
  }
  for (const [k, g] of Object.entries(out)) {
    g.meanMs = r1(g.meanMs / Math.max(1, g.httpRequests));
    g.chains = chains.get(k)?.size ?? 0;
  }
  return out;
}
// ---------------------------------------------------------------------------------------------------------------
// ---------------------------------------------------------------------------------------------------------------
type Ev = { type?: string; [k: string]: unknown };
interface ChainMark {
  wave: number | null;
  reasons: string[] | null;
  settledMs: number | null;
  nativeMs: number | null;
  round: number;
}
interface FlowOptions {
  identity: PortfolioIdentity;
  catalog: Catalog;
  providers: () => PortfolioProvider[];
  priority?: string[];
  hints?: { recent?: string[]; context?: string[] };
  t0: number;
  onDefiTrigger?: (held: string[], reason: string, atMs: number) => void;
  onWalletDone?: (held: string[], atMs: number) => void;
}
const nonzero = (h: Holding) => !h.spam && BigInt(h.balance) > 0n;
const heldIds = (holdings: Holding[]) =>
  [
    ...new Set(
      holdings
        .filter(
          (h) =>
            nonzero(h) && !h.native && /^0x[0-9a-fA-F]{40}$/.test(h.address),
        )
        .map((h) => h.chainId + ":" + h.address.toLowerCase())
        .filter((id) => /^\d{1,20}:0x[0-9a-f]{40}$/.test(id)),
    ),
  ]
    .sort()
    .slice(0, 1000);
async function walletFlow(o: FlowOptions) {
  const at = () => r1(performance.now() - o.t0);
  const marks: Record<string, number | null> = {
    walletShellReadyMs: null,
    firstMeaningfulAssetMs: null,
    firstCheckedResultMs: null,
    firstPageCompleteMs: null,
    fullWalletCoverageMs: null,
    defiTriggerMs: null,
  };
  const chains = new Map<string, ChainMark>();
  const events: { type: string; ms: number; detail?: unknown }[] = [];
  const firstAsset: { chainId: string; address: string; ms: number }[] = [];
  const seen = { firstPage: null as Ev | null, plan: null as Ev | null };
  let progressiveHeld: Holding[] = [];
  let current: PortfolioResult | undefined;
  let cursor: string | undefined;
  let rounds = 0;
  const roundMs: number[] = [];
  const scheduler: unknown[] = [];
  let defiTriggered = false;
  const trigger = (held: string[], reason: string) => {
    if (defiTriggered) return;
    defiTriggered = true;
    marks.defiTriggerMs = at();
    o.onDefiTrigger?.(held, reason, marks.defiTriggerMs);
  };
  do {
    const round = rounds + 1;
    const result = await scanPortfolio(
      o.identity,
      o.catalog,
      undefined,
      o.providers(),
      {
        ...ROUTE,
        continuation: cursor ?? null,
        priority: o.priority,
        // V1.14.2 progressive options; earlier code ignores unknown option fields.
        ...({
          ...ROUTE_V1142,
          hints: o.hints,
          onEvent: (e: Ev) => {
            const ms = at();
            const type = String(e.type);
            events.push({ type, ms });
            if (type === "plan") {
              seen.plan ??= e;
              marks.walletShellReadyMs ??= ms;
              for (const c of (e.chains as {
                chainId: string;
                wave: number;
                reasons: string[];
              }[]) ?? [])
                if (!chains.has(c.chainId))
                  chains.set(c.chainId, {
                    wave: c.wave,
                    reasons: c.reasons,
                    settledMs: null,
                    nativeMs: null,
                    round,
                  });
            }
            if (type === "native") {
              const h = e.holding as Holding;
              const m = chains.get(String(e.chainId));
              if (m) m.nativeMs ??= ms;
              if (nonzero(h) && marks.firstMeaningfulAssetMs === null) {
                marks.firstMeaningfulAssetMs = ms;
                firstAsset.push({ chainId: h.chainId, address: h.address, ms });
              }
            }
            if (type === "chain") {
              const hs = (e.holdings as Holding[]) ?? [];
              const m = chains.get(String(e.chainId));
              if (m) m.settledMs = ms;
              progressiveHeld = [
                ...progressiveHeld.filter((h) => h.chainId !== e.chainId),
                ...hs,
              ];
              const cov = e.coverage as { state: string };
              if (cov.state !== "FAILED" && cov.state !== "PENDING")
                marks.firstCheckedResultMs ??= ms;
              const hit = hs.find(nonzero);
              if (hit && marks.firstMeaningfulAssetMs === null) {
                marks.firstMeaningfulAssetMs = ms;
                firstAsset.push({
                  chainId: hit.chainId,
                  address: hit.address,
                  ms,
                });
              }
            }
            if (type === "firstPage") {
              seen.firstPage ??= { ...e, ms };
              marks.firstPageCompleteMs ??= ms;
              // No asset before the first page: the first definitive checked result is the meaningful answer.
              marks.firstMeaningfulAssetMs ??= marks.firstCheckedResultMs ?? ms;
            }
            if (type === "defiReady")
              trigger(heldIds(progressiveHeld), String(e.reason));
            if (type === "scheduler") scheduler.push(e);
          },
        } as object),
      },
    );
    const ms = at();
    roundMs.push(ms);
    // Code without progressive events: the first round response is the first time anything is visible.
    marks.walletShellReadyMs ??= ms;
    marks.firstPageCompleteMs ??= ms;
    marks.firstCheckedResultMs ??= ms;
    marks.firstMeaningfulAssetMs ??= ms;
    if (rounds === 0)
      for (const c of result.coverage)
        if (!chains.has(c.chainId))
          chains.set(c.chainId, {
            wave: null,
            reasons: null,
            settledMs: c.state === "PENDING" ? null : ms,
            nativeMs: null,
            round,
          });
    for (const c of result.coverage) {
      const m = chains.get(c.chainId);
      if (m && m.settledMs === null && c.state !== "PENDING") {
        m.settledMs = ms;
        m.round = round;
      }
    }
    current = current && cursor ? mergePortfolio(current, result) : result;
    // The accepted client starts DeFi once the first wallet page is rendered.
    if (rounds === 0) trigger(heldIds(current.holdings), "FIRST_ROUND");
    cursor = result.continuation ?? undefined;
    rounds++;
  } while (cursor && rounds <= WALLET_CONTINUE);
  marks.fullWalletCoverageMs = at();
  o.onWalletDone?.(heldIds(current!.holdings), marks.fullWalletCoverageMs);
  return {
    marks,
    walletFirstResultMs: marks.firstPageCompleteMs,
    rounds,
    roundMs,
    final: current!,
    chains,
    events,
    firstAsset,
    firstPage: seen.firstPage,
    plan: seen.plan,
    scheduler,
  };
}
// DeFi rounds exactly like the client (held exact ids, continuation until empty, ≤ 20 rounds).
async function defiFlow(
  wallet: string,
  plane: DataPlane,
  opts: {
    held: string[];
    t0: number;
    priceRead: Parameters<typeof scanDefi>[2] extends infer O
      ? O extends { priceRead?: infer P }
        ? P
        : never
      : never;
    store?: Parameters<typeof scanDefi>[2] extends infer O
      ? O extends { store?: infer S }
        ? S
        : never
      : never;
    signal?: AbortSignal;
  },
) {
  const at = () => r1(performance.now() - opts.t0);
  const start = at();
  let firstResult: number | null = null;
  let continuation: string[] | undefined;
  let rounds = 0;
  const positions: string[] = [];
  for (let r = 0; r < 20; r++) {
    if (opts.signal?.aborted) break;
    const scan = await scanDefi(wallet, plane, {
      deploymentIds: continuation,
      held: opts.held.length ? opts.held : undefined,
      clientScope: "app-explicit-public-address",
      priceRead: opts.priceRead,
      store: opts.store,
      catalog: null,
      signal: opts.signal,
      onResult: () => {
        firstResult ??= at();
      },
    });
    rounds++;
    firstResult ??= at();
    positions.push(...scan.positions.map((p) => p.id));
    continuation = scan.continuation;
    if (!continuation.length) break;
  }
  return {
    startMs: start,
    firstDefiResultMs: firstResult,
    fullDefiScanMs: r1(at() - start),
    endMs: at(),
    rounds,
    positions: positions.length,
  };
}
// ---------------------------------------------------------------------------------------------------------------
function chainCensus(
  flow: Awaited<ReturnType<typeof walletFlow>>,
  records: Rec[],
  failureClass?: (id: string) => string | null,
) {
  const byChain = new Map<string, Rec[]>();
  for (const r of records.filter((x) => x.phase === "wallet"))
    byChain.set(r.chainId, [...(byChain.get(r.chainId) ?? []), r]);
  const cov = new Map(flow.final.coverage.map((c) => [c.chainId, c]));
  const rows = [...flow.chains.entries()].map(([chainId, m]) => {
    const rs = byChain.get(chainId) ?? [];
    const c = cov.get(chainId);
    const hs = flow.final.holdings.filter(
      (h) => h.chainId === chainId && BigInt(h.balance) > 0n,
    );
    const start = rs.length ? Math.min(...rs.map((r) => r.start)) : null;
    const end = rs.length ? Math.max(...rs.map((r) => r.end)) : null;
    return {
      chainId,
      wave: m.wave,
      priorityReasons: m.reasons,
      round: m.round,
      startMs: start,
      lastResponseMs: end,
      settledMs: m.settledMs,
      nativeEventMs: m.nativeMs,
      durationMs: start !== null && end !== null ? r1(end - start) : null,
      httpRequests: rs.length,
      rpcItems: rs.reduce((a, r) => a + r.methods.length, 0),
      retries: Math.max(
        0,
        rs.filter((r) => r.status !== "ok").length -
          (c?.state === "FAILED" ? 1 : 0),
      ),
      errors: rs.filter((r) => r.status !== "ok").map((r) => r.status),
      result: c?.state ?? "NOT_PLANNED",
      tier: c?.tier ?? null,
      reason: c?.reason ?? null,
      nativeNonzero: hs.some((h) => h.native),
      tokenNonzero: hs.some((h) => !h.native),
      failureClass: failureClass?.(chainId) ?? null,
    };
  });
  rows.sort(
    (a, b) =>
      (a.settledMs ?? Infinity) - (b.settledMs ?? Infinity) ||
      a.chainId.localeCompare(b.chainId),
  );
  return rows;
}
function memorySampler() {
  let peakRss = 0,
    peakHeap = 0;
  const sample = () => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  };
  sample();
  const timer = setInterval(sample, 25);
  return () => {
    clearInterval(timer);
    sample();
    return {
      peakRssMb: r1(peakRss / 2 ** 20),
      peakHeapUsedMb: r1(peakHeap / 2 ** 20),
    };
  };
}
// ---------------------------------------------------------------------------------------------------------------
async function fixture(
  profile: WalletProfile,
  runs: number,
  watch: boolean,
  withDefi: boolean,
) {
  const ww = buildWalletWorld();
  const seeded = seedWalletProfile(ww, profile);
  const log: Rec[] = [];
  let t0 = performance.now();
  const transport = recorder(
    ww.world.net.transport,
    log,
    () => t0,
    currentPhase,
    (url) => ww.operatorOf.get(url) ?? "UNKNOWN",
  );
  const plane = ww.plane(transport, seeded.store);
  const identity = { evm: seeded.wallet };
  const out = [];
  let previous: PortfolioResult | undefined;
  for (let i = 0; i < runs; i++) {
    clearScanStateForTests();
    await resetWalletCaches();
    ww.world.net.reset();
    log.length = 0;
    // The client's request inputs (V1.14.2 client; the V1.14.1 client sent the same `priority`): the connected
    // chain, then (on a refresh of the same wallet) chains this wallet already held value on.
    const known = previous
      ? [...previous.holdings]
          .filter((h) => !h.spam && BigInt(h.balance) > 0n)
          .sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
          .map((h) => h.chainId)
      : [];
    const priority = watch
      ? undefined
      : [...new Set([seeded.walletChain, ...known])].slice(0, 5);
    const hints = watch
      ? undefined
      : { recent: [...new Set(known)].slice(0, 24) };
    const stopMem = memorySampler();
    t0 = performance.now();
    let defi: Promise<Awaited<ReturnType<typeof defiFlow>>> | null = null;
    let defiHeldAtStart: string[] = [];
    let walletDoneHeld: string[] = [];
    const f = await walletFlow({
      identity,
      catalog: ww.catalog,
      t0,
      priority,
      hints,
      providers: () => [
        new SelfHostedPortfolioProvider(
          plane,
          ww.catalog,
          ww.priceRead,
          undefined,
          seeded.extraTokens,
        ),
      ],
      onDefiTrigger: (held) => {
        if (!withDefi) return;
        defiHeldAtStart = held;
        defi = inDefi(() =>
          defiFlow(seeded.wallet, plane, {
            held,
            t0,
            priceRead: ww.priceRead,
            store: ww.world.store,
          }),
        );
      },
      onWalletDone: (held) => (walletDoneHeld = held),
    });
    const defiResult = defi ? await defi : null;
    const mem = stopMem();
    const census = requestCensus(log.filter((r) => r.phase === "wallet"));
    const firstPageCut = f.marks.firstPageCompleteMs ?? Infinity;
    const rows = chainCensus(f, log, (id) => failureOf(id));
    out.push({
      run: i + 1,
      cache: i === 0 ? "COLD" : "WARM",
      mode: watch ? "watch" : "wallet",
      priority: priority ?? [],
      hints: hints ?? null,
      ...f.marks,
      walletFirstResultMs: f.walletFirstResultMs,
      rounds: f.rounds,
      roundMs: f.roundMs,
      chainsScheduled: rows.filter((r) => r.result !== "NOT_PLANNED").length,
      chainsRead: new Set(
        log.filter((r) => r.phase === "wallet").map((r) => r.chainId),
      ).size,
      coverage: f.final.coverageSummary,
      requests: census,
      requestsBeforeFirstPage: requestCensus(
        log.filter((r) => r.phase === "wallet" && r.start <= firstPageCut),
      ),
      concurrency: concurrency(log.filter((r) => r.phase === "wallet")),
      providerGroups: providerCensus(log.filter((r) => r.phase === "wallet")),
      firstAsset: f.firstAsset[0] ?? null,
      firstPage: f.firstPage,
      firstPageChains: rows
        .filter((r) => r.settledMs !== null && r.settledMs <= firstPageCut)
        .map((r) => ({
          chainId: r.chainId,
          wave: r.wave,
          reasons: r.priorityReasons,
          settledMs: r.settledMs,
          result: r.result,
        })),
      plan: f.plan
        ? {
            waves: (f.plan.chains as { wave: number }[]).reduce<
              Record<string, number>
            >((a, c) => ((a[c.wave] = (a[c.wave] ?? 0) + 1), a), {}),
          }
        : null,
      scheduler: f.scheduler,
      defi: defiResult
        ? {
            ...(defiResult as object),
            heldAtStart: defiHeldAtStart.length,
            heldAtWalletDone: walletDoneHeld.length,
            heldChanged:
              JSON.stringify(defiHeldAtStart) !==
              JSON.stringify(walletDoneHeld),
            // DeFi candidate truth: only held ids on networks hosting reviewed DeFi deployments admit candidates; a
            // change there is what makes the client restart DeFi once with the complete set.
            heldChangedOnDefiChains: (() => {
              const defiChains = new Set(
                ((f.plan as { defiChains?: string[] } | null)?.defiChains ??
                  []) as string[],
              );
              const on = (ids: string[]) =>
                JSON.stringify(
                  ids.filter((id) => defiChains.has(id.split(":")[0])),
                );
              return defiChains.size
                ? on(defiHeldAtStart) !== on(walletDoneHeld)
                : null;
            })(),
            requests: requestCensus(log.filter((r) => r.phase === "defi")),
          }
        : null,
      memory: mem,
      chainCensus: rows,
      economic: walletEconomics(f.final),
    });
    previous = f.final;
  }
  return {
    kind: "SIMULATED_MULTICHAIN_WALLET_FIXTURE",
    profile,
    wallet: seeded.wallet,
    expectedNonzero: seeded.expected,
    chains: ww.chains.length,
    latencyModel: {
      baseMs: 90,
      perItemMs: 0.2,
      jitter: 0.1,
      seed: 7,
      slowMs: 1200,
      timeoutMs: 9000,
    },
    route: { ...ROUTE, ...ROUTE_V1142 },
    context: context(),
    runs: out,
  };
}
async function resetWalletCaches() {
  // V1.14.2 adds process-level wallet-scan caches (chain result TTL, slow-chain memory); V1.14.1 has none beyond the
  // multicall-proof and price caches, which stay warm across warm runs by design. Import fails -> no-op.
  try {
    const m = (await import("../src/data/portfolio/" + "chain-cache")) as {
      clearWalletResultCacheForTests?: () => void;
    };
    m.clearWalletResultCacheForTests?.();
  } catch {
    /* V1.14.1: no wallet chain cache module. */
  }
}
async function resetAllWalletCaches() {
  try {
    const m = (await import("../src/data/portfolio/" + "chain-cache")) as {
      clearWalletCachesForTests?: () => void;
    };
    m.clearWalletCachesForTests?.();
  } catch {
    /* V1.14.1 */
  }
}
async function oracle() {
  const out: Record<string, unknown> = {};
  for (const profile of WALLET_PROFILES)
    for (const watch of [false, true]) {
      await resetAllWalletCaches();
      const f = await fixture(profile, 2, watch, false);
      out[`${profile}:${watch ? "watch" : "wallet"}`] = f.runs.map((r) => ({
        cache: r.cache,
        digest: r.economic.digest,
        holdingsDigest: r.economic.holdingsDigest,
        coverageDigest: r.economic.coverageDigest,
        defiDigest: r.economic.defiDigest,
        totalKnownUsd: r.economic.totalKnownUsd,
        assetCount: r.economic.assetCount,
        summary: r.economic.summary,
        economic: r.economic.economic,
      }));
    }
  return { kind: "WALLET_ECONOMIC_ORACLE", profiles: out, context: context() };
}
// ---------------------------------------------------------------------------------------------------------------
async function live(runs: number, withDefi: boolean) {
  const log: Rec[] = [];
  let t0 = performance.now();
  const transport = recorder(
    httpsTransport,
    log,
    () => t0,
    currentPhase,
    (_url, endpoint) =>
      (endpoint as { operatorGroup?: string | null }).operatorGroup ??
      "UNKNOWN",
  );
  const plane = new DataPlane(null, transport);
  const { upstreamRead } = await import("../src/adapters/routing-core");
  const catalog: Catalog = {
    networks: fallbackRegistry().routing,
    tools: [],
    generation: "perf",
    observedAt: Date.now(),
    stale: false,
  };
  const out = [];
  for (let i = 0; i < runs; i++) {
    clearScanStateForTests();
    await resetWalletCaches();
    log.length = 0;
    const stopMem = memorySampler();
    t0 = performance.now();
    let defi: Promise<Awaited<ReturnType<typeof defiFlow>>> | null = null;
    const f = await walletFlow({
      identity: { evm: LIVE_WALLET },
      catalog,
      t0,
      // "View another address": no connected chain, no previous-scan hints.
      providers: () => [
        new SelfHostedPortfolioProvider(plane, catalog, upstreamRead),
        new NativePortfolioProvider(),
      ],
      onDefiTrigger: (held) => {
        if (!withDefi) return;
        defi = inDefi(() =>
          defiFlow(LIVE_WALLET, plane, {
            held,
            t0,
            priceRead: upstreamRead,
          }),
        );
      },
    });
    const defiResult = defi ? await defi : null;
    const mem = stopMem();
    const firstPageCut = f.marks.firstPageCompleteMs ?? Infinity;
    const rows = chainCensus(f, log);
    out.push({
      run: i + 1,
      cache: i === 0 ? "COLD" : "WARM",
      ...f.marks,
      walletFirstResultMs: f.walletFirstResultMs,
      rounds: f.rounds,
      roundMs: f.roundMs,
      chainsScheduled: rows.filter((r) => r.result !== "NOT_PLANNED").length,
      checked: f.final.coverageSummary.checked,
      pending: f.final.coverageSummary.pending,
      failed: f.final.coverageSummary.failed,
      coverage: f.final.coverageSummary,
      requests: requestCensus(log.filter((r) => r.phase === "wallet")),
      requestsBeforeFirstPage: requestCensus(
        log.filter((r) => r.phase === "wallet" && r.start <= firstPageCut),
      ),
      concurrency: concurrency(log.filter((r) => r.phase === "wallet")),
      providerGroups: providerCensus(log.filter((r) => r.phase === "wallet")),
      firstAsset: f.firstAsset[0] ?? null,
      firstPage: f.firstPage,
      scheduler: f.scheduler,
      defi: defiResult
        ? {
            ...(defiResult as object),
            requests: requestCensus(log.filter((r) => r.phase === "defi")),
          }
        : null,
      memory: mem,
      chainCensus: rows,
      holdings: f.final.holdings
        .filter((h) => BigInt(h.balance) > 0n)
        .map((h) => ({
          chainId: h.chainId,
          symbol: h.symbol,
          native: h.native,
          usd: h.usd,
        })),
    });
    if (i + 1 < runs) await new Promise((r) => setTimeout(r, 5000));
  }
  return {
    kind: "REAL_READ_ONLY_PUBLIC_RPC_WALLET",
    wallet: LIVE_WALLET,
    note: "public protocol treasury contract from a pinned official source; never an identified person",
    route: { ...ROUTE, ...ROUTE_V1142 },
    context: context(),
    runs: out,
  };
}
// ---------------------------------------------------------------------------------------------------------------
const runs = Number(rest.find((x) => /^\d+$/.test(x)) ?? 3);
let result: unknown;
if (mode === "fixture")
  result = await fixture(
    profileArg as WalletProfile,
    runs,
    rest.includes("--watch"),
    rest.includes("--defi"),
  );
else if (mode === "oracle") result = await oracle();
else if (mode === "live") result = await live(runs, rest.includes("--defi"));
else throw Error("UNKNOWN_MODE");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode,
      argv: rest,
      unhandledRejections: {
        count: unhandled.length,
        samples: [...new Set(unhandled)].slice(0, 10),
      },
      ...(result as object),
    },
    null,
    1,
  ),
);
const brief = (r: { runs?: unknown[] }) =>
  (r.runs ?? []).map((x) => {
    const y = x as Record<string, unknown> & {
      requests?: { httpRequests: number; rpcItems: number };
      coverage?: Record<string, unknown>;
      concurrency?: unknown;
      defi?: Record<string, unknown> | null;
      memory?: unknown;
    };
    return {
      run: y.run,
      cache: y.cache,
      shell: y.walletShellReadyMs,
      firstAsset: y.firstMeaningfulAssetMs,
      firstPage: y.firstPageCompleteMs,
      full: y.fullWalletCoverageMs,
      rounds: y.rounds,
      http: y.requests?.httpRequests,
      items: y.requests?.rpcItems,
      checked: y.coverage?.checked,
      pending: y.coverage?.pending,
      failed: y.coverage?.failed,
      conc: y.concurrency,
      defi: y.defi
        ? {
            start: y.defi.startMs,
            first: y.defi.firstDefiResultMs,
            full: y.defi.fullDefiScanMs,
          }
        : null,
      mem: y.memory,
    };
  });
if (unhandled.length)
  console.log(JSON.stringify({ unhandledRejections: unhandled.length }));
console.log(
  JSON.stringify(
    mode === "oracle"
      ? Object.fromEntries(
          Object.entries(
            (result as { profiles: Record<string, { digest: string }[]> })
              .profiles,
          ).map(([k, v]) => [k, v.map((x) => x.digest.slice(0, 12))]),
        )
      : brief(result as { runs?: unknown[] }),
    null,
    1,
  ),
);
process.exit(0);
