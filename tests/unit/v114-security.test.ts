import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  normalizeUniverse,
  parseChainlistText,
  type RawSources,
} from "../../src/defi/universe/normalize";
import { computeCoverage } from "../../src/defi/universe/coverage";
import { parseUniverse, serializeUniverse } from "../../src/defi/universe/io";
import {
  buildIndex,
  protocolDetail,
  queryProtocols,
  CatalogQueryError,
} from "../../src/defi/universe/store";
import { defaultTierConfig } from "../../src/data/registry/chains";
// V1.14 adversarial catalog inputs (all upstream metadata is untrusted). Fixtures are synthetic.
const dir = "tests/fixtures/defi-universe/";
const load = (): RawSources & { protocols: Record<string, unknown>[] } => ({
  protocols: JSON.parse(readFileSync(dir + "protocols.json", "utf8")),
  chains: JSON.parse(readFileSync(dir + "chains.json", "utf8")),
  config: JSON.parse(readFileSync(dir + "config.json", "utf8")),
});
const identities = [
  {
    id: "1",
    chainId: "1",
    caip2: "eip155:1",
    name: "Ethereum",
    ecosystem: "EVM",
  },
  {
    id: "8453",
    chainId: "8453",
    caip2: "eip155:8453",
    name: "Base",
    ecosystem: "EVM",
  },
];
const chainlist = parseChainlistText(readFileSync(dir + "chainIds.js", "utf8"));
const run = (raw: RawSources) =>
  normalizeUniverse(raw, {
    syncId: "security-sync",
    generatedAt: "2026-10-11T00:00:00.000Z",
    sources: [],
    identities,
    chainlist,
  });
const deployments = [
  { id: "aave-v3-1", protocolId: "aave-v3", chainId: "1", adapter: "aave-v3" },
  {
    id: "uniswap-v3-1",
    protocolId: "uniswap-v3",
    chainId: "1",
    adapter: "uniswap-v3",
  },
  {
    id: "uniswap-v2-1",
    protocolId: "uniswap-v2",
    chainId: "1",
    adapter: "uniswap-v2",
  },
];
const registries = {
  rpcChains: new Set(["1", "8453"]),
  multicallChains: new Set(["1"]),
  tiers: defaultTierConfig,
  routingChains: new Set(["1"]),
  customChains: new Set<string>(),
  deployments,
};
const extra = (row: Record<string, unknown>) => {
  const raw = load();
  raw.protocols.push({
    category: "Dexs",
    chains: ["Ethereum"],
    tvl: 1,
    chainTvls: { Ethereum: 1 },
    ...row,
  });
  return raw;
};
describe("V1.14 catalog security: untrusted upstream metadata", () => {
  it("logos and arbitrary upstream fields are never stored, served or rendered", () => {
    const r = run(
      extra({
        id: "9901",
        name: "Logo Bomb",
        slug: "logo-bomb",
        logo: "javascript:alert(1)",
        twitter: "<svg onload=alert(1)>",
        description: "<script>steal()</script>",
        audit_links: ["https://evil.example/"],
      }),
    );
    const text = serializeUniverse(r.universe);
    for (const needle of [
      "javascript:",
      "onload",
      "<script",
      '"logo"',
      "steal(",
      "evil.example",
    ])
      expect(text.includes(needle), needle).toBe(false);
  });
  it("a fork or child of a reviewed protocol never inherits its adapter or coverage", () => {
    const r = run(
      extra({
        id: "9902",
        name: "Uniswap V2 Fork",
        slug: "uniswap-v2-fork",
        forkedFromIds: ["2197"],
        parentProtocol: "parent#uniswap",
        module: "uniswap/index.js",
      }),
    );
    const rows = computeCoverage(r.universe, deployments).filter(
      (x) => x.protocolId === "llama:9902",
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every(
        (x) => x.status === "CATALOG_ONLY" && x.deployments.length === 0,
      ),
    ).toBe(true);
    const index = buildIndex(r.universe, "a".repeat(64), registries);
    const d = protocolDetail(index, "llama:9902")!;
    expect(d.identity.forkedFrom).toEqual([
      expect.objectContaining({ id: "llama:2197" }),
    ]);
    expect(d.reviewedAdapters).toEqual([]);
  });
  it("an upstream chain that reuses a known name with a different chain id is not mapped to that network", () => {
    const raw = load();
    (raw.chains as Record<string, unknown>[]).push({
      name: "Base ",
      chainId: 84530,
      tvl: 1,
      tokenSymbol: "ETH",
      gecko_id: null,
    });
    const r = run(raw);
    const spoof = r.universe.chains.find((c) => c.chainId === "84530");
    expect(spoof?.otherbridgeId ?? null).toBeNull();
    const base = r.universe.chains.find((c) => c.otherbridgeId === "8453")!;
    expect(base.chainId).toBe("8453");
  });
  it("malformed upstream rows are recorded with exact reasons, never coerced", () => {
    const raw = load();
    raw.protocols.push(
      { id: "9903", name: 42, slug: "bad-name", chains: ["Ethereum"] },
      {
        id: "9904",
        name: "Bad Chains",
        slug: "bad-chains",
        chains: "Ethereum",
      },
      { id: { nested: true }, name: "Bad Id", slug: "bad-id", chains: [] },
      {
        id: "9906",
        name: "Bad Tvl",
        slug: "bad-tvl",
        chains: ["Ethereum"],
        tvl: "1e400",
      },
    );
    const r = run(raw);
    const reasons = new Map(
      r.unmappedProtocols.map((u) => [u.llamaId ?? u.name, u.reason]),
    );
    expect(r.unmappedProtocols.length).toBeGreaterThanOrEqual(2);
    for (const [, reason] of reasons) expect(reason).toMatch(/^[A-Z_]+$/);
    const tvl = r.universe.protocols.find((p) => p.llamaId === "9906");
    if (tvl)
      expect(tvl.tvlUsd === null || Number.isFinite(tvl.tvlUsd)).toBe(true);
  });
  it("an oversized or non-conforming catalog file is rejected before parsing", () => {
    expect(() => parseUniverse("x".repeat(64 * 1024 * 1024 + 1))).toThrow(
      "CATALOG_TOO_LARGE",
    );
    expect(() =>
      parseUniverse(
        '{"kind":"protocol","id":"llama:1","__proto__":{"polluted":true}}',
      ),
    ).toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
  it("hostile search input is bounded and cannot select by injected syntax", () => {
    const index = buildIndex(run(load()).universe, "b".repeat(64), registries);
    expect(() => queryProtocols(index, { q: "a".repeat(81) })).toThrow(
      CatalogQueryError,
    );
    for (const q of ["%", "_", "' OR 1=1 --", ".*", "‮evil", "(?=a)"]) {
      const r = queryProtocols(index, { q, status: "ALL", limit: 10 });
      expect(r.items.length).toBeLessThanOrEqual(10);
    }
    expect(() =>
      queryProtocols(index, { cursor: "eyJmb3JnZWQiOnRydWV9", limit: 10 }),
    ).toThrow(CatalogQueryError);
    expect(() =>
      queryProtocols(index, { chain: "chain:../../etc/passwd" }),
    ).toThrow(CatalogQueryError);
    expect(() => queryProtocols(index, { limit: 10000 })).toThrow(
      CatalogQueryError,
    );
  });
});
