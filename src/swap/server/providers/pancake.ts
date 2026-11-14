import { singletonQuotes } from "./singleton";
import { createPublicClient, custom } from "viem";
import { mainnet, base, bsc } from "viem/chains";
import {
  ERC20Token as Token,
  CurrencyAmount,
  TradeType,
} from "../../../../swap-providers/runtime";
import {
  SmartRouter,
  InfinityRouter,
  PoolType,
  type SmartRouterTrade,
  type Pool,
} from "../../../../swap-providers/runtime";
import {
  impactBps,
  SwapError,
  ZERO,
  type SwapIntent,
  type SwapQuote,
  type RouteLeg,
} from "../../model";
import { buildEvm, wrapped } from "../evm";
import { makeQuote, type QuoteAdapter } from "../provider";
import { rpc } from "../transport";
import { evmContext } from "./aerodrome";
import { digest } from "../digest";

export function normalizePancake(
  t: SmartRouterTrade<TradeType>,
  i: SwapIntent,
  block: string,
): SwapQuote {
  const shares = t.routes.map((r) => Math.round(r.percent * 100));
  if (shares.length)
    shares[shares.length - 1] =
      10000 - shares.slice(0, -1).reduce((sum, share) => sum + share, 0);
  if (shares.some((share) => share <= 0 || share > 10000))
    throw new SwapError("REVIEW_REQUIRED");
  const route: RouteLeg[] = t.routes.flatMap((r, branch) =>
    r.pools.map((p, n) => {
      const poolType =
        p.type === PoolType.V2
          ? "V2"
          : p.type === PoolType.V3
            ? "V3"
            : p.type === PoolType.InfinityCL
              ? "INFINITY_CL"
              : p.type === PoolType.InfinityBIN
                ? "INFINITY_BIN"
                : p.type === PoolType.STABLE
                  ? "STABLE"
                  : null;
      if (!poolType) throw new SwapError("REVIEW_REQUIRED");
      return {
        venue: "PancakeSwap",
        poolType,
        pool: SmartRouter.getPoolAddress(p),
        tokenIn:
          poolType.startsWith("INFINITY") && r.path[n].isNative
            ? ZERO
            : r.path[n].wrapped.address,
        tokenOut:
          poolType.startsWith("INFINITY") && r.path[n + 1].isNative
            ? ZERO
            : r.path[n + 1].wrapped.address,
        shareBps: shares[branch],
        branch,
        ...(n === 0
          ? { amountIn: BigInt(r.inputAmount.quotient.toString()) }
          : {}),
        ...(n === r.pools.length - 1
          ? { amountOut: BigInt(r.outputAmount.quotient.toString()) }
          : {}),
        ...("fee" in p && typeof p.fee === "number" ? { fee: p.fee } : {}),
        ...("hooks" in p ? { hook: p.hooks ?? ZERO } : {}),
        ...("poolManager" in p ? { factory: p.poolManager } : {}),
        ...("tickSpacing" in p ? { tickSpacing: p.tickSpacing } : {}),
        ...("poolManager" in p && ("tickSpacing" in p || "binStep" in p)
          ? {
              parameters: `0x${((BigInt("tickSpacing" in p ? p.tickSpacing : p.binStep) << 16n) | BigInt(p.hooksRegistrationBitmap ?? 0)).toString(16).padStart(64, "0")}`,
            }
          : {}),
      };
    }),
  );
  const quote = makeQuote(
    i,
    "PancakeSwap",
    "PANCAKESWAP_SMART",
    BigInt(t.inputAmount.quotient.toString()),
    BigInt(t.outputAmount.quotient.toString()),
    route,
    {
      sourceBlock: BigInt(block).toString(),
      splitCount: t.routes.length,
      hops: Math.max(...t.routes.map((r) => r.pools.length)),
      priceImpactBps: impactBps(
        SmartRouter.getPriceImpact(t).toFixed(4),
        "PERCENT",
      ),
      build: "QUOTE_ONLY",
    },
  );
  try {
    buildEvm(quote, i);
    quote.build = "UNSIGNED_BUILD";
  } catch {
    /* Unsupported routes remain visible as quote only. */
  }
  quote.id = digest({ ...quote, id: "pending" });
  return quote;
}
export const pancake: QuoteAdapter = {
  mode: "PANCAKESWAP_SMART",
  provider: "PancakeSwap",
  chains: ["1", "56", "8453"],
  exactOut: true,
  build: async (q, i) => buildEvm(q, i),
  async quote(i, signal, onQuote) {
    const block = await evmContext(i, signal),
      chain = i.chain === "1" ? mainnet : i.chain === "56" ? bsc : base;
    const client = createPublicClient({
      chain,
      transport: custom(
        {
          request: ({ method, params }) =>
            rpc(i.chain, method, (params ?? []) as unknown[], signal),
        },
        { retryCount: 0 },
      ),
    });
    // SDK's pinned viem differs in nominal types. The exposed read client implements the same public interface.
    const onChainProvider = (() => client) as NonNullable<
      Parameters<typeof SmartRouter.getV3CandidatePools>[0]["onChainProvider"]
    >;
    const a = new Token(
      Number(i.chain),
      wrapped(i, "tokenIn") as `0x${string}`,
      i.tokenIn.decimals,
      i.tokenIn.symbol,
    );
    const b = new Token(
      Number(i.chain),
      wrapped(i, "tokenOut") as `0x${string}`,
      i.tokenOut.decimals,
      i.tokenOut.symbol,
    );
    const pairs: [typeof a, typeof b][] = [[a, b]];
    const pools = await Promise.allSettled([
      // Official SDK direct on-chain discovery avoids third-party TVL/price fetches and unbounded SDK fallback logging.
      SmartRouter.getV2PoolsOnChain(pairs, onChainProvider, BigInt(block)),
      SmartRouter.getV3PoolsWithoutTicksOnChain(
        pairs,
        onChainProvider,
        BigInt(block),
      ),
    ]);
    const available: Pool[] = [];
    for (const r of pools)
      if (r.status === "fulfilled") available.push(...r.value);
    if (signal.aborted) throw new SwapError("PROVIDER_TIMEOUT");
    const amount = CurrencyAmount.fromRawAmount(
        i.kind === "EXACT_IN" ? a : b,
        i.amount.toString(),
      ),
      kind =
        i.kind === "EXACT_IN" ? TradeType.EXACT_INPUT : TradeType.EXACT_OUTPUT;
    const out: SwapQuote[] = [];
    for (const families of [
      [PoolType.V2],
      [PoolType.V3],
      [PoolType.V2, PoolType.V3],
    ]) {
      const eligible = available.filter((p) =>
        families.some((family) => family === p.type),
      );
      if (!eligible.length) continue;
      const t = await SmartRouter.getBestTrade(
        amount,
        i.kind === "EXACT_IN" ? b : a,
        kind,
        {
          gasPriceWei: BigInt(
            (await rpc(i.chain, "eth_gasPrice", [], signal)) as string,
          ),
          maxHops: 3,
          maxSplits: 4,
          poolProvider: SmartRouter.createStaticPoolProvider(eligible),
          quoteProvider: SmartRouter.createQuoteProvider({ onChainProvider }),
          blockNumber: Number(BigInt(block)),
          signal,
        },
      );
      if (t) {
        const q = normalizePancake(t, i, block);
        out.push(q);
        onQuote?.(q);
      }
    }
    // Infinity is a separate SDK route architecture, never passed through V3 pool math.
    if (i.chain !== "1" && !signal.aborted) {
      try {
        const infinity = await InfinityRouter.getInfinityCandidatePools({
          currencyA: a,
          currencyB: b,
          clientProvider: onChainProvider,
        });
        const reviewed = infinity.filter((p) => !p.hooks || p.hooks === ZERO);
        if (reviewed.length) {
          const t = await InfinityRouter.getBestTrade(
            amount,
            i.kind === "EXACT_IN" ? b : a,
            kind,
            {
              candidatePools: reviewed,
              gasPriceWei: 0n,
              maxHops: 3,
              maxSplits: 4,
              signal,
            },
          );
          if (t) {
            const q = normalizePancake(
              { ...t, gasEstimate: t.gasUseEstimate },
              i,
              block,
            );
            out.push(q);
            onQuote?.(q);
          }
        }
      } catch {
        /* An unavailable Infinity discovery source cannot hide a checked V2/V3 quote. */
      }
    }
    out.push(
      ...(await singletonQuotes(
        i,
        "PANCAKESWAP_SMART",
        block,
        signal,
        onQuote,
      )),
    );
    if (!out.length) throw new SwapError("NO_LIQUIDITY");
    return out;
  },
};
