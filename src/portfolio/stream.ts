import { z } from "zod";
import {
  balanceSchema,
  mergePortfolio,
  portfolioSchema,
  type ChainCoverage,
  type Holding,
  type PortfolioResult,
} from "./model";
import { chainCoverageSchema, summarize } from "../data/core/coverage";
import { defiCoverageSchema } from "./positions";
import { PRIORITY_REASONS } from "../data/portfolio/priority";
// V1.14.2 progressive wallet scan (NDJSON). Every line is schema-validated on both ends. Lines are provisional;
// the final `result` line is the complete reconciled round and replaces everything provisional, so a balance that
// appeared in several progress lines can never be counted twice, and a network that has not answered is PENDING,
// never empty. Browser-safe (no Node imports): shared by the route, the Portfolio client, tests and the harness.
export const WALLET_STREAM_VERSION = 1;
const chainId = z.string().regex(/^\d{1,18}$/);
const ms = z.number().finite().nonnegative().max(3_600_000);
export const plannedChainSchema = z
  .object({
    chainId,
    wave: z.number().int().min(0).max(4),
    reasons: z.array(z.enum(PRIORITY_REASONS)).min(1).max(9),
  })
  .strict();
export const planLineSchema = z
  .object({
    type: z.literal("plan"),
    v: z.literal(WALLET_STREAM_VERSION),
    continued: z.boolean(),
    chains: z.array(plannedChainSchema).max(2500),
    /** Terminal coverage of networks that are not scheduled (catalog-only, unsupported, no vetted RPC). */
    coverage: z.array(chainCoverageSchema).max(2500),
    firstPage: z
      .object({
        chains: z.number().int().nonnegative(),
        deadlineMs: ms,
        chainBudgetMs: ms,
      })
      .strict(),
    /** Planned networks hosting reviewed DeFi deployments (the DeFi start trigger waits for their wallet answer). */
    defiChains: z.array(chainId).max(256),
  })
  .strict();
export const nativeLineSchema = z
  .object({ type: z.literal("native"), chainId, holding: balanceSchema })
  .strict()
  .refine((l) => l.holding.chainId === l.chainId && l.holding.native);
export const chainLineSchema = z
  .object({
    type: z.literal("chain"),
    chainId,
    wave: z.number().int().min(0).max(4),
    holdings: z.array(balanceSchema).max(20000),
    coverage: chainCoverageSchema,
    defiCoverage: z.array(defiCoverageSchema).max(100).optional(),
  })
  .strict()
  .refine(
    (l) =>
      l.coverage.chainId === l.chainId &&
      l.holdings.every((h) => h.chainId === l.chainId) &&
      (l.defiCoverage ?? []).every((d) => d.chainId === l.chainId),
  );
export const firstPageLineSchema = z
  .object({
    type: z.literal("firstPage"),
    reason: z.enum(["WAVES_SETTLED", "CHAIN_BUDGET", "DEADLINE", "ROUND_END"]),
    elapsedMs: ms,
    included: z.array(chainId).max(2500),
    outstanding: z.array(chainId).max(2500),
  })
  .strict();
export const defiReadyLineSchema = z
  .object({
    type: z.literal("defiReady"),
    reason: z.enum(["DEFI_CHAINS_SETTLED", "FIRST_PAGE"]),
    elapsedMs: ms,
  })
  .strict();
// Scheduler receipt (chain-level only; never a wallet address, balance or price).
export const walletReceiptSchema = z
  .object({
    v: z.literal(1),
    timing: z
      .object({
        planMs: ms,
        firstAssetMs: ms.nullable(),
        firstPageMs: ms.nullable(),
        defiReadyMs: ms.nullable(),
        roundMs: ms,
      })
      .strict(),
    waves: z.record(z.string().regex(/^[0-4]$/), z.number().int()),
    firstPage: z
      .object({
        reason: z.string().max(20).nullable(),
        included: z.number().int().nonnegative(),
        outstanding: z.array(chainId).max(2500),
      })
      .strict(),
    deferred: z.array(chainId).max(2500),
    concurrency: z
      .object({
        base: z.number().int(),
        max: z.number().int(),
        final: z.number().int(),
        peak: z.number().int(),
        increases: z.number().int(),
        backoffs: z.number().int(),
        groupWaits: z.number().int(),
      })
      .strict(),
    cache: z
      .object({
        hits: z.number().int(),
        joins: z.number().int(),
        reads: z.number().int(),
      })
      .strict(),
    chains: z
      .array(
        z
          .object({
            chainId,
            wave: z.number().int().min(0).max(4),
            startMs: ms.nullable(),
            settledMs: ms.nullable(),
            durationMs: ms.nullable(),
            outcome: z.enum(["DONE", "FAILED", "PENDING"]),
            cache: z.enum(["HIT", "JOINED", "READ"]).nullable(),
          })
          .strict(),
      )
      .max(2500),
  })
  .strict();
export type WalletReceipt = z.infer<typeof walletReceiptSchema>;
export const resultLineSchema = z
  .object({
    type: z.literal("result"),
    result: portfolioSchema,
    receipt: walletReceiptSchema.optional(),
  })
  .strict();
export const errorLineSchema = z
  .object({
    type: z.literal("error"),
    error: z.string().regex(/^[A-Z_]{1,40}$/),
  })
  .strict();
export type PlanLine = z.infer<typeof planLineSchema>;
export type NativeLine = z.infer<typeof nativeLineSchema>;
export type ChainLine = z.infer<typeof chainLineSchema>;
export type FirstPageLine = z.infer<typeof firstPageLineSchema>;
export type DefiReadyLine = z.infer<typeof defiReadyLineSchema>;
export type ResultLine = z.infer<typeof resultLineSchema>;
export type ProgressLine =
  PlanLine | NativeLine | ChainLine | FirstPageLine | DefiReadyLine;
export type WalletLine =
  ProgressLine | ResultLine | z.infer<typeof errorLineSchema>;
const byType: Record<string, z.ZodType<WalletLine>> = {
  plan: planLineSchema,
  native: nativeLineSchema as z.ZodType<WalletLine>,
  chain: chainLineSchema as z.ZodType<WalletLine>,
  firstPage: firstPageLineSchema,
  defiReady: defiReadyLineSchema,
  result: resultLineSchema,
  error: errorLineSchema,
};
/** Strict line validation (unknown types and extra fields are rejected). */
export function parseWalletLine(value: unknown): WalletLine {
  const type = (value as { type?: unknown } | null)?.type;
  const schema = typeof type === "string" ? byType[type] : undefined;
  if (!schema) throw Error("INVALID_LINE");
  return schema.parse(value);
}
// ---------------------------------------------------------------------------------------------------------------
// Provisional state of one round.
export interface WalletProgress {
  plan: PlanLine | null;
  /** Settled networks of this round (one line per network; a repeated line replaces, never adds). */
  chains: ReadonlyMap<string, ChainLine>;
  /** Native fast-path holdings of networks that have not settled yet. */
  natives: ReadonlyMap<string, Holding>;
  firstPage: FirstPageLine | null;
  defiReady: DefiReadyLine | null;
  startedAt: number;
}
export const emptyProgress = (startedAt = Date.now()): WalletProgress => ({
  plan: null,
  chains: new Map(),
  natives: new Map(),
  firstPage: null,
  defiReady: null,
  startedAt,
});
export function applyWalletLine(
  p: WalletProgress,
  line: ProgressLine,
): WalletProgress {
  switch (line.type) {
    case "plan":
      return p.plan ? p : { ...p, plan: line };
    case "native": {
      // A late native line can never replace a settled network's exact result.
      if (p.chains.has(line.chainId) || !planned(p, line.chainId)) return p;
      const natives = new Map(p.natives);
      natives.set(line.chainId, line.holding);
      return { ...p, natives };
    }
    case "chain": {
      if (!planned(p, line.chainId)) return p;
      const chains = new Map(p.chains);
      chains.set(line.chainId, line);
      const natives = new Map(p.natives);
      natives.delete(line.chainId);
      return { ...p, chains, natives };
    }
    case "firstPage":
      return p.firstPage ? p : { ...p, firstPage: line };
    case "defiReady":
      return p.defiReady ? p : { ...p, defiReady: line };
  }
}
const planned = (p: WalletProgress, id: string) =>
  !!p.plan?.chains.some((c) => c.chainId === id);
const pendingCoverage = (id: string, at: number): ChainCoverage => ({
  chainId: id,
  state: "PENDING",
  tier: "CATALOG_ONLY",
  native: "PENDING",
  tokens: "PENDING",
  historicalComplete: false,
  indexedFromBlock: null,
  indexedThroughBlock: null,
  headBlock: null,
  observedBlock: null,
  reason: "NONE",
  observedAt: at,
});
/**
 * The provisional round as a PortfolioResult: settled networks with their exact result, native fast-path rows of
 * networks still reading tokens, every other planned network PENDING, and the plan's terminal coverage. With `base`
 * (a continuation round), the round is merged into the previous view by the accepted continuation rule.
 */
export function progressiveResult(
  p: WalletProgress,
  base?: PortfolioResult,
): PortfolioResult | undefined {
  if (!p.plan) return base;
  const coverage = new Map<string, ChainCoverage>();
  for (const c of p.plan.coverage) coverage.set(c.chainId, c);
  for (const c of p.plan.chains)
    coverage.set(
      c.chainId,
      p.chains.get(c.chainId)?.coverage ??
        pendingCoverage(c.chainId, p.startedAt),
    );
  const holdings: Holding[] = [];
  for (const line of p.chains.values()) holdings.push(...line.holdings);
  for (const [id, h] of p.natives) if (!p.chains.has(id)) holdings.push(h);
  const list = [...coverage.values()];
  const summary = summarize(list);
  const round: PortfolioResult = {
    state:
      summary.pending > 0
        ? "PARTIAL"
        : summary.checked === 0
          ? "FAILED"
          : summary.coverageComplete
            ? "COMPLETE"
            : "PARTIAL",
    holdings,
    coverage: list,
    coverageSummary: summary,
    defiCoverage: [...p.chains.values()].flatMap((l) => l.defiCoverage ?? []),
    continuation: null,
    dataPlane: base?.dataPlane ?? "AVAILABLE",
    source: "otherbridge-data-plane",
    observedAt: p.startedAt,
    revision: "progressive",
  };
  return base ? mergePortfolio(base, round) : round;
}
/** Exact held asset ids (chainId:contract) on the given networks: the DeFi candidate input (never symbols). */
export function heldIds(
  holdings: readonly Holding[],
  chains?: ReadonlySet<string>,
): string[] {
  return [
    ...new Set(
      holdings
        .filter(
          (h) =>
            !h.spam &&
            !h.native &&
            (!chains || chains.has(h.chainId)) &&
            /^0x[0-9a-fA-F]{40}$/.test(h.address) &&
            BigInt(h.balance) > 0n,
        )
        .map((h) => h.chainId + ":" + h.address.toLowerCase())
        .filter((id) => /^\d{1,20}:0x[0-9a-f]{40}$/.test(id)),
    ),
  ]
    .sort()
    .slice(0, 1000);
}
/** First confirmed nonzero, non-spam holding in the provisional state (the first meaningful asset). */
export const hasMeaningfulAsset = (p: WalletProgress) =>
  [...p.natives.values()].some((h) => !h.spam && BigInt(h.balance) > 0n) ||
  [...p.chains.values()].some((l) =>
    l.holdings.some((h) => !h.spam && BigInt(h.balance) > 0n),
  );
/** First definitive answer (a network checked, with or without balance). */
export const hasCheckedResult = (p: WalletProgress) =>
  [...p.chains.values()].some(
    (l) => l.coverage.state !== "FAILED" && l.coverage.state !== "PENDING",
  );
