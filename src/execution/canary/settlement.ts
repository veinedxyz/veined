// G14 Track A: destination settlement, refund tracking and final on-chain balance reconciliation of the canary (pure).
// Round-1 review fixes (F2, F5, F8): the deposit is taken from the MINED source receipt (the pinned Base pool's single
// FundsDeposited in that transaction); a fill counts only if EVERY relay field of the pinned Arbitrum pool's
// FilledRelay equals that deposit (tokens, amounts, depositor, recipient, exclusive relayer, deadlines, message hash)
// and the executed recipient / amount / message are unchanged (VEINED never signs a speed-up); fills that do not match
// are ignored (a third party's fake fill neither delivers nor blocks); the destination pins are re-read at settlement.
// A refund counts only as a USDC transfer from the Base pool to the owner in a block AFTER the deposit block and
// after the fill deadline — it is not yet tied to Across' refund leaf (stated, not hidden). "Completed" exists only as
// RECONCILED; balance movements unrelated to the canary are reported as such (UNKNOWN), never as success.
import { decodeEventLog, keccak256, parseAbi, type Hex } from "viem";
import {
  CANARY_PINS,
  destinationPinProblems,
  type DestinationPinReads,
} from "./pins";
import type { CanaryCheck } from "./quote-verify";

export const SETTLEMENT_ABI = parseAbi([
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
/** Kept for callers of the round-1 name. */
export const FILLED_RELAY_ABI = SETTLEMENT_ABI;
export interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
  /** Block timestamp (seconds); required for refund logs. */
  timestamp?: number;
  /** eth_getLogs marks logs of a reorganised block as removed: they never count (round-3 review R1). */
  removed?: boolean;
}
/** The relay as the source chain recorded it (all fields a fill must repeat). */
export interface CanaryDeposit {
  depositId: string;
  inputToken: string;
  outputToken: string;
  inputAmount: string;
  outputAmount: string;
  depositor: string;
  recipient: string;
  exclusiveRelayer: string;
  fillDeadline: number;
  exclusivityDeadline: number;
  messageHash: string;
  /** The source block the deposit was mined in (decimal). */
  sourceBlock: string;
  owner: string;
  /** The minimum the owner reviewed (raw Arbitrum USDC). */
  minimumOut: string;
}
export type SettlementStatus =
  "PENDING" | "DELIVERED" | "REFUND_PENDING" | "REFUNDED" | "DISCREPANCY";
export interface Settlement {
  status: SettlementStatus;
  code: string;
  delivered: string | null;
  refunded: string | null;
  hash: string | null;
}
const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
const b32 = (x: string) => `0x${x.slice(-40)}`.toLowerCase();
const DIGITS = /^(0|[1-9]\d{0,77})$/;
const ZERO32 = "0x" + "0".repeat(64);
/** Across hashes a non-empty message; an empty one is the zero word. */
export const messageHashOf = (message: string) =>
  message === "0x" ? ZERO32 : keccak256(message as Hex);
/** Grace after the fill deadline before an unfilled deposit is reported as refund pending. */
export const REFUND_GRACE_SEC = 15 * 60;

/** The deposit of the mined canary transaction: exactly one FundsDeposited of the pinned Base pool in `txHash`. */
export function depositFromSourceLogs(
  logs: readonly ChainLog[],
  txHash: string,
  owner: string,
  minimumOut: string,
): CanaryDeposit | null {
  const pool = lower(CANARY_PINS.spokePools["8453"].address);
  const found: CanaryDeposit[] = [];
  for (const l of logs) {
    if (
      lower(l.address) !== pool ||
      lower(l.transactionHash) !== lower(txHash) ||
      !DIGITS.test(l.blockNumber)
    )
      continue;
    try {
      const x = decodeEventLog({
        abi: SETTLEMENT_ABI,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
      });
      if (
        x.eventName !== "FundsDeposited" ||
        x.args.destinationChainId !== 42161n
      )
        continue;
      const a = x.args;
      found.push({
        depositId: a.depositId.toString(),
        inputToken: lower(a.inputToken),
        outputToken: lower(a.outputToken),
        inputAmount: a.inputAmount.toString(),
        outputAmount: a.outputAmount.toString(),
        depositor: lower(a.depositor),
        recipient: lower(a.recipient),
        exclusiveRelayer: lower(a.exclusiveRelayer),
        fillDeadline: Number(a.fillDeadline),
        exclusivityDeadline: Number(a.exclusivityDeadline),
        messageHash: messageHashOf(a.message),
        sourceBlock: l.blockNumber,
        owner: lower(owner),
        minimumOut,
      });
    } catch {
      // not a deposit
    }
  }
  return found.length === 1 ? found[0] : null;
}

export function destinationSettlement(i: {
  deposit: CanaryDeposit;
  /** Logs the server read on Arbitrum for the pinned SpokePool and the USDC token (a second source is item B4). */
  destinationLogs: readonly ChainLog[];
  /** USDC Transfer logs the server read on Base after the deadline (refund search). */
  sourceRefundLogs: readonly ChainLog[];
  /** Destination pins re-read now (review F8). */
  destinationPins: DestinationPinReads | null;
  nowSec: number;
}): Settlement {
  const d = i.deposit;
  const none = { delivered: null, refunded: null, hash: null };
  if (
    !d ||
    ![
      d.depositId,
      d.inputAmount,
      d.outputAmount,
      d.minimumOut,
      d.sourceBlock,
    ].every((v) => typeof v === "string" && DIGITS.test(v)) ||
    !/^0x[0-9a-fA-F]{40}$/.test(d.owner)
  )
    return { status: "DISCREPANCY", code: "DEPOSIT_RECORD_INVALID", ...none };
  const owner = lower(d.owner);
  // The reviewed relay itself must be the owner's, to the owner, in USDC, at least the minimum.
  if (
    b32(d.depositor) !== owner ||
    b32(d.recipient) !== owner ||
    b32(d.outputToken) !== lower(CANARY_PINS.usdc["42161"].address) ||
    BigInt(d.outputAmount) < BigInt(d.minimumOut)
  )
    return {
      status: "DISCREPANCY",
      code: "DEPOSIT_NOT_THE_REVIEWED_RELAY",
      ...none,
    };
  const pins = destinationPinProblems(i.destinationPins);
  if (pins.length)
    return {
      status: "DISCREPANCY",
      code: `DESTINATION_PINS:${pins.join(",")}`,
      ...none,
    };
  const pool = lower(CANARY_PINS.spokePools["42161"].address);
  const usdcArb = lower(CANARY_PINS.usdc["42161"].address);
  const fills: { hash: string; amount: bigint }[] = [];
  const transfers: { hash: string; to: string; value: bigint }[] = [];
  for (const l of i.destinationLogs) {
    if (l.removed === true) continue;
    try {
      const x = decodeEventLog({
        abi: SETTLEMENT_ABI,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
      });
      if (x.eventName === "FilledRelay") {
        const a = x.args,
          info = a.relayExecutionInfo;
        const matches =
          lower(l.address) === pool &&
          a.originChainId === 8453n &&
          a.depositId.toString() === d.depositId &&
          lower(a.inputToken) === d.inputToken &&
          lower(a.outputToken) === d.outputToken &&
          a.inputAmount.toString() === d.inputAmount &&
          a.outputAmount.toString() === d.outputAmount &&
          lower(a.depositor) === d.depositor &&
          lower(a.recipient) === d.recipient &&
          lower(a.exclusiveRelayer) === d.exclusiveRelayer &&
          Number(a.fillDeadline) === d.fillDeadline &&
          Number(a.exclusivityDeadline) === d.exclusivityDeadline &&
          lower(a.messageHash) === lower(d.messageHash) &&
          // Executed as deposited: VEINED never signs a speed-up, so recipient and message may not differ. A fast fill
          // pays exactly the output amount; a SLOW fill (fillType 2) pays the amount Across computed, which must still
          // reach the reviewed minimum (round-2 review N6).
          lower(info.updatedRecipient) === d.recipient &&
          lower(info.updatedMessageHash) === lower(d.messageHash) &&
          (Number(info.fillType) === 2
            ? info.updatedOutputAmount >= BigInt(d.minimumOut)
            : info.updatedOutputAmount.toString() === d.outputAmount);
        if (matches)
          fills.push({
            hash: lower(l.transactionHash),
            amount: info.updatedOutputAmount,
          });
      } else if (x.eventName === "Transfer" && lower(l.address) === usdcArb)
        transfers.push({
          hash: lower(l.transactionHash),
          to: lower(x.args.to),
          value: x.args.value,
        });
    } catch {
      // unrelated log
    }
  }
  if (new Set(fills.map((f) => f.hash)).size > 1)
    return { status: "DISCREPANCY", code: "MULTIPLE_MATCHING_FILLS", ...none };
  if (fills.length >= 1) {
    const { hash, amount } = fills[0];
    const ofFill = transfers.filter((t) => t.hash === hash);
    // No USDC log of the fill transaction read yet: an incomplete read, retried — never a terminal verdict (R1).
    if (ofFill.length === 0)
      return {
        status: "DISCREPANCY",
        code: "FILL_PAYMENT_NOT_READ",
        delivered: null,
        refunded: null,
        hash,
      };
    const paid = ofFill
      .filter((t) => t.to === owner)
      .reduce((a, t) => a + t.value, 0n);
    // Fully paid (a relayer adding more is still paid; the extra shows up as unrelated activity in reconciliation).
    if (paid < amount)
      return {
        status: "DISCREPANCY",
        code: "FILL_UNDERPAID_TO_OWNER",
        delivered: paid.toString(),
        refunded: null,
        hash,
      };
    return {
      status: "DELIVERED",
      code: "FILLED_TO_OWNER",
      delivered: amount.toString(),
      refunded: null,
      hash,
    };
  }
  if (i.nowSec <= d.fillDeadline + REFUND_GRACE_SEC)
    return { status: "PENDING", code: "AWAITING_FILL", ...none };
  const basePool = lower(CANARY_PINS.spokePools["8453"].address);
  const usdcBase = lower(CANARY_PINS.usdc["8453"].address);
  let refunded = 0n;
  let refundHash: string | null = null;
  for (const l of i.sourceRefundLogs) {
    if (l.removed === true) continue;
    if (
      !DIGITS.test(l.blockNumber) ||
      BigInt(l.blockNumber) <= BigInt(d.sourceBlock) ||
      !Number.isSafeInteger(l.timestamp) ||
      l.timestamp! <= d.fillDeadline
    )
      continue;
    try {
      const x = decodeEventLog({
        abi: SETTLEMENT_ABI,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
      });
      if (
        x.eventName === "Transfer" &&
        lower(l.address) === usdcBase &&
        lower(x.args.from) === basePool &&
        lower(x.args.to) === owner
      ) {
        refunded += x.args.value;
        refundHash = lower(l.transactionHash);
      }
    } catch {
      // unrelated log
    }
  }
  if (refunded >= BigInt(d.inputAmount))
    return {
      status: "REFUNDED",
      code: "REFUND_TO_OWNER_AFTER_DEADLINE",
      delivered: null,
      refunded: refunded.toString(),
      hash: refundHash,
    };
  return { status: "REFUND_PENDING", code: "UNFILLED_AFTER_DEADLINE", ...none };
}

/**
 * Final reconciliation (two agreeing sources per balance, read at explicit blocks before and after):
 *   delivered: Base USDC fell by exactly the amount sent; Arbitrum USDC rose by exactly the delivered fill;
 *   refunded:  Base USDC fell by exactly amount - refund (LI.FI's fee stays spent); Arbitrum unchanged.
 * A movement in the owner's favour beyond that is UNRELATED_ACTIVITY (UNKNOWN: needs the owner's eye, never "completed");
 * a movement against the owner is a FAIL.
 */
export function reconcileCanary(i: {
  amountIn: string;
  delivered: string | null;
  refunded?: string | null;
  minimumOut: string;
  base: { before: string | null; after: string | null };
  arbitrum: { before: string | null; after: string | null };
}): CanaryCheck {
  const refunded = i.refunded ?? null;
  const settled = i.delivered ?? null;
  if ((settled === null) === (refunded === null))
    return { id: "RECONCILIATION", status: "UNKNOWN", code: "NOT_SETTLED" };
  const v = [
    i.amountIn,
    i.minimumOut,
    settled ?? refunded,
    i.base.before,
    i.base.after,
    i.arbitrum.before,
    i.arbitrum.after,
  ];
  if (v.some((x) => x === null || !DIGITS.test(x as string)))
    return {
      id: "RECONCILIATION",
      status: "UNKNOWN",
      code: "BALANCES_NOT_AGREED",
    };
  const [amountIn, minimumOut, amount, bb, ba, ab, aa] = v.map((x) =>
    BigInt(x as string),
  );
  const sourceFall = bb - ba,
    destRise = aa - ab;
  const wantFall = settled !== null ? amountIn : amountIn - amount;
  const wantRise = settled !== null ? amount : 0n;
  if (
    (settled !== null && amount < minimumOut) ||
    sourceFall > wantFall ||
    destRise < wantRise
  )
    return {
      id: "RECONCILIATION",
      status: "FAIL",
      code: "BALANCE_DELTA_AGAINST_OWNER",
    };
  if (sourceFall < wantFall || destRise > wantRise)
    return {
      id: "RECONCILIATION",
      status: "UNKNOWN",
      code: "UNRELATED_ACTIVITY",
    };
  return {
    id: "RECONCILIATION",
    status: "PASS",
    code: settled !== null ? "BOTH_CHAINS_RECONCILED" : "REFUND_RECONCILED",
  };
}
