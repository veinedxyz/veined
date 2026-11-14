// G14 Track A: the frozen scope of the single owner-signed canary. Browser-safe. Nothing outside this scope can be
// reviewed as a canary (any other chain, token, amount, tool or recipient is refused before any read).
//   Base (8453) Circle native USDC  ->  Arbitrum (42161) Circle native USDC, via LI.FI AcrossFacetV4 (pinned),
//   at most 5 USDC, sender = recipient = refund address = the owner's own connected account, single use
// (enforced by the engine's append-only use journal).
// The scope authorizes NOTHING: the execution gate stays CLOSED (src/execution/server/gate.ts) and opening it for this
// scope needs the separately approved protected changes in EXACT_G7_APPROVAL_REQUEST_TR.md plus a later owner GOAL.
import { encodeFunctionData, erc20Abi, type Hex } from "viem";
import { CANARY_PINS } from "./pins";

export const CANARY_SCOPE = Object.freeze({
  id: "base-arbitrum-usdc-max5",
  sourceChainId: "8453",
  destinationChainId: "42161",
  pay: Object.freeze({
    chainId: "8453",
    address: CANARY_PINS.usdc["8453"].address,
    symbol: "USDC",
    decimals: 6,
    native: false,
  }),
  receive: Object.freeze({
    chainId: "42161",
    address: CANARY_PINS.usdc["42161"].address,
    symbol: "USDC",
    decimals: 6,
    native: false,
  }),
  /** Raw USDC units (6 decimals): 1 USDC minimum (fees stay a small share), 5 USDC hard maximum. */
  minAmount: 1_000_000n,
  maxAmount: 5_000_000n,
  /** LI.FI tool / bridge the quote must name (allowBridges=across). */
  tool: "across",
  /** Every cost taken out of the amount (LI.FI fee + relayer fees) together may not exceed this share. */
  maxCostBps: 300,
  /** The Across output multiplier is bounded: never above 1:1 for USDC -> USDC, never below the cost bound. */
  minMultiplier: 970_000_000_000_000_000n,
  // At least 1 bp stays with the relayer (a 1:1 multiplier is a deposit no relayer fills, review F4).
  maxMultiplier: 999_900_000_000_000_000n,
  /** Across fill deadline must leave a real window, but not lock funds for long (refund path). */
  minFillWindowSec: 30 * 60,
  maxFillWindowSec: 6 * 3600,
  /** The quote timestamp must be this close to the review time. */
  maxQuoteClockSkewSec: 10 * 60,
  /** The block a review reads (pins, balances, simulation) may be at most this old. */
  maxReviewBlockAgeSec: 60,
  /** Across exclusivity: none, or at most this many seconds for one EVM relayer (review F4). */
  maxExclusivitySec: 300,
  /** Upper bound for the gas limit the wallet signs (the simulated need x margin must fit below it). */
  maxGasLimit: 2_000_000n,
  /**
   * One canary per owner and scope, ever: enforced by the engine's append-only use journal at the first owner
   * authorization (server/canary/engine.ts, review F3) — not by this constant.
   */
  singleUse: true,
});

const DIGITS = /^(0|[1-9]\d{0,40})$/;
export type ScopeProblem =
  | "AMOUNT_INVALID"
  | "AMOUNT_BELOW_MINIMUM"
  | "AMOUNT_ABOVE_CANARY_MAXIMUM"
  | "OWNER_INVALID";
/** Null when `amount` (raw USDC units) and `owner` fit the canary scope. */
export function scopeProblem(
  amount: unknown,
  owner: unknown,
): ScopeProblem | null {
  if (typeof owner !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(owner))
    return "OWNER_INVALID";
  if (/^0x0{40}$/i.test(owner)) return "OWNER_INVALID";
  if (typeof amount !== "string" || !DIGITS.test(amount))
    return "AMOUNT_INVALID";
  const a = BigInt(amount);
  if (a < CANARY_SCOPE.minAmount) return "AMOUNT_BELOW_MINIMUM";
  if (a > CANARY_SCOPE.maxAmount) return "AMOUNT_ABOVE_CANARY_MAXIMUM";
  return null;
}
/**
 * The exact transaction that withdraws a standing canary approval: approve(Diamond, 0) on Base USDC from the owner
 * (round-3 review M2). Built only; sending it needs the same owner signature in the owner's own wallet (live path:
 * proposal B3) — Rabby's own approval manager can revoke it today without VEINED.
 */
export function revocationTransaction(owner: string): {
  chainId: string;
  from: string;
  to: string;
  value: string;
  data: string;
} {
  if (scopeProblem("1000000", owner)) throw new RangeError("OWNER_INVALID");
  return {
    chainId: CANARY_SCOPE.sourceChainId,
    from: owner,
    to: CANARY_PINS.usdc["8453"].address,
    value: "0",
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CANARY_PINS.diamond.address as Hex, 0n],
    }),
  };
}
