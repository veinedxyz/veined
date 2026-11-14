// G13: owner-signed execution FOUNDATION — browser-safe types, the frozen policy and the transaction lifecycle.
// Nothing in src/execution signs, approves, sends, holds a key or opens a deposit address. Execution stays CLOSED:
// the protected gates (src/g5/route-pins.ts, src/routing/model.ts executionGate, src/swap/model.ts EXECUTION,
// src/security/firewall.ts killPolicy, src/features/wallet/adapter.ts) are read, never changed (see server/gate.ts).
// These modules describe and check what a reviewed plan must satisfy BEFORE a future, separately owner-approved gate
// could hand its exact canonical transaction to the owner's own wallet (PROTECTED_CHANGE_PROPOSAL_TR.md).

export const EXECUTION_POLICY = Object.freeze({
  // x1.2026-11.2: review rounds 1-4 (decoder allowlist + canonical layout, fee proof, lifecycle invariants, record-bound
  // authorization, pinned token spender, strict plan shape, plan digest v3).
  version: "x1.2026-11.2",
  /** VEINED platform commission: disabled. Any other value is refused everywhere. */
  platformFeeBps: 0 as const,
  /** A quote older than this is never presented for a signature (the firewall's own bound is 15 s on simulation). */
  maxQuoteAgeMs: 30_000,
  /** The owner needs at least this long between review and the quote's expiry. */
  minRemainingMs: 10_000,
  /** An owner authorization lives at most this long, and never past the quote's expiry. */
  authorizationTtlMs: 60_000,
  /** Source-chain confirmations before a transaction counts as confirmed. */
  confirmations: Object.freeze({
    default: 3,
    "1": 3,
    "10": 10,
    "56": 15,
    "8453": 10,
    "42161": 10,
  } as Readonly<Record<string, number>>),
  /** Native gas kept beyond the estimate (basis points of the estimate). */
  gasMarginBps: 2000,
  /** Slippage above this is refused for an owner-signed plan. */
  maxSlippageBps: 300,
  /** Costs at or above this share of the amount make a plan uneconomic (same bound as the H03 notice). */
  uneconomicCostBps: 1000,
  /** NEAR Intents executable quote: accepted deadline window from now. */
  // 5 min (review F21): the app's own dry request asks for a 10-minute deadline, so it must fit inside the window.
  nearDeadlineMinMs: 5 * 60_000,
  nearDeadlineMaxMs: 24 * 3600_000,
  /** A submitted transaction not seen by any RPC for this long is reported as dropped (never retried). */
  dropAfterMs: 30 * 60_000,
});

export type ExecutionKind = "EVM_SWAP" | "EVM_BRIDGE" | "NEAR_INTENTS";
export interface AssetRef {
  chainId: string;
  /** EVM: checksummed or lowercase 0x address; the zero address is the native coin. NEAR: the 1Click asset id. */
  address: string;
  symbol: string;
  decimals: number;
  native: boolean;
}
export interface FeeLine {
  name: string;
  /** Smallest unit of `asset`. */
  amount: string;
  /** Decimal USD as the provider reported it, or null. */
  usd: string | null;
  /** Taken out of the amount sent (true) or paid on top (false). */
  included: boolean;
  kind: "gas" | "fee";
  asset: AssetRef;
}
/** An ERC-20 approval the plan needs: exact token, exact reviewed spender, exact amount (never more than sent). */
export interface ApprovalRequest {
  token: string;
  spender: string;
  amount: string;
}
/** The canonical wallet transaction: the only shape that could ever reach WalletProviderAdapter.sendCanonicalTransaction. */
export interface WalletTransaction {
  /** Decimal chain id. */
  chainId: string;
  from: string;
  to: string;
  /** Decimal wei. */
  value: string;
  data: string;
  /** Decimal gas limit when the provider gave one. */
  gas?: string;
  /** Decimal EIP-1559 fee caps when set: they are part of what the wallet signs (adapter CANONICAL_TX_FIELDS). */
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
}
export interface ExecutionPlan {
  version: string;
  kind: ExecutionKind;
  /** Route source ("routing-core", "uniswap", "near-intents" …) and the route's own tool. */
  provider: string;
  tool: string;
  quoteId: string;
  quotedAt: number;
  expiresAt: number;
  /** The provider's quote can be executed (false for every dry / preview quote). */
  executable: boolean;
  account: string;
  sourceChainId: string;
  destinationChainId: string;
  pay: AssetRef;
  receive: AssetRef;
  amountIn: string;
  expectedOut: string;
  minimumOut: string;
  recipient: string;
  /** NEAR Intents: where a failed swap refunds (must be the sender on the origin chain). */
  refundTo: string | null;
  slippageBps: number;
  platformFeeBps: number;
  fees: FeeLine[];
  /**
   * The contract that pulls the pay token (the allowance is read for it; review round 3, R1): required for a token
   * payment, null for the native coin. Bound by the plan digest; after an approval the re-quote must keep it.
   */
  spender: string | null;
  approval: ApprovalRequest | null;
  transaction: WalletTransaction | null;
}

// ---- Lifecycle -------------------------------------------------------------------------------------------------
export const LIFECYCLE = [
  "DRAFT",
  "QUOTED",
  "PREFLIGHT_PASSED",
  "GUARDIAN_PASSED",
  "REVIEWED",
  "AWAITING_APPROVAL_SIGNATURE",
  "APPROVAL_SUBMITTED",
  "APPROVAL_CONFIRMED",
  "AWAITING_SIGNATURE",
  "SUBMITTED",
  "SOURCE_CONFIRMED",
  "DESTINATION_PENDING",
  "SETTLED",
  "RECONCILED",
  // Stops (never "completed")
  "BLOCKED",
  "EXPIRED",
  "OWNER_REJECTED",
  "UNCERTAIN",
  "SOURCE_FAILED",
  "REPLACED",
  "DROPPED",
  "REORGED",
  "DESTINATION_FAILED",
  "REFUND_PENDING",
  "REFUNDED",
  "DISCREPANCY",
] as const;
export type LifecycleState = (typeof LIFECYCLE)[number];

/** Every legal edge. Anything else is refused (a pending transaction can never jump to settled or reconciled). */
export const TRANSITIONS: Readonly<
  Record<LifecycleState, readonly LifecycleState[]>
> = Object.freeze({
  DRAFT: ["QUOTED", "BLOCKED"],
  QUOTED: ["PREFLIGHT_PASSED", "BLOCKED", "EXPIRED"],
  PREFLIGHT_PASSED: ["GUARDIAN_PASSED", "BLOCKED", "EXPIRED"],
  GUARDIAN_PASSED: ["REVIEWED", "BLOCKED", "EXPIRED"],
  REVIEWED: [
    "AWAITING_APPROVAL_SIGNATURE",
    "AWAITING_SIGNATURE",
    "BLOCKED",
    "EXPIRED",
  ],
  // Once a wallet prompt may be open, expiry is not an end: the quote's expiry moves the record to UNCERTAIN, so a
  // hash the wallet returns later can still be recorded (review F06).
  AWAITING_APPROVAL_SIGNATURE: [
    "APPROVAL_SUBMITTED",
    "OWNER_REJECTED",
    "UNCERTAIN",
  ],
  APPROVAL_SUBMITTED: [
    "APPROVAL_CONFIRMED",
    "SOURCE_FAILED",
    "REPLACED",
    "DROPPED",
    "REORGED",
  ],
  // After an approval the route is quoted and reviewed AGAIN before the main signature (fresh numbers).
  APPROVAL_CONFIRMED: ["QUOTED", "APPROVAL_SUBMITTED"],
  AWAITING_SIGNATURE: ["SUBMITTED", "OWNER_REJECTED", "UNCERTAIN"],
  SUBMITTED: [
    "SUBMITTED",
    "SOURCE_CONFIRMED",
    "SOURCE_FAILED",
    "REPLACED",
    "DROPPED",
  ],
  SOURCE_CONFIRMED: [
    "DESTINATION_PENDING",
    "SETTLED",
    "REORGED",
    "DESTINATION_FAILED",
    "REFUND_PENDING",
    "REFUNDED",
    "DISCREPANCY",
  ],
  // Only the main transaction reaches REORGED; an approval reorg returns to APPROVAL_SUBMITTED directly (review F05).
  // A reorged-out transaction may be re-mined under a same-intent hash (SUBMITTED), never be seen again (DROPPED), or
  // lose its nonce to another transaction (REPLACED, review round 3 N6).
  // Round 4 (S1): the SAME hash re-mined is followed again (confirmed or reverted); the drop window runs from the reorg.
  REORGED: [
    "SUBMITTED",
    "SOURCE_CONFIRMED",
    "SOURCE_FAILED",
    "DROPPED",
    "REPLACED",
  ],
  DESTINATION_PENDING: [
    "REORGED",
    "SETTLED",
    "DESTINATION_FAILED",
    "REFUND_PENDING",
    "REFUNDED",
    "DISCREPANCY",
  ],
  // Round 4 (S2): a deposit reported incomplete may still complete (NEAR INCOMPLETE_DEPOSIT -> PROCESSING -> SUCCESS).
  REFUND_PENDING: [
    "REFUNDED",
    "DESTINATION_FAILED",
    "DESTINATION_PENDING",
    "SETTLED",
    "DISCREPANCY",
    // Round 5 (T2): the source transaction can still be reorganised while a refund is pending.
    "REORGED",
  ],
  SETTLED: ["RECONCILED", "DISCREPANCY"],
  // A wallet request without a definitive answer: no new signature is ever requested; only observation resolves it.
  // It resolves only by a hash found for this intent, or by a timeout with the account nonce unchanged (review F06).
  UNCERTAIN: ["SUBMITTED", "APPROVAL_SUBMITTED", "DROPPED"],
  RECONCILED: [],
  BLOCKED: [],
  EXPIRED: [],
  OWNER_REJECTED: [],
  SOURCE_FAILED: [],
  REPLACED: [],
  DROPPED: [],
  DESTINATION_FAILED: [],
  REFUNDED: [],
  DISCREPANCY: [],
});
export const TERMINAL: ReadonlySet<LifecycleState> = new Set(
  LIFECYCLE.filter((s) => TRANSITIONS[s].length === 0),
);
/** The one state that may be called "completed": delivered AND the final balances reconciled. */
export const isCompleted = (s: LifecycleState) => s === "RECONCILED";
/** States in which money may be moving and the outcome is not known yet. */
export const PENDING_STATES: ReadonlySet<LifecycleState> = new Set([
  "APPROVAL_SUBMITTED",
  "SUBMITTED",
  "SOURCE_CONFIRMED",
  "DESTINATION_PENDING",
  "REFUND_PENDING",
  "SETTLED",
  "UNCERTAIN",
  "REORGED",
]);
/** What a screen may say about a state. Only RECONCILED reads "completed"; every moving state reads "pending". */
export type StateLabel =
  | "PREPARING"
  | "WAITING_FOR_OWNER"
  | "PENDING"
  | "COMPLETED"
  | "STOPPED"
  | "NEEDS_ATTENTION";
export function labelOf(s: LifecycleState): StateLabel {
  if (isCompleted(s)) return "COMPLETED";
  if (s === "AWAITING_APPROVAL_SIGNATURE" || s === "AWAITING_SIGNATURE")
    return "WAITING_FOR_OWNER";
  // States where money may have moved or must be checked by the owner never read as a quiet "stopped" (review F06).
  if (
    s === "UNCERTAIN" ||
    s === "DISCREPANCY" ||
    s === "REFUND_PENDING" ||
    s === "REFUNDED" ||
    s === "DROPPED" ||
    s === "REPLACED" ||
    s === "DESTINATION_FAILED"
  )
    return "NEEDS_ATTENTION";
  if (PENDING_STATES.has(s)) return "PENDING";
  if (TERMINAL.has(s)) return "STOPPED";
  return "PREPARING";
}
