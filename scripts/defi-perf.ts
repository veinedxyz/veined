// V1.14.1 DeFi scan performance harness (read-only; never signs or sends a transaction). It drives the same flow as the
// Portfolio client: the first wallet page, then DeFi rounds (held exact token ids, continuation until empty), and
// writes a machine-readable receipt. Only stable public APIs are used, so the identical harness measures the accepted
// V1.14 code (before) and the V1.14.1 code (after).
//   fixture <production|whale|zero> <out.json> [runs]   deterministic simulator (SYNTHETIC_TEST_ONLY); run 1 cold, 2..N warm
//   stress <out.json> [runs]                            multi-chain simulator: public-RPC rate limits, provider aggregate cap
//   census <out.json>                                   per-deployment isolated request census on the simulator
//   live <out.json> [runs] [--store]                    real read-only public RPC, one public protocol treasury address
//   search <out.json>                                   real accepted catalog search timings
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { decodeFunctionData, type Hex } from "viem";
import { DataPlane, fallbackRegistry } from "../src/data/plane";
import { httpsTransport, type RpcTransport } from "../src/data/rpc/transport";
import type { ApprovedEndpoint } from "../src/data/rpc/pool";
import { multicall3Abi, SELECTORS } from "../src/data/evm/erc20";
import { MULTICALL3 } from "../src/data/evm/multicall";
import { scanDefi, clearScanStateForTests } from "../src/defi/scanner";
import { deployments } from "../src/defi/registry";
import type {
  DefiScan,
  DeploymentCoverage,
  DefiPosition,
} from "../src/defi/model";
import type { DiscoveryStore } from "../src/defi/store";
import { scanPortfolio } from "../src/portfolio/service";
import {
  SelfHostedPortfolioProvider,
  curatedUniverse,
} from "../src/data/portfolio/provider";
import {
  loadCatalog,
  queryChains,
  queryProtocols,
} from "../src/defi/universe/store";
import type { Catalog } from "../src/routing/model";
import {
  buildWorld,
  census,
  seedProfile,
  simPriceRead,
  type SimProfile,
  type SimWorld,
} from "../tests/fixtures/defi-sim";
process.env.OTHERBRIDGE_DATA_LOG = "off";
// Recorded, never hidden: an unhandled rejection is a defect of the code under measurement (V1.14 `bounded()` leaves
// the work promise unobserved when its signal is already aborted). The receipt reports the count.
const unhandled: string[] = [];
process.on("unhandledRejection", (e) =>
  unhandled.push(String((e as Error)?.message ?? e).slice(0, 80)),
);
const [mode, outFile, ...rest] = process.argv.slice(2);
if (!mode || !outFile) throw Error("USAGE: defi-perf.ts <mode> <out.json> ...");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const round = (n: number) => Math.round(n * 10) / 10;
const LIVE_WALLET = "0x464c71f6c2f760dda6093dcb91c24c39e5d6e18c"; // Aave V3 Ethereum Collector (pinned official constant)
const context = (cache: "COLD" | "WARM") => ({
  node: process.version,
  platform: process.platform,
  cpu: cpus()[0]?.model?.trim(),
  logicalCpus: cpus().length,
  totalMemGb: +(totalmem() / 2 ** 30).toFixed(1),
  cache,
});
/** Economic digest: every value-bearing field of positions and coverage outcomes (no timing, scan ids or evidence). */
export function economicDigest(
  positions: DefiPosition[],
  coverage: DeploymentCoverage[],
) {
  const p = [...positions]
    .sort((a, b) => (a.id < b.id ? -1 : 1))
    .map((x) => ({
      id: x.id,
      supplied: x.supplied.map((a) => [
        a.assetId,
        a.rawAmount,
        a.decimals,
        a.symbol,
        a.valueUsd,
      ]),
      collateral: x.collateral.map((a) => [a.assetId, a.rawAmount, a.valueUsd]),
      borrowed: x.borrowed.map((a) => [a.assetId, a.rawAmount, a.valueUsd]),
      underlying: x.underlying.map((a) => [
        a.assetId,
        a.rawAmount,
        a.role,
        a.valueUsd,
      ]),
      rewards: x.rewards.map((r) => [r.asset.assetId, r.rawClaimable]),
      fees: (x.fees ?? []).map((a) => [a.assetId, a.rawAmount]),
      representations: [...x.representations].sort(),
      rewardsStatus: x.rewardsStatus,
      risk: x.risk,
      gross: x.grossAssetsUsd,
      debt: x.debtUsd,
      net: x.knownNetUsd,
      confidence: x.confidence,
      coverage: x.coverage,
      warnings: [...x.warnings].sort(),
      details: x.details,
      sourceBlock: x.sourceBlock,
    }));
  const c = [...coverage]
    .sort((a, b) => (a.deploymentId < b.deploymentId ? -1 : 1))
    .map((x) => [
      x.deploymentId,
      x.state,
      x.result,
      x.reason,
      x.scanResult ?? null,
    ]);
  return {
    positions: sha(JSON.stringify(p)),
    coverage: sha(JSON.stringify(c)),
    positionCount: positions.length,
    outcomes: c,
  };
}
interface FlowResult {
  walletFirstResultMs: number;
  walletHoldings: number;
  firstAdapterResultMs: number | null;
  firstDefiRoundMs: number;
  firstDefiResultMs: number;
  fullDefiScanMs: number;
  endToEndMs: number;
  rounds: {
    round: number;
    ms: number;
    deployments: number;
    adaptersRun: number;
    logicalReads: number;
    peakConcurrency: number;
  }[];
  candidates: number | null;
  funnel: unknown;
  signals: unknown;
  adaptersRun: number;
  logicalReads: number;
  coverage: DeploymentCoverage[];
  positions: DefiPosition[];
  peakConcurrency: number;
}
async function flow(opts: {
  wallet: string;
  plane: DataPlane;
  catalog: Catalog;
  priceRead: Parameters<typeof scanDefi>[2] extends infer O
    ? O extends { priceRead?: infer P }
      ? P
      : never
    : never;
  walletPriceRead: ConstructorParameters<typeof SelfHostedPortfolioProvider>[2];
  store?: DiscoveryStore;
  defiCatalog: Awaited<ReturnType<typeof loadCatalog>> | null;
  chains?: string[];
  skipWallet?: boolean;
  held?: string[];
  onDefiStart?: () => void;
}): Promise<FlowResult> {
  const t0 = performance.now();
  let holdings: {
    chainId: string;
    address: string;
    balance: string;
    spam?: boolean;
  }[] = [];
  let walletFirst = 0;
  if (!opts.skipWallet) {
    const page = await scanPortfolio(
      { evm: opts.wallet },
      opts.catalog,
      undefined,
      [
        new SelfHostedPortfolioProvider(
          opts.plane,
          opts.catalog,
          opts.walletPriceRead,
        ),
      ],
      {
        priority: ["1"],
        concurrency: 8,
        deadlineMs: 18000,
        perChainMs: 7000,
        maxChains: 2000,
      },
    );
    holdings = page.holdings;
    walletFirst = performance.now() - t0;
  }
  // The client sends exact held ids (never symbols) of nonzero, non-spam token balances.
  const held =
    opts.held ??
    [
      ...new Set(
        holdings
          .filter(
            (h) =>
              !h.spam &&
              /^0x[0-9a-fA-F]{40}$/.test(h.address) &&
              BigInt(h.balance) > 0n,
          )
          .map((h) => h.chainId + ":" + h.address.toLowerCase()),
      ),
    ]
      .filter((id) => /^\d{1,20}:0x[0-9a-f]{40}$/.test(id))
      .sort()
      .slice(0, 1000);
  opts.onDefiStart?.();
  const t1 = performance.now();
  let firstAdapter: number | null = null;
  let firstRound = 0;
  let continuation: string[] | undefined;
  const coverage: DeploymentCoverage[] = [];
  const positions: DefiPosition[] = [];
  const rounds: FlowResult["rounds"] = [];
  let first: DefiScan | undefined;
  let peak = 0;
  for (let r = 0; r < 20; r++) {
    const s = performance.now();
    const scan = await scanDefi(opts.wallet, opts.plane, {
      chains: opts.chains,
      deploymentIds: continuation,
      held: held.length ? held : undefined,
      clientScope: "app-explicit-public-address",
      priceRead: opts.priceRead,
      store: opts.store,
      catalog: async () => opts.defiCatalog,
      onProgress: (c) => {
        if (firstAdapter === null && c.calls > 0)
          firstAdapter = performance.now() - t0;
      },
    });
    first ??= scan;
    if (!firstRound) firstRound = performance.now() - t0;
    peak = Math.max(peak, scan.peakConcurrency);
    // Merge like the client: a deployment's latest coverage replaces earlier pending entries.
    for (const c of scan.coverage) {
      const i = coverage.findIndex((x) => x.deploymentId === c.deploymentId);
      if (i >= 0) coverage[i] = c;
      else coverage.push(c);
    }
    positions.push(...scan.positions);
    rounds.push({
      round: r + 1,
      ms: round(performance.now() - s),
      deployments: scan.coverage.filter((c) => c.state !== "PENDING").length,
      adaptersRun: scan.coverage.filter((c) => c.calls > 0).length,
      logicalReads: scan.coverage.reduce((a, c) => a + c.calls, 0),
      peakConcurrency: scan.peakConcurrency,
    });
    continuation = scan.continuation;
    if (!continuation.length) break;
  }
  const end = performance.now();
  return {
    walletFirstResultMs: round(walletFirst),
    walletHoldings: holdings.filter((h) => BigInt(h.balance) > 0n).length,
    firstAdapterResultMs: firstAdapter === null ? null : round(firstAdapter),
    firstDefiRoundMs: round(firstRound),
    // UI-visible first DeFi result: the first round response (V1.14 has no streaming; V1.14.1 adds a streamed path
    // measured separately as firstAdapterResultMs, which is what a streaming client renders first).
    firstDefiResultMs: round(firstRound),
    fullDefiScanMs: round(end - t1),
    endToEndMs: round(end - t0),
    rounds,
    candidates: first?.receipt?.funnel.candidateDeployments ?? null,
    funnel: first?.receipt?.funnel ?? null,
    signals: first?.receipt?.signals ?? null,
    adaptersRun: coverage.filter((c) => c.calls > 0).length,
    logicalReads: coverage.reduce((a, c) => a + c.calls, 0),
    coverage,
    positions,
    peakConcurrency: peak,
  };
}
const routingCatalog = (): Catalog => ({
  networks: fallbackRegistry().routing,
  tools: [],
  generation: "perf",
  observedAt: Date.now(),
  stale: false,
});
function simPlane(world: SimWorld, chains: string[], endpointsPerChain = 1) {
  const base = fallbackRegistry();
  const endpoints: ApprovedEndpoint[] = chains.flatMap((c) =>
    world.net.endpoints(c, endpointsPerChain),
  );
  const reg = { ...base, endpoints };
  return new DataPlane(null, world.net.transport, 60000, () => reg);
}
function seedWalletTokens(world: SimWorld, chains: string[]) {
  for (const chainId of chains) {
    const chain = world.net.chains.get(chainId)!;
    for (const a of curatedUniverse(chainId))
      if (!chain.contracts.has(a.address))
        chain.token(a.address, a.symbol ?? "TKN", a.decimals ?? 18);
  }
}
function summarize(
  f: FlowResult,
  records: SimWorld["net"]["log"],
  walletCut: number,
) {
  const defi = census(records.slice(walletCut));
  return {
    walletFirstResultMs: f.walletFirstResultMs,
    firstAdapterResultMs: f.firstAdapterResultMs,
    firstDefiResultMs: f.firstDefiResultMs,
    fullDefiScanMs: f.fullDefiScanMs,
    endToEndMs: f.endToEndMs,
    rounds: f.rounds,
    candidates: f.candidates,
    funnel: f.funnel,
    signals: f.signals,
    adaptersRun: f.adaptersRun,
    logicalReads: f.logicalReads,
    peakConcurrency: f.peakConcurrency,
    wallet: census(records.slice(0, walletCut)),
    defi,
    states: f.coverage.reduce<Record<string, number>>(
      (a, c) => ((a[c.state] = (a[c.state] ?? 0) + 1), a),
      {},
    ),
    scanResults: f.coverage.reduce<Record<string, number>>(
      (a, c) => (
        (a[c.scanResult ?? "?"] = (a[c.scanResult ?? "?"] ?? 0) + 1),
        a
      ),
      {},
    ),
    perDeployment: f.coverage
      .filter((c) => c.calls > 0 || c.state === "FAILED")
      .map((c) => ({
        id: c.deploymentId,
        state: c.state,
        reason: c.reason,
        scanResult: c.scanResult,
        logicalReads: c.calls,
        batches: c.batches,
        fallbacks: c.fallbacks,
        errors: c.errors,
        ms: c.durationMs,
      })),
    economic: economicDigest(f.positions, f.coverage),
  };
}
async function fixture(
  profile: SimProfile,
  runs: number,
  kind: "fixture" | "stress",
) {
  const chains =
    kind === "stress" ? ["1", "8453", "42161", "10", "137", "56"] : ["1"];
  const world = buildWorld({
    chains,
    latencyMs: 90,
    perItemMs: 0.2,
    jitter: 0.1,
    morphoMarkets: 1814,
    morphoVaults: 382,
  });
  seedWalletTokens(world, chains);
  if (kind === "stress") {
    // Public-RPC conditions: chain 1 throttles at 25 requests/s and caps aggregates at 300 inner calls; chain 137 is slow.
    world.net.behavior.set(`https://rpc0.sim.test/1`, {
      latencyMs: 90,
      perItemMs: 0.2,
      jitter: 0.1,
      ratePerSecond: 25,
      maxAggregateInner: 300,
    });
    world.net.behavior.set(`https://rpc0.sim.test/137`, {
      latencyMs: 1200,
      perItemMs: 0.5,
      jitter: 0.1,
    });
  }
  const wallet = seedProfile(world, profile);
  const plane = simPlane(world, chains);
  const catalog = routingCatalog();
  const defiCatalog = await loadCatalog().catch(() => null);
  const priceRead = simPriceRead(world);
  const out = [];
  for (let i = 0; i < runs; i++) {
    clearScanStateForTests();
    world.net.reset();
    const records = world.net.log;
    let cut = 0;
    const f = await flow({
      wallet,
      plane,
      catalog,
      priceRead,
      walletPriceRead: null,
      store: world.store,
      defiCatalog,
      chains,
      onDefiStart: () => (cut = records.length),
    });
    out.push({
      run: i + 1,
      cache: i === 0 ? "COLD" : "WARM",
      ...summarize(f, records, cut),
      metadataCache: await cacheStats(),
    });
  }
  return {
    kind: kind === "stress" ? "SIMULATED_STRESS" : "SIMULATED_FIXTURE",
    profile,
    wallet,
    chains,
    latencyModel: { baseMs: 90, perItemMs: 0.2, jitter: 0.1, seed: 7 },
    context: context("COLD"),
    runs: out,
  };
}
async function censusMode() {
  const chains = ["1", "8453", "10"];
  const world = buildWorld({
    chains,
    latencyMs: 90,
    perItemMs: 0.2,
    jitter: 0,
    morphoMarkets: 1814,
    morphoVaults: 382,
  });
  const wallet = seedProfile(world, "production");
  const plane = simPlane(world, chains);
  const priceRead = simPriceRead(world);
  const held = world.held(wallet);
  const families = [
    "aave-v3",
    "compound-iii",
    "morpho-blue",
    "morpho-vault",
    "uniswap-v2",
    "uniswap-v3",
    "lido",
    "curve",
    "balancer-v2",
    "solidly-v2",
    "erc4626",
    "lst-rate",
    "eigenlayer",
  ];
  const rows = [];
  for (const d of deployments.filter(
    (x) => chains.includes(x.chainId) && families.includes(x.adapter),
  )) {
    for (const cache of ["COLD", "WARM"] as const) {
      if (cache === "COLD") await resetMetadataCaches();
      clearScanStateForTests();
      world.net.reset();
      const s = performance.now();
      const scan = await scanDefi(wallet, plane, {
        deploymentIds: [d.id],
        held,
        clientScope: "census",
        priceRead,
        store: world.store,
        catalog: null,
      });
      const ms = performance.now() - s;
      const c = scan.coverage.find((x) => x.deploymentId === d.id)!;
      const k = census(world.net.log);
      rows.push({
        deploymentId: d.id,
        family: d.adapter,
        chainId: d.chainId,
        cache,
        state: c.state,
        reason: c.reason,
        scanResult: c.scanResult,
        positions: scan.positions.length,
        logicalReads: c.calls,
        httpRequests: k.httpRequests,
        rpcItems: k.rpcItems,
        multicallBatches: k.multicallBatches,
        innerCalls: k.innerCalls,
        jsonRpcBatches: k.jsonRpcBatches,
        retries: (c as { retries?: number }).retries ?? null,
        cooldownSkips: (c as { cooldownSkips?: number }).cooldownSkips ?? null,
        cacheHits: (c as { cacheHits?: number }).cacheHits ?? null,
        fallbacks: c.fallbacks,
        errors: c.errors,
        durationMs: round(ms),
        byMethod: k.byMethod,
      });
    }
  }
  return {
    kind: "SIMULATED_PER_DEPLOYMENT_CENSUS",
    wallet,
    latencyModel: { baseMs: 90, perItemMs: 0.2, jitter: 0 },
    context: context("COLD"),
    rows,
  };
}
async function cacheStats() {
  // V1.14.1 metadata cache census (absent in V1.14: null).
  try {
    const m = (await import("../src/defi/" + "cache")) as {
      metadataCacheStats?: () => unknown;
    };
    return m.metadataCacheStats?.() ?? null;
  } catch {
    return null;
  }
}
async function resetMetadataCaches() {
  // V1.14.1 adds process-wide static metadata caches; the accepted V1.14 code has none (import fails -> no-op).
  try {
    const m = (await import("../src/defi/" + "cache")) as {
      clearDefiMetadataCacheForTests?: () => void;
    };
    m.clearDefiMetadataCacheForTests?.();
  } catch {
    /* V1.14: no static cache module. */
  }
}
interface LiveRecord {
  group: string;
  at: number;
  host: string;
  chainId: string;
  kind: "single" | "batch";
  methods: string[];
  aggregates: number;
  inner: number;
  status: string;
  ms: number;
}
function countingTransport(log: LiveRecord[]): RpcTransport {
  return async (endpoint, body, options) => {
    const reqs = (Array.isArray(body) ? body : [body]) as {
      method: string;
      params: unknown[];
    }[];
    let aggregates = 0,
      inner = 0;
    for (const r of reqs)
      if (r.method === "eth_call") {
        const p = r.params[0] as { to?: string; data?: string };
        if (
          p?.to?.toLowerCase() === MULTICALL3 &&
          p.data?.startsWith(SELECTORS.aggregate3)
        ) {
          aggregates++;
          try {
            inner += (
              decodeFunctionData({ abi: multicall3Abi, data: p.data as Hex })
                .args[0] as unknown[]
            ).length;
          } catch {
            /* counted as an aggregate only */
          }
        }
      }
    const rec: LiveRecord = {
      at: Date.now(),
      // Operator identity (V1.5 provenance): different URLs of one operator are one provider group.
      group:
        (endpoint as { operatorGroup?: string | null }).operatorGroup ??
        "UNKNOWN",
      host: new URL(endpoint.url).host,
      chainId: endpoint.chainId,
      kind: Array.isArray(body) ? "batch" : "single",
      methods: reqs.map((r) => r.method),
      aggregates,
      inner,
      status: "ok",
      ms: 0,
    };
    log.push(rec);
    const s = performance.now();
    try {
      return await httpsTransport(endpoint, body, options);
    } catch (e) {
      rec.status = (e as { code?: string }).code ?? "ERROR";
      throw e;
    } finally {
      rec.ms = round(performance.now() - s);
    }
  };
}
function liveCensus(records: LiveRecord[]) {
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
    hosts: [...new Set(records.map((r) => r.host))],
    byOperatorGroup: records.reduce<Record<string, number>>(
      (a, r) => ((a[r.group] = (a[r.group] ?? 0) + 1), a),
      {},
    ),
    byHostStatus: records.reduce<Record<string, number>>(
      (a, r) => (
        (a[r.host + " " + r.status] = (a[r.host + " " + r.status] ?? 0) + 1),
        a
      ),
      {},
    ),
    meanRequestMs: records.length
      ? round(records.reduce((a, r) => a + r.ms, 0) / records.length)
      : 0,
  };
}
/** Exact semantics of the accepted V1.14 measurement (one first-pass scanDefi, chain 1, extended deadlines, no held). */
async function live114(runs: number) {
  const log: LiveRecord[] = [];
  const plane = new DataPlane(null, countingTransport(log));
  const index = await loadCatalog();
  const out = [];
  for (let i = 0; i < runs; i++) {
    clearScanStateForTests();
    log.length = 0;
    const s = performance.now();
    const scan = await scanDefi(LIVE_WALLET, plane, {
      chains: ["1"],
      clientScope: "v114-perf",
      deadlineMs: 120000,
      perAdapterMs: 40000,
      catalog: async () => index,
    });
    out.push({
      run: i + 1,
      cache: i === 0 ? "COLD" : "WARM",
      elapsedMs: Math.round(performance.now() - s),
      positions: scan.positions.length,
      coverage: scan.coverage.map((c) => [
        c.deploymentId,
        c.state,
        c.reason,
        c.scanResult ?? null,
        c.calls,
        c.durationMs,
      ]),
      continuation: scan.continuation.length,
      receipt: scan.receipt,
      peakConcurrency: scan.peakConcurrency,
      defi: liveCensus(log),
    });
    if (i + 1 < runs) await new Promise((r) => setTimeout(r, 5000));
  }
  return {
    kind: "REAL_READ_ONLY_PUBLIC_RPC_V114_METHOD",
    wallet: LIVE_WALLET,
    method:
      "scanDefi(chains:[1], deadlineMs:120000, perAdapterMs:40000, no held) first pass",
    context: context("COLD"),
    runs: out,
  };
}
async function live(runs: number, withStore: boolean, withWallet: boolean) {
  const log: LiveRecord[] = [];
  const plane = new DataPlane(null, countingTransport(log));
  let store: DiscoveryStore | undefined;
  if (withStore) {
    const url = process.env.OTHERBRIDGE_DATA_DATABASE_URL;
    if (!url) throw Error("STORE_URL_REQUIRED");
    const { connect } = await import("../src/data/store/postgres");
    const { PostgresDefiStore } = await import("../src/defi/store");
    store = new PostgresDefiStore(
      connect(url, { max: 2, application: "otherbridge-perf" }),
    );
  }
  const defiCatalog = await loadCatalog().catch(() => null);
  const { upstreamRead } = await import("../src/adapters/routing-core");
  const catalog = routingCatalog();
  const out = [];
  for (let i = 0; i < runs; i++) {
    clearScanStateForTests();
    log.length = 0;
    let defiStart = 0;
    const f = await flow({
      wallet: LIVE_WALLET,
      plane,
      catalog,
      priceRead: upstreamRead,
      walletPriceRead: upstreamRead,
      store,
      defiCatalog,
      chains: ["1"],
      skipWallet: !withWallet,
      onDefiStart: () => (defiStart = log.length),
    });
    const walletRecords = log.slice(0, defiStart);
    const defiRecords = log.slice(defiStart);
    out.push({
      run: i + 1,
      cache: i === 0 ? "COLD" : "WARM",
      walletFirstResultMs: withWallet ? f.walletFirstResultMs : null,
      firstAdapterResultMs: f.firstAdapterResultMs,
      firstDefiResultMs: f.firstDefiResultMs,
      fullDefiScanMs: f.fullDefiScanMs,
      endToEndMs: f.endToEndMs,
      rounds: f.rounds,
      candidates: f.candidates,
      funnel: f.funnel,
      signals: f.signals,
      adaptersRun: f.adaptersRun,
      logicalReads: f.logicalReads,
      peakConcurrency: f.peakConcurrency,
      wallet: withWallet ? liveCensus(walletRecords) : null,
      defi: liveCensus(defiRecords),
      states: f.coverage.reduce<Record<string, number>>(
        (a, c) => ((a[c.state] = (a[c.state] ?? 0) + 1), a),
        {},
      ),
      perDeployment: f.coverage.map((c) => ({
        id: c.deploymentId,
        state: c.state,
        reason: c.reason,
        scanResult: c.scanResult,
        logicalReads: c.calls,
        batches: c.batches,
        fallbacks: c.fallbacks,
        errors: c.errors,
        ms: c.durationMs,
      })),
      positions: f.positions.map((p) => ({
        id: p.id,
        coverage: p.coverage,
        supplied: p.supplied.length,
        borrowed: p.borrowed.length,
        warnings: p.warnings,
      })),
      economic: economicDigest(f.positions, f.coverage),
    });
    if (i + 1 < runs) await new Promise((r) => setTimeout(r, 5000));
  }
  return {
    kind: "REAL_READ_ONLY_PUBLIC_RPC",
    wallet: LIVE_WALLET,
    note: "public protocol treasury contract from a pinned official source; never an identified person",
    chains: ["1"],
    store: withStore ? "LOCAL_POSTGRES_REGISTRY_LANES" : "NONE",
    context: context("COLD"),
    runs: out,
  };
}
async function search() {
  const t0 = performance.now();
  const index = await loadCatalog();
  const loadMs = performance.now() - t0;
  const terms = [
    "aave",
    "uni",
    "curve",
    "lido",
    "morpho",
    "pancake",
    "spark",
    "eth",
    "swap",
    "lend",
    "vault",
    "bridge",
    "x",
    "a",
    "stake",
    "restake",
    "perp",
    "option",
    "yield",
    "farm",
  ];
  const times: number[] = [];
  for (let r = 0; r < 10; r++)
    for (const q of terms) {
      const s = performance.now();
      queryProtocols(index, { q, status: "ALL", limit: 50 });
      times.push(performance.now() - s);
    }
  const chainTimes: number[] = [];
  for (const q of ["eth", "sol", "base", "arb", "cosmos", "bit"]) {
    const s = performance.now();
    queryChains(index, { q, status: "ALL", limit: 50 });
    chainTimes.push(performance.now() - s);
  }
  const pct = (v: number[], p: number) =>
    [...v].sort((a, b) => a - b)[
      Math.min(v.length - 1, Math.floor((v.length * p) / 100))
    ];
  return {
    kind: "REAL_CATALOG_SEARCH",
    catalogVersion: index.universe.syncId,
    catalogLoadMs: Math.round(loadMs),
    protocolSearch: {
      queries: times.length,
      p50Ms: +pct(times, 50).toFixed(2),
      p95Ms: +pct(times, 95).toFixed(2),
    },
    chainSearch: {
      queries: chainTimes.length,
      p95Ms: +pct(chainTimes, 95).toFixed(2),
    },
    context: context("COLD"),
  };
}
const runs = Number(rest.find((x) => /^\d+$/.test(x)) ?? 3);
let result: unknown;
if (mode === "fixture")
  result = await fixture(
    (rest[0] as SimProfile) ?? "production",
    Number(rest[1] ?? 3),
    "fixture",
  );
else if (mode === "stress")
  result = await fixture("production", runs, "stress");
else if (mode === "census") result = await censusMode();
else if (mode === "live")
  result = await live(
    runs,
    rest.includes("--store"),
    !rest.includes("--no-wallet"),
  );
else if (mode === "live114") result = await live114(runs);
else if (mode === "search") result = await search();
else throw Error("UNKNOWN_MODE");
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(
  outFile,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      mode,
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
      defi?: { httpRequests: number; rpcItems: number; rateLimited?: number };
      receipt?: { slowest?: unknown; rpcCalls?: number };
    };
    return {
      run: y.run,
      cache: y.cache,
      walletFirst: y.walletFirstResultMs,
      firstAdapter: y.firstAdapterResultMs,
      firstDefi: y.firstDefiResultMs,
      fullDefi: y.fullDefiScanMs,
      elapsed: y.elapsedMs,
      http: y.defi?.httpRequests,
      rpcItems: y.defi?.rpcItems,
      rl: y.defi?.rateLimited,
      states: y.states,
      slowest: y.receipt?.slowest,
      logical: y.receipt?.rpcCalls,
    };
  });
if (unhandled.length)
  console.log(JSON.stringify({ unhandledRejections: unhandled.length }));
console.log(
  JSON.stringify(
    mode === "census"
      ? { rows: (result as { rows: unknown[] }).rows.length }
      : mode === "search"
        ? result
        : brief(result as { runs?: unknown[] }),
    null,
    1,
  ),
);
process.exit(0);
