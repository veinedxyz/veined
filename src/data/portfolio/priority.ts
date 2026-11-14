// V1.14.2 explainable wallet-scan priority. Deterministic and order-only: evidence decides WHEN a network is read,
// never WHAT it holds, and every planned network is still read (no evidence ever removes a network from the plan).
// Scheduling evidence is never presented as a balance; a priority reason is not a coverage state.
export const PRIORITY_REASONS = [
  // The connected wallet's chain (client `priority`, ≤ 5).
  "CURRENT_CHAIN",
  // The user's current Bridge / Swap / Portfolio network (client `hints.context`, ≤ 5).
  "RECENT_USER_CONTEXT",
  // Networks where this same identity held a nonzero, non-spam balance in its previous scan (client memory only).
  "RECENT_NONZERO",
  // Canonical historical activity in the self-hosted index (scheduling evidence; never a current balance).
  "INDEXED_ACTIVITY",
  // Exact token candidates the user imported for the network.
  "KNOWN_TOKEN",
  // Mainstream routable network with Otherbridge's deepest reviewed coverage (curated asset registry, protocol
  // receipt contracts or reviewed DeFi deployments): canonical project metadata, not a list.
  "HIGH_CONFIDENCE_PORTFOLIO_CHAIN",
  // Routable network ranked by the accepted chain priority policy (routable first, then TVL).
  "GENERAL_PRIORITY",
  // Network outside the routing catalog (long tail).
  "LONG_TAIL",
  // Repeatedly exceeded the first-page budget: moved to the background wave (scheduling, not support status).
  "DEFERRED_TO_BACKGROUND_SLOW_CHAIN",
] as const;
export type PriorityReason = (typeof PRIORITY_REASONS)[number];
export type Wave = 0 | 1 | 2 | 3 | 4;
export const WAVE_LIMITS = {
  /** Wave 0: current chain + current user context. */
  current: 5,
  /** Wave 1: recent nonzero, indexed activity and known-token networks. */
  evidence: 24,
  /** Wave 2: routable networks taken from the head of the accepted priority policy in addition to the
   * high-confidence capability set. */
  generalHead: 8,
} as const;
export interface WaveEvidence {
  current?: readonly string[];
  context?: readonly string[];
  recent?: readonly string[];
  indexed?: ReadonlySet<string>;
  knownToken?: ReadonlySet<string>;
  highConfidence?: ReadonlySet<string>;
  routable?: ReadonlySet<string>;
  /** Networks quarantined by the slow-chain memory (process-level, chain-only). */
  slow?: ReadonlySet<string>;
}
export interface PlannedChain {
  chainId: string;
  wave: Wave;
  /** Every applicable reason, strongest first (the first reason explains the wave). */
  reasons: PriorityReason[];
  /** Index in the accepted canonical plan order (V1.14.1 order: priority, then activity / routable / TVL). */
  canonical: number;
}
/** The first-page set: waves 0-2 (current context, user evidence and high-confidence / high-priority networks). */
export const FIRST_PAGE_WAVES: readonly Wave[] = [0, 1, 2];
/**
 * Assigns every network of the canonical plan to exactly one wave and returns the scheduling order: wave by wave;
 * wave 0 in client order (current chain, then context), wave 1 with recent networks first in client (value) order,
 * every other wave in canonical order; deferred slow networks last. The output is a permutation of the input.
 */
export function planWaves(
  canonical: readonly string[],
  e: WaveEvidence,
): PlannedChain[] {
  const unique = [...new Set(canonical)];
  const index = new Map(unique.map((id, i) => [id, i]));
  const inPlan = (id: string) => index.has(id);
  const current = [...new Set(e.current ?? [])].filter(inPlan);
  const context = [...new Set(e.context ?? [])].filter(inPlan);
  const recent = [...new Set(e.recent ?? [])].filter(inPlan);
  const has = (s: ReadonlySet<string> | undefined, id: string) =>
    !!s && s.has(id);
  const reasonsOf = (id: string): PriorityReason[] => {
    const r: PriorityReason[] = [];
    if (current.includes(id)) r.push("CURRENT_CHAIN");
    if (context.includes(id)) r.push("RECENT_USER_CONTEXT");
    if (recent.includes(id)) r.push("RECENT_NONZERO");
    if (has(e.indexed, id)) r.push("INDEXED_ACTIVITY");
    if (has(e.knownToken, id)) r.push("KNOWN_TOKEN");
    const routable = has(e.routable, id);
    if (routable && has(e.highConfidence, id))
      r.push("HIGH_CONFIDENCE_PORTFOLIO_CHAIN");
    r.push(routable ? "GENERAL_PRIORITY" : "LONG_TAIL");
    if (has(e.slow, id)) r.push("DEFERRED_TO_BACKGROUND_SLOW_CHAIN");
    return r;
  };
  const wave = new Map<string, Wave>();
  // Wave 0: current chain(s), then current user context, bounded.
  for (const id of [...current, ...context])
    if (!wave.has(id) && [...wave.values()].length < WAVE_LIMITS.current)
      wave.set(id, 0);
  // Wave 1: user evidence (recent nonzero first, in client value order; then index / known-token in canonical order).
  const evidence = [
    ...recent,
    ...unique.filter((id) => has(e.indexed, id) || has(e.knownToken, id)),
  ];
  let w1 = 0;
  for (const id of evidence)
    if (!wave.has(id) && w1 < WAVE_LIMITS.evidence) {
      wave.set(id, 1);
      w1++;
    }
  // Waves 2-4 (generic scheduling evidence; a quarantined slow network is deferred to wave 4).
  let head = 0;
  for (const id of unique) {
    if (wave.has(id)) continue;
    const routable = has(e.routable, id);
    if (has(e.slow, id)) wave.set(id, 4);
    else if (routable && has(e.highConfidence, id)) wave.set(id, 2);
    else if (routable && head < WAVE_LIMITS.generalHead) {
      wave.set(id, 2);
      head++;
    } else wave.set(id, routable ? 3 : 4);
  }
  const order = (id: string) => {
    const w = wave.get(id)!;
    if (w === 0) {
      const i = current.indexOf(id);
      return i >= 0 ? i : current.length + context.indexOf(id);
    }
    if (w === 1) {
      const i = recent.indexOf(id);
      return i >= 0 ? i : recent.length + index.get(id)!;
    }
    // Deferred slow networks run after every other wave-4 network.
    return (has(e.slow, id) ? unique.length : 0) + index.get(id)!;
  };
  return unique
    .map((chainId) => {
      const reasons = reasonsOf(chainId);
      const w = wave.get(chainId)!;
      // The explaining reason first: the one that placed the network in its wave.
      const lead: PriorityReason | undefined =
        w === 0
          ? reasons.find(
              (r) => r === "CURRENT_CHAIN" || r === "RECENT_USER_CONTEXT",
            )
          : w === 1
            ? reasons.find(
                (r) =>
                  r === "RECENT_NONZERO" ||
                  r === "INDEXED_ACTIVITY" ||
                  r === "KNOWN_TOKEN",
              )
            : w === 4 && has(e.slow, chainId)
              ? "DEFERRED_TO_BACKGROUND_SLOW_CHAIN"
              : w === 2
                ? (reasons.find(
                    (r) => r === "HIGH_CONFIDENCE_PORTFOLIO_CHAIN",
                  ) ?? "GENERAL_PRIORITY")
                : undefined;
      return {
        chainId,
        wave: w,
        reasons: lead ? [lead, ...reasons.filter((r) => r !== lead)] : reasons,
        canonical: index.get(chainId)!,
      };
    })
    .sort(
      (a, b) =>
        a.wave - b.wave ||
        order(a.chainId) - order(b.chainId) ||
        a.canonical - b.canonical,
    );
}
/** Scheduling class for the process-wide read slots: first-result reads, first-page reads, background coverage. */
export const slotPriority = (wave: Wave) =>
  wave <= 1 ? 0 : wave === 2 ? 1 : 2;
