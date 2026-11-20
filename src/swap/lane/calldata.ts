// VEINED-FIN-LIVE-20261115-01: the swap lane's two transactions, built from ONE route's pinned values only, and an
// INDEPENDENT exact decoder for them. A transaction is accepted only when decoding it and re-encoding the decoded
// arguments gives back EXACTLY the same bytes (canonical ABI: no planted bytes, no relocated offsets, no extra calls),
// and when every decoded field equals what the reviewed plan of THAT route says: token in/out, fee tier, recipient =
// owner, amountIn = the record's exact amount, amountOutMinimum = the reviewed minimum, no price limit, deadline inside
// the lane window. The ABI and the selectors are the same on every route (SwapRouter02 / IV3SwapRouter).
import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbi,
  type Hex,
} from "viem";
import { SWAP_LANE_SELECTORS } from "./pins";
import { SWAP_LANE_SCOPE, type SwapLaneRoute } from "./scope";

export const LANE_ERC20_ABI = parseAbi([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
export const LANE_ROUTER_ABI = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
]);
export const LANE_QUOTER_ABI = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
type Route = Readonly<SwapLaneRoute>;
const lower = (a: string) => a.toLowerCase();
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** approve(route.router, amount) — the exact allowance to the route's router, nothing else. */
export function approveCalldata(route: Route, amount: bigint): Hex {
  return encodeFunctionData({
    abi: LANE_ERC20_ABI,
    functionName: "approve",
    args: [route.router as Hex, amount],
  });
}
export function swapCalldata(
  route: Route,
  i: {
    owner: string;
    amountIn: bigint;
    amountOutMinimum: bigint;
    deadline: bigint;
  },
): Hex {
  const inner = encodeFunctionData({
    abi: LANE_ROUTER_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: route.pay.address as Hex,
        tokenOut: route.receive.address as Hex,
        fee: route.poolFee,
        recipient: i.owner as Hex,
        amountIn: i.amountIn,
        amountOutMinimum: i.amountOutMinimum,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  return encodeFunctionData({
    abi: LANE_ROUTER_ABI,
    functionName: "multicall",
    args: [i.deadline, [inner]],
  });
}
export function quoteCalldata(route: Route, amountIn: bigint): Hex {
  return encodeFunctionData({
    abi: LANE_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [
      {
        tokenIn: route.pay.address as Hex,
        tokenOut: route.receive.address as Hex,
        amountIn,
        fee: route.poolFee,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
}

function exact<T extends readonly unknown[]>(
  abi: T,
  data: unknown,
): { functionName: string; args: readonly unknown[] } | null {
  if (
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})*$/.test(data)
  )
    return null;
  try {
    const d = decodeFunctionData({ abi: abi as never, data: data as Hex }) as {
      functionName: string;
      args: readonly unknown[];
    };
    const encode = encodeFunctionData as unknown as (p: {
      abi: unknown;
      functionName: string;
      args: readonly unknown[];
    }) => Hex;
    const again = encode({ abi, functionName: d.functionName, args: d.args });
    return lower(again) === lower(data) ? d : null;
  } catch {
    return null;
  }
}
export interface DecodedApprove {
  spender: string;
  amount: bigint;
}
export function decodeApprove(data: unknown): DecodedApprove | null {
  if (
    typeof data !== "string" ||
    !data.toLowerCase().startsWith(SWAP_LANE_SELECTORS.approve)
  )
    return null;
  const d = exact(LANE_ERC20_ABI, data);
  if (!d || d.functionName !== "approve") return null;
  return { spender: lower(d.args[0] as string), amount: d.args[1] as bigint };
}
export interface DecodedSwap {
  deadline: bigint;
  tokenIn: string;
  tokenOut: string;
  fee: number;
  recipient: string;
  amountIn: bigint;
  amountOutMinimum: bigint;
  sqrtPriceLimitX96: bigint;
}
export function decodeSwap(data: unknown): DecodedSwap | null {
  if (
    typeof data !== "string" ||
    !data.toLowerCase().startsWith(SWAP_LANE_SELECTORS.multicall)
  )
    return null;
  const m = exact(LANE_ROUTER_ABI, data);
  if (!m || m.functionName !== "multicall") return null;
  const [deadline, calls] = m.args as [bigint, readonly string[]];
  if (calls.length !== 1) return null;
  if (!lower(calls[0]).startsWith(SWAP_LANE_SELECTORS.exactInputSingle))
    return null;
  const e = exact(LANE_ROUTER_ABI, calls[0]);
  if (!e || e.functionName !== "exactInputSingle") return null;
  const p = e.args[0] as {
    tokenIn: string;
    tokenOut: string;
    fee: number;
    recipient: string;
    amountIn: bigint;
    amountOutMinimum: bigint;
    sqrtPriceLimitX96: bigint;
  };
  return {
    deadline,
    tokenIn: lower(p.tokenIn),
    tokenOut: lower(p.tokenOut),
    fee: Number(p.fee),
    recipient: lower(p.recipient),
    amountIn: p.amountIn,
    amountOutMinimum: p.amountOutMinimum,
    sqrtPriceLimitX96: p.sqrtPriceLimitX96,
  };
}
/** Why an approve calldata is not the lane's exact approval of `amount` to the route's router (null = it is). */
export function approveProblem(
  route: Route,
  data: unknown,
  amount: bigint,
): string | null {
  const d = decodeApprove(data);
  if (!d) return "APPROVE_CALLDATA_NOT_CANONICAL";
  if (!same(d.spender, route.router)) return "APPROVE_SPENDER_NOT_ROUTER";
  if (d.amount !== amount) return "APPROVE_NOT_EXACT_AMOUNT";
  return null;
}
/** Why a swap calldata is not exactly the reviewed swap of this route (null = it is). */
export function swapProblem(
  route: Route,
  data: unknown,
  want: { owner: string; amountIn: bigint; amountOutMinimum: bigint },
  nowSec: number,
): string | null {
  const d = decodeSwap(data);
  if (!d) return "SWAP_CALLDATA_NOT_CANONICAL";
  if (!same(d.tokenIn, route.pay.address)) return "SWAP_TOKEN_IN";
  if (!same(d.tokenOut, route.receive.address)) return "SWAP_TOKEN_OUT";
  if (d.fee !== route.poolFee) return "SWAP_FEE_TIER";
  if (!same(d.recipient, want.owner)) return "SWAP_RECIPIENT_NOT_OWNER";
  if (d.amountIn !== want.amountIn) return "SWAP_AMOUNT_NOT_EXACT";
  if (d.amountOutMinimum !== want.amountOutMinimum)
    return "SWAP_MIN_OUT_NOT_REVIEWED";
  if (d.amountOutMinimum <= 0n) return "SWAP_MIN_OUT_ZERO";
  if (d.sqrtPriceLimitX96 !== 0n) return "SWAP_PRICE_LIMIT_SET";
  if (d.deadline <= BigInt(nowSec)) return "SWAP_DEADLINE_PASSED";
  if (d.deadline > BigInt(nowSec + SWAP_LANE_SCOPE.deadlineSec + 30))
    return "SWAP_DEADLINE_TOO_FAR";
  return null;
}
/** Minimum output for a fresh quote: ceil(quote * (1 - slippage)) (never rounds in the pool's favour). */
export function minimumOutFor(quote: bigint, slippageBps: number): bigint {
  return (quote * BigInt(10_000 - slippageBps) + 9_999n) / 10_000n;
}
/**
 * The pool's spot output for `amountIn` of the pay token, in raw receive units, from slot0's sqrtPriceX96
 * (sqrtP = sqrt(token1 / token0) * 2^96, raw units, so the decimals of both tokens are already inside the price).
 *   pay = token0: out (token1) = amountIn * sqrtP^2 / 2^192
 *   pay = token1: out (token0) = amountIn * 2^192 / sqrtP^2
 * Floors (never in the pool's favour against the quote); 0 for a zero price.
 */
export function spotOutFor(
  route: Route,
  amountIn: bigint,
  sqrtPriceX96: bigint,
): bigint {
  if (amountIn <= 0n || sqrtPriceX96 <= 0n) return 0n;
  const p2 = sqrtPriceX96 * sqrtPriceX96;
  return route.payIsToken0 ? (amountIn * p2) >> 192n : (amountIn << 192n) / p2;
}
