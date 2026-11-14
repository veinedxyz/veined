// G14 protected proposal B5: the owner-approved canary record — SCHEMA, VALIDATOR and a DISARMED constant.
// PROTECTED file. Browser-safe and dependency-free on purpose (it is read by the wallet adapter as well as the server).
//
// What this file is: the ONE place an owner-approved canary record could ever live, and the pure function that decides
// whether such a record covers one concrete wallet step. What it is NOT: an approval. `OWNER_CANARY_APPROVAL` is
// `null` (disarmed). No owner address, amount, minimum output, gas budget or deadline is filled in, and none may be
// invented by an agent: a real record is a separate protected change made from the owner's own written values
// (EXACT_APPLICATION_REQUEST_TR.md, `PENDING_OWNER_POLICY_DECISION` / `NO_OWNER_APPROVED_CANARY`).
//
// There is deliberately no parameter, environment variable, cookie, header, query string, storage key or build flag
// that can arm it: the constant is the only source, and every consumer (firewall canary check, wallet adapter,
// submission boundary, canary gate) reads the constant itself — none of them accepts a record from a caller.
// `evaluateCanaryApproval` is exported as a pure function only so its rules can be tested with synthetic records.
//
// The record binds, for ONE canary: scope, pin set, the exact account, the token / spender / target / selector, the
// EXACT amount, the MINIMUM OUTPUT the owner accepts for that exact amount, the total NATIVE GAS BUDGET (wei), a
// validity window and single use. Three points the owner asked to be explicit (G14-AUDIT-03):
//   - the minimum output is an absolute number for the exact amount (5 USDC -> 4.90 USDC is `exactAmount` 5000000,
//     `minimumOut` 4900000). It is never derived proportionally for another amount, and the general 300 bps cost
//     bound (src/execution/canary/scope.ts) neither replaces nor relaxes it: both must hold;
//   - the gas budget is native wei, not a gas limit: sum(gasLimit x maxFeePerGas) of every wallet step still to be
//     signed, plus what earlier steps already cost, plus the OP-stack L1 data fee estimate, must fit. The 2,000,000
//     gas-limit bound of the scope is a separate limit and is not a budget;
//   - withdrawing a standing allowance (approve(spender, 0)) is NOT covered by this record or its budget: it needs
//     its own owner approval (`allowanceCleanup`).
// Every missing, malformed, contradictory, expired or unknown fact is DENIED. Nothing here signs, sends or stores.

export const CANARY_APPROVAL_VERSION = "veined.owner-canary-approval.v1";

/** The frozen bounds every record must repeat exactly (mirrors src/execution/canary/{scope,pins}.ts; tested equal). */
export const CANARY_APPROVAL_BOUNDS = Object.freeze({
  scope: "base-arbitrum-usdc-max5",
  pinSet: "g14-canary-pins.2026-11-12.2",
  sourceChainId: "8453",
  destinationChainId: "42161",
  /** Circle native USDC on Base / Arbitrum. */
  token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  destinationToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  /** LI.FI Diamond on Base: the only call target and the only spender. */
  target: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
  /** AcrossFacetV4.swapAndStartBridgeTokensViaAcrossV4 — the only accepted entry point. */
  selector: "0x1794958f",
  /** ERC-20 approve(address,uint256): accepted only as approve(spender, exactAmount) on `token`. */
  approveSelector: "0x095ea7b3",
  /** Raw USDC units (6 decimals). */
  minAmount: "1000000",
  maxAmount: "5000000",
  /** Upper bound of any single gas limit a record may cover (the scope's bound; a limit, not a budget). */
  maxGasLimit: "2000000",
  /**
   * Structural ceiling of a record's validity window (ms): a mistyped date can never yield a long-lived approval.
   * A ceiling only — the owner's own window may be (and should be) much shorter. Proposed value, review 1 F10.
   */
  maxValidityMs: 86_400_000,
  /**
   * The only source step the pinned call may carry: LI.FI's fee collection on Base (address and selector as pinned
   * in src/execution/canary/pins.ts, tested equal). Any other step call is refused at the wallet boundary.
   */
  feeCollector: "0xde2b920506ee931a6a2abdf566526220214fbbae",
  feeCollectorSelector: "0x332d746b",
  /**
   * G14 closure (PP1-AUDIT-01): how long the owner's own trusted gesture for ONE wallet step counts (ms). The limit
   * lives here, next to the record, because the wallet adapter enforces it at the last instant before the request.
   */
  gestureMaxAgeMs: 30_000,
  /**
   * G14 closure (review 2 R3): no dispatch limit may lie further ahead of the request's clock than the server can
   * ever grant — an authorization lives 60 s, a quote 30 s (src/execution/model.ts EXECUTION_POLICY) — plus 5 s for
   * the difference between the server's and the page's clocks. The limits' digest is an integrity binding, not a
   * signature; this bound holds whoever builds the limits.
   */
  dispatchHorizonMs: 65_000,
});

export interface OwnerCanaryApproval {
  version: typeof CANARY_APPROVAL_VERSION;
  /** 32 random bytes chosen for this one approval (binds journals and reviews to it). */
  approvalId: string;
  scope: string;
  pinSet: string;
  /** The owner's own public account: sender = recipient = refund address. */
  account: string;
  sourceChainId: string;
  destinationChainId: string;
  token: string;
  destinationToken: string;
  target: string;
  spender: string;
  selector: string;
  /** Raw USDC units, decimal. `exactAmount` is the only amount this record covers. */
  maxAmount: string;
  exactAmount: string;
  /** The least the owner accepts on the destination for `exactAmount` (raw units, decimal). */
  minimumOut: string;
  /** Total native wei the owner allows the canary's wallet steps to cost on the source chain. */
  nativeGasBudgetWei: string;
  /** Validity window, milliseconds since the epoch: notBefore <= now < notAfter. */
  notBefore: number;
  notAfter: number;
  singleUse: true;
  /** Revoking a standing allowance is outside this record. */
  allowanceCleanup: "SEPARATE_OWNER_APPROVAL";
}

/**
 * DISARMED. There is no owner-approved canary in this build. Arming it is a separate protected change with the
 * owner's own values; nothing else in the code base can supply a record.
 */
export const OWNER_CANARY_APPROVAL =
  null as Readonly<OwnerCanaryApproval> | null;
/**
 * DISARMED. G14 closure (review 3 N12): the SHA-256 (64 lower-case hex) of the OWNER'S OWN canary key — a random
 * secret only the owner holds, digested by the server runtime with a fixed prefix. The account and the amount of a
 * canary are public, so naming them proves nothing: a canary record can be STARTED only by a request that carries the
 * key whose digest is this constant, and every wallet step needs the session that review handed out. Without this
 * constant the canary is not armed. It is not a signature and proves no wallet ownership (the adapter re-reads the
 * live wallet at the last instant); it only keeps strangers from starting or burning the owner's single-use canary.
 * Null in this build; set together with the owner record, by the owner, as a separate protected change.
 */
export const OWNER_CANARY_KEY_SHA256 = null as string | null;

/**
 * G14 closure: approvals the owner WITHDREW. A record whose approvalId is listed here is refused everywhere the record
 * is read (structural problem APPROVAL_REVOKED) even when it is otherwise well formed and inside its window. Empty in
 * this build (there is no record to withdraw). Like the record itself it is a protected constant: no request,
 * variable or switch can add to it or remove from it.
 */
export const REVOKED_CANARY_APPROVALS: readonly string[] = Object.freeze([]);

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO_ADDRESS = /^0x0{40}$/i;
const DECIMAL = /^(0|[1-9]\d{0,77})$/;
const ID = /^0x[0-9a-f]{64}$/;
const RECORD_KEYS = Object.freeze([
  "version",
  "approvalId",
  "scope",
  "pinSet",
  "account",
  "sourceChainId",
  "destinationChainId",
  "token",
  "destinationToken",
  "target",
  "spender",
  "selector",
  "maxAmount",
  "exactAmount",
  "minimumOut",
  "nativeGasBudgetWei",
  "notBefore",
  "notAfter",
  "singleUse",
  "allowanceCleanup",
] as const);
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const decimal = (x: unknown): bigint | null =>
  typeof x === "string" && DECIMAL.test(x) ? BigInt(x) : null;

/** Structural problems of a record (empty = well formed). `null` is the disarmed state, not a well-formed record. */
export function approvalRecordProblems(record: unknown): string[] {
  if (record === null || record === undefined)
    return ["NO_OWNER_APPROVED_CANARY"];
  if (typeof record !== "object" || Array.isArray(record))
    return ["RECORD_SHAPE"];
  const proto = Object.getPrototypeOf(record) as unknown;
  if (proto !== Object.prototype && proto !== null) return ["RECORD_SHAPE"];
  const r = record as Record<string, unknown>;
  const keys = Object.keys(r);
  if (
    keys.length !== RECORD_KEYS.length ||
    RECORD_KEYS.some((k) => !Object.prototype.hasOwnProperty.call(r, k))
  )
    return ["RECORD_SHAPE"];
  const B = CANARY_APPROVAL_BOUNDS;
  const out: string[] = [];
  if (r.version !== CANARY_APPROVAL_VERSION) out.push("VERSION_MISMATCH");
  if (typeof r.approvalId !== "string" || !ID.test(r.approvalId))
    out.push("APPROVAL_ID_INVALID");
  else if (REVOKED_CANARY_APPROVALS.includes(r.approvalId))
    out.push("APPROVAL_REVOKED");
  if (r.scope !== B.scope) out.push("SCOPE_MISMATCH");
  if (r.pinSet !== B.pinSet) out.push("PIN_SET_MISMATCH");
  if (
    typeof r.account !== "string" ||
    !ADDRESS.test(r.account) ||
    ZERO_ADDRESS.test(r.account)
  )
    out.push("ACCOUNT_INVALID");
  if (
    r.sourceChainId !== B.sourceChainId ||
    r.destinationChainId !== B.destinationChainId
  )
    out.push("CHAIN_MISMATCH");
  if (!same(r.token, B.token) || !same(r.destinationToken, B.destinationToken))
    out.push("TOKEN_MISMATCH");
  if (!same(r.target, B.target)) out.push("TARGET_MISMATCH");
  if (!same(r.spender, B.spender)) out.push("SPENDER_MISMATCH");
  if (!same(r.selector, B.selector)) out.push("SELECTOR_MISMATCH");
  const max = decimal(r.maxAmount),
    exact = decimal(r.exactAmount),
    min = decimal(r.minimumOut),
    budget = decimal(r.nativeGasBudgetWei);
  if (
    max === null ||
    exact === null ||
    max > BigInt(B.maxAmount) ||
    exact < BigInt(B.minAmount) ||
    exact > max
  )
    out.push("AMOUNT_POLICY_INVALID");
  // The owner's minimum is an absolute number for the exact amount: present, positive and never above what is sent.
  if (min === null || min <= 0n || (exact !== null && min > exact))
    out.push("MINIMUM_OUT_INVALID");
  if (budget === null || budget <= 0n) out.push("GAS_BUDGET_INVALID");
  if (
    !Number.isSafeInteger(r.notBefore) ||
    !Number.isSafeInteger(r.notAfter) ||
    (r.notBefore as number) <= 0 ||
    (r.notAfter as number) <= (r.notBefore as number) ||
    (r.notAfter as number) - (r.notBefore as number) > B.maxValidityMs
  )
    out.push("VALIDITY_INVALID");
  if (r.singleUse !== true) out.push("SINGLE_USE_REQUIRED");
  if (r.allowanceCleanup !== "SEPARATE_OWNER_APPROVAL")
    out.push("ALLOWANCE_CLEANUP_POLICY_INVALID");
  return out;
}

export type CanaryAction = "APPROVE" | "SEND";
export interface CanaryGasStep {
  action: CanaryAction;
  /** Decimal gas limit and fee cap (wei) the wallet request itself carries for this step. */
  gasLimit: string;
  maxFeePerGas: string;
}
/**
 * The facts of ONE concrete wallet step, as the server proved them. Every field is required; `null` means "not
 * proven" and denies. Nothing here is a claim a request may make about itself: the wiring step must fill these from
 * the decoded calldata, the two-operator reads and the durable use store.
 */
export interface CanaryApprovalFacts {
  now: number;
  action: CanaryAction;
  /** The connected wallet's live account and chain (decimal chain id). */
  account: string | null;
  chainId: string | null;
  /** Pin set the CURRENT pin evidence was checked against, and whether every pin matched at two operators. */
  pinSet: string | null;
  pinsVerified: boolean | null;
  token: string | null;
  spender: string | null;
  /** Contract the step calls and its 4-byte selector. */
  target: string | null;
  selector: string | null;
  /** Raw units this step approves (APPROVE) or sends (SEND). */
  amount: string | null;
  /** Effective destination output of the reviewed call, recomputed from its calldata (raw units). */
  expectedOut: string | null;
  gas: {
    /** Every wallet step still to be signed under this record (APPROVE if needed, then SEND). */
    remaining: readonly CanaryGasStep[];
    /** Native wei earlier steps of this canary already cost (0 when none was mined). */
    spentWei: string;
    /** OP-stack L1 data fee estimate (wei) of the remaining steps. */
    l1FeeWei: string;
  } | null;
  /** Single-use state from a DURABLE store. Without one (null / not durable / unknown) nothing is allowed. */
  use: {
    durable: boolean;
    approveConsumed: boolean | null;
    sendConsumed: boolean | null;
  } | null;
}
export interface CanaryApprovalDecision {
  status: "DISARMED" | "DENIED" | "VALID";
  reasons: string[];
}

/**
 * Whether `record` covers exactly this step. VALID only when the record is well formed, in its validity window, and
 * every fact is present and equal to it. Pure: reads no clock, environment, request or storage.
 */
export function evaluateCanaryApproval(
  record: unknown,
  facts: CanaryApprovalFacts,
): CanaryApprovalDecision {
  if (record === null || record === undefined)
    return { status: "DISARMED", reasons: ["NO_OWNER_APPROVED_CANARY"] };
  const structural = approvalRecordProblems(record);
  if (structural.length) return { status: "DENIED", reasons: structural };
  const r = record as OwnerCanaryApproval;
  const B = CANARY_APPROVAL_BOUNDS;
  const reasons: string[] = [];
  const f = facts as Partial<CanaryApprovalFacts> | null | undefined;
  if (!f || typeof f !== "object")
    return { status: "DENIED", reasons: ["FACTS_MISSING"] };
  if (typeof f.now !== "number" || !Number.isFinite(f.now))
    reasons.push("CLOCK_UNKNOWN");
  else if (f.now < r.notBefore) reasons.push("APPROVAL_NOT_YET_VALID");
  else if (f.now >= r.notAfter) reasons.push("APPROVAL_EXPIRED");
  if (f.action !== "APPROVE" && f.action !== "SEND")
    reasons.push("ACTION_UNKNOWN");
  if (!same(f.account, r.account)) reasons.push("ACCOUNT_MISMATCH");
  if (f.chainId !== r.sourceChainId) reasons.push("WRONG_CHAIN");
  if (f.pinSet !== r.pinSet || f.pinsVerified !== true)
    reasons.push("PINS_NOT_VERIFIED");
  if (!same(f.token, r.token)) reasons.push("TOKEN_MISMATCH");
  if (!same(f.spender, r.spender)) reasons.push("SPENDER_MISMATCH");
  // APPROVE calls the token (approve(spender, exactAmount)); SEND calls the pinned Diamond entry point. Nothing else.
  const wantTarget = f.action === "APPROVE" ? r.token : r.target;
  const wantSelector = f.action === "APPROVE" ? B.approveSelector : r.selector;
  if (!same(f.target, wantTarget)) reasons.push("TARGET_MISMATCH");
  if (!same(f.selector, wantSelector)) reasons.push("SELECTOR_MISMATCH");
  const amount = decimal(f.amount);
  if (amount === null || amount !== BigInt(r.exactAmount))
    reasons.push("AMOUNT_NOT_EXACT");
  const out = decimal(f.expectedOut);
  if (out === null) reasons.push("OUTPUT_UNKNOWN");
  else if (out < BigInt(r.minimumOut))
    reasons.push("OUTPUT_BELOW_OWNER_MINIMUM");
  else if (out > BigInt(r.exactAmount)) reasons.push("OUTPUT_ABOVE_INPUT");
  // Native gas budget (wei): what was spent + every remaining step at its own fee cap + the L1 data fee estimate.
  const g = f.gas;
  if (!g || typeof g !== "object" || !Array.isArray(g.remaining))
    reasons.push("GAS_BUDGET_UNPROVEN");
  else {
    const spent = decimal(g.spentWei),
      l1 = decimal(g.l1FeeWei);
    const steps = g.remaining as readonly Partial<CanaryGasStep>[];
    const actions = steps.map((s) => s?.action);
    const expected = f.action === "APPROVE" ? ["APPROVE", "SEND"] : ["SEND"];
    let total = spent !== null && l1 !== null ? spent + l1 : null;
    let shape =
      actions.length === expected.length &&
      actions.every((a, i) => a === expected[i]);
    for (const s of steps) {
      const limit = decimal(s?.gasLimit),
        cap = decimal(s?.maxFeePerGas);
      if (
        limit === null ||
        cap === null ||
        limit <= 0n ||
        cap <= 0n ||
        limit > BigInt(B.maxGasLimit)
      ) {
        shape = false;
        break;
      }
      if (total !== null) total += limit * cap;
    }
    if (!shape || total === null) reasons.push("GAS_BUDGET_UNPROVEN");
    else if (total > BigInt(r.nativeGasBudgetWei))
      reasons.push("GAS_BUDGET_EXCEEDED");
  }
  const u = f.use;
  if (!u || typeof u !== "object" || u.durable !== true)
    reasons.push("USE_STORE_UNPROVEN");
  else {
    if (u.sendConsumed !== false)
      reasons.push(
        u.sendConsumed === true ? "CANARY_ALREADY_SENT" : "USE_STATE_UNKNOWN",
      );
    if (f.action === "APPROVE" && u.approveConsumed !== false)
      reasons.push(
        u.approveConsumed === true
          ? "APPROVAL_ALREADY_USED"
          : "USE_STATE_UNKNOWN",
      );
    if (f.action === "SEND" && typeof u.approveConsumed !== "boolean")
      reasons.push("USE_STATE_UNKNOWN");
  }
  const unique = [...new Set(reasons)];
  return unique.length
    ? { status: "DENIED", reasons: unique }
    : { status: "VALID", reasons: [] };
}

const HEX_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;
const word = (hex: string) => hex.toLowerCase().padStart(64, "0");
/** approve(spender, amount) calldata, built here (no codec dependency): selector + two 32-byte words. */
export function exactApproveCalldata(spender: string, amount: bigint): string {
  return (
    CANARY_APPROVAL_BOUNDS.approveSelector +
    word(spender.slice(2)) +
    word(amount.toString(16))
  );
}
/** What the pinned entry point's calldata says it does, read without a codec dependency. */
export interface CanarySendFacts {
  /** BridgeData.receiver and AcrossV4Data.receiverAddress / refundAddress (lower case). */
  receiver: string;
  acrossReceiver: string;
  refund: string;
  /** BridgeData.sendingAssetId, the single source step's tokens, AcrossV4Data input / output tokens (lower case). */
  sendingAsset: string;
  stepSendingAsset: string;
  stepReceivingAsset: string;
  acrossInputToken: string;
  acrossOutputToken: string;
  destinationChainId: string;
  hasDestinationCall: boolean;
  /** Amount the single source step pulls from the sender, and the amount bridged after it (raw units). */
  inputAmount: string;
  bridgedAmount: string;
  /** AcrossV4Data.outputAmountMultiplier (1e18 = 1:1). */
  multiplier: string;
  /** What the facet deposits for the destination: bridgedAmount x outputAmountMultiplier / 1e18. */
  effectiveOutput: string;
  messageLength: string;
  /** The single source step's call: target, approval target and the first four bytes of its calldata. */
  stepCallTo: string;
  stepApproveTo: string;
  stepSelector: string;
}
const WORD = 64;
const MULTIPLIER_BASE = 10n ** 18n;
/**
 * Reads swapAndStartBridgeTokensViaAcrossV4(BridgeData, SwapData[], AcrossV4Data) calldata by following the ABI
 * offsets exactly as the contract's decoder does (offsets relative to the enclosing tuple / array body), so the
 * values read here are the values the contract will see even for a non-canonical encoding. Returns null when the
 * data is not this call, an offset is not word-aligned or points outside the data, an address word has high bits
 * set, or there is not exactly one source step. It reads; it accepts nothing by itself.
 *   BridgeData   (bytes32 transactionId, string bridge, string integrator, address referrer, address sendingAssetId,
 *                 address receiver, uint256 minAmount, uint256 destinationChainId, bool hasSourceSwaps,
 *                 bool hasDestinationCall)
 *   SwapData[]   (address callTo, address approveTo, address sendingAssetId, address receivingAssetId,
 *                 uint256 fromAmount, bytes callData, bool requiresDeposit)
 *   AcrossV4Data (bytes32 receiverAddress, bytes32 refundAddress, bytes32 sendingAssetId, bytes32 receivingAssetId,
 *                 uint256 outputAmount, uint128 outputAmountMultiplier, bytes32 exclusiveRelayer,
 *                 uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityParameter, bytes message)
 */
export function readCanarySendCalldata(data: unknown): CanarySendFacts | null {
  if (
    typeof data !== "string" ||
    !/^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})+$/.test(data) ||
    data.slice(0, 10).toLowerCase() !== CANARY_APPROVAL_BOUNDS.selector
  )
    return null;
  const args = data.slice(10).toLowerCase();
  const size = args.length / 2;
  /** The 32-byte word at byte offset `at` of the arguments, or null when it is not inside them. */
  const word32 = (at: bigint): string | null =>
    at >= 0n && at % 32n === 0n && at + 32n <= BigInt(size)
      ? args.slice(Number(at) * 2, Number(at) * 2 + WORD)
      : null;
  const uint = (at: bigint): bigint | null => {
    const w = word32(at);
    return w === null ? null : BigInt("0x" + w);
  };
  const address = (at: bigint): string | null => {
    const w = word32(at);
    return w === null || !/^0{24}/.test(w) ? null : "0x" + w.slice(24);
  };
  const bool = (at: bigint): boolean | null => {
    const v = uint(at);
    return v === 0n ? false : v === 1n ? true : null;
  };
  const bd = uint(0n),
    sd = uint(32n),
    ad = uint(64n);
  if (bd === null || sd === null || ad === null) return null;
  const sendingAsset = address(bd + 128n),
    receiver = address(bd + 160n),
    bridgedAmount = uint(bd + 192n),
    destinationChainId = uint(bd + 224n),
    hasDestinationCall = bool(bd + 288n);
  // Exactly one source step; its tuple is found through the element offset (relative to the array body).
  const steps = uint(sd);
  const stepOffset = uint(sd + 32n);
  if (steps !== 1n || stepOffset === null) return null;
  const step = sd + 32n + stepOffset;
  const stepCallTo = address(step),
    stepApproveTo = address(step + 32n),
    stepSendingAsset = address(step + 64n),
    stepReceivingAsset = address(step + 96n),
    inputAmount = uint(step + 128n),
    stepDataOffset = uint(step + 160n);
  // The step's calldata (bytes): length word, then the bytes; the selector is its first four bytes.
  const stepData = stepDataOffset === null ? null : step + stepDataOffset;
  const stepDataLength = stepData === null ? null : uint(stepData);
  const stepDataHead = stepData === null ? null : word32(stepData + 32n);
  const stepSelector =
    stepDataLength !== null && stepDataLength >= 4n && stepDataHead !== null
      ? "0x" + stepDataHead.slice(0, 8)
      : null;
  const acrossReceiver = address(ad),
    refund = address(ad + 32n),
    acrossInputToken = address(ad + 64n),
    acrossOutputToken = address(ad + 96n),
    multiplier = uint(ad + 160n),
    messageOffset = uint(ad + 320n);
  const messageLength =
    messageOffset === null ? null : uint(ad + messageOffset);
  if (
    sendingAsset === null ||
    receiver === null ||
    bridgedAmount === null ||
    destinationChainId === null ||
    hasDestinationCall === null ||
    stepSendingAsset === null ||
    stepReceivingAsset === null ||
    inputAmount === null ||
    acrossReceiver === null ||
    refund === null ||
    acrossInputToken === null ||
    acrossOutputToken === null ||
    multiplier === null ||
    multiplier >= 1n << 128n ||
    messageLength === null ||
    stepCallTo === null ||
    stepApproveTo === null ||
    stepSelector === null
  )
    return null;
  return {
    receiver,
    acrossReceiver,
    refund,
    sendingAsset,
    stepSendingAsset,
    stepReceivingAsset,
    acrossInputToken,
    acrossOutputToken,
    destinationChainId: destinationChainId.toString(),
    hasDestinationCall,
    inputAmount: inputAmount.toString(),
    bridgedAmount: bridgedAmount.toString(),
    effectiveOutput: (
      (bridgedAmount * multiplier) /
      MULTIPLIER_BASE
    ).toString(),
    messageLength: messageLength.toString(),
    multiplier: multiplier.toString(),
    stepCallTo,
    stepApproveTo,
    stepSelector,
  };
}
/** Why the pinned-selector calldata is not the record's one transfer, or null (record must be well formed). */
export function canarySendCalldataProblem(
  record: OwnerCanaryApproval,
  data: unknown,
): string | null {
  const f = readCanarySendCalldata(data);
  if (!f) return "SEND_CALLDATA_UNREADABLE";
  if (
    !same(f.receiver, record.account) ||
    !same(f.acrossReceiver, record.account)
  )
    return "SEND_RECEIVER_NOT_OWNER";
  if (!same(f.refund, record.account)) return "SEND_REFUND_NOT_OWNER";
  if (
    !same(f.sendingAsset, record.token) ||
    !same(f.stepSendingAsset, record.token) ||
    !same(f.stepReceivingAsset, record.token) ||
    !same(f.acrossInputToken, record.token) ||
    !same(f.acrossOutputToken, record.destinationToken)
  )
    return "SEND_TOKEN_MISMATCH";
  if (f.destinationChainId !== record.destinationChainId)
    return "SEND_DESTINATION_MISMATCH";
  if (f.hasDestinationCall || f.messageLength !== "0")
    return "SEND_DESTINATION_CALL";
  if (f.inputAmount !== record.exactAmount) return "SEND_AMOUNT_NOT_EXACT";
  // The single source step may only be the pinned fee collection (review 2 G1): no other contract is called with
  // the owner's tokens before they are bridged.
  const B = CANARY_APPROVAL_BOUNDS;
  if (
    !same(f.stepCallTo, B.feeCollector) ||
    !same(f.stepApproveTo, B.feeCollector) ||
    f.stepSelector !== B.feeCollectorSelector
  )
    return "SEND_STEP_NOT_PINNED_FEE";
  if (BigInt(f.bridgedAmount) > BigInt(record.exactAmount))
    return "SEND_BRIDGED_ABOVE_INPUT";
  // What is actually bridged can never be less than the owner's minimum, and USDC -> USDC is never delivered above
  // 1:1 (review 2 G1): together these cap whatever the source step keeps at exactAmount - minimumOut, the cost the
  // owner already accepted — a large "multiplier" cannot dress up a small bridged amount.
  if (BigInt(f.bridgedAmount) < BigInt(record.minimumOut))
    return "SEND_BRIDGED_BELOW_OWNER_MINIMUM";
  if (BigInt(f.multiplier) <= 0n || BigInt(f.multiplier) > MULTIPLIER_BASE)
    return "SEND_MULTIPLIER_OUT_OF_BOUNDS";
  if (BigInt(f.effectiveOutput) < BigInt(record.minimumOut))
    return "SEND_OUTPUT_BELOW_OWNER_MINIMUM";
  if (BigInt(f.effectiveOutput) > BigInt(record.exactAmount))
    return "SEND_OUTPUT_ABOVE_INPUT";
  return null;
}
/**
 * The wallet-side guard of the single financial primitive for the gate "veined-owner-canary": why this exact wallet
 * request is NOT one of the two requests the record covers, or null. The request must be on Base, from the record's
 * account, with no native value and explicit gas / fee caps that fit the budget, and be either
 * approve(spender, exactAmount) on the token or a call of the pinned selector on the pinned target.
 * The pinned-selector call is not accepted by shape: its own arguments are read from the calldata the way the
 * contract's ABI decoder reads them (canarySendCalldataProblem) and must name the record's account as receiver and
 * refund address, the record's token and exact amount, Arbitrum and the destination USDC, no destination call or
 * message, and an effective output at or above the owner's minimum. A gate name with a page-built transaction is
 * therefore not enough. Also bound here: the single source step is the pinned fee collection, the bridged amount
 * is at least the owner's minimum and the multiplier is at most 1:1. Left to the server review (they affect
 * liveness or the exact fee, not where the funds can go beyond the accepted cost): the fee recipient and amount
 * inside the fee call, deadlines, exclusivity, referrer and the canonical encoding.
 */
export function canaryWalletRequestProblem(
  record: unknown,
  request: Readonly<Record<string, string | undefined>>,
  now: number,
): string | null {
  const structural = approvalRecordProblems(record);
  if (structural.length) return structural[0];
  const r = record as OwnerCanaryApproval;
  if (!Number.isFinite(now) || now < r.notBefore)
    return "APPROVAL_NOT_YET_VALID";
  if (now >= r.notAfter) return "APPROVAL_EXPIRED";
  const B = CANARY_APPROVAL_BOUNDS;
  const q = (v: string | undefined) =>
    typeof v === "string" && HEX_QUANTITY.test(v) ? BigInt(v) : null;
  if (q(request.chainId) !== BigInt(r.sourceChainId)) return "WRONG_CHAIN";
  if (!same(request.from, r.account)) return "ACCOUNT_MISMATCH";
  if (q(request.value) !== 0n) return "NATIVE_VALUE_NOT_ZERO";
  const data =
    typeof request.data === "string" ? request.data.toLowerCase() : "";
  const approve = exactApproveCalldata(r.spender, BigInt(r.exactAmount));
  const isApprove = same(request.to, r.token) && data === approve;
  const isSend =
    same(request.to, r.target) &&
    data.startsWith(r.selector.toLowerCase()) &&
    data.length > 10 &&
    (data.length - 10) % 64 === 0;
  if (!isApprove && !isSend) return "REQUEST_NOT_IN_CANARY_SCOPE";
  if (isSend) {
    const problem = canarySendCalldataProblem(r, data);
    if (problem) return problem;
  }
  const gas = q(request.gas),
    cap = q(request.maxFeePerGas),
    tip = q(request.maxPriorityFeePerGas);
  if (gas === null || cap === null || tip === null)
    return "GAS_FIELDS_REQUIRED";
  if (gas <= 0n || cap <= 0n || tip > cap || gas > BigInt(B.maxGasLimit))
    return "GAS_FIELDS_OUT_OF_BOUNDS";
  if (gas * cap > BigInt(r.nativeGasBudgetWei)) return "GAS_BUDGET_EXCEEDED";
  return null;
}

/**
 * G14 closure (PP1-AUDIT-01) — what ONE prepared wallet step carries to the last instant before the wallet request.
 * Every field is the SERVER's prepared evidence for that step (never a lifetime the page chooses): the owner record it
 * belongs to, the server's record / review / action / attempt of the step, the digest the server fixed over them and
 * the exact transaction, when the server authorization of the step ends, when the reviewed quote (the prepared plan)
 * ends, and the owner's own trusted gesture for THIS step. Missing, malformed or unknown = refused.
 */
export interface CanaryDispatchLimits {
  approvalId: string;
  action: CanaryAction;
  /** The server's record id, review digest, attempt id and prepared digest of this step. */
  record: string;
  review: string;
  attempt: string;
  preparedDigest: string;
  /** Milliseconds since the epoch. The step is dead AT these instants (now >= limit is refused). */
  authorizationExpiresAt: number;
  quoteExpiresAt: number;
  /** The browser's event.isTrusted and its time for this step's own click / key press. */
  gesture: { trusted: boolean; at: number };
}
const DISPATCH_KEYS = Object.freeze([
  "approvalId",
  "action",
  "record",
  "review",
  "attempt",
  "preparedDigest",
  "authorizationExpiresAt",
  "quoteExpiresAt",
  "gesture",
] as const);
const DIGEST64 = /^[0-9a-f]{64}$/;
const ATTEMPT = /^[0-9a-f]{32}$/;
const RECORD_NAME = /^[A-Za-z0-9._-]{1,80}$/;
/**
 * The LAST check before the single financial wallet request of the canary. Pure and synchronous: the caller runs it
 * after its last await and calls the wallet in the same synchronous step. `now` is the caller's current time, already
 * guarded against a clock that was set back (the adapter never lets it fall below what it has seen). Returns why the
 * request must NOT leave, or null. In order: the owner record still covers the exact request NOW (window, account,
 * chain, shape, calldata, gas); the limits are complete and well formed; they name this record's approval and the
 * request's own action; the server authorization, the reviewed quote and the owner's gesture are all still alive.
 * The boundaries are exact: at `authorizationExpiresAt`, `quoteExpiresAt` or the record's `notAfter` the step is
 * already dead; a gesture is alive up to and including `gestureMaxAgeMs` after it was made, and never before it.
 */
export function canaryDispatchProblem(
  record: unknown,
  request: Readonly<Record<string, string | undefined>>,
  limits: unknown,
  now: number,
): string | null {
  const covered = canaryWalletRequestProblem(record, request, now);
  if (covered) return covered;
  const r = record as OwnerCanaryApproval;
  if (!limits || typeof limits !== "object" || Array.isArray(limits))
    return "DISPATCH_LIMITS_MISSING";
  const proto = Object.getPrototypeOf(limits) as unknown;
  if (proto !== Object.prototype && proto !== null)
    return "DISPATCH_LIMITS_MISSING";
  const l = limits as Record<string, unknown>;
  if (
    Object.keys(l).length !== DISPATCH_KEYS.length ||
    DISPATCH_KEYS.some((k) => !Object.prototype.hasOwnProperty.call(l, k))
  )
    return "DISPATCH_LIMITS_MISSING";
  const g = l.gesture as { trusted?: unknown; at?: unknown } | null;
  if (
    (l.action !== "APPROVE" && l.action !== "SEND") ||
    typeof l.record !== "string" ||
    !RECORD_NAME.test(l.record) ||
    typeof l.review !== "string" ||
    !DIGEST64.test(l.review) ||
    typeof l.attempt !== "string" ||
    !ATTEMPT.test(l.attempt) ||
    typeof l.preparedDigest !== "string" ||
    !DIGEST64.test(l.preparedDigest) ||
    !Number.isSafeInteger(l.authorizationExpiresAt) ||
    !Number.isSafeInteger(l.quoteExpiresAt) ||
    !g ||
    typeof g !== "object"
  )
    return "DISPATCH_LIMITS_MALFORMED";
  if (l.approvalId !== r.approvalId) return "DISPATCH_APPROVAL_MISMATCH";
  // The action the server prepared must be the action the request itself is (APPROVE calls the token).
  const toToken = same(request.to, r.token);
  if ((l.action === "APPROVE") !== toToken) return "DISPATCH_ACTION_MISMATCH";
  if (now >= (l.authorizationExpiresAt as number))
    return "AUTHORIZATION_EXPIRED";
  if (now >= (l.quoteExpiresAt as number)) return "QUOTE_EXPIRED";
  if (
    (l.authorizationExpiresAt as number) - now >
      CANARY_APPROVAL_BOUNDS.dispatchHorizonMs ||
    (l.quoteExpiresAt as number) - now >
      CANARY_APPROVAL_BOUNDS.dispatchHorizonMs
  )
    return "DISPATCH_LIMITS_UNBOUNDED";
  if (
    g.trusted !== true ||
    typeof g.at !== "number" ||
    !Number.isFinite(g.at) ||
    now < g.at ||
    now - g.at > CANARY_APPROVAL_BOUNDS.gestureMaxAgeMs
  )
    return "OWNER_GESTURE_REQUIRED";
  return null;
}
/**
 * G14 follow-up F2: the exact shape of ONE server preparation (what the server's canary runtime prepared for one wallet
 * step), as a frozen prototype-less copy with exactly its own nine fields and the exact eight-field transaction — or
 * null. Pure and synchronous; shared by the submission boundary and the wallet adapter so both read the server's
 * answer the same way. It proves only the SHAPE: where the object came from is decided by the caller of this check.
 */
export interface CanaryPreparationShape {
  action: CanaryAction;
  record: string;
  review: string;
  transaction: Readonly<Record<(typeof PREPARED_TX_FIELDS)[number], string>>;
  expiresAt: number;
  approvalId: string;
  attempt: string;
  quoteExpiresAt: number;
  digest: string;
}
const PREPARED_TX_FIELDS = Object.freeze([
  "chainId",
  "from",
  "to",
  "value",
  "data",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const);
const PREPARATION_FIELDS = Object.freeze([
  "action",
  "record",
  "review",
  "transaction",
  "expiresAt",
  "approvalId",
  "attempt",
  "quoteExpiresAt",
  "digest",
] as const);
const plainObject = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v) as object | null);
export function canaryExactTransaction(
  value: unknown,
): CanaryPreparationShape["transaction"] | null {
  if (!plainObject(value)) return null;
  const keys = Object.keys(value);
  if (
    keys.length !== PREPARED_TX_FIELDS.length ||
    PREPARED_TX_FIELDS.some(
      (k) =>
        !Object.prototype.hasOwnProperty.call(value, k) ||
        typeof value[k] !== "string",
    )
  )
    return null;
  const copy = Object.create(null) as Record<string, string>;
  for (const k of PREPARED_TX_FIELDS) copy[k] = value[k] as string;
  return Object.freeze(copy) as CanaryPreparationShape["transaction"];
}
export function canaryExactPreparation(
  value: unknown,
): Readonly<CanaryPreparationShape> | null {
  if (!plainObject(value)) return null;
  const transaction = canaryExactTransaction(value.transaction);
  if (
    Object.keys(value).length !== PREPARATION_FIELDS.length ||
    PREPARATION_FIELDS.some(
      (k) => !Object.prototype.hasOwnProperty.call(value, k),
    ) ||
    !transaction ||
    (value.action !== "APPROVE" && value.action !== "SEND") ||
    typeof value.record !== "string" ||
    !/^[A-Za-z0-9._-]{1,80}$/.test(value.record) ||
    typeof value.review !== "string" ||
    !DIGEST64.test(value.review) ||
    typeof value.approvalId !== "string" ||
    !/^0x[0-9a-f]{64}$/.test(value.approvalId) ||
    typeof value.attempt !== "string" ||
    !ATTEMPT.test(value.attempt) ||
    typeof value.digest !== "string" ||
    !DIGEST64.test(value.digest) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !Number.isSafeInteger(value.quoteExpiresAt)
  )
    return null;
  return Object.freeze({
    action: value.action,
    record: value.record,
    review: value.review,
    transaction,
    expiresAt: value.expiresAt as number,
    approvalId: value.approvalId,
    attempt: value.attempt,
    quoteExpiresAt: value.quoteExpiresAt as number,
    digest: value.digest,
  });
}
/**
 * The fixed-order text that binds one prepared step: owner approval, record, review, action, attempt, both time
 * limits and the exact eight-field wallet request. The server digests it at prepare(); the page and the adapter carry
 * the digest; the server compares it again at confirm and when the request / the hash is recorded. It is an integrity
 * binding between those steps, not a signature (the page cannot verify the server's MAC; stated).
 */
export function canaryPreparedText(p: {
  approvalId: string;
  record: string;
  review: string;
  action: CanaryAction;
  attempt: string;
  authorizationExpiresAt: number;
  quoteExpiresAt: number;
  transaction: Readonly<Record<string, string | undefined>>;
}): string {
  const t = p.transaction;
  const low = (v: string | undefined) =>
    typeof v === "string" ? v.toLowerCase() : null;
  return JSON.stringify([
    "veined.canary.prepared.v1",
    p.approvalId,
    p.record,
    p.review,
    p.action,
    p.attempt,
    p.authorizationExpiresAt,
    p.quoteExpiresAt,
    [
      low(t.chainId),
      low(t.from),
      low(t.to),
      low(t.value),
      low(t.data),
      low(t.gas),
      low(t.maxFeePerGas),
      low(t.maxPriorityFeePerGas),
    ],
  ]);
}

/** Fixed-order text of a record (what a digest or an audit line binds to). Throws on a malformed record. */
export function canaryApprovalCanonical(record: unknown): string {
  if (approvalRecordProblems(record).length)
    throw new RangeError("CANARY_APPROVAL_INVALID");
  const r = record as Record<string, unknown>;
  return JSON.stringify(
    RECORD_KEYS.map((k) =>
      typeof r[k] === "string" && /^0x/.test(r[k] as string)
        ? (r[k] as string).toLowerCase()
        : r[k],
    ),
  );
}
