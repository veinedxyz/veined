// G13: read-only observations -> lifecycle events (pure). Nothing here sends, retries or replaces a transaction:
// a stuck, replaced or dropped transaction is REPORTED, never re-broadcast. Hardened after the Phase 3 review (F06,
// F17): missing data never concludes anything (an unreadable block hash is not "no reorg"; a consumed nonce whose
// transaction was not found is not a cancellation), a delivery needs an amount read on chain, and reconciliation uses
// this intent's own transfer, not a balance that an unrelated deposit could raise.
import { EXECUTION_POLICY, type ExecutionPlan } from "./model";
import type { ExecutionEvent, TxRole } from "./lifecycle";
import { planProblem } from "./plan-check";

const DIGITS = /^(0|[1-9]\d{0,77})$/;
export interface SourceObservation {
  role: TxRole;
  /** The hash currently tracked for this role. */
  hash: string;
  /** eth_getTransactionReceipt; null while not mined (or not visible). */
  receipt: {
    status: "success" | "reverted";
    blockNumber: string;
    blockHash: string;
  } | null;
  /** Hash of the canonical block at receipt.blockNumber re-read NOW (a different hash = the block was reorganised). */
  canonicalHashAtBlock: string | null;
  head: string | null;
  /** eth_getTransactionByHash returned the transaction. */
  transactionKnown: boolean;
  /** The account's mined nonce now, and the nonce the submitted transaction used. */
  accountNonce: string | null;
  txNonce: string | null;
  /** A mined transaction that used the same nonce, if one was found, and whether it carries the same intent. */
  replacement: { hash: string; sameIntent: boolean } | null;
  submittedAt: number;
  /**
   * The last time the transaction was seen — the record's `lastSeenAt` (main) or `approvalSeenAt` (approval):
   * submission, a receipt, a mempool sighting or a reorg (rounds 5 T1, 6 U1/U2). The drop window runs from here.
   */
  since?: number | null;
  /** The block hash the record has the transaction confirmed in: a receipt in another block, or none, is a reorg. */
  confirmedBlockHash?: string | null;
  now: number;
}
export function observeSource(o: SourceObservation): ExecutionEvent | null {
  // Structurally malformed reads conclude nothing (rounds 5 T4, 6 U3/U4).
  const text = (v: unknown) => v === null || typeof v === "string";
  if (
    !o ||
    typeof o !== "object" ||
    typeof o.hash !== "string" ||
    (o.role !== "main" && o.role !== "approval") ||
    (o.receipt !== null &&
      (!o.receipt ||
        typeof o.receipt !== "object" ||
        typeof o.receipt.blockHash !== "string" ||
        typeof o.receipt.blockNumber !== "string" ||
        (o.receipt.status !== "success" && o.receipt.status !== "reverted"))) ||
    (o.confirmedBlockHash != null &&
      typeof o.confirmedBlockHash !== "string") ||
    !text(o.canonicalHashAtBlock) ||
    !text(o.head) ||
    !text(o.accountNonce) ||
    !text(o.txNonce) ||
    typeof o.transactionKnown !== "boolean" ||
    !Number.isFinite(o.now) ||
    !Number.isFinite(o.submittedAt) ||
    // G14 (review round 7, V1): `since: null` (a record whose last-seen anchor is still empty) means "no anchor yet":
    // the window runs from the submission, so a reorg or drop is still seen. Only a non-null non-number is malformed.
    (o.since != null && !Number.isFinite(o.since))
  )
    return null;
  const base = { at: o.now, role: o.role };
  // A transaction recorded as confirmed whose receipt is gone or now sits in another block was reorganised (S1).
  if (
    o.confirmedBlockHash &&
    (!o.receipt ||
      o.receipt.blockHash.toLowerCase() !== o.confirmedBlockHash.toLowerCase())
  )
    return { type: "REORG", ...base, hash: o.hash };
  if (o.receipt) {
    // Without the canonical block hash a reorg cannot be excluded: no event (review F17).
    if (!o.canonicalHashAtBlock) return null;
    if (
      o.canonicalHashAtBlock.toLowerCase() !== o.receipt.blockHash.toLowerCase()
    )
      return { type: "REORG", ...base, hash: o.hash };
    if (o.receipt.status === "reverted")
      return { type: "TX_FAILED", ...base, hash: o.hash };
    if (!o.head || !DIGITS.test(o.head) || !DIGITS.test(o.receipt.blockNumber))
      return null;
    const confirmations = Number(
      BigInt(o.head) - BigInt(o.receipt.blockNumber) + 1n,
    );
    if (confirmations < 1) return null;
    return {
      type: "TX_CONFIRMED",
      ...base,
      hash: o.hash,
      block: o.receipt.blockNumber,
      blockHash: o.receipt.blockHash,
      confirmations,
    };
  }
  if (o.replacement)
    return {
      type: "TX_REPLACED",
      ...base,
      replaced: o.hash,
      hash: o.replacement.hash,
      sameIntent: o.replacement.sameIntent === true,
    };
  // Still known to the RPC (in the mempool): a sighting, which refreshes the record's anchor (round 6, U1).
  if (o.transactionKnown) return { type: "REOBSERVED", ...base, hash: o.hash };
  const nonceKnown =
    !!o.accountNonce &&
    !!o.txNonce &&
    DIGITS.test(o.accountNonce) &&
    DIGITS.test(o.txNonce);
  // A consumed nonce whose transaction is not found yet may be a speed-up we have not seen: no conclusion (review F06b).
  if (nonceKnown && BigInt(o.accountNonce!) > BigInt(o.txNonce!)) return null;
  const unseenForMs = o.now - (o.since ?? o.submittedAt);
  if (
    nonceKnown &&
    !o.transactionKnown &&
    unseenForMs > EXECUTION_POLICY.dropAfterMs
  )
    return { type: "TX_DROPPED", ...base, hash: o.hash, unseenForMs };
  return null;
}
/**
 * Routing status (src/routing/model.ts RouteStatus). Only an AUTHORITATIVE status (bound to this transfer) counts, and a
 * completion is recorded only with the amount READ on the destination chain; otherwise it stays pending.
 */
export function routeStatusEvent(
  s: { status: string; authoritative: boolean; destinationHash?: string },
  deliveredOnChain: string | null,
  now: number,
  /** The refund READ on the source chain (review round 3, R2); without it a refund is only "pending". */
  refundedOnChain: string | null = null,
): ExecutionEvent | null {
  if (!s.authoritative) return null;
  switch (s.status) {
    case "PENDING":
      return { type: "DESTINATION", at: now, status: "PENDING" };
    case "COMPLETED":
      return deliveredOnChain &&
        DIGITS.test(deliveredOnChain) &&
        s.destinationHash
        ? {
            type: "DESTINATION",
            at: now,
            status: "DELIVERED",
            hash: s.destinationHash,
            amount: deliveredOnChain,
          }
        : { type: "DESTINATION", at: now, status: "PENDING" };
    case "PARTIAL":
      return {
        type: "DESTINATION",
        at: now,
        status: "PARTIAL",
        hash: s.destinationHash,
      };
    case "REFUNDED":
      return refundEvent(now, refundedOnChain);
    case "FAILED":
      return { type: "DESTINATION", at: now, status: "FAILED" };
    default:
      return null;
  }
}
/** A provider's "refunded" is recorded as REFUNDED only with the amount read on chain; otherwise REFUND_PENDING. */
function refundEvent(
  now: number,
  refundedOnChain: string | null,
): ExecutionEvent {
  return refundedOnChain && /^[1-9]\d{0,77}$/.test(refundedOnChain)
    ? {
        type: "DESTINATION",
        at: now,
        status: "REFUNDED",
        amount: refundedOnChain,
      }
    : { type: "DESTINATION", at: now, status: "REFUND_PENDING" };
}
/**
 * NEAR Intents 1Click /v0/status (statuses and fields verified against the official OpenAPI, 2026-11-11). The status
 * comes from the provider; the delivered amount must be READ on NEAR (`deliveredOnChain`), never taken from
 * `swapDetails.amountOut` (review F17). Anything unknown is ignored, never "success".
 */
export function nearStatusEvent(
  raw: unknown,
  now: number,
  deliveredOnChain: string | null,
  /** The refund READ on the origin chain (review round 3, R2). */
  refundedOnChain: string | null = null,
): ExecutionEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as {
    status?: unknown;
    swapDetails?: { destinationChainTxHashes?: { hash?: unknown }[] };
  };
  const hash = r.swapDetails?.destinationChainTxHashes?.find(
    (h) => typeof h?.hash === "string",
  )?.hash as string | undefined;
  switch (r.status) {
    case "PENDING_DEPOSIT":
    case "KNOWN_DEPOSIT_TX":
    case "PROCESSING":
      return { type: "DESTINATION", at: now, status: "PENDING" };
    case "SUCCESS":
      return deliveredOnChain && DIGITS.test(deliveredOnChain) && hash
        ? {
            type: "DESTINATION",
            at: now,
            status: "DELIVERED",
            hash,
            amount: deliveredOnChain,
          }
        : { type: "DESTINATION", at: now, status: "PENDING" };
    case "INCOMPLETE_DEPOSIT":
      return { type: "DESTINATION", at: now, status: "REFUND_PENDING" };
    case "REFUNDED":
      return refundEvent(now, refundedOnChain);
    case "FAILED":
      return { type: "DESTINATION", at: now, status: "FAILED" };
    default:
      return null;
  }
}
/**
 * Final reconciliation from READ values: the source lost exactly the amount sent in the pay asset, the native coin
 * paid exactly the network fee (+ the transaction value for a token transfer), and THIS intent's own destination
 * transfer to the recipient carried at least the minimum. A mismatch is a DISCREPANCY, never smoothed over.
 */
export function reconcile(
  plan: ExecutionPlan,
  b: {
    payBefore: string;
    payAfter: string;
    nativeBefore: string;
    nativeAfter: string;
    networkFeePaid: string;
    txValue: string;
    /** Amount of the destination transfer of this intent to the recipient (from its log), not a balance delta. */
    deliveredInTransfer: string;
  },
): { ok: boolean; detail: string } {
  if (
    !b ||
    typeof b !== "object" ||
    ![
      b.payBefore,
      b.payAfter,
      b.nativeBefore,
      b.nativeAfter,
      b.networkFeePaid,
      b.txValue,
      b.deliveredInTransfer,
    ].every((v) => typeof v === "string" && DIGITS.test(v))
  )
    return { ok: false, detail: "BALANCE_UNREADABLE" };
  // The strict plan shape (review round 3 R7, round 4 S4): a malformed plan is refused, never thrown on.
  if (planProblem(plan)) return { ok: false, detail: "PLAN_INVALID" };
  // The value the transaction carried must be exactly the reviewed one (review round 3, R3): a transfer that took
  // more than was reviewed never reconciles.
  if (!plan.transaction || !DIGITS.test(plan.transaction.value))
    return { ok: false, detail: "NO_REVIEWED_TRANSACTION" };
  if (b.txValue !== plan.transaction.value)
    return { ok: false, detail: "TRANSACTION_VALUE_MISMATCH" };
  const amount = BigInt(plan.amountIn),
    fee = BigInt(b.networkFeePaid);
  if (plan.pay.native) {
    // The native coin pays the transaction value (amount + disclosed native fees) and the network fee (review F17).
    if (
      BigInt(b.txValue) < amount ||
      BigInt(b.payBefore) - BigInt(b.payAfter) !== BigInt(b.txValue) + fee
    )
      return { ok: false, detail: "SOURCE_DELTA_MISMATCH" };
  } else {
    if (BigInt(b.payBefore) - BigInt(b.payAfter) !== amount)
      return { ok: false, detail: "SOURCE_DELTA_MISMATCH" };
    if (
      BigInt(b.nativeBefore) - BigInt(b.nativeAfter) !==
      fee + BigInt(b.txValue)
    )
      return { ok: false, detail: "NATIVE_DELTA_MISMATCH" };
  }
  if (BigInt(b.deliveredInTransfer) < BigInt(plan.minimumOut))
    return { ok: false, detail: "DESTINATION_BELOW_MINIMUM" };
  return { ok: true, detail: "BALANCES_RECONCILED" };
}
