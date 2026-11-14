import { fixtureCatalog } from "./routing";
import type {
  ChainCoverage,
  Holding,
  PortfolioResult,
} from "../../src/portfolio/model";
import { summarize } from "../../src/data/core/coverage";
export function coverage(
  chainId: string,
  state: ChainCoverage["state"],
  extra: Partial<ChainCoverage> = {},
): ChainCoverage {
  return {
    chainId,
    state,
    tier:
      state === "NATIVE_ONLY"
        ? "NATIVE_ONLY"
        : state === "CATALOG_ONLY"
          ? "CATALOG_ONLY"
          : "ON_DEMAND_FUNGIBLE",
    native:
      state === "FAILED"
        ? "FAILED"
        : state === "PENDING"
          ? "PENDING"
          : state === "CATALOG_ONLY"
            ? "UNSUPPORTED"
            : "CHECKED",
    tokens:
      state === "COMPLETE" || state === "PARTIAL"
        ? "KNOWN_TOKENS"
        : state === "FAILED"
          ? "FAILED"
          : state === "PENDING"
            ? "PENDING"
            : "NOT_CHECKED",
    historicalComplete: false,
    indexedFromBlock: null,
    indexedThroughBlock: null,
    headBlock: null,
    observedBlock: null,
    reason:
      state === "FAILED"
        ? "RPC_UNAVAILABLE"
        : state === "PENDING"
          ? "DEADLINE"
          : "NONE",
    observedAt: Date.now(),
    ...extra,
  };
}
export function holding(
  chainId = "1",
  balance = "1000000000000000000",
  usd: number | null = 2800,
  extra: Partial<Holding> = {},
): Holding {
  const n = fixtureCatalog().networks.find((n) => n.id === chainId)!;
  const at = Date.now();
  return {
    ...n.nativeAsset,
    balance,
    native: true,
    spam: false,
    suspicious: false,
    usd,
    priceAt: usd === null ? null : at,
    observedAt: at,
    logo: "/networks/neutral.svg",
    lastActivity: at - 120 * 86400000,
    ...extra,
  };
}
export function portfolioFixture(
  state: PortfolioResult["state"] = "PARTIAL",
): PortfolioResult {
  const at = Date.now();
  const list = [
    coverage("1", "COMPLETE"),
    coverage("8453", "COMPLETE"),
    coverage("56", "NATIVE_ONLY"),
    coverage("42161", "FAILED"),
  ];
  return {
    state,
    holdings: [
      holding(),
      holding("8453", "2000000000000000000", 5600),
      holding("56", "0", 0),
      holding("56", "100000000000000000000", 120, {
        address: "0x4444444444444444444444444444444444444444",
        native: false,
        symbol: "TOKEN",
        name: "Wallet token",
      }),
      holding("1", "1", 0.0001, {
        address: "0x5555555555555555555555555555555555555555",
        native: false,
        symbol: "DUST",
      }),
      holding("1", "999999999999999999999999999999999999", null, {
        address: "0x6666666666666666666666666666666666666666",
        native: false,
        symbol: "SPAM",
        spam: true,
      }),
    ],
    coverage: list,
    coverageSummary: summarize(list),
    continuation: null,
    dataPlane: "AVAILABLE",
    source: "otherbridge-data-plane",
    observedAt: at,
    revision: `synthetic-${at}`,
    synthetic: true,
  };
}
