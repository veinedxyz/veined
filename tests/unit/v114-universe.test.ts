import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  auditParity,
  normalizeUniverse,
  parseChainlistText,
  type RawSources,
} from "../../src/defi/universe/normalize";
import {
  cleanName,
  cleanUrl,
  skeleton,
} from "../../src/defi/universe/sanitize";
import { universeDiff, diffMarkdown } from "../../src/defi/universe/diff";
import { anomalyChecks, syncAccepted } from "../../src/defi/universe/anomaly";
import {
  computeCoverage,
  linksFor,
  summarize,
} from "../../src/defi/universe/coverage";
import {
  chainCapabilities,
  type CapabilityRegistries,
} from "../../src/defi/universe/capabilities";
import { parseUniverse, serializeUniverse } from "../../src/defi/universe/io";
import {
  buildIndex,
  CatalogQueryError,
  protocolDetail,
  queryChains,
  queryProtocols,
  coverageReport,
} from "../../src/defi/universe/store";
import { buildQueue } from "../../src/defi/universe/queue";
import { productCategory } from "../../src/defi/universe/categories";
import { defaultTierConfig } from "../../src/data/registry/chains";
import type { Universe } from "../../src/defi/universe/model";

const dir = "tests/fixtures/defi-universe/";
const load = (): RawSources => ({
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
  {
    id: "56",
    chainId: "56",
    caip2: "eip155:56",
    name: "BNB Smart Chain",
    ecosystem: "EVM",
  },
  {
    id: "1151111081099710",
    chainId: "1151111081099710",
    caip2: "solana:mainnet",
    name: "Solana",
    ecosystem: "SVM",
  },
  {
    id: "728126428",
    chainId: "728126428",
    caip2: "tron:mainnet",
    name: "Tron",
    ecosystem: "TVM",
  },
];
const chainlist = parseChainlistText(readFileSync(dir + "chainIds.js", "utf8"));
const run = (raw = load(), previous?: Universe, syncId = "fixture-sync-1") =>
  normalizeUniverse(raw, {
    syncId,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sources: [],
    previous,
    identities,
    chainlist,
  });
const registries: CapabilityRegistries = {
  rpcChains: new Set(["1", "8453", "56", "1151111081099710"]),
  multicallChains: new Set(["1", "8453"]),
  tiers: defaultTierConfig,
  routingChains: new Set(["1", "8453"]),
  customChains: new Set(),
  deployments: [
    {
      id: "aave-v3-1",
      protocolId: "aave-v3",
      chainId: "1",
      adapter: "aave-v3",
    },
    {
      id: "aave-v3-8453",
      protocolId: "aave-v3",
      chainId: "8453",
      adapter: "aave-v3",
    },
    {
      id: "uniswap-v3-1",
      protocolId: "uniswap-v3",
      chainId: "1",
      adapter: "uniswap-v3",
    },
    { id: "lido-1", protocolId: "lido", chainId: "1", adapter: "lido" },
    {
      id: "erc4626-sdai-1",
      protocolId: "erc4626",
      chainId: "1",
      adapter: "erc4626",
    },
    {
      id: "compound-1-usdc",
      protocolId: "compound-iii",
      chainId: "1",
      adapter: "compound-iii",
    },
  ],
};
const chainOf = (u: Universe, name: string) =>
  u.chains.find((c) => c.name === name || c.aliases.includes(name))!;
const protocolOf = (u: Universe, llamaId: string) =>
  u.protocols.find((p) => p.llamaId === llamaId)!;

describe("V1.14 universe normalization: no silent omission", () => {
  it("accounts for every upstream chain name and every protocol row exactly", () => {
    const raw = load(),
      r = run(raw);
    const parity = auditParity(raw, r);
    expect(parity.pass).toBe(true);
    expect(parity.missingChains).toEqual([]);
    expect(parity.missingProtocols).toEqual([]);
    expect(r.universe.stats.protocolsSeen).toBe(
      (raw.protocols as unknown[]).length,
    );
    expect(
      r.universe.stats.protocolsMapped + r.universe.stats.protocolsUnmapped,
    ).toBe(r.universe.stats.protocolsSeen);
    expect(
      r.universe.stats.chainsMapped + r.universe.stats.chainsUnmapped,
    ).toBe(r.universe.stats.chainsSeen);
    expect(r.universe.stats.chainCatalogRows).toBe(
      (raw.chains as unknown[]).length,
    );
  });
  it("records malformed rows with exact reasons instead of dropping them", () => {
    const r = run();
    expect(
      r.unmappedChains.some(
        (c) =>
          c.reason === "SOURCE_INCOMPLETE" &&
          c.detail.startsWith("MALFORMED_CHAIN_CATALOG_ROW:12"),
      ),
    ).toBe(true);
    expect(
      r.unmappedProtocols
        .filter((p) => p.reason === "MALFORMED_ROW")
        .map((p) => p.detail)
        .sort(),
    ).toEqual(["MISSING_OR_INVALID_ID", "ROW_NOT_OBJECT"]);
    // A nameless row without an id cannot be invented into a protocol; a named one stays searchable as unidentified.
    expect(
      r.universe.protocols.some(
        (p) =>
          p.id.startsWith("llama:unidentified-") && p.name === "Nameless No Id",
      ),
    ).toBe(true);
  });
  it("detects a parity break when an upstream protocol disappears from the result", () => {
    const raw = load(),
      r = run(raw);
    const broken = {
      ...r,
      universe: {
        ...r.universe,
        protocols: r.universe.protocols.filter((p) => p.llamaId !== "182"),
      },
    };
    const parity = auditParity(raw, broken);
    expect(parity.pass).toBe(false);
    expect(parity.missingProtocols.length).toBe(1);
    const checks = anomalyChecks(
      undefined,
      broken.universe,
      universeDiff(undefined, broken.universe),
      parity,
      new Set(["SILENT_OMISSION"]),
    );
    expect(syncAccepted(checks)).toBe(false); // never overridable
  });
});
describe("V1.14 chain identity and aliases", () => {
  it("maps aliases by chain catalog name, key map, chain id + gecko id; keeps every raw name", () => {
    const u = run().universe;
    const bsc = chainOf(u, "BSC");
    expect(bsc.aliases).toContain("Binance");
    expect(bsc.chainId).toBe("56");
    expect(chainOf(u, "xDai").key).toBe(chainOf(u, "Gnosis").key);
    expect(chainOf(u, "Story").key).toBe(chainOf(u, "Data Network").key);
    expect(chainOf(u, "Cosmos").key).toBe(chainOf(u, "CosmosHub").key);
  });
  it("keeps a look-alike or conflicting alias separate and marks it for review", () => {
    const r = run();
    const impostor = r.unmappedChains.find((c) => c.name === "Impostor")!;
    expect(impostor.reason).toBe("AMBIGUOUS_ALIAS");
    expect(chainOf(r.universe, "Base").aliases).not.toContain("Impostor");
    const greek = r.unmappedChains.find((c) => c.name === "Βase")!;
    expect(greek.reason).toBe("IDENTITY_REVIEW_REQUIRED");
  });
  it("classifies VM families by explicit network identity before upstream EVM tags", () => {
    const u = run().universe;
    expect(chainOf(u, "Tron").vm).toBe("Tron");
    expect(chainOf(u, "Solana").vm).toBe("Solana");
    expect(chainOf(u, "Bitcoin").vm).toBe("Bitcoin");
    expect(chainOf(u, "CosmosHub").vm).toBe("Cosmos");
    expect(chainOf(u, "Polkadot").vm).toBe("Other");
    expect(chainOf(u, "Ethereum").vm).toBe("EVM");
    for (const name of ["Tron", "Solana", "Bitcoin", "CosmosHub", "Polkadot"])
      expect(chainOf(u, name).capabilities).toContain("UNSUPPORTED_VM");
  });
  it("an EVM chain without a verifiable chain id is UNKNOWN_CHAIN_ID; chainlist only fills an exact single key", () => {
    const r = run();
    expect(r.unmappedChains.find((c) => c.name === "NoIdChain")!.reason).toBe(
      "UNKNOWN_CHAIN_ID",
    );
    const canto = chainOf(r.universe, "Canto");
    expect(canto.chainId).toBe("7700");
    expect(canto.flags).toContain("CHAIN_ID_FROM_CHAINLIST");
    expect(canto.mapping.crossChecked).toBe(true);
    expect(chainOf(r.universe, "Ethereum").mapping.crossChecked).toBe(true);
    expect(
      r.unmappedChains.find((c) => c.name === "OnlyMetadata")!.reason,
    ).toBe("METADATA_ONLY");
    expect(chainOf(r.universe, "Polkadot").status).toBe("REFERENCED_ONLY");
  });
  it("parses the chainlist module as text only and rejects anything else", () => {
    expect(
      parseChainlistText('export default {\n "1": "ethereum",\n "2": "x",\n}'),
    ).toEqual({ "1": "ethereum", "2": "x" });
    expect(() =>
      parseChainlistText("module.exports = { '1': 'ethereum' }"),
    ).toThrow("CHAINLIST_FORMAT_UNEXPECTED");
    expect(() =>
      parseChainlistText("export default { constructor: process.exit(1) }"),
    ).toThrow("CHAINLIST_EMPTY");
    expect(() =>
      parseChainlistText("export default {" + " ".repeat(2_000_001) + "}"),
    ).toThrow();
  });
});
describe("V1.14 untrusted protocol metadata", () => {
  it("homoglyph clones, bidi names, slug takeover and duplicate names never inherit identity", () => {
    const r = run();
    const byId = (id: string) =>
      r.unmappedProtocols.find((p) => p.llamaId === id);
    expect(byId("9001")!.reason).toBe("IDENTITY_REVIEW_REQUIRED"); // Cyrillic "Аave V3"
    expect(byId("9002")!.reason).toBe("IDENTITY_REVIEW_REQUIRED"); // RLO control
    expect(byId("9003")!.reason).toBe("SLUG_COLLISION"); // second claimant of aave-v3
    expect(byId("9013")!.detail).toMatch(/^NAME_COLLISION/); // second "Lido"
    expect(byId("9014")!.detail).toMatch(/^NAME_COLLISION/); // second "Spark Savings"
    expect(protocolOf(r.universe, "9002").name).toBe("EvilSwap");
    expect(protocolOf(r.universe, "9002").url).toBeNull();
    expect(protocolOf(r.universe, "1599").mapping.status).toBe("MAPPED");
  });
  it("names keep apostrophes but lose markup/control; URLs are reduced to a validated origin and path", () => {
    expect(cleanName("JPEG'd").value).toBe("JPEG'd");
    expect(cleanName("<img src=x onerror=alert(1)>").flags).toContain(
      "MARKUP_REMOVED",
    );
    expect(cleanName("A\u200bB").flags).toContain("INVISIBLE_REMOVED");
    expect(cleanName("x".repeat(500)).value.length).toBe(120);
    expect(skeleton("Аave V3")).toBe(skeleton("Aave V3"));
    expect(cleanUrl("javascript:alert(1)").url).toBeNull();
    expect(cleanUrl("data:text/html,x").url).toBeNull();
    expect(cleanUrl("https://user:pw@aave.com/").url).toBeNull();
    expect(cleanUrl("https://127.0.0.1/").url).toBeNull();
    expect(cleanUrl("https://aave.com/app?ref=1#x").url).toBe(
      "https://aave.com/app",
    );
    expect(cleanUrl("http://xn--80ak6aa92e.com/").flags).toEqual([
      "PUNYCODE_HOST",
      "INSECURE_URL",
    ]);
    expect(cleanUrl("https://xn--invalid-.com/").url).toBeNull();
  });
  it("preserves raw categories, normalizes product categories and flags unknown ones", () => {
    const u = run().universe;
    expect(protocolOf(u, "1599").category).toBe("Lending");
    expect(protocolOf(u, "1599").productCategory).toBe("lending");
    expect(protocolOf(u, "9008").productCategory).toBe("other");
    expect(protocolOf(u, "9008").flags).toContain("NEW_CATEGORY");
    expect(productCategory("Liquid Restaking").category).toBe(
      "liquid-restaking",
    );
    expect(protocolOf(u, "1599").parent).toEqual({
      id: "parent#aave",
      name: "Aave",
    });
    expect(protocolOf(u, "1599").version).toBe("V3");
  });
  it("builds protocol-chain rows through aliases with TVL only as context", () => {
    const u = run().universe;
    const rows = u.rows.filter((r) => r.protocolId === "llama:1599");
    expect(rows.map((r) => r.chainKey).sort()).toEqual(
      [
        chainOf(u, "Base").key,
        chainOf(u, "BSC").key,
        chainOf(u, "Ethereum").key,
        chainOf(u, "Solana").key,
      ].sort(),
    );
    const eth = rows.find((r) => r.chainKey === chainOf(u, "Ethereum").key)!;
    expect(eth.tvlUsd).toBe(15000000000);
    expect(eth.borrowedUsd).toBe(9000000000);
    expect(protocolOf(u, "9009").flags).toContain("NO_CHAIN_RELATION");
    expect(u.rows.some((r) => r.protocolId === "llama:9009")).toBe(false);
  });
  it("marks deprecated, dead and rugged protocols without hiding them", () => {
    const u = run().universe;
    expect(protocolOf(u, "9005").status).toBe("DEAD");
    expect(protocolOf(u, "9006").status).toBe("RUGGED");
    expect(u.stats.deprecatedProtocols).toBe(2);
  });
});
describe("V1.14 history, diff and anomaly protection", () => {
  it("keeps removed protocols as REMOVED_UPSTREAM with their rows and reports renames/slug changes", () => {
    const first = run().universe;
    const raw = load();
    const protocols = (raw.protocols as Record<string, unknown>[]).filter(
      (p) => p?.id !== "182",
    );
    const uni = protocols.find((p) => p?.id === "2198")!;
    uni.name = "Uniswap V3 Renamed";
    uni.chains = ["Ethereum"];
    const second = run({ ...raw, protocols }, first, "fixture-sync-2");
    const lido = protocolOf(second.universe, "182");
    expect(lido.status).toBe("REMOVED_UPSTREAM");
    expect(second.universe.rows.some((r) => r.protocolId === "llama:182")).toBe(
      true,
    );
    expect(lido.firstSeen).toBe("fixture-sync-1");
    const diff = universeDiff(first, second.universe);
    expect(diff.protocols.removed.map((p) => p.id)).toEqual(["llama:182"]);
    expect(diff.protocols.renamed).toEqual([
      { id: "llama:2198", from: "Uniswap V3", to: "Uniswap V3 Renamed" },
    ]);
    expect(diff.protocols.chainsChanged[0].removed.length).toBe(2);
    expect(diffMarkdown(diff, second.universe.stats)).toContain(
      "Protocols removed upstream",
    );
  });
  it("a new id claiming a slug that belonged to another id in the last-good catalog is a takeover", () => {
    const first = run().universe;
    const raw = load();
    const protocols = (raw.protocols as Record<string, unknown>[]).map((p) =>
      p?.id === "182" ? { ...p, slug: "lido-moved" } : p,
    );
    protocols.push({
      id: "9999",
      name: "Lido Finance",
      slug: "lido",
      category: "Liquid Staking",
      chains: ["Ethereum"],
      tvl: 1,
    });
    const second = run({ ...raw, protocols }, first, "fixture-sync-2");
    expect(
      second.unmappedProtocols.find((p) => p.llamaId === "9999")!.reason,
    ).toBe("SLUG_COLLISION");
    expect(protocolOf(second.universe, "182").flags).toContain("SLUG_CHANGED");
  });
  it("blocks a truncated feed (last-good fallback) unless a reviewer accepts that specific code", () => {
    const first = run().universe;
    const raw = load();
    const small = {
      ...raw,
      protocols: (raw.protocols as unknown[]).slice(0, 5),
    };
    const second = run(small, first, "fixture-sync-2");
    const diff = universeDiff(first, second.universe);
    const parity = auditParity(small, second);
    const checks = anomalyChecks(first, second.universe, diff, parity);
    expect(checks.find((c) => c.code === "PROTOCOL_COUNT_DROP")!.pass).toBe(
      false,
    );
    expect(syncAccepted(checks)).toBe(false);
    const reviewed = anomalyChecks(
      first,
      second.universe,
      diff,
      parity,
      new Set(["PROTOCOL_COUNT_DROP", "MASS_REMOVAL"]),
    );
    expect(syncAccepted(reviewed)).toBe(true);
    expect(
      reviewed.find((c) => c.code === "PROTOCOL_COUNT_DROP")!.detail,
    ).toContain("ACCEPTED_BY_REVIEWER");
  });
  it("flags chain identity changes for review", () => {
    const first = run().universe;
    const raw = load();
    const chains = (raw.chains as Record<string, unknown>[]).map((c) =>
      c?.name === "Base" ? { ...c, chainId: 84530 } : c,
    );
    const config = JSON.parse(JSON.stringify(raw.config));
    config.chainCoingeckoIds.Base.chainId = 84530;
    const second = run({ ...raw, chains, config }, first, "fixture-sync-2");
    const diff = universeDiff(first, second.universe);
    expect(diff.chains.chainIdChanged.map((c) => c.key)).toContain(
      chainOf(first, "Base").key,
    );
    const checks = anomalyChecks(
      first,
      second.universe,
      diff,
      auditParity({ ...raw, chains, config }, second),
    );
    expect(checks.find((c) => c.code === "CHAIN_IDENTITY_CHANGE")!.pass).toBe(
      false,
    );
  });
  it("serializes one entity per line and round-trips through the strict schema", () => {
    const u = run().universe;
    const text = serializeUniverse(u);
    expect(parseUniverse(text)).toEqual(u);
    expect(text.split("\n").length).toBeGreaterThan(u.protocols.length);
    expect(() =>
      parseUniverse(text.replace('"version":1', '"version":2')),
    ).toThrow();
  });
});
describe("V1.14 coverage truth", () => {
  const u = run().universe;
  const rows = computeCoverage(u, registries.deployments);
  const at = (llamaId: string, chain: string) =>
    rows.filter(
      (r) =>
        r.protocolId === "llama:" + llamaId &&
        r.chainKey === chainOf(u, chain).key,
    );
  it("is keyed by protocol + chain + product + adapter version and never a single supported boolean", () => {
    expect(at("1599", "Ethereum")[0]).toMatchObject({
      status: "FULL_POSITION",
      product: "Aave V3 Pool",
      adapterVersion: "1.1.0",
      deployments: ["aave-v3-1"],
    });
    expect(at("1599", "BSC")[0]).toMatchObject({
      status: "NOT_CHECKED",
      reason: "NO_REVIEWED_DEPLOYMENT_ON_CHAIN",
    });
    expect(at("1599", "Solana")[0]).toMatchObject({
      status: "UNSUPPORTED",
      reason: "UNSUPPORTED_VM",
    });
    expect(at("2198", "Ethereum")[0].status).toBe("FULL_POSITION");
    expect(at("182", "Ethereum")[0].status).toBe("FULL_POSITION");
  });
  it("catalog-only, custodial, deprecated and non-EVM entries are explicit, never checked zeros", () => {
    expect(at("9007", "Solana")[0]).toMatchObject({
      status: "UNSUPPORTED",
      reason: "UNSUPPORTED_VM",
    });
    expect(at("9004", "Ethereum")[0]).toMatchObject({
      status: "UNSUPPORTED",
      reason: "NO_ONCHAIN_USER_POSITION",
    });
    expect(at("9005", "Ethereum")[0].status).toBe("DEPRECATED");
    expect(at("9012", "Polkadot")[0].status).toBe("UNSUPPORTED");
    expect(rows.find((r) => r.protocolId === "llama:9009")).toMatchObject({
      chainKey: "chain:unspecified",
      status: "CATALOG_ONLY",
      reason: "NO_CHAIN_RELATION_IN_SOURCE",
    });
    for (const r of rows)
      expect([
        "FULL_POSITION",
        "PARTIAL_POSITION",
        "DISCOVERY_ONLY",
        "NOT_CHECKED",
        "CATALOG_ONLY",
        "NEEDS_REVIEW",
        "UNSUPPORTED",
        "DEPRECATED",
        "FAILED",
      ]).toContain(r.status);
    // Every cataloged protocol has at least one coverage row.
    expect(new Set(rows.map((r) => r.protocolId)).size).toBe(
      u.protocols.length,
    );
  });
  it("catalog renames, clones and slug drift can never enable financial logic", () => {
    expect(at("9001", "Ethereum")[0].status).toBe("NEEDS_REVIEW"); // homoglyph clone of Aave V3
    expect(at("9003", "Ethereum")[0].status).toBe("NEEDS_REVIEW"); // claims the aave-v3 slug
    expect(at("2088", "Ethereum")[0]).toMatchObject({
      status: "NEEDS_REVIEW",
      reason: "REVIEWED_IDENTITY_CHANGED",
    });
    expect(at("9014", "Ethereum")[0].status).toBe("NEEDS_REVIEW");
    expect(linksFor({ llamaId: "9003", slug: "aave-v3" }).takeover).toBe(true);
    // Rewriting a catalog protocol's name/category does not change its coverage.
    const tampered = {
      ...u,
      protocols: u.protocols.map((p) =>
        p.llamaId === "9008"
          ? {
              ...p,
              name: "Aave V3",
              category: "Lending",
              productCategory: "lending" as const,
            }
          : p,
      ),
    };
    expect(
      computeCoverage(tampered, registries.deployments)
        .filter((r) => r.protocolId === "llama:9008")
        .every(
          (r) => r.status === "CATALOG_ONLY" || r.status === "NEEDS_REVIEW",
        ),
    ).toBe(true);
  });
  it("product-family attribution is capped and limited to reviewed deployments", () => {
    expect(at("6716", "Ethereum")[0]).toMatchObject({
      status: "PARTIAL_POSITION",
      deployments: ["erc4626-sdai-1"],
    });
    expect(at("6716", "Base")[0].status).toBe("NOT_CHECKED");
  });
  it("headline summary takes the best per-chain state but keeps per-chain counts", () => {
    const s = summarize(rows).get("llama:1599")!;
    expect(s.headline).toBe("FULL_POSITION");
    expect(s.counts).toEqual({
      FULL_POSITION: 2,
      NOT_CHECKED: 1,
      UNSUPPORTED: 1,
    });
    expect(s.chains).toBe(4);
  });
});
describe("V1.14 chain capabilities", () => {
  const u = run().universe;
  it("derives product capabilities from reviewed registries only, never from a name match", () => {
    expect(chainCapabilities(chainOf(u, "Ethereum"), registries)).toEqual([
      "CATALOG",
      "IDENTIFIED",
      "RPC_READ",
      "PORTFOLIO_NATIVE",
      "PORTFOLIO_FUNGIBLE",
      "DEFI_DISCOVERY",
      "DEFI_POSITION",
      "BRIDGE",
      "SWAP",
    ]);
    expect(chainCapabilities(chainOf(u, "BSC"), registries)).toEqual([
      "CATALOG",
      "IDENTIFIED",
      "RPC_READ",
      "PORTFOLIO_NATIVE",
    ]);
    const solana = chainCapabilities(chainOf(u, "Solana"), registries);
    expect(solana).toContain("UNSUPPORTED_VM");
    expect(solana).not.toContain("DEFI_POSITION");
    const impostor = u.chains.find((c) => c.name === "Impostor")!;
    expect(chainCapabilities(impostor, registries)).toEqual([
      "CATALOG",
      "DEPRECATED",
      "NEEDS_REVIEW",
    ]);
    expect(chainCapabilities(chainOf(u, "NoIdChain"), registries)).toEqual([
      "CATALOG",
      "NEEDS_REVIEW",
    ]);
  });
});
describe("V1.14 catalog index queries", () => {
  const u = run().universe;
  const index = buildIndex(u, "f".repeat(64), registries);
  it("searches every cataloged protocol with bounded pages and identity-first ranking", () => {
    const r = queryProtocols(index, { q: "aave", limit: 10 });
    expect(r.items[0].name).toBe("Aave V3");
    expect(r.items.length).toBeLessThanOrEqual(10);
    const all = queryProtocols(index, { status: "ALL", limit: 100 });
    expect(all.total).toBe(u.protocols.length);
    expect(
      queryProtocols(index, { q: "mystery" }).items[0].coverage.headline,
    ).toBe("CATALOG_ONLY");
  });
  it("paginates with cursors bound to the catalog version and filters", () => {
    const p1 = queryProtocols(index, { status: "ALL", limit: 5, sort: "name" });
    expect(p1.nextCursor).toBeTruthy();
    const p2 = queryProtocols(index, {
      status: "ALL",
      limit: 5,
      sort: "name",
      cursor: p1.nextCursor,
    });
    expect(new Set([...p1.items, ...p2.items].map((i) => i.id)).size).toBe(10);
    expect(() =>
      queryProtocols(index, {
        status: "ALL",
        limit: 5,
        sort: "tvl",
        cursor: p1.nextCursor,
      }),
    ).toThrow(CatalogQueryError);
    expect(() => queryProtocols(index, { cursor: "!!" })).toThrow(
      "INVALID_CURSOR",
    );
    expect(() => queryProtocols(index, { limit: 101 })).toThrow(
      "INVALID_LIMIT",
    );
    expect(() => queryProtocols(index, { q: "x".repeat(81) })).toThrow(
      "INVALID_QUERY",
    );
    expect(() => queryProtocols(index, { category: "'; DROP TABLE" })).toThrow(
      "INVALID_FILTER",
    );
    expect(() =>
      queryProtocols(index, { chain: "chain:does-not-exist" }),
    ).toThrow("INVALID_FILTER");
  });
  it("filters by chain, VM, category and coverage", () => {
    const eth = chainOf(u, "Ethereum").key;
    expect(
      queryProtocols(index, {
        chain: eth,
        coverage: "FULL_POSITION",
        limit: 100,
      })
        .items.map((i) => i.id)
        .sort(),
    ).toEqual(["llama:1599", "llama:182", "llama:2198"]);
    expect(
      queryProtocols(index, { vm: "Solana", limit: 100 })
        .items.map((i) => i.id)
        .sort(),
    ).toEqual(["llama:1599", "llama:9007"]);
    expect(
      queryProtocols(index, {
        category: "liquid-staking",
        limit: 100,
      }).items.every((i) => i.productCategory === "liquid-staking"),
    ).toBe(true);
  });
  it("protocol detail keeps TVL context separate from any wallet value and shows per-chain coverage", () => {
    const d = protocolDetail(index, "aave-v3")!;
    expect(d.identity.id).toBe("llama:1599");
    expect(d.tvlContext.source).toMatch(/TVL/);
    expect(Object.keys(d)).not.toContain("walletValue");
    expect(
      d.chains.find((c) => c.name === "Ethereum")!.coverage[0].status,
    ).toBe("FULL_POSITION");
    expect(d.reviewedAdapters[0].product).toBe("Aave V3 Pool");
    expect(
      protocolDetail(index, "llama:9002")!.identity.websiteHost,
    ).toBeNull();
    expect(protocolDetail(index, "nope")).toBeNull();
  });
  it("searches every network including aliases and non-EVM chains", () => {
    expect(queryChains(index, { q: "binance" }).items[0].name).toBe("BSC");
    expect(queryChains(index, { vm: "Tron" }).items.map((c) => c.name)).toEqual(
      ["Tron"],
    );
    expect(queryChains(index, { status: "ALL", limit: 100 }).total).toBe(
      u.chains.length,
    );
    expect(
      queryChains(index, { capability: "DEFI_POSITION" })
        .items.map((c) => c.name)
        .sort(),
    ).toEqual(["Base", "Ethereum"]);
  });
  it("coverage report and queue cover every active protocol", () => {
    const report = coverageReport(index);
    expect(
      Object.values(report.protocolHeadline).reduce((a, b) => a + b!, 0),
    ).toBe(u.protocols.length);
    expect(report.tvlWeighted.fullShare).toBeGreaterThan(0);
    const queue = buildQueue(index);
    expect(queue.length).toBe(
      u.protocols.filter((p) => p.status === "ACTIVE").length,
    );
    expect(queue.find((q) => q.protocolId === "llama:9007")!.blocker).toBe(
      "UNSUPPORTED_VM",
    );
    expect(queue.find((q) => q.protocolId === "llama:9004")!.blocker).toBe(
      "NO_ONCHAIN_USER_POSITION",
    );
    expect(queue.find((q) => q.protocolId === "llama:9001")!.blocker).toBe(
      "IDENTITY_IDENTITY_REVIEW_REQUIRED",
    );
    for (const q of queue) expect(q.priority).toBeGreaterThanOrEqual(0);
  });
});
