import { singletonQuotes } from "./singleton";
import { z } from "zod";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  identity,
  rawUnits,
  impactBps,
  SwapError,
  ZERO,
  type SwapIntent,
  type SwapQuote,
  type RouteLeg,
} from "../../model";
import { buildEvm, wrapped } from "../evm";
import { makeQuote, type QuoteAdapter, type EvmBuild } from "../provider";
import { jsonRead, rpc } from "../transport";
import { evmContext } from "./aerodrome";
import { digest } from "../digest";
export const deployment = {
  "1": {
    quoter: "0x61fFE014bA17989E743c5F6cB21bF9697530B21e",
    factory: "0x1F98431c8aD98523631AE4a59f267346ea31F984",
    v2: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
  },
  "56": {
    quoter: "0x78D78E420Da98ad378D7799bE8f4AF69033EB077",
    factory: "0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7",
    v2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },
  "8453": {
    quoter: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
    factory: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
    v2: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
  },
} as const;
const abi = parseAbi([
  "function getPool(address,address,uint24) view returns(address)",
  "function getPair(address,address) view returns(address)",
  "function factory() view returns(address)",
  "function getAmountsOut(uint256,address[]) view returns(uint256[])",
  "function getAmountsIn(uint256,address[]) view returns(uint256[])",
  "function quoteExactInputSingle((address tokenIn,address tokenOut,uint256 amountIn,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountOut,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
  "function quoteExactOutputSingle((address tokenIn,address tokenOut,uint256 amount,uint24 fee,uint160 sqrtPriceLimitX96) params) returns(uint256 amountIn,uint160 sqrtPriceX96After,uint32 initializedTicksCrossed,uint256 gasEstimate)",
]);
const token = z.object({ address: z.string(), chainId: z.number().optional() });
const apiSchema = z.object({
  routing: z.literal("CLASSIC"),
  quote: z.object({
    quoteId: z.string(),
    input: z.object({ token: z.string(), amount: rawUnits }),
    output: z.object({
      token: z.string(),
      amount: rawUnits,
      recipient: z.string().optional(),
    }),
    route: z.array(
      z.array(
        z.object({
          type: z.enum(["v2-pool", "v3-pool", "v4-pool"]),
          address: z.string().optional(),
          tokenIn: token,
          tokenOut: token,
          fee: z.union([z.string(), z.number()]).optional(),
          hooks: z.string().optional(),
          tickSpacing: z.union([z.string(), z.number()]).optional(),
          poolId: z.string().optional(),
          amountIn: rawUnits.optional(),
          amountOut: rawUnits.optional(),
        }),
      ),
    ),
    priceImpact: z.union([z.string(), z.number()]).optional(),
    blockNumber: z.union([z.string(), z.number()]).optional(),
    slippage: z.number().optional(),
  }),
  swapTransaction: z
    .object({
      to: z.string(),
      from: z.string(),
      data: z.string(),
      value: z.string(),
      chainId: z.number(),
    })
    .optional(),
});
export function normalizeUniswap(raw: unknown, i: SwapIntent) {
  const parsed = apiSchema.safeParse(raw);
  if (!parsed.success) throw new SwapError("INVALID_SCHEMA");
  const { quote: c } = parsed.data;
  if (
    identity(c.input.token) !== identity(i.tokenIn.address) ||
    identity(c.output.token) !== identity(i.tokenOut.address) ||
    (c.output.recipient &&
      identity(c.output.recipient) !== identity(i.recipient))
  )
    throw new SwapError("REVIEW_REQUIRED");
  const shares = c.route.map((branch, n) =>
    n === c.route.length - 1
      ? 0
      : Number(((branch[0].amountIn ?? 0n) * 10000n) / c.input.amount),
  );
  shares[shares.length - 1] = 10000 - shares.reduce((a, b) => a + b, 0);
  const route: RouteLeg[] = c.route.flatMap((branch, branchIndex) =>
    branch.map((p, hop) => {
      if (
        [p.tokenIn, p.tokenOut].some(
          (t) => t.chainId !== undefined && t.chainId !== Number(i.chain),
        )
      )
        throw new SwapError("REVIEW_REQUIRED");
      return {
        venue: "Uniswap",
        poolType:
          p.type === "v2-pool" ? "V2" : p.type === "v3-pool" ? "V3" : "V4",
        pool: p.poolId ?? p.address ?? "unidentified",
        tokenIn: p.tokenIn.address,
        tokenOut: p.tokenOut.address,
        shareBps: shares[branchIndex],
        ...(p.fee ? { fee: Number(p.fee) } : {}),
        ...(p.hooks ? { hook: p.hooks } : {}),
        ...(p.tickSpacing ? { tickSpacing: Number(p.tickSpacing) } : {}),
        branch: branchIndex,
        ...(hop === 0 && p.amountIn !== undefined
          ? { amountIn: p.amountIn }
          : {}),
        ...(hop === branch.length - 1 && p.amountOut !== undefined
          ? { amountOut: p.amountOut }
          : {}),
      };
    }),
  );
  const q = makeQuote(
    i,
    "Uniswap",
    "UNISWAP",
    c.input.amount,
    c.output.amount,
    route,
    {
      splitCount: c.route.length,
      hops: Math.max(...c.route.map((b) => b.length)),
      sourceBlock: c.blockNumber ? String(c.blockNumber) : null,
      priceImpactBps: impactBps(c.priceImpact, "PERCENT"),
      build: "QUOTE_ONLY",
    },
  );
  try {
    buildEvm(q, i);
    q.build = "UNSIGNED_BUILD";
  } catch {
    /* Keep unreviewed routes visible. */
  }
  q.id = digest({ ...q, id: "pending" });
  return { q, tx: parsed.data.swapTransaction };
}
export function uniswap(apiKey: string): QuoteAdapter {
  const builds = new Map<string, EvmBuild>();
  return {
    mode: "UNISWAP",
    provider: "Uniswap",
    chains: ["1", "56", "8453"],
    exactOut: true,
    async build(q, i) {
      return builds.get(q.id) ?? buildEvm(q, i);
    },
    async quote(i, signal, onQuote) {
      if (apiKey) {
        const raw = await jsonRead(
          "https://trade-api.gateway.uniswap.org/v1/quote",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              "x-api-key": apiKey,
              "x-universal-router-version": "2.1.2",
            },
            body: JSON.stringify({
              type: i.kind === "EXACT_IN" ? "EXACT_INPUT" : "EXACT_OUTPUT",
              amount: i.amount.toString(),
              tokenInChainId: Number(i.chain),
              tokenOutChainId: Number(i.chain),
              tokenIn: i.tokenIn.address,
              tokenOut: i.tokenOut.address,
              swapper: i.taker,
              recipient: i.recipient,
              slippageTolerance: i.slippage.bps / 100,
              permitAmount: "EXACT",
              protocols: ["V2", "V3", "V4"],
              hooksOptions: "V4_NO_HOOKS",
            }),
          },
          signal,
        );
        const { q, tx } = normalizeUniswap(raw, i);
        if (tx) {
          builds.set(q.id, {
            ecosystem: "EVM",
            chainId: String(tx.chainId),
            from: tx.from,
            to: tx.to,
            value: tx.value,
            data: tx.data as Hex,
          });
          while (builds.size > 128) builds.delete(builds.keys().next().value!);
        }
        return [q];
      }
      // Credential-free, bounded direct on-chain discovery. This is explicitly a V2/V3 subset, not API coverage.
      const block = await evmContext(i, signal),
        p = deployment[i.chain as keyof typeof deployment],
        a = wrapped(i, "tokenIn") as Address,
        b = wrapped(i, "tokenOut") as Address,
        found: SwapQuote[] = [];
      const publish = (q: SwapQuote) => {
        found.push(q);
        onQuote?.(q);
      };
      try {
        const fn = i.kind === "EXACT_IN" ? "getAmountsOut" : "getAmountsIn";
        const r = await rpc(
          i.chain,
          "eth_call",
          [
            {
              to: p.v2,
              data: encodeFunctionData({
                abi,
                functionName: fn,
                args: [i.amount, [a, b]],
              }),
            },
            block,
          ],
          signal,
        );
        const amounts = decodeFunctionResult({
          abi,
          functionName: fn,
          data: r as Hex,
        });
        const f = decodeFunctionResult({
          abi,
          functionName: "factory",
          data: (await rpc(
            i.chain,
            "eth_call",
            [
              {
                to: p.v2,
                data: encodeFunctionData({ abi, functionName: "factory" }),
              },
              block,
            ],
            signal,
          )) as Hex,
        });
        const pool = decodeFunctionResult({
          abi,
          functionName: "getPair",
          data: (await rpc(
            i.chain,
            "eth_call",
            [
              {
                to: f,
                data: encodeFunctionData({
                  abi,
                  functionName: "getPair",
                  args: [a, b],
                }),
              },
              block,
            ],
            signal,
          )) as Hex,
        });
        if (pool !== ZERO && amounts.length === 2 && amounts[1] > 0n)
          publish(
            makeQuote(
              i,
              "Uniswap",
              "UNISWAP",
              amounts[0],
              amounts[1],
              [
                {
                  venue: "Uniswap",
                  poolType: "V2",
                  pool,
                  tokenIn: a,
                  tokenOut: b,
                  shareBps: 10000,
                  factory: f,
                },
              ],
              {
                sourceBlock: BigInt(block).toString(),
                build: "UNSIGNED_BUILD",
              },
            ),
          );
      } catch {
        /* A missing V2 pair does not exclude concentrated liquidity. */
      }
      for (const fees of [
        [500, 3000],
        [100, 10000],
      ])
        await Promise.all(
          fees.map(async (fee) => {
            if (signal.aborted) return;
            try {
              const pool = decodeFunctionResult({
                abi,
                functionName: "getPool",
                data: (await rpc(
                  i.chain,
                  "eth_call",
                  [
                    {
                      to: p.factory,
                      data: encodeFunctionData({
                        abi,
                        functionName: "getPool",
                        args: [a, b, fee],
                      }),
                    },
                    block,
                  ],
                  signal,
                )) as Hex,
              });
              if (pool === ZERO) return;
              const data =
                i.kind === "EXACT_IN"
                  ? encodeFunctionData({
                      abi,
                      functionName: "quoteExactInputSingle",
                      args: [
                        {
                          tokenIn: a,
                          tokenOut: b,
                          amountIn: i.amount,
                          fee,
                          sqrtPriceLimitX96: 0n,
                        },
                      ],
                    })
                  : encodeFunctionData({
                      abi,
                      functionName: "quoteExactOutputSingle",
                      args: [
                        {
                          tokenIn: a,
                          tokenOut: b,
                          amount: i.amount,
                          fee,
                          sqrtPriceLimitX96: 0n,
                        },
                      ],
                    });
              const amounts = decodeFunctionResult({
                abi,
                functionName:
                  i.kind === "EXACT_IN"
                    ? "quoteExactInputSingle"
                    : "quoteExactOutputSingle",
                data: (await rpc(
                  i.chain,
                  "eth_call",
                  [{ to: p.quoter, data }, block],
                  signal,
                )) as Hex,
              });
              if (amounts[0] > 0n)
                publish(
                  makeQuote(
                    i,
                    "Uniswap",
                    "UNISWAP",
                    i.kind === "EXACT_IN" ? i.amount : amounts[0],
                    i.kind === "EXACT_IN" ? amounts[0] : i.amount,
                    [
                      {
                        venue: "Uniswap",
                        poolType: "V3",
                        pool,
                        tokenIn: a,
                        tokenOut: b,
                        fee,
                        shareBps: 10000,
                        factory: p.factory,
                      },
                    ],
                    {
                      sourceBlock: BigInt(block).toString(),
                      build: "UNSIGNED_BUILD",
                    },
                  ),
                );
            } catch {
              /* Missing liquidity remains unquoted. */
            }
          }),
        );
      found.push(
        ...(await singletonQuotes(i, "UNISWAP", block, signal, onQuote)),
      );
      if (!found.length) throw new SwapError("NO_LIQUIDITY");
      return found;
    },
  };
}
