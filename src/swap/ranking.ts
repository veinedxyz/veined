import { quoteEligible, type SwapIntent, type SwapQuote } from "./model";
const cmp = (a: bigint, b: bigint) => (a < b ? -1 : a > b ? 1 : 0);
export function netValue(
  q: SwapQuote,
  kind: SwapIntent["kind"],
): bigint | null {
  const base = kind === "EXACT_IN" ? q.outputUsdMicros : q.inputUsdMicros;
  if (
    q.valuation !== "INDEPENDENT" ||
    base === null ||
    !q.costs.some((c) => c.kind === "NETWORK") ||
    q.costs.some(
      (c) =>
        !c.included &&
        (c.amount === null ||
          (c.amount > 0n &&
            (c.usdMicros === null || c.evidence !== "INDEPENDENT"))),
    )
  )
    return null;
  const extra = q.costs
    .filter((c) => !c.included)
    .reduce((v, c) => v + (c.usdMicros ?? 0n), 0n);
  return kind === "EXACT_IN" ? base - extra : -(base + extra);
}
export function rankQuotes(
  quotes: SwapQuote[],
  i: SwapIntent,
  now = Date.now(),
) {
  const valid = quotes.filter((q) => quoteEligible(q, now));
  const net =
    valid.length > 0 && valid.every((q) => netValue(q, i.kind) !== null);
  const output = (a: SwapQuote, b: SwapQuote) =>
    i.kind === "EXACT_IN"
      ? cmp(b.amountOut, a.amountOut)
      : cmp(a.amountIn, b.amountIn);
  valid.sort((a, b) => {
    if (i.preference === "RECOMMENDED" && net) {
      const d = cmp(netValue(b, i.kind)!, netValue(a, i.kind)!);
      if (d) return d;
    }
    if (i.preference === "FASTEST" && a.latencyMs !== b.latencyMs)
      return a.latencyMs - b.latencyMs;
    if (i.preference === "DIRECT") {
      const d = a.hops - b.hops || a.splitCount - b.splitCount;
      if (d) return d;
    }
    return output(a, b) || a.id.localeCompare(b.id);
  });
  return {
    quotes: valid,
    basis:
      i.preference === "RECOMMENDED" && net
        ? ("BEST_NET_VALUE" as const)
        : ("RAW_OUTPUT" as const),
    checkedProviders: new Set(valid.map((q) => q.provider)).size,
  };
}
/** Selection binds a quote version, not a provider. A stream update cannot replace the reviewed bytes. */
export function stickySelection(
  selected: SwapQuote | undefined,
  ranked: SwapQuote[],
) {
  const best = ranked[0];
  const current = selected ?? best;
  const better = !!(
    selected &&
    best &&
    best.id !== selected.id &&
    ((best.amountOut * 10000n > selected.amountOut * 10010n &&
      best.amountIn <= selected.amountIn) ||
      (best.amountOut >= selected.amountOut &&
        best.amountIn * 10010n < selected.amountIn * 10000n))
  );
  return { selected: current, better };
}
