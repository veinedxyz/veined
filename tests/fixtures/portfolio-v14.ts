import { fixtureCatalog } from "./routing";
import { coverage, holding } from "./portfolio";
import { summarize } from "../../src/data/core/coverage";
import type {
  ChainCoverage,
  Holding,
  PortfolioResult,
} from "../../src/portfolio/model";
// SYNTHETIC_TEST_ONLY self-hosted portfolio pages: >40 networks, progressive continuation, an
// asset discovered by the Otherbridge index, native-only, catalog-only and indexing coverage.
export const INDEXED_TOKEN = "0x7777777777777777777777777777777777777777";
export const FORGOTTEN_CHAIN = "900005";
const evm = () =>
  fixtureCatalog()
    .networks.filter(
      (n) =>
        n.mainnet && n.ecosystem === "EVM" && n.provider === "routing-core",
    )
    .map((n) => n.id);
export const PENDING_CHAINS = Array.from({ length: 30 }, (_, i) =>
  String(900000 + i),
);
const CATALOG_ONLY = Array.from({ length: 5 }, (_, i) => String(900100 + i));
function result(
  list: ChainCoverage[],
  holdings: Holding[],
  continuation: string | null,
  revision: string,
): PortfolioResult {
  const at = Date.now();
  const summary = summarize(list);
  return {
    state: summary.coverageComplete ? "COMPLETE" : "PARTIAL",
    holdings,
    coverage: list,
    coverageSummary: summary,
    continuation,
    dataPlane: "AVAILABLE",
    source: "otherbridge-data-plane",
    observedAt: at,
    revision,
    synthetic: true,
  };
}
export function firstPage(): PortfolioResult {
  const ids = evm();
  const list: ChainCoverage[] = ids.map((id) =>
    id === "42161"
      ? coverage(id, "PARTIAL", {
          tier: "FULL_INDEXED",
          tokens: "INDEXED",
          indexedFromBlock: "511564476",
          indexedThroughBlock: "511588656",
          headBlock: "511588659",
          observedBlock: "511588659",
        })
      : id === "57073"
        ? coverage(id, "INDEXING", {
            tier: "FULL_INDEXED",
            tokens: "KNOWN_TOKENS",
            reason: "INDEX_LAGGING",
            indexedFromBlock: "57590675",
            indexedThroughBlock: "57590900",
          })
        : id === "1088" || id === "4217"
          ? coverage(id, "NATIVE_ONLY")
          : id === "50"
            ? coverage(id, "FAILED")
            : coverage(id, "PARTIAL", { observedBlock: "100" }),
  );
  list.push(...PENDING_CHAINS.map((id) => coverage(id, "PENDING")));
  list.push(
    ...CATALOG_ONLY.map((id) =>
      coverage(id, "CATALOG_ONLY", { reason: "NO_VETTED_RPC" }),
    ),
  );
  const holdings: Holding[] = [
    holding("1", "50000000000000000", 140),
    holding("8453", "2000000000000000000", 5600),
    holding("42161", "1000000000000000", 2.8, { lastActivity: null }),
    holding("42161", "1500000000", 1500, {
      address: INDEXED_TOKEN,
      native: false,
      symbol: "IDX",
      name: "Indexed discovery token",
      decimals: 6,
      discovery: "indexed",
      lastActivity: null,
    }),
    holding("1088", "535669690312983058", null, { lastActivity: null }),
    holding("56", "100000000000000000000", 120, {
      address: "0x4444444444444444444444444444444444444444",
      native: false,
      symbol: "TOKEN",
      name: "Wallet token",
      lastActivity: null,
    }),
    holding("56", "0", 0),
  ];
  return result(
    list,
    holdings,
    "synthetic-continuation-1",
    `synthetic-v14-page1-${Date.now()}`,
  );
}
export function secondPage(): PortfolioResult {
  const list = PENDING_CHAINS.map((id) => coverage(id, "NATIVE_ONLY"));
  const at = Date.now();
  const forgotten: Holding = {
    chainId: FORGOTTEN_CHAIN,
    address: "0x0000000000000000000000000000000000000000",
    symbol: "SYN5",
    name: "Synthetic 5 native",
    decimals: 18,
    balance: "4200000000000000000",
    native: true,
    spam: false,
    suspicious: false,
    usd: null,
    priceAt: null,
    observedAt: at,
    logo: "/networks/neutral.svg",
    lastActivity: null,
    discovery: "native",
    observedBlock: "4242",
  };
  return result(list, [forgotten], null, `synthetic-v14-page2-${Date.now()}`);
}
export function unavailablePage(): PortfolioResult {
  const list = evm()
    .slice(0, 12)
    .map((id) =>
      coverage(id, "CATALOG_ONLY", { reason: "DATA_PLANE_UNAVAILABLE" }),
    );
  return {
    ...result(list, [], null, `synthetic-v14-unavailable-${Date.now()}`),
    state: "FAILED",
    dataPlane: "UNAVAILABLE",
  };
}
