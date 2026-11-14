import { z } from "zod";
// Browser-safe coverage vocabulary shared by the data plane, the Data API and the Portfolio UI.
// V1.11: CURATED_BALANCE_SCAN = native + exact balanceOf sweep of the curated asset registry through a verified
// Multicall3 (no token universe/index available for the chain). Never "complete"; never history.
export const tierSchema = z.enum([
  "FULL_INDEXED",
  "ON_DEMAND_FUNGIBLE",
  "CURATED_BALANCE_SCAN",
  "NATIVE_ONLY",
  "CATALOG_ONLY",
]);
export type Tier = z.infer<typeof tierSchema>;
export const tierRank: Record<Tier, number> = {
  CATALOG_ONLY: 0,
  NATIVE_ONLY: 1,
  CURATED_BALANCE_SCAN: 2,
  ON_DEMAND_FUNGIBLE: 3,
  FULL_INDEXED: 4,
};
export const lowerTier = (a: Tier, b: Tier): Tier =>
  tierRank[a] <= tierRank[b] ? a : b;
export const coverageStateSchema = z.enum([
  "COMPLETE",
  "PARTIAL",
  "NATIVE_ONLY",
  "INDEXING",
  "CATALOG_ONLY",
  "FAILED",
  "PENDING",
]);
export type CoverageState = z.infer<typeof coverageStateSchema>;
export const blockSchema = z
  .string()
  .regex(/^(0|[1-9]\d{0,19})$/)
  .nullable();
export const coverageReasonSchema = z.enum([
  "NONE",
  "ADDRESS_MISSING",
  "RPC_UNAVAILABLE",
  "NO_VETTED_RPC",
  "DEADLINE",
  "UNSUPPORTED_ECOSYSTEM",
  "INDEX_LAGGING",
  "INDEX_NOT_STARTED",
  "DATA_PLANE_UNAVAILABLE",
  "CHAIN_MISMATCH",
  "CATALOG_ONLY",
  "IMPLAUSIBLE_BALANCE",
  "TOKEN_READ_INCOMPLETE",
]);
export type CoverageReason = z.infer<typeof coverageReasonSchema>;
export const chainCoverageSchema = z
  .object({
    chainId: z.string().regex(/^(\d{1,18}|bitcoin|sui|tron|stellar)$/),
    state: coverageStateSchema,
    tier: tierSchema,
    native: z.enum(["CHECKED", "FAILED", "UNSUPPORTED", "PENDING"]),
    tokens: z.enum([
      "INDEXED",
      "KNOWN_TOKENS",
      "CURATED",
      "ENUMERATED",
      "NOT_CHECKED",
      "FAILED",
      "PENDING",
    ]),
    historicalComplete: z.boolean(),
    indexedFromBlock: blockSchema,
    indexedThroughBlock: blockSchema,
    headBlock: blockSchema,
    observedBlock: blockSchema,
    reason: coverageReasonSchema,
    observedAt: z.number().nonnegative(),
  })
  .strict();
export type ChainCoverage = z.infer<typeof chainCoverageSchema>;
export const coverageSummarySchema = z
  .object({
    planned: z.number().int().nonnegative(),
    checked: z.number().int().nonnegative(),
    indexed: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    nativeOnly: z.number().int().nonnegative(),
    catalogOnly: z.number().int().nonnegative(),
    unsupported: z.number().int().nonnegative(),
    coverageComplete: z.boolean(),
    historicalComplete: z.boolean(),
  })
  .strict();
export type CoverageSummary = z.infer<typeof coverageSummarySchema>;
export function summarize(coverage: ChainCoverage[]): CoverageSummary {
  const count = (f: (c: ChainCoverage) => boolean) => coverage.filter(f).length;
  const pending = count((c) => c.state === "PENDING"),
    failed = count((c) => c.state === "FAILED"),
    checked = count(
      (c) =>
        c.native === "CHECKED" ||
        c.tokens === "ENUMERATED" ||
        (c.native === "UNSUPPORTED" &&
          (c.tokens === "KNOWN_TOKENS" ||
            c.tokens === "INDEXED" ||
            c.tokens === "CURATED")),
    );
  return {
    planned: coverage.length,
    checked,
    indexed: count((c) => c.tokens === "INDEXED"),
    pending,
    failed,
    nativeOnly: count((c) => c.state === "NATIVE_ONLY"),
    catalogOnly: count((c) => c.state === "CATALOG_ONLY"),
    unsupported: count((c) => c.reason === "UNSUPPORTED_ECOSYSTEM"),
    // Complete only when nothing remains unchecked and nothing failed; never inferred from silence.
    coverageComplete:
      coverage.length > 0 &&
      pending === 0 &&
      failed === 0 &&
      coverage.every((c) => c.state === "COMPLETE"),
    historicalComplete:
      coverage.length > 0 && coverage.every((c) => c.historicalComplete),
  };
}
