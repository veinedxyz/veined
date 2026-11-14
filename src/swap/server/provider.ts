import {
  POLICY,
  SwapError,
  type Provider,
  type ProviderMode,
  type RouteLeg,
  type SwapCost,
  type SwapIntent,
  type SwapQuote,
} from "../model";
import { digest } from "./digest";
export type EvmBuild = {
  ecosystem: "EVM";
  chainId: string;
  from: string;
  to: string;
  value: string;
  data: `0x${string}`;
};
export type SolanaBuild = {
  ecosystem: "SVM";
  transaction: string;
  lastValidBlockHeight: number | null;
};
export type UnsignedBuild = EvmBuild | SolanaBuild;
export interface QuoteAdapter {
  mode: ProviderMode;
  provider: Provider;
  chains: readonly string[];
  exactOut: boolean;
  quote(
    i: SwapIntent,
    signal: AbortSignal,
    onQuote?: (q: SwapQuote) => void,
  ): Promise<SwapQuote[]>;
  build?(
    q: SwapQuote,
    i: SwapIntent,
    signal: AbortSignal,
  ): Promise<UnsignedBuild>;
}
export function baseCosts(token: string): SwapCost[] {
  return [
    {
      kind: "PLATFORM",
      amount: 0n,
      token,
      included: true,
      usdMicros: 0n,
      evidence: "INDEPENDENT",
    },
    {
      kind: "PROVIDER",
      amount: 0n,
      token,
      included: true,
      usdMicros: 0n,
      evidence: "PROVIDER",
    },
    {
      kind: "PROTOCOL",
      amount: null,
      token,
      included: true,
      usdMicros: null,
      evidence: "UNKNOWN",
    },
    {
      kind: "NETWORK",
      amount: null,
      token: "native",
      included: false,
      usdMicros: null,
      evidence: "UNKNOWN",
    },
  ];
}
export function makeQuote(
  i: SwapIntent,
  provider: Provider,
  mode: ProviderMode,
  amountIn: bigint,
  amountOut: bigint,
  route: RouteLeg[],
  details: Partial<SwapQuote> = {},
): SwapQuote {
  const quotedAt = Date.now();
  const q: SwapQuote = {
    id: "pending",
    intentDigest: digest(i),
    provider,
    mode,
    chain: i.chain,
    ecosystem: i.ecosystem,
    amountIn,
    amountOut,
    minAmountOut:
      i.kind === "EXACT_IN"
        ? (amountOut * BigInt(10000 - i.slippage.bps)) / 10000n
        : amountOut,
    maxAmountIn:
      i.kind === "EXACT_OUT"
        ? (amountIn * BigInt(10000 + i.slippage.bps) + 9999n) / 10000n
        : amountIn,
    costs: baseCosts(i.tokenOut.address),
    priceImpactBps: null,
    slippageBps: i.slippage.bps,
    route,
    hops: route.length,
    splitCount: 1,
    quotedAt,
    expiresAt: Math.min(i.expiresAt, quotedAt + POLICY.ttlMs),
    sourceBlock: null,
    latencyMs: 0,
    simulation: "NOT_RUN",
    build: "QUOTE_ONLY",
    review: "BUILD_REVIEW_REQUIRED",
    outputUsdMicros: null,
    inputUsdMicros: null,
    valuation: "UNKNOWN",
    ...details,
  };
  q.id = digest(q);
  return q;
}
export const blocked = (
  mode: ProviderMode,
  provider: Provider,
  chains: readonly string[],
  code: "CREDENTIAL_REQUIRED" | "BUILD_REVIEW_REQUIRED",
): QuoteAdapter => ({
  mode,
  provider,
  chains,
  exactOut: false,
  async quote() {
    throw new SwapError(code);
  },
});
