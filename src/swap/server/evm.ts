import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { identity, SwapError, type SwapIntent, type SwapQuote } from "../model";
import { AERO, PINS, routerPin } from "./config";
import type { EvmBuild } from "./provider";
import { planUniversal, inspectCommands } from "./universal";

export const universalAbi = parseAbi([
  "function execute(bytes commands, bytes[] inputs, uint256 deadline) payable",
]);
export const aeroAbi = parseAbi([
  "struct Route { address from; address to; bool stable; address factory; }",
  "function getAmountsOut(uint256 amountIn, Route[] routes) view returns (uint256[] amounts)",
  "function poolFor(address tokenA, address tokenB, bool stable, address factory) view returns (address pool)",
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
  "function swapExactETHForTokens(uint256 amountOutMin, Route[] routes, address to, uint256 deadline) payable returns (uint256[] amounts)",
  "function swapExactTokensForETH(uint256 amountIn, uint256 amountOutMin, Route[] routes, address to, uint256 deadline) returns (uint256[] amounts)",
]);
export const clAbi = parseAbi([
  "function exactInput((bytes path,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function exactOutput((bytes path,address recipient,uint256 deadline,uint256 amountOut,uint256 amountInMaximum) params) payable returns (uint256 amountIn)",
]);
export const clPaymentsAbi = parseAbi([
  "function multicall(bytes[] data) payable returns(bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum,address recipient) payable",
  "function refundETH() payable",
]);
const addr = (a: string) => a as Address;
export const wrapped = (i: SwapIntent, t: "tokenIn" | "tokenOut") =>
  i[t].native ? PINS[i.chain as keyof typeof PINS].wrapper : i[t].address;
function reject(): never {
  throw new SwapError("REVIEW_REQUIRED");
}
function same(a: string, b: string) {
  if (identity(a) !== identity(b)) reject();
}
function routePath(q: SwapQuote, i: SwapIntent) {
  if (
    q.splitCount !== 1 ||
    q.route.some((l) => l.shareBps !== 10000) ||
    q.route.length > 4
  )
    throw new SwapError("BUILD_REVIEW_REQUIRED");
  const path = [q.route[0].tokenIn, ...q.route.map((l) => l.tokenOut)];
  same(path[0], wrapped(i, "tokenIn"));
  same(path.at(-1)!, wrapped(i, "tokenOut"));
  for (let n = 1; n < q.route.length; n++)
    same(q.route[n - 1].tokenOut, q.route[n].tokenIn);
  return path;
}
export function v3Path(path: string[], fees: number[], reverse = false): Hex {
  if (reverse) {
    path = [...path].reverse();
    fees = [...fees].reverse();
  }
  return `0x${path.map((p, n) => p.slice(2).toLowerCase() + (n < fees.length ? fees[n].toString(16).padStart(6, "0") : "")).join("")}` as Hex;
}
/** Local builder accepts only the reviewed subset. No approvals, signatures, transfer commands or unsafe selectors. */
export function buildEvm(q: SwapQuote, i: SwapIntent): EvmBuild {
  const pin = routerPin(q.mode, i.chain),
    path = q.mode.startsWith("AERODROME") ? routePath(q, i) : [],
    deadline = BigInt(Math.floor(q.expiresAt / 1000));
  let data: Hex;
  if (q.mode === "AERODROME_CLASSIC") {
    if (i.kind !== "EXACT_IN") throw new SwapError("BUILD_REVIEW_REQUIRED");
    const routes = q.route.map((l) => {
      if (
        !["STABLE", "VOLATILE"].includes(l.poolType) ||
        identity(l.factory ?? "") !== identity(AERO.factory)
      )
        reject();
      return {
        from: addr(l.tokenIn),
        to: addr(l.tokenOut),
        stable: l.poolType === "STABLE",
        factory: addr(AERO.factory),
      };
    });
    data = i.tokenIn.native
      ? encodeFunctionData({
          abi: aeroAbi,
          functionName: "swapExactETHForTokens",
          args: [q.minAmountOut, routes, addr(i.recipient), deadline],
        })
      : encodeFunctionData({
          abi: aeroAbi,
          functionName: i.tokenOut.native
            ? "swapExactTokensForETH"
            : "swapExactTokensForTokens",
          args: [
            q.amountIn,
            q.minAmountOut,
            routes,
            addr(i.recipient),
            deadline,
          ],
        });
  } else if (q.mode === "AERODROME_SLIPSTREAM") {
    if (q.route.some((l) => l.poolType !== "SLIPSTREAM" || !l.fee)) reject();
    const encoded = v3Path(
      path,
      q.route.map((l) => l.fee!),
      i.kind === "EXACT_OUT",
    );
    data =
      i.kind === "EXACT_IN"
        ? encodeFunctionData({
            abi: clAbi,
            functionName: "exactInput",
            args: [
              {
                path: encoded,
                recipient: i.tokenOut.native
                  ? addr(pin.address)
                  : addr(i.recipient),
                deadline,
                amountIn: q.amountIn,
                amountOutMinimum: q.minAmountOut,
              },
            ],
          })
        : encodeFunctionData({
            abi: clAbi,
            functionName: "exactOutput",
            args: [
              {
                path: encoded,
                recipient: i.tokenOut.native
                  ? addr(pin.address)
                  : addr(i.recipient),
                deadline,
                amountOut: q.amountOut,
                amountInMaximum: q.maxAmountIn,
              },
            ],
          });
    const calls: Hex[] = [data];
    if (i.tokenOut.native)
      calls.push(
        encodeFunctionData({
          abi: clPaymentsAbi,
          functionName: "unwrapWETH9",
          args: [q.minAmountOut, addr(i.recipient)],
        }),
      );
    if (i.tokenIn.native && i.kind === "EXACT_OUT")
      calls.push(
        encodeFunctionData({ abi: clPaymentsAbi, functionName: "refundETH" }),
      );
    if (calls.length > 1)
      data = encodeFunctionData({
        abi: clPaymentsAbi,
        functionName: "multicall",
        args: [calls],
      });
  } else {
    const planned = planUniversal(q, i);
    data = encodeFunctionData({
      abi: universalAbi,
      functionName: "execute",
      args: [planned.commands, planned.inputs, deadline],
    });
  }
  return {
    ecosystem: "EVM",
    chainId: i.chain,
    from: i.taker,
    to: pin.address,
    value: (i.tokenIn.native ? q.maxAmountIn : 0n).toString(),
    data,
  };
}
export interface EvmDecoded {
  router: string;
  routerVersion: string;
  deadline: number;
  recipient: string;
  tokenIn: string;
  tokenOut: string;
  amountIn: bigint;
  amountOut: bigint;
  minOut: bigint;
  maxIn: bigint;
  commands: number[];
  approval: {
    kind: "NONE" | "ERC20" | "PERMIT2";
    spender: string | null;
    tokenApprovalSpender: string | null;
    amount: bigint;
  };
}
/** Decode the actual bytes first, then require exact canonical re-encoding. Trailing bytes and hidden commands fail. */
export function decodeEvm(
  tx: EvmBuild,
  q: SwapQuote,
  i: SwapIntent,
  now = Date.now(),
): EvmDecoded {
  if (
    Object.keys(tx).sort().join(",") !==
      ["ecosystem", "chainId", "from", "to", "value", "data"]
        .sort()
        .join(",") ||
    tx.ecosystem !== "EVM" ||
    tx.chainId !== i.chain ||
    q.chain !== i.chain
  )
    reject();
  const pin = routerPin(q.mode, i.chain);
  same(tx.from, i.taker);
  same(tx.to, pin.address);
  if (tx.value !== (i.tokenIn.native ? q.maxAmountIn : 0n).toString()) reject();
  let deadline = 0;
  const commands: number[] = [];
  try {
    if (q.mode === "AERODROME_CLASSIC") {
      const d = decodeFunctionData({ abi: aeroAbi, data: tx.data });
      if (
        ![
          "swapExactETHForTokens",
          "swapExactTokensForTokens",
          "swapExactTokensForETH",
        ].includes(d.functionName)
      )
        reject();
      deadline = Number(d.args!.at(-1));
    } else if (q.mode === "AERODROME_SLIPSTREAM") {
      let data = tx.data;
      if (data.startsWith("0xac9650d8")) {
        const multi = decodeFunctionData({ abi: clPaymentsAbi, data });
        if (multi.functionName !== "multicall" || multi.args[0].length > 3)
          reject();
        data = multi.args[0][0];
        for (const payment of multi.args[0].slice(1)) {
          const decoded = decodeFunctionData({
            abi: clPaymentsAbi,
            data: payment,
          });
          if (!["unwrapWETH9", "refundETH"].includes(decoded.functionName))
            reject();
        }
      }
      const d = decodeFunctionData({ abi: clAbi, data });
      deadline = Number(d.args[0].deadline);
    } else {
      const d = decodeFunctionData({ abi: universalAbi, data: tx.data });
      const [cmds, inputs, expires] = d.args;
      deadline = Number(expires);
      commands.push(...inspectCommands(cmds, inputs, q));
    }
    const expected = buildEvm(q, i);
    if (expected.data.toLowerCase() !== tx.data.toLowerCase()) reject();
  } catch (e) {
    if (e instanceof SwapError) throw e;
    reject();
  }
  if (
    deadline * 1000 <= now ||
    deadline * 1000 > q.expiresAt ||
    q.expiresAt <= now
  )
    throw new SwapError("QUOTE_STALE");
  if (
    q.costs.some(
      (c) =>
        ["PROVIDER", "PLATFORM", "TIP"].includes(c.kind) && c.amount !== 0n,
    )
  )
    reject();
  return {
    router: identity(pin.address),
    routerVersion: pin.version,
    deadline,
    recipient: i.recipient,
    tokenIn: i.tokenIn.address,
    tokenOut: i.tokenOut.address,
    amountIn: q.amountIn,
    amountOut: q.amountOut,
    minOut: q.minAmountOut,
    maxIn: q.maxAmountIn,
    commands,
    approval: {
      kind: i.tokenIn.native ? "NONE" : pin.permit2 ? "PERMIT2" : "ERC20",
      spender: i.tokenIn.native ? null : pin.address,
      tokenApprovalSpender: i.tokenIn.native
        ? null
        : (pin.permit2 ?? pin.address),
      amount: i.tokenIn.native ? 0n : q.maxAmountIn,
    },
  };
}
