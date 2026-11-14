import { createHash, randomBytes } from "node:crypto";
import type { Catalog, Network } from "../routing/model";
import {
  identitySchema,
  normalizeHoldings,
  type ChainCoverage,
  type PortfolioIdentity,
  type PortfolioProvider,
  type PortfolioResult,
  type Holding,
} from "./model";
import { summarize } from "../data/core/coverage";
import {
  runScheduled,
  encodeContinuation,
  decodeContinuation,
  encodeBoundContinuation,
  decodeBoundContinuation,
  planDigest,
} from "../data/portfolio/scheduler";
import {
  planWaves,
  slotPriority,
  type PlannedChain,
  type Wave,
} from "../data/portfolio/priority";
import {
  recordChainDuration,
  slowChains,
  walletReadSlots,
} from "../data/portfolio/chain-cache";
import { walletPseudonym } from "../data/core/privacy";
import { positionContracts, type DefiCoverage } from "./positions";
import { deployments } from "../defi/registry";
import type {
  ChainLine,
  DefiReadyLine,
  FirstPageLine,
  NativeLine,
  PlanLine,
  WalletReceipt,
} from "./stream";
/** V1.14.2 progressive events: the stream lines (validated by the route) plus the round's scheduler receipt. */
export type WalletEvent =
  | PlanLine
  | NativeLine
  | ChainLine
  | FirstPageLine
  | DefiReadyLine
  | { type: "scheduler"; receipt: WalletReceipt };
export interface ScanOptions {
  continuation?: string | null;
  concurrency?: number;
  deadlineMs?: number;
  perChainMs?: number;
  maxChains?: number;
  /** V1.11: chains to scan first (e.g. the connected wallet's chain); order only. */
  priority?: string[];
  onRun?: (run: {
    scope: string;
    planned: string[];
    elapsedMs: number;
    result: PortfolioResult;
  }) => void;
  /**
   * V1.14.2 multi-wave progressive scan (the app route). Absent → the V1.14.1 single-order scan (Data API): the same
   * plan in the same order, only the cursor is the bound v2 cursor.
   */
  waves?: boolean;
  /** V1.14.2 client scheduling evidence (order only; never a balance): previous-scan nonzero networks, user context. */
  hints?: { recent?: string[]; context?: string[] };
  /** V1.14.2 adaptive concurrency hard maximum (wave scans only). */
  maxConcurrency?: number;
  /** V1.14.2 explicit refresh: skip the short wallet-chain result cache (an identical running read is still joined). */
  fresh?: boolean;
  /** V1.14.2 progressive events (wave scans only). */
  onEvent?: (event: WalletEvent) => void;
}
const blank = (chainId: string, at: number): ChainCoverage => ({
  chainId,
  state: "PENDING",
  tier: "CATALOG_ONLY",
  native: "PENDING",
  tokens: "PENDING",
  historicalComplete: false,
  indexedFromBlock: null,
  indexedThroughBlock: null,
  headBlock: null,
  observedBlock: null,
  reason: "DEADLINE",
  observedAt: at,
});
const failedCoverage = (
  id: string,
  code: string,
  at: number,
): ChainCoverage => ({
  ...blank(id, at),
  state: "FAILED",
  native: "FAILED",
  tokens: "FAILED",
  reason: /CHAIN_MISMATCH/.test(code) ? "CHAIN_MISMATCH" : "RPC_UNAVAILABLE",
});
// V1.14.2 first-page rule (deterministic; never "wait N seconds" alone). The first page is the set of waves 0-2. It
// completes when every first-page network has an answer (WAVES_SETTLED); when every first-page network still without
// an answer has been reading for longer than the chain budget (CHAIN_BUDGET: one slow provider never holds the
// page); at the first-page deadline (DEADLINE); or when the round ends first (ROUND_END). A network that exceeds
// the chain budget earns a slow-chain strike (two strikes in 30 minutes defer it to the background wave).
export const FIRST_PAGE_DEADLINE_MS = 5000;
export const FIRST_PAGE_CHAIN_BUDGET_MS = 2000;
const FIRST_PAGE_TICK_MS = 50;
// Progressive scans may raise parallelism only while the host is not under memory pressure.
const LOAD_RSS_BYTES = 1536 * 2 ** 20;
// Planned networks hosting reviewed DeFi deployments: the DeFi start trigger waits for their wallet answer, because
// their exact held receipt tokens admit DeFi candidates (candidate truth).
const DEFI_CHAINS = new Set(deployments.map((d) => d.chainId));
// Canonical (fixed key order) so equivalent identities always share one continuation scope.
export function identityScope(identity: PortfolioIdentity) {
  const canonical = (
    ["evm", "solana", "bitcoin", "sui", "tron", "stellar"] as const
  ).map((k) => [k, identity[k] ?? null]);
  return walletPseudonym(JSON.stringify(canonical)).slice(0, 16);
}
// Provider-neutral orchestration. Every discovered chain is scheduled (no fixed cap); work is bounded
// by concurrency, per-chain timeouts and a deadline, and anything unfinished is explicitly PENDING.
export async function scanPortfolio(
  identity: PortfolioIdentity,
  catalog: Catalog,
  signal?: AbortSignal,
  providers: PortfolioProvider[] = [],
  options: ScanOptions = {},
): Promise<PortfolioResult> {
  identitySchema.parse(identity);
  const t0 = Date.now();
  const waves = options.waves === true;
  const emit = (event: WalletEvent) => {
    try {
      options.onEvent?.(event);
    } catch {
      /* A consumer never breaks the scan. */
    }
  };
  const deadlineMs = options.deadlineMs ?? 20000;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(deadlineMs),
    ...(signal ? [signal] : []),
  ]);
  const discovered = await Promise.allSettled(
    providers.map((p) => p.discoverActivity(identity, deadline)),
  );
  const ids = [
    ...new Set(
      discovered.flatMap((r) => (r.status === "fulfilled" ? r.value : [])),
    ),
  ];
  const scope = identityScope(identity);
  const at0 = Date.now();
  const networkFor = (id: string): Network | undefined =>
    catalog.networks.find((n) => n.mainnet && n.id === id) ??
    providers.map((p) => p.describe?.(id)).find((n): n is Network => !!n);
  const scannable = ids.filter((id) => {
    const n = networkFor(id);
    return (
      n &&
      providers.some((p) => p.capabilities().ecosystems.includes(n.ecosystem))
    );
  });
  const unsupportedIds = ids.filter((id) => !scannable.includes(id));
  const first = (options.priority ?? []).filter((id) => scannable.includes(id));
  // V1.14.2 bound cursor: identity scope, scan generation, catalog version + planned network set, round, expiry.
  const plan = planDigest(catalog.generation ?? "", scannable);
  let generation = randomBytes(8).toString("hex"),
    round = 1;
  let planned: string[];
  if (options.continuation) {
    // The progressive app scan accepts only its bound v2 cursor; the Data API keeps the accepted v1 cursor.
    if (waves && !options.continuation.includes("."))
      throw Error("INVALID_CONTINUATION");
    if (waves) {
      const cursor = decodeBoundContinuation(
        options.continuation,
        scope,
        plan,
        scannable,
      );
      planned = cursor.pending;
      generation = cursor.generation;
      round = cursor.round + 1;
    } else planned = decodeContinuation(options.continuation, scope, scannable);
  } else planned = [...first, ...scannable.filter((id) => !first.includes(id))];
  const continued = !!options.continuation;
  // The accepted per-scan provider budgets (e.g. upstream price chains) follow the accepted canonical plan order, so
  // the scheduling order of the waves can never change which networks are priced (economic equivalence).
  if (waves) for (const p of providers) p.planScan?.(planned);
  // Waves: order only. Every planned network stays scheduled; evidence never removes one.
  let order = planned;
  let waveOf = new Map<string, Wave>();
  let chainPlan: PlannedChain[] = [];
  if (waves) {
    const evidence = await Promise.all(
      providers.map((p) =>
        p.scanEvidence ? p.scanEvidence(identity).catch(() => null) : null,
      ),
    );
    const union = (
      k: "indexed" | "knownToken" | "highConfidence" | "routable",
    ) => new Set(evidence.flatMap((e) => (e ? [...e[k]] : [])));
    const recent = (options.hints?.recent ?? []).slice(0, 24);
    // A priority entry that the client also reports as previous-scan evidence is explained by that evidence; the
    // first entry is the connected chain.
    const current = first.filter((id, i) => i === 0 || !recent.includes(id));
    chainPlan = planWaves(planned, {
      current,
      context: (options.hints?.context ?? []).slice(0, 5),
      recent,
      indexed: union("indexed"),
      knownToken: union("knownToken"),
      highConfidence: union("highConfidence"),
      routable: union("routable"),
      slow: slowChains(),
    });
    order = chainPlan.map((c) => c.chainId);
    waveOf = new Map(chainPlan.map((c) => [c.chainId, c.wave]));
  }
  // Terminal coverage of networks that are not scheduled (first round only), computed before the round so the plan
  // can show it, and applied after the scheduled answers with the accepted precedence: unsupported ecosystems and
  // non-EVM identities always; a provider's unscannable network only where nothing else answered.
  const forced = new Map<string, ChainCoverage>(),
    fallback = new Map<string, ChainCoverage>();
  if (!continued) {
    const at = Date.now();
    const catalogOnly = (id: string, reason: ChainCoverage["reason"]) => ({
      ...blank(id, at),
      state: "CATALOG_ONLY" as const,
      native: "UNSUPPORTED" as const,
      tokens: "NOT_CHECKED" as const,
      reason,
    });
    for (const id of unsupportedIds)
      forced.set(id, catalogOnly(id, "UNSUPPORTED_ECOSYSTEM"));
    for (const p of providers)
      for (const c of (await p.unscannable?.(identity).catch(() => [])) ?? [])
        if (!forced.has(c.chainId) && !fallback.has(c.chainId))
          fallback.set(c.chainId, c);
    for (const key of ["bitcoin", "sui", "tron", "stellar"] as const)
      if (identity[key])
        forced.set(key, catalogOnly(key, "UNSUPPORTED_ECOSYSTEM"));
    const SOL = "1151111081099710";
    if (
      identity.solana &&
      !planned.some((id) => networkFor(id)?.ecosystem === "SVM") &&
      !forced.has(SOL) &&
      !fallback.has(SOL)
    )
      fallback.set(SOL, catalogOnly(SOL, "NO_VETTED_RPC"));
  }
  const terminal = [
    ...forced.values(),
    ...[...fallback.values()].filter((c) => !order.includes(c.chainId)),
  ];
  const holdings: Holding[] = [];
  const coverage = new Map<string, ChainCoverage>();
  // The first page is waves 0-2, except networks quarantined as slow: a slow network that keeps user evidence is
  // still read early in its wave, but it never holds the first page again (it already exceeded the budget twice).
  const quarantined = (c: PlannedChain) =>
    c.reasons.includes("DEFERRED_TO_BACKGROUND_SLOW_CHAIN");
  const firstPageSet = new Set(
    !continued && waves
      ? chainPlan
          .filter((c) => c.wave <= 2 && !quarantined(c))
          .map((c) => c.chainId)
      : [],
  );
  const defiSet = new Set(
    !continued && waves ? order.filter((id) => DEFI_CHAINS.has(id)) : [],
  );
  if (waves)
    emit({
      type: "plan",
      v: 1,
      continued,
      chains: chainPlan.map((c) => ({
        chainId: c.chainId,
        wave: c.wave,
        reasons: c.reasons,
      })),
      coverage: terminal.filter((c) => !order.includes(c.chainId)),
      firstPage: {
        chains: firstPageSet.size,
        deadlineMs: FIRST_PAGE_DEADLINE_MS,
        chainBudgetMs: FIRST_PAGE_CHAIN_BUDGET_MS,
      },
      defiChains: [...defiSet],
    });
  const planMs = Date.now() - t0;
  // Progressive bookkeeping (chain-level only; no wallet data).
  const started = new Map<string, number>(),
    settledAt = new Map<string, number>(),
    durations = new Map<string, number>(),
    cacheOf = new Map<string, "HIT" | "JOINED" | "READ">();
  let firstAssetMs: number | null = null;
  let firstPage: FirstPageLine | null = null;
  let defiReady: DefiReadyLine | null = null;
  const checkDefi = () => {
    if (defiReady || !waves || continued) return;
    const reason = [...defiSet].every((id) => settledAt.has(id))
      ? "DEFI_CHAINS_SETTLED"
      : firstPage
        ? "FIRST_PAGE"
        : null;
    if (!reason) return;
    defiReady = { type: "defiReady", reason, elapsedMs: Date.now() - t0 };
    emit(defiReady);
  };
  let tick: ReturnType<typeof setInterval> | undefined;
  const checkFirstPage = (end = false) => {
    if (firstPage || !waves || continued) return;
    const now = Date.now();
    const outstanding = [...firstPageSet].filter((id) => !settledAt.has(id));
    const reason: FirstPageLine["reason"] | null = !outstanding.length
      ? "WAVES_SETTLED"
      : outstanding.every(
            (id) =>
              started.has(id) &&
              now - started.get(id)! >= FIRST_PAGE_CHAIN_BUDGET_MS,
          )
        ? "CHAIN_BUDGET"
        : now - t0 >= FIRST_PAGE_DEADLINE_MS
          ? "DEADLINE"
          : end
            ? "ROUND_END"
            : null;
    if (!reason) return;
    firstPage = {
      type: "firstPage",
      reason,
      elapsedMs: now - t0,
      included: order.filter((id) => settledAt.has(id)),
      outstanding,
    };
    clearInterval(tick);
    emit(firstPage);
    checkDefi();
  };
  if (waves && !continued)
    tick = setInterval(() => checkFirstPage(), FIRST_PAGE_TICK_MS);
  const remainingBudget = Math.max(1000, deadlineMs - (Date.now() - at0));
  // Operator group of each network's primary endpoint (bounded per-group parallelism), resolved once per round.
  const groups = new Map<string, string>();
  type ChainValue = {
    rows: Holding[];
    coverage: ChainCoverage;
    defiCoverage: DefiCoverage[] | undefined;
  };
  let schedule: Awaited<ReturnType<typeof runScheduled<ChainValue>>>;
  try {
    schedule = await runScheduled<ChainValue>(
      order,
      async (id, taskSignal) => {
        const n = networkFor(id)!;
        let last: unknown = Error("NO_PROVIDER");
        for (const p of providers) {
          if (!p.capabilities().ecosystems.includes(n.ecosystem)) continue;
          try {
            if (p.scanChain) {
              const r = await p.scanChain(
                n,
                identity,
                taskSignal,
                waves
                  ? {
                      fresh: options.fresh,
                      timeoutMs: options.perChainMs ?? 8000,
                      // Native fast path: a confirmed nonzero native balance before the chain's token reads end.
                      onNative: (h) => {
                        if (settledAt.has(id) || taskSignal.aborted) return;
                        const [row] = normalizeHoldings([h]);
                        if (
                          !row ||
                          row.chainId !== id ||
                          !row.native ||
                          row.spam ||
                          BigInt(row.balance) === 0n
                        )
                          return;
                        firstAssetMs ??= Date.now() - t0;
                        emit({ type: "native", chainId: id, holding: row });
                      },
                    }
                  : undefined,
              );
              const rows = normalizeHoldings(r.holdings);
              if (
                rows.some((h) => h.chainId !== n.id) ||
                r.coverage.chainId !== n.id
              )
                throw Error("CHAIN_MISMATCH");
              if (r.cache) cacheOf.set(id, r.cache);
              return {
                rows,
                coverage: r.coverage,
                defiCoverage: r.defiCoverage,
              };
            }
            const rows = normalizeHoldings(
              await p.getBalances(n, identity, taskSignal),
            );
            if (rows.some((h) => h.chainId !== n.id))
              throw Error("CHAIN_MISMATCH");
            const fungible = p.capabilities().fungible;
            return {
              defiCoverage: undefined,
              rows: rows.map((h) => ({
                ...h,
                discovery: h.discovery ?? (h.native ? "native" : "provider"),
              })),
              coverage: {
                ...blank(n.id, Date.now()),
                state: fungible ? "COMPLETE" : "NATIVE_ONLY",
                tier: fungible ? "ON_DEMAND_FUNGIBLE" : "NATIVE_ONLY",
                native: "CHECKED",
                tokens: fungible ? "KNOWN_TOKENS" : "NOT_CHECKED",
                reason: "NONE",
              } satisfies ChainCoverage,
            };
          } catch (error) {
            last = error;
            if (taskSignal.aborted) throw error;
            /* Try the next provider's safe fallback; identifiers/payloads are never logged. */
          }
        }
        throw last;
      },
      {
        concurrency: options.concurrency ?? 3,
        deadlineMs: remainingBudget,
        perTaskMs: options.perChainMs ?? 8000,
        maxTasks: options.maxChains ?? 2000,
        signal,
        ...(waves
          ? {
              maxConcurrency: Math.max(
                options.concurrency ?? 3,
                options.maxConcurrency ?? options.concurrency ?? 3,
              ),
              groupOf: (id: string) => {
                let g = groups.get(id);
                if (g === undefined)
                  groups.set(
                    id,
                    (g =
                      providers
                        .map((p) => p.operatorGroup?.(id))
                        .find(Boolean) ?? `chain:${id}`),
                  );
                return g;
              },
              perGroup: 4,
              slots: walletReadSlots,
              priorityOf: (id: string) => slotPriority(waveOf.get(id) ?? 4),
              loadOk: () => process.memoryUsage().rss < LOAD_RSS_BYTES,
              onStart: (id: string, at: number) => started.set(id, at),
              onSettle: (
                id: string,
                outcome:
                  { ok: true; value: ChainValue } | { ok: false; code: string },
                at: number,
                durationMs: number,
              ) => {
                settledAt.set(id, at - t0);
                durations.set(id, durationMs);
                const wave = waveOf.get(id) ?? 4;
                // Slow-chain memory (chain-only): only first-page networks are measured against the page budget.
                if (wave <= 2)
                  recordChainDuration(
                    id,
                    outcome.ok || outcome.code !== "TIMEOUT"
                      ? durationMs
                      : Number.POSITIVE_INFINITY,
                    FIRST_PAGE_CHAIN_BUDGET_MS,
                  );
                const line: ChainLine = outcome.ok
                  ? {
                      type: "chain",
                      chainId: id,
                      wave,
                      holdings: outcome.value.rows,
                      coverage: outcome.value.coverage,
                      ...(outcome.value.defiCoverage
                        ? { defiCoverage: outcome.value.defiCoverage }
                        : {}),
                    }
                  : {
                      type: "chain",
                      chainId: id,
                      wave,
                      holdings: [],
                      coverage: failedCoverage(id, outcome.code, Date.now()),
                    };
                if (
                  firstAssetMs === null &&
                  line.holdings.some((h) => !h.spam && BigInt(h.balance) > 0n)
                )
                  firstAssetMs = Date.now() - t0;
                emit(line);
                checkFirstPage();
                checkDefi();
              },
            }
          : {}),
      },
    );
  } finally {
    clearInterval(tick);
  }
  checkFirstPage(true);
  checkDefi();
  const at = Date.now();
  for (const [id, value] of schedule.done) {
    holdings.push(...value.rows);
    coverage.set(id, value.coverage);
  }
  for (const [id, code] of schedule.failed)
    coverage.set(id, failedCoverage(id, code, at));
  for (const id of schedule.pending) coverage.set(id, blank(id, at));
  for (const [id, c] of forced) coverage.set(id, { ...c, observedAt: at });
  for (const [id, c] of fallback) if (!coverage.has(id)) coverage.set(id, c);
  const list = [...coverage.values()];
  const summary = summarize(list);
  const normalized = normalizeHoldings(holdings);
  const defiCoverage: DefiCoverage[] = [...schedule.done.values()].flatMap(
    (r) => r.defiCoverage ?? [],
  );
  if (identity.evm)
    for (const p of positionContracts) {
      if (
        defiCoverage.some(
          (c) =>
            c.chainId === p.chainId &&
            c.protocol === p.protocol &&
            c.category === p.category,
        )
      )
        continue;
      const c = coverage.get(p.chainId);
      const group = positionContracts.filter(
        (x) =>
          x.chainId === p.chainId &&
          x.protocol === p.protocol &&
          x.category === p.category,
      );
      defiCoverage.push({
        chainId: p.chainId,
        protocol: p.protocol,
        category: p.category,
        state:
          c?.state === "PENDING"
            ? "PENDING"
            : c?.state === "FAILED"
              ? "FAILED"
              : "NOT_CHECKED",
        checked: 0,
        planned: group.length,
        observedAt: at,
        observedBlock: null,
      });
    }
  // Pending networks continue in the accepted canonical order (never the wave order).
  const canonicalIndex = new Map(planned.map((id, i) => [id, i]));
  const pending = [...schedule.pending].sort(
    (a, b) =>
      (canonicalIndex.get(a) ?? Infinity) - (canonicalIndex.get(b) ?? Infinity),
  );
  const statuses = providers.map((p) => p.status?.() ?? "AVAILABLE");
  const result: PortfolioResult = {
    state: catalog.stale
      ? "STALE"
      : summary.checked === 0
        ? "FAILED"
        : summary.coverageComplete
          ? "COMPLETE"
          : "PARTIAL",
    holdings: normalized,
    defiCoverage,
    coverage: list,
    coverageSummary: summary,
    continuation: waves
      ? encodeBoundContinuation({ scope, generation, plan, round }, pending)
      : encodeContinuation(scope, schedule.pending),
    dataPlane: statuses.includes("AVAILABLE")
      ? "AVAILABLE"
      : statuses.includes("DEGRADED")
        ? "DEGRADED"
        : "UNAVAILABLE",
    source: "otherbridge-data-plane",
    observedAt: at,
    revision: createHash("sha256")
      .update(JSON.stringify([at, scope, normalized, list]))
      .digest("hex"),
  };
  if (waves) {
    const fp = firstPage as FirstPageLine | null;
    const dr = defiReady as DefiReadyLine | null;
    const counts: Record<string, number> = {};
    for (const c of chainPlan) counts[c.wave] = (counts[c.wave] ?? 0) + 1;
    const hits = [...cacheOf.values()];
    emit({
      type: "scheduler",
      receipt: {
        v: 1,
        timing: {
          planMs,
          firstAssetMs,
          firstPageMs: fp?.elapsedMs ?? null,
          defiReadyMs: dr?.elapsedMs ?? null,
          roundMs: at - t0,
        },
        waves: counts,
        firstPage: {
          reason: fp?.reason ?? null,
          included: fp?.included.length ?? 0,
          outstanding: fp?.outstanding ?? [],
        },
        deferred: chainPlan.filter(quarantined).map((c) => c.chainId),
        concurrency: {
          base: schedule.adaptive?.base ?? options.concurrency ?? 3,
          max: schedule.adaptive?.max ?? options.concurrency ?? 3,
          final: schedule.adaptive?.final ?? options.concurrency ?? 3,
          peak: schedule.maxInFlight,
          increases: schedule.adaptive?.increases ?? 0,
          backoffs: schedule.adaptive?.backoffs ?? 0,
          groupWaits: schedule.adaptive?.groupWaits ?? 0,
        },
        cache: {
          hits: hits.filter((c) => c === "HIT").length,
          joins: hits.filter((c) => c === "JOINED").length,
          reads: hits.filter((c) => c === "READ").length,
        },
        chains: chainPlan.map((c) => {
          const s = started.get(c.chainId);
          return {
            chainId: c.chainId,
            wave: c.wave,
            startMs: s === undefined ? null : Math.max(0, s - t0),
            settledMs: settledAt.get(c.chainId) ?? null,
            durationMs: durations.get(c.chainId) ?? null,
            outcome: schedule.done.has(c.chainId)
              ? "DONE"
              : schedule.failed.has(c.chainId)
                ? "FAILED"
                : "PENDING",
            cache: cacheOf.get(c.chainId) ?? null,
          };
        }),
      },
    });
  }
  options.onRun?.({ scope, planned, elapsedMs: schedule.elapsedMs, result });
  return result;
}
