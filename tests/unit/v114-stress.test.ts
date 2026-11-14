import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  auditParity,
  normalizeUniverse,
} from "../../src/defi/universe/normalize";
import { parseUniverse, serializeUniverse } from "../../src/defi/universe/io";
import {
  buildIndex,
  coverageReport,
  protocolDetail,
  queryChains,
  queryProtocols,
} from "../../src/defi/universe/store";
import { buildQueue } from "../../src/defi/universe/queue";
import { defaultTierConfig } from "../../src/data/registry/chains";
import { portfolioTotals, exposureGraph } from "../../src/defi/valuation";
import {
  scanSchema,
  type DefiPosition,
  type PositionAsset,
} from "../../src/defi/model";
// V1.14 stress and performance gates on SYNTHETIC catalogs/portfolios (no network). Timing results are written to
// V114_PERF_OUT when set (evidence run); assertions use generous ceilings so slower CI hosts stay deterministic.
const perf: Record<string, unknown> = {};
const ms = (t: number) => Math.round((performance.now() - t) * 10) / 10;
const pct = (values: number[], p: number) =>
  [...values].sort((a, b) => a - b)[
    Math.min(values.length - 1, Math.floor((values.length * p) / 100))
  ];
const CHAINS = 5000,
  PROTOCOLS = 20000,
  PER_PROTOCOL = 5;
const categories = [
  "Lending",
  "Dexs",
  "Liquid Staking",
  "Yield",
  "CDP",
  "Derivatives",
  "Bridge",
  "Restaking",
  "RWA",
  "CEX",
];
function synthetic() {
  const chains = Array.from({ length: CHAINS }, (_, i) => ({
    name: "Stress Chain " + i,
    chainId: 900000 + i,
    tvl: (CHAINS - i) * 1000,
    tokenSymbol: "S" + i,
    gecko_id: null,
  }));
  const chainCoingeckoIds = Object.fromEntries(
    chains.map((c, i) => [
      c.name,
      {
        chainId: c.chainId,
        categories: [i % 50 === 0 ? "Cosmos" : "EVM"],
        geckoId: null,
      },
    ]),
  );
  const protocols = Array.from({ length: PROTOCOLS }, (_, i) => {
    const names = Array.from(
      { length: PER_PROTOCOL },
      (_, k) => "Stress Chain " + ((i * 7 + k * 911) % CHAINS),
    );
    return {
      id: String(100000 + i),
      name: "Stress Protocol " + i,
      slug: "stress-protocol-" + i,
      category: categories[i % categories.length],
      chains: names,
      tvl: (PROTOCOLS - i) * 10,
      chainTvls: Object.fromEntries(names.map((n) => [n, 1])),
      url: "https://protocol" + i + ".example/",
      module: "stress/" + i + ".js",
      listedAt: 1650000000,
    };
  });
  return {
    protocols,
    chains,
    config: { chainCoingeckoIds, chainKeyToLabelMap: {}, parentProtocols: [] },
  };
}
const registries = {
  rpcChains: new Set<string>(),
  multicallChains: new Set<string>(),
  tiers: defaultTierConfig,
  routingChains: new Set<string>(),
  customChains: new Set<string>(),
  deployments: [],
};
describe("V1.14 long-catalog stress (5,000 chains, 20,000 protocols, 100,000 protocol-chain rows)", () => {
  const raw = synthetic();
  let t = performance.now();
  const result = normalizeUniverse(raw, {
    syncId: "stress-sync",
    generatedAt: "2026-10-11T00:00:00.000Z",
    sources: [],
    identities: [],
    chainlist: {},
  });
  perf.normalizeMs = ms(t);
  t = performance.now();
  const text = serializeUniverse(result.universe);
  perf.serializeMs = ms(t);
  perf.catalogBytes = Buffer.byteLength(text);
  t = performance.now();
  const parsed = parseUniverse(text);
  perf.parseMs = ms(t);
  t = performance.now();
  const index = buildIndex(parsed, "e".repeat(64), registries);
  perf.indexMs = ms(t);
  it("accounts for every synthetic chain, protocol and relation without silent omission", () => {
    expect(result.universe.protocols).toHaveLength(PROTOCOLS);
    expect(result.universe.chains.filter((c) => c.inChainCatalog)).toHaveLength(
      CHAINS,
    );
    expect(result.universe.rows.length).toBe(PROTOCOLS * PER_PROTOCOL);
    const parity = auditParity(raw, result);
    expect(parity.missingChains).toEqual([]);
    expect(parity.missingProtocols).toEqual([]);
    expect(parsed.protocols).toHaveLength(PROTOCOLS);
    expect(perf.normalizeMs as number).toBeLessThan(60000);
    expect(perf.indexMs as number).toBeLessThan(60000);
  });
  it("search, filter and cursor pagination stay bounded on the long catalog", () => {
    const times: number[] = [];
    for (let i = 0; i < 200; i++) {
      const s = performance.now();
      const r = queryProtocols(index, {
        q: "protocol " + ((i * 97) % PROTOCOLS),
        limit: 50,
      });
      times.push(performance.now() - s);
      expect(r.items.length).toBeGreaterThan(0);
      expect(r.items.length).toBeLessThanOrEqual(50);
    }
    perf.searchP50Ms = Math.round(pct(times, 50) * 100) / 100;
    perf.searchP95Ms = Math.round(pct(times, 95) * 100) / 100;
    expect(perf.searchP95Ms as number).toBeLessThan(1000);
    const filters: number[] = [];
    for (const category of [
      "lending",
      "dex",
      "liquid-staking",
      "derivatives",
    ]) {
      const s = performance.now();
      const r = queryProtocols(index, { category, status: "ALL", limit: 100 });
      filters.push(performance.now() - s);
      expect(r.items.every((p) => p.productCategory === category)).toBe(true);
    }
    perf.filterP95Ms = Math.round(pct(filters, 95) * 100) / 100;
    let cursor: string | null | undefined;
    let pages = 0,
      seen = 0;
    const s = performance.now();
    do {
      const r = queryChains(index, { cursor, limit: 100, status: "ALL" });
      seen += r.items.length;
      cursor = r.nextCursor;
      pages++;
    } while (cursor && pages < 1000);
    perf.chainPaginationMs = ms(s);
    perf.chainPages = pages;
    expect(seen).toBe(index.universe.chains.length);
    const d = protocolDetail(index, "llama:100042");
    expect(d?.chains.length).toBe(PER_PROTOCOL);
  });
  it("coverage report and adapter queue cover every synthetic protocol", () => {
    let s = performance.now();
    const report = coverageReport(index);
    perf.coverageReportMs = ms(s);
    const headline = Object.values(report.protocolHeadline).reduce(
      (a, b) => a + (b ?? 0),
      0,
    );
    expect(headline).toBe(PROTOCOLS);
    // No synthetic protocol can be position-capable: none is linked to a reviewed adapter.
    expect(report.protocolHeadline.FULL_POSITION ?? 0).toBe(0);
    s = performance.now();
    const queue = buildQueue(index);
    perf.queueMs = ms(s);
    expect(queue.length).toBeGreaterThan(0);
    expect(queue.length).toBeLessThanOrEqual(PROTOCOLS);
  });
});
describe("V1.14 portfolio stress (500 positions, 2,000 assets, 100 debts, 500 rewards)", () => {
  const W = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
  const asset = (
    i: number,
    role: PositionAsset["role"],
    priced = true,
  ): PositionAsset => ({
    assetId: "1:0x" + (i + 1).toString(16).padStart(40, "0"),
    chainId: "1",
    contract: "0x" + (i + 1).toString(16).padStart(40, "0"),
    symbol: "T" + i,
    decimals: 18,
    rawAmount: (10n ** 18n * BigInt(i + 1)).toString(),
    role,
    valueUsd: priced ? (i + 1).toFixed(6) : null,
  });
  const positions: DefiPosition[] = Array.from({ length: 500 }, (_, i) => ({
    id: "stress:" + i,
    wallet: W,
    chainId: "1",
    deploymentId: "stress-" + (i % 25),
    protocolId: "stress-" + (i % 25),
    protocolName: "Stress " + (i % 25),
    category: "lending",
    positionKey: String(i),
    adapterVersion: "1.1.0",
    sourceBlock: "1",
    sourceBlockHash: "0x" + "ab".repeat(32),
    observedAt: Date.now(),
    supplied: [0, 1, 2, 3].map((k) =>
      asset((i * 4 + k) % 1500, "supplied", (i + k) % 37 !== 0),
    ),
    collateral: [],
    borrowed: i < 100 ? [asset(1500 + i, "borrowed", i % 13 !== 0)] : [],
    underlying: [],
    representations: [],
    rewards: [
      {
        asset: asset(1700 + i, "reward"),
        rawClaimable: "1",
        sourceContract: "0x" + "1".padStart(40, "0"),
        confidence: "protocol-view",
        observedAt: Date.now(),
      },
    ],
    rewardsStatus: "CHECKED",
    risk: { kind: "not-available", reason: "NOT_APPLICABLE" },
    grossAssetsUsd: "4.000000",
    debtUsd: i < 100 ? "1.000000" : "0.000000",
    knownNetUsd: "3.000000",
    confidence: "EXACT_WITH_PRICE",
    coverage: "FULL_POSITION",
    warnings: [],
    evidence: [],
    details: {},
  }));
  it("totals, exposure graph and schema validation stay fast and exact", () => {
    const scan = {
      version: 2 as const,
      wallet: W,
      scanId: "stress",
      observedAt: Date.now(),
      positions,
      coverage: [],
      replacedWalletAssets: [],
      replacementOwners: {},
      continuation: [],
      nonEvm: "NOT_CHECKED" as const,
      elapsedMs: 1,
      peakConcurrency: 1,
    };
    let s = performance.now();
    const t = portfolioTotals([], scan);
    perf.portfolioTotalsMs = ms(s);
    expect(t.defiUsd).toBe((500 * 4).toFixed(6));
    expect(t.debtUsd).toBe((100 * 1).toFixed(6));
    expect(t.rewardsUsd).not.toBe("0.000000");
    expect(t.knownNetUsd).toBe((2000 - 100).toFixed(6));
    expect(t.unpricedDebt).toBe(8);
    s = performance.now();
    const graph = exposureGraph(positions);
    perf.exposureGraphMs = ms(s);
    expect(graph.length).toBe(1600);
    expect(graph.reduce((a, n) => a + n.positions.length, 0)).toBe(
      500 * 4 + 100,
    );
    s = performance.now();
    scanSchema.parse(scan);
    perf.scanSchemaParseMs = ms(s);
    expect(
      (perf.portfolioTotalsMs as number) + (perf.exposureGraphMs as number),
    ).toBeLessThan(5000);
    if (process.env.V114_PERF_OUT)
      writeFileSync(
        process.env.V114_PERF_OUT,
        JSON.stringify(
          {
            kind: "SYNTHETIC_STRESS",
            chains: CHAINS,
            protocols: PROTOCOLS,
            rows: PROTOCOLS * PER_PROTOCOL,
            positions: 500,
            assets: 2000,
            debts: 100,
            rewards: 500,
            node: process.version,
            ...perf,
          },
          null,
          2,
        ),
      );
  });
});
