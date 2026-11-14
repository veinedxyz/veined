import { z } from "zod";
import { isAssetLogoSrc } from "../assets/logo-path";
import { validAddress } from "../routing/addresses";
import type { Asset, Network } from "../routing/model";
import { currentPrice } from "./pricing";
import {
  blockSchema,
  chainCoverageSchema,
  coverageSummarySchema,
  summarize,
  type ChainCoverage,
} from "../data/core/coverage";
import { priceEvidenceSchema } from "../data/core/price";
import { sanitizeText } from "../data/core/sanitize";
import {
  positionSchema,
  defiCoverageSchema,
  positionFor,
  type DefiCoverage,
} from "./positions";
export { chainCoverageSchema, type ChainCoverage } from "../data/core/coverage";
export const identitySchema = z
  .object({
    evm: z
      .string()
      .refine((v) => validAddress("EVM", v))
      .optional(),
    solana: z
      .string()
      .refine((v) => validAddress("SVM", v))
      .optional(),
    bitcoin: z
      .array(z.string().refine((v) => validAddress("UTXO", v, "btc")))
      .min(1)
      .max(5)
      .optional(),
    sui: z
      .string()
      .refine((v) => validAddress("MVM", v))
      .optional(),
    tron: z
      .string()
      .refine((v) => validAddress("TVM", v))
      .optional(),
    stellar: z
      .string()
      .refine((v) => validAddress("STL", v))
      .optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0);
export type PortfolioIdentity = z.infer<typeof identitySchema>;
export const balanceSchema = z
  .object({
    chainId: z.string().regex(/^\d{1,18}$/),
    address: z.string().min(1).max(128),
    symbol: z.string().max(32),
    name: z.string().max(120),
    decimals: z.number().int().min(0).max(36),
    balance: z.string().regex(/^(0|[1-9]\d{0,77})$/),
    native: z.boolean(),
    spam: z.boolean(),
    suspicious: z.boolean(),
    usd: z.number().finite().nonnegative().nullable(),
    priceAt: z.number().nonnegative().nullable(),
    observedAt: z.number().nonnegative(),
    // V1.11: the neutral mark or a sanitized same-origin registry logo (never a remote URL).
    logo: z
      .string()
      .refine((src) => src === "/networks/neutral.svg" || isAssetLogoSrc(src)),
    lastActivity: z.number().nonnegative().nullable(),
    // V1.4 provenance: how the asset was found and at which block its balance was read.
    discovery: z
      .enum([
        "native",
        "indexed",
        "known-token",
        "curated",
        "imported",
        "enumerated",
        "provider",
      ])
      .optional(),
    observedBlock: blockSchema.optional(),
    price: priceEvidenceSchema.optional(),
    metadataVerified: z.boolean().optional(),
    // true when the token is in the approved routing catalog; false marks an unverified token.
    routable: z.boolean().optional(),
    position: positionSchema.optional(),
  })
  .strict();
export type Holding = z.infer<typeof balanceSchema>;
export const portfolioSchema = z
  .object({
    state: z.enum(["COMPLETE", "PARTIAL", "STALE", "FAILED"]),
    holdings: z.array(balanceSchema).max(20000),
    coverage: z.array(chainCoverageSchema).max(2500),
    coverageSummary: coverageSummarySchema,
    continuation: z.string().max(40000).nullable(),
    dataPlane: z.enum(["AVAILABLE", "DEGRADED", "UNAVAILABLE"]),
    source: z.literal("otherbridge-data-plane"),
    observedAt: z.number(),
    revision: z.string().max(100),
    synthetic: z.boolean().optional(),
    defiCoverage: z.array(defiCoverageSchema).max(100).optional(),
  })
  .strict();
export type PortfolioResult = z.infer<typeof portfolioSchema>;
export interface PortfolioCapabilities {
  ecosystems: string[];
  fungible: boolean;
  native: boolean;
  discovery: boolean;
}
// Provider-neutral contract retained from V1.3. Optional V1.4 members let a provider describe
// chains outside the routing catalog, report chains it cannot check, and return exact coverage.
export interface PortfolioProvider {
  capabilities(): PortfolioCapabilities;
  discoverActivity(
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ): Promise<string[]>;
  getBalances(
    network: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ): Promise<Holding[]>;
  getNativeBalance(
    network: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ): Promise<Holding[]>;
  describe?(chainId: string): Network | undefined;
  unscannable?(
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ): Promise<ChainCoverage[]>;
  scanChain?(
    network: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
    hooks?: ChainScanHooks,
  ): Promise<{
    holdings: Holding[];
    coverage: ChainCoverage;
    defiCoverage?: DefiCoverage[];
    /** V1.14.2: how the chain result was obtained (short wallet-chain cache). */
    cache?: "HIT" | "JOINED" | "READ";
  }>;
  status?(): "AVAILABLE" | "DEGRADED" | "UNAVAILABLE";
  /** V1.14.2: the accepted canonical plan order of a round; per-scan budgets follow it, never the wave order. */
  planScan?(order: string[]): void;
  /** V1.14.2 scheduling evidence (order only; never a balance or a coverage state). */
  scanEvidence?(identity: PortfolioIdentity): Promise<ScanEvidence>;
  /** V1.14.2: provider operator group of a chain's primary endpoint (bounded per-group concurrency). */
  operatorGroup?(chainId: string): string | undefined;
}
/** V1.14.2 progressive wave scan hooks. */
export interface ChainScanHooks {
  /** Native fast path: a confirmed nonzero native balance before the chain's token reads finish (provisional). */
  onNative?: (holding: Holding) => void;
  /** Explicit refresh: skip the short wallet-chain result cache. */
  fresh?: boolean;
  /** Bound of a shared (single-flight) chain read. */
  timeoutMs?: number;
}
export interface ScanEvidence {
  /** Canonical historical activity of this identity in the self-hosted index. */
  indexed: ReadonlySet<string>;
  /** Networks with exact user-imported token candidates. */
  knownToken: ReadonlySet<string>;
  /** Routable networks with reviewed coverage (curated registry, receipt contracts or reviewed DeFi deployments). */
  highConfidence: ReadonlySet<string>;
  routable: ReadonlySet<string>;
}
// Same character policy as the data-plane sanitizer (adds LRM/RLM/ALM, zero-width, BOM, NFKC).
export const cleanMetadata = (s: string, limit: number) =>
  sanitizeText(s, limit);
export function normalizeHoldings(raw: unknown): Holding[] {
  const parsed = z.array(balanceSchema).max(20000).parse(raw),
    seen = new Set<string>();
  return parsed
    .filter((h) => {
      const key = `${h.chainId}:${h.address.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((h) => ({
      ...h,
      symbol: cleanMetadata(h.symbol, 32) || "?",
      name: cleanMetadata(h.name, 120),
      // Only a pinned exact contract can carry a protocol identity. Symbols never establish positions.
      position: (() => {
        const p = positionFor(h.chainId, h.address);
        return p
          ? {
              protocol: p.protocol,
              category: p.category,
              role: p.role,
              source: p.source,
            }
          : undefined;
      })(),
      suspicious:
        h.suspicious ||
        /https?:|www\.|claim|airdrop/i.test(`${h.symbol} ${h.name}`),
      usd:
        h.priceAt === null
          ? null
          : currentPrice(
              [{ usd: h.usd, observedAt: h.priceAt, source: "normalized" }],
              h.observedAt,
            ),
    }));
}
export function chainHoldings(
  result: PortfolioResult | undefined,
  chainId: string,
) {
  return (
    result?.holdings.filter(
      (h) => h.chainId === chainId && !h.spam && BigInt(h.balance) > 0n,
    ) ?? []
  );
}
export { detectedValue } from "./value";
import { detectedValue } from "./value";
// Balance priority: known USD value, then non-zero without USD, then native gas, routable, rest.
const holdingRank = (h: Holding | undefined) =>
  !h ? 2 : h.usd !== null && h.usd > 0 ? 0 : 1;
export function sortNetworks(networks: Network[], result?: PortfolioResult) {
  return [...networks].sort((a, b) => {
    const x = chainHoldings(result, a.id),
      y = chainHoldings(result, b.id);
    const rank = (rows: Holding[]) =>
      !rows.length ? 2 : rows.some((h) => h.usd !== null && h.usd > 0) ? 0 : 1;
    return (
      rank(x) - rank(y) ||
      detectedValue(y) - detectedValue(x) ||
      Number(b.provider === "routing-core") -
        Number(a.provider === "routing-core") ||
      a.name.localeCompare(b.name)
    );
  });
}
export function sortAssets(
  assets: Asset[],
  native: string,
  result?: PortfolioResult,
) {
  return [...assets].sort((a, b) => {
    const x = chainHoldings(result, a.chainId).find(
        (h) => h.address.toLowerCase() === a.address.toLowerCase(),
      ),
      y = chainHoldings(result, b.chainId).find(
        (h) => h.address.toLowerCase() === b.address.toLowerCase(),
      );
    return (
      holdingRank(x) - holdingRank(y) ||
      (y?.usd ?? 0) - (x?.usd ?? 0) ||
      Number(b.address === native) - Number(a.address === native) ||
      a.symbol.localeCompare(b.symbol)
    );
  });
}
export function portfolioStale(result: PortfolioResult, now = Date.now()) {
  return (
    result.state === "STALE" ||
    now - result.observedAt >= 60000 ||
    now < result.observedAt
  );
}
export function redactAddress(address: string) {
  return address.length > 12
    ? `${address.slice(0, 6)}…${address.slice(-4)}`
    : "[redacted]";
}
// Progressive continuation: newer per-chain coverage replaces older; holdings of rescanned chains
// are replaced, never accumulated. Different identities are never merged.
export function mergePortfolio(
  previous: PortfolioResult,
  next: PortfolioResult,
): PortfolioResult {
  const rescanned = new Set(
    next.coverage.filter((c) => c.state !== "PENDING").map((c) => c.chainId),
  );
  const coverage = new Map(previous.coverage.map((c) => [c.chainId, c]));
  for (const c of next.coverage)
    if (c.state !== "PENDING" || !coverage.has(c.chainId))
      coverage.set(c.chainId, c);
  const holdings = [
    ...previous.holdings.filter((h) => !rescanned.has(h.chainId)),
    ...next.holdings,
  ];
  const merged = [...coverage.values()];
  const summary = summarize(merged);
  return {
    ...next,
    state:
      next.state === "STALE" || previous.state === "STALE"
        ? "STALE"
        : summary.checked === 0
          ? "FAILED"
          : summary.coverageComplete
            ? "COMPLETE"
            : "PARTIAL",
    holdings,
    coverage: merged,
    coverageSummary: summary,
    defiCoverage: [
      ...(previous.defiCoverage ?? []).filter((c) => !rescanned.has(c.chainId)),
      ...(next.defiCoverage ?? []).filter(
        (c) =>
          rescanned.has(c.chainId) ||
          !previous.defiCoverage?.some(
            (p) =>
              p.chainId === c.chainId &&
              p.protocol === c.protocol &&
              p.category === c.category,
          ),
      ),
    ],
    // Older pages stay older: freshness reflects the oldest balance in the merged view.
    observedAt: Math.min(previous.observedAt, next.observedAt),
    revision: next.revision,
  };
}
