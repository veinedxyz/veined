// G12 H03: a quote as its source reported it -> the inputs of quoteEconomics (pure; no I/O, no React). Used by the
// notice next to the quote and by the live read-only evidence probe, so both read a quote the same way. These
// functions never throw: anything they cannot read yields null (no notice), never a guessed number.
import type { RoutingQuote, Asset } from "../routing/model";
import type { SwapQuote } from "../swap/model";
import { quoteEconomics, usdMicros, type Economics } from "./economics";

/** What the registry knows about one side of a route (exact chain + contract), as the Guardian surface reads it. */
export interface AssetEvidence {
  chainId: string;
  symbol: string;
  decimals: number;
  native: boolean;
  level?: string;
  risk?: readonly string[];
  /** The registry's market listing id of this exact contract, when it has one. */
  coingeckoId?: string;
}
/** Native coins that are the same asset on every network that uses them as its native coin. */
const SAME_NATIVE: ReadonlySet<string> = new Set(["ETH"]);
/**
 * The same reviewed asset on two different networks: both sides trusted by the registry (no risk flag), the same symbol
 * and decimals, AND the same identity - the same market listing for tokens (so a bridged token that merely carries the
 * symbol is not "the same"), or an allow-listed native coin on both sides. Anything unknown is "not the same".
 */
export function sameReviewedAsset(a: AssetEvidence, b: AssetEvidence): boolean {
  const trusted = (x: AssetEvidence) =>
    (x.level === "CANONICAL" || x.level === "CURATED") && !x.risk?.length;
  if (
    a.chainId === b.chainId ||
    !trusted(a) ||
    !trusted(b) ||
    a.symbol !== b.symbol ||
    a.decimals !== b.decimals
  )
    return false;
  if (a.native || b.native)
    return a.native && b.native && SAME_NATIVE.has(a.symbol);
  return !!a.coingeckoId && a.coingeckoId === b.coingeckoId;
}

/** A cross-chain route's economics from the quote exactly as the route source reported it. */
export function routingEconomics(
  q: RoutingQuote,
  from: Pick<Asset, "decimals">,
  to: Pick<Asset, "decimals">,
  sameAsset: boolean,
): Economics | null {
  try {
    const amountIn = BigInt(q.input.amount),
      expectedOut = BigInt(q.expected),
      minimumOut = BigInt(q.minimum);
    const out = usdMicros(q.outputUsd);
    // The value of the amount sent, from the route source's own figures only:
    //   same asset: the output's unit price applies to the input (exact);
    //   a reported loss (0 < price impact < 1): input = output / (1 - impact);
    //   no loss reported (impact 0: the input is worth at most the output): the output value stands in, so the cost
    //     share is a lower bound;
    //   price impact unknown: the input value is UNKNOWN (never guessed), so no cost statement is made.
    // The route source's own input value is not part of the normalized quote; that limit is stated in the H03 report.
    let input: bigint | null = null;
    if (out !== null && out > 0n) {
      if (sameAsset && expectedOut > 0n)
        input =
          (out * amountIn * 10n ** BigInt(to.decimals)) /
          (expectedOut * 10n ** BigInt(from.decimals));
      else if (q.priceImpact !== null && Number.isFinite(q.priceImpact)) {
        const impact = BigInt(Math.round(q.priceImpact * 1_000_000));
        if (impact === 0n) input = out;
        else if (impact > 0n && impact < 1_000_000n)
          input = (out * 1_000_000n) / (1_000_000n - impact);
      }
    }
    return quoteEconomics({
      sameAsset,
      amountIn,
      inDecimals: from.decimals,
      expectedOut,
      minimumOut,
      outDecimals: to.decimals,
      inputUsdMicros: input,
      outputUsdMicros: out,
      costs: q.fees.map((f) => ({
        // A cost line of exactly zero units costs nothing even when the source attached no dollar value to it.
        usdMicros: usdMicros(f.usd) ?? (/^0+$/.test(f.amount) ? 0n : null),
        included: f.included,
      })),
    });
  } catch {
    return null;
  }
}

/** A same-network swap quote's economics (independent or provider valuation as the quote carries it). */
export function swapEconomics(
  q: Pick<
    SwapQuote,
    | "amountIn"
    | "amountOut"
    | "minAmountOut"
    | "inputUsdMicros"
    | "outputUsdMicros"
    | "costs"
  >,
  inDecimals: number,
  outDecimals: number,
): Economics | null {
  try {
    return quoteEconomics({
      sameAsset: false,
      amountIn: q.amountIn,
      inDecimals,
      expectedOut: q.amountOut,
      minimumOut: q.minAmountOut,
      outDecimals,
      inputUsdMicros: q.inputUsdMicros,
      outputUsdMicros: q.outputUsdMicros,
      costs: q.costs.map((c) => ({
        usdMicros: c.amount === 0n ? 0n : c.usdMicros,
        included: c.included,
      })),
    });
  } catch {
    return null;
  }
}
