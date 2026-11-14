import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  keccak256,
  parseAbi,
  parseAbiParameters,
  type Address,
  type Hex,
} from "viem";
import {
  ZERO,
  type RouteLeg,
  type SwapIntent,
  type SwapQuote,
} from "../../model";
import { buildEvm, wrapped } from "../evm";
import { makeQuote } from "../provider";
import { rpc } from "../transport";
import { INFINITY, infinityKey, v4Key } from "../universal";
export const V4_DEPLOYMENTS: Record<
  string,
  { manager: Address; quoter: Address; stateView: Address }
> = {
  "1": {
    manager: "0x000000000004444c5dc75cB358380D2e3dE08A90",
    quoter: "0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203",
    stateView: "0x7ffe42c4a5deea5b0fec41c94c136cf115597227",
  },
  "8453": {
    manager: "0x498581ff718922c3f8e6a244956af099b2652b2b",
    quoter: "0x0d5e0f971ed27fbff6c2837bf31316121532048d",
    stateView: "0xa3c0c9b65bad0b08107aa264b0f3db444b867a71",
  },
  "56": {
    manager: "0x28e2ea090877bf75740558f6bfb36a5ffee9e9df",
    quoter: "0x9f75dd27d6664c475b90e105573e550ff69437b0",
    stateView: "0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4",
  },
};
const uniABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)",
  "function quoteExactOutputSingle(((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountIn,uint256 gasEstimate)",
]);
const infinityABI = parseAbi([
  "function quoteExactInputSingle(((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountOut,uint256 gasEstimate)",
  "function quoteExactOutputSingle(((address currency0,address currency1,address hooks,address poolManager,uint24 fee,bytes32 parameters) poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns(uint256 amountIn,uint256 gasEstimate)",
]);
/** Bounded direct discovery: the deployed quoter establishes actual liquidity at the same block. No price/tick approximation. */
export async function singletonQuotes(
  i: SwapIntent,
  mode: "UNISWAP" | "PANCAKESWAP_SMART",
  block: string,
  signal: AbortSignal,
  onQuote?: (q: SwapQuote) => void,
) {
  if (
    i.amount >= 1n << 128n ||
    (mode === "PANCAKESWAP_SMART" && i.chain === "1")
  )
    return [];
  const uni = mode === "UNISWAP",
    result: SwapQuote[] = [],
    provider = uni ? "Uniswap" : "PancakeSwap";
  const pairs: Array<[Address, Address]> = [
    [
      (i.tokenIn.native ? ZERO : wrapped(i, "tokenIn")) as Address,
      (i.tokenOut.native ? ZERO : wrapped(i, "tokenOut")) as Address,
    ],
  ];
  if (i.tokenIn.native || i.tokenOut.native)
    pairs.push([
      wrapped(i, "tokenIn") as Address,
      wrapped(i, "tokenOut") as Address,
    ]);
  for (const [tokenIn, tokenOut] of pairs) {
    const [currency0, currency1] = [tokenIn, tokenOut].sort((a, b) =>
      a.toLowerCase().localeCompare(b.toLowerCase()),
    );
    const candidates = uni
      ? ([
          ["V4", 100, 1],
          ["V4", 500, 10],
          ["V4", 3000, 60],
          ["V4", 10000, 200],
        ] as const)
      : ([
          ["INFINITY_CL", 67, 1],
          ["INFINITY_CL", 335, 10],
          ["INFINITY_CL", 1676, 50],
          ["INFINITY_CL", 6722, 200],
          ["INFINITY_BIN", 67, 1],
          ["INFINITY_BIN", 335, 10],
          ["INFINITY_BIN", 1676, 50],
          ["INFINITY_BIN", 6722, 100],
        ] as const);
    for (let n = 0; n < candidates.length; n += 4)
      await Promise.all(
        candidates.slice(n, n + 4).map(async ([poolType, fee, spacing]) => {
          if (signal.aborted) return;
          const parameters =
            `0x${(BigInt(spacing) << 16n).toString(16).padStart(64, "0")}` as Hex;
          const poolManager = (
            poolType === "INFINITY_BIN" ? INFINITY.bin : INFINITY.cl
          ) as Address;
          const common = { currency0, currency1, fee, hooks: ZERO as Address };
          const key = uni
            ? { ...common, tickSpacing: spacing }
            : { ...common, poolManager, parameters };
          const pool = keccak256(
            uni
              ? encodeAbiParameters(v4Key, [
                  currency0,
                  currency1,
                  fee,
                  spacing,
                  ZERO as Address,
                ])
              : encodeAbiParameters(infinityKey, [
                  currency0,
                  currency1,
                  ZERO as Address,
                  poolManager,
                  fee,
                  parameters,
                ]),
          );
          const leg: RouteLeg = {
            venue: provider,
            poolType,
            pool,
            tokenIn,
            tokenOut,
            shareBps: 10000,
            fee,
            hook: ZERO,
            ...(uni
              ? { tickSpacing: spacing }
              : { factory: poolManager, parameters }),
          };
          try {
            const params = {
              poolKey: key,
              zeroForOne: tokenIn === currency0,
              exactAmount: i.amount,
              hookData: "0x" as Hex,
            };
            const data = encodeFunctionData({
              abi: uni ? uniABI : infinityABI,
              functionName:
                i.kind === "EXACT_IN"
                  ? "quoteExactInputSingle"
                  : "quoteExactOutputSingle",
              args: [params as never],
            });
            const to = uni
              ? V4_DEPLOYMENTS[i.chain].quoter
              : poolType === "INFINITY_BIN"
                ? "0xC631f4B0Fc2Dd68AD45f74B2942628db117dD359"
                : "0xd0737C9762912dD34c3271197E362Aa736Df0926";
            const raw = await rpc(
              i.chain,
              "eth_call",
              [{ to, data }, block],
              signal,
            );
            const [amount] = decodeAbiParameters(
              parseAbiParameters("uint256,uint256"),
              raw as Hex,
            );
            if (amount === 0n) return;
            const q = makeQuote(
              i,
              provider,
              mode,
              i.kind === "EXACT_IN" ? i.amount : amount,
              i.kind === "EXACT_IN" ? amount : i.amount,
              [leg],
              {
                sourceBlock: BigInt(block).toString(),
                build: "UNSIGNED_BUILD",
              },
            );
            buildEvm(q, i);
            result.push(q);
            onQuote?.(q);
          } catch {
            /* A nonexistent, uninitialized or unsupported pool is not a quote. */
          }
        }),
      );
  }
  return result;
}
