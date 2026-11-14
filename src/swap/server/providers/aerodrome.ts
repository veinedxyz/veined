import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import {
  SwapError,
  ZERO,
  type SwapIntent,
  type SwapQuote,
  type RouteLeg,
} from "../../model";
import { AERO } from "../config";
import { aeroAbi, buildEvm, v3Path, wrapped } from "../evm";
import { makeQuote, type QuoteAdapter } from "../provider";
import { rpc } from "../transport";
const registryAbi = parseAbi([
  "function isPoolFactoryApproved(address) view returns (bool)",
]);
const quoterAbi = parseAbi([
  "function quoteExactInput(bytes path,uint256 amountIn) returns (uint256 amountOut,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
  "function quoteExactOutput(bytes path,uint256 amountOut) returns (uint256 amountIn,uint160[] sqrtPriceX96AfterList,uint32[] initializedTicksCrossedList,uint256 gasEstimate)",
]);
const factoryAbi = parseAbi([
  "function getPool(address,address,int24) view returns(address)",
]);
export async function evmContext(i: SwapIntent, signal: AbortSignal) {
  const chain = await rpc(i.chain, "eth_chainId", [], signal);
  if (typeof chain !== "string" || BigInt(chain) !== BigInt(i.chain))
    throw new SwapError("REVIEW_REQUIRED");
  const block = await rpc(i.chain, "eth_blockNumber", [], signal);
  if (typeof block !== "string" || !/^0x[0-9a-f]+$/i.test(block))
    throw new SwapError("INVALID_SCHEMA");
  return block;
}
export function aerodrome(classic = true): QuoteAdapter {
  return {
    mode: classic ? "AERODROME_CLASSIC" : "AERODROME_SLIPSTREAM",
    provider: "Aerodrome",
    chains: ["8453"],
    exactOut: !classic,
    build: async (q, i) => buildEvm(q, i),
    async quote(i, signal, onQuote) {
      const block = await evmContext(i, signal),
        from = wrapped(i, "tokenIn") as Address,
        to = wrapped(i, "tokenOut") as Address;
      const found: SwapQuote[] = [];
      if (classic) {
        const approved = await rpc(
          i.chain,
          "eth_call",
          [
            {
              to: AERO.registry,
              data: encodeFunctionData({
                abi: registryAbi,
                functionName: "isPoolFactoryApproved",
                args: [AERO.factory as Address],
              }),
            },
            block,
          ],
          signal,
        );
        if (
          typeof approved !== "string" ||
          !decodeFunctionResult({
            abi: registryAbi,
            functionName: "isPoolFactoryApproved",
            data: approved as Hex,
          })
        )
          throw new SwapError("REVIEW_REQUIRED");
        const wrapper = wrapped(
          { ...i, tokenIn: { ...i.tokenIn, native: true } },
          "tokenIn",
        ) as Address;
        const paths: Address[][] = [[from, to]];
        if (
          from.toLowerCase() !== wrapper.toLowerCase() &&
          to.toLowerCase() !== wrapper.toLowerCase()
        )
          paths.push([from, wrapper, to]);
        for (const path of paths) {
          await Promise.all(
            [false, true].map(async (stable) => {
              const routes = path.slice(1).map((token, n) => ({
                from: path[n],
                to: token,
                stable,
                factory: AERO.factory as Address,
              }));
              try {
                const data = await rpc(
                  i.chain,
                  "eth_call",
                  [
                    {
                      to: AERO.router,
                      data: encodeFunctionData({
                        abi: aeroAbi,
                        functionName: "getAmountsOut",
                        args: [i.amount, routes],
                      }),
                    },
                    block,
                  ],
                  signal,
                );
                if (typeof data !== "string")
                  throw new SwapError("INVALID_SCHEMA");
                const amounts = decodeFunctionResult({
                  abi: aeroAbi,
                  functionName: "getAmountsOut",
                  data: data as Hex,
                });
                if (amounts.length !== path.length || amounts.at(-1)! <= 0n)
                  return;
                const legs = [];
                for (const r of routes) {
                  const p = await rpc(
                    i.chain,
                    "eth_call",
                    [
                      {
                        to: AERO.router,
                        data: encodeFunctionData({
                          abi: aeroAbi,
                          functionName: "poolFor",
                          args: [r.from, r.to, r.stable, r.factory],
                        }),
                      },
                      block,
                    ],
                    signal,
                  );
                  if (typeof p !== "string") return;
                  const pool = decodeFunctionResult({
                    abi: aeroAbi,
                    functionName: "poolFor",
                    data: p as Hex,
                  });
                  const code = await rpc(
                    i.chain,
                    "eth_getCode",
                    [pool, block],
                    signal,
                  );
                  if (typeof code !== "string" || code === "0x") return;
                  legs.push({
                    venue: "Aerodrome",
                    poolType: stable
                      ? ("STABLE" as const)
                      : ("VOLATILE" as const),
                    pool,
                    tokenIn: r.from,
                    tokenOut: r.to,
                    shareBps: 10000,
                    factory: AERO.factory,
                  });
                }
                const q = makeQuote(
                  i,
                  "Aerodrome",
                  "AERODROME_CLASSIC",
                  i.amount,
                  amounts.at(-1)!,
                  legs,
                  {
                    sourceBlock: BigInt(block).toString(),
                    build: "UNSIGNED_BUILD",
                  },
                );
                found.push(q);
                onQuote?.(q);
              } catch (e) {
                if (signal.aborted) throw e;
                if (
                  e instanceof SwapError &&
                  ["REVIEW_REQUIRED", "INVALID_SCHEMA"].includes(e.code)
                )
                  throw e;
              }
            }),
          );
        }
      } else {
        const wrapper = wrapped(
          { ...i, tokenIn: { ...i.tokenIn, native: true } },
          "tokenIn",
        ) as Address;
        const middles = [
          wrapper,
          "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address,
        ].filter(
          (m) =>
            ![from.toLowerCase(), to.toLowerCase()].includes(m.toLowerCase()),
        );
        const paths: Address[][] = [
          [from, to],
          ...middles.map((m) => [from, m, to]),
        ];
        const candidates = new Map<string, Promise<RouteLeg[]>>();
        const edge = (a: Address, b: Address) => {
          const key = [a.toLowerCase(), b.toLowerCase()].join(":");
          let value = candidates.get(key);
          if (!value) {
            value = Promise.all(
              [1, 50, 100, 200, 2000].map(async (spacing) => {
                try {
                  const raw = await rpc(
                    i.chain,
                    "eth_call",
                    [
                      {
                        to: AERO.clFactory,
                        data: encodeFunctionData({
                          abi: factoryAbi,
                          functionName: "getPool",
                          args: [a, b, spacing],
                        }),
                      },
                      block,
                    ],
                    signal,
                  );
                  const pool = decodeFunctionResult({
                    abi: factoryAbi,
                    functionName: "getPool",
                    data: raw as Hex,
                  });
                  return pool.toLowerCase() === ZERO
                    ? null
                    : {
                        venue: "Aerodrome",
                        poolType: "SLIPSTREAM" as const,
                        pool,
                        tokenIn: a,
                        tokenOut: b,
                        shareBps: 10000,
                        fee: spacing,
                        factory: AERO.clFactory,
                      };
                } catch (e) {
                  if (signal.aborted) throw e;
                  return null;
                }
              }),
            ).then((rows) =>
              rows.filter((r): r is NonNullable<typeof r> => r !== null),
            );
            candidates.set(key, value);
          }
          return value;
        };
        for (const path of paths) {
          if (signal.aborted) break;
          const first = await edge(path[0], path[1]);
          const routes =
            path.length === 2 ? first.map((l) => [l]) : ([] as RouteLeg[][]);
          if (path.length === 3) {
            const second = await edge(path[1], path[2]);
            for (const a of first.slice(0, 2))
              for (const b of second.slice(0, 2)) routes.push([a, b]);
          }
          for (const legs of routes) {
            if (signal.aborted) break;
            try {
              const fn =
                i.kind === "EXACT_IN" ? "quoteExactInput" : "quoteExactOutput";
              const raw = await rpc(
                i.chain,
                "eth_call",
                [
                  {
                    to: AERO.quoter,
                    data: encodeFunctionData({
                      abi: quoterAbi,
                      functionName: fn,
                      args: [
                        v3Path(
                          path,
                          legs.map((l) => l.fee!),
                          i.kind === "EXACT_OUT",
                        ),
                        i.amount,
                      ],
                    }),
                  },
                  block,
                ],
                signal,
              );
              const amounts = decodeFunctionResult({
                abi: quoterAbi,
                functionName: fn,
                data: raw as Hex,
              });
              if (amounts[0] <= 0n) continue;
              const q = makeQuote(
                i,
                "Aerodrome",
                "AERODROME_SLIPSTREAM",
                i.kind === "EXACT_IN" ? i.amount : amounts[0],
                i.kind === "EXACT_IN" ? amounts[0] : i.amount,
                legs,
                {
                  sourceBlock: BigInt(block).toString(),
                  build: "UNSIGNED_BUILD",
                  hops: legs.length,
                },
              );
              found.push(q);
              onQuote?.(q);
            } catch (e) {
              if (signal.aborted) throw e;
            }
          }
        }
      }
      if (!found.length) throw new SwapError("NO_LIQUIDITY");
      return found;
    },
  };
}
