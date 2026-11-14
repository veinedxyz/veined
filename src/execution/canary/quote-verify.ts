// G14 Track A: verification of a FRESH EXECUTABLE quote for the canary scope, from the provider's own transaction
// request (pure; every value is checked from the calldata, never from the provider's "decoded" or "estimate" fields,
// which only serve as numbers that must AGREE with the calldata). Each check is PASS / FAIL / UNKNOWN; anything not
// PASS blocks. The executable transaction request does not reach this code in the candidate today: the protected
// routing normalizer discards it (proposal B1) — so on the live path these checks read UNKNOWN until B1.
// Round-1 review fixes: only swap-and-start (F1); the Across multiplier must leave a relayer margin and exclusivity
// must be short and EVM-shaped (F4); the minimum is decimal only (F13); the gas limit is bounded (F11).
import { CANARY_PINS } from "./pins";
import { CANARY_SCOPE, scopeProblem } from "./scope";
import { decodeAcrossCall, type AcrossCall } from "./across-decoder";
import { EXECUTION_POLICY } from "../model";

export type CanaryCheckId =
  | "SCOPE"
  | "QUOTE_FRESH"
  | "TARGET"
  | "CALLDATA"
  | "RECIPIENT"
  | "REFUND"
  | "ASSETS"
  | "FEES"
  | "MIN_OUTPUT"
  | "SPENDER"
  | "DEADLINES"
  | "GAS_LIMIT";
export type CanaryStatus = "PASS" | "FAIL" | "UNKNOWN";
export interface CanaryCheck {
  id: string;
  status: CanaryStatus;
  code: string;
}
export interface ExecutableQuote {
  tool: string;
  /** Server receipt time of the quote (ms). */
  quotedAt: number;
  transactionRequest: {
    to: string;
    from: string;
    data: string;
    value: string;
    chainId: number | string;
    gasLimit?: string;
  } | null;
  estimate: {
    approvalAddress: string;
    toAmountMin: string;
    fromAmount: string;
  };
}
export interface QuoteVerification {
  checks: CanaryCheck[];
  call: AcrossCall | null;
  /** Sum of the fee payments decoded from the calldata (raw pay units). */
  feeTotal: bigint | null;
  /** The quote's gas limit when it is well formed and bounded (decimal string), else null. */
  gasLimit: string | null;
  ready: boolean;
}
const lower = (a: unknown) => (typeof a === "string" ? a.toLowerCase() : "");
const DECIMAL = /^(0|[1-9]\d{0,40})$/;
const ZERO = "0x0000000000000000000000000000000000000000";
const ZERO32 = "0x" + "0".repeat(64);
/** Decimal or 0x-hex quantity (the provider sends hex), else null. */
const quantity = (v: unknown): bigint | null => {
  if (typeof v === "string" && DECIMAL.test(v)) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v))
    return BigInt(v);
  return null;
};
const ALL: readonly CanaryCheckId[] = [
  "QUOTE_FRESH",
  "TARGET",
  "CALLDATA",
  "RECIPIENT",
  "REFUND",
  "ASSETS",
  "FEES",
  "MIN_OUTPUT",
  "SPENDER",
  "DEADLINES",
  "GAS_LIMIT",
];

export function verifyCanaryQuote(i: {
  quote: ExecutableQuote | null;
  owner: string;
  amountIn: string;
  /** The minimum the owner accepts on Arbitrum (raw units, decimal), shown in the review. */
  minimumOut: string;
  now: number;
}): QuoteVerification {
  const checks: CanaryCheck[] = [];
  const add = (id: CanaryCheckId, status: CanaryStatus, code: string) =>
    checks.push({ id, status, code });
  const none = (): QuoteVerification => ({
    checks,
    call: null,
    feeTotal: null,
    gasLimit: null,
    ready: false,
  });
  const scope = scopeProblem(i.amountIn, i.owner);
  const minOk = typeof i.minimumOut === "string" && DECIMAL.test(i.minimumOut);
  if (scope || !minOk) {
    add("SCOPE", "FAIL", scope ?? "MINIMUM_INVALID");
    return none();
  }
  add("SCOPE", "PASS", CANARY_SCOPE.id);
  const minOut = BigInt(i.minimumOut);
  const owner = lower(i.owner);
  const amountIn = BigInt(i.amountIn);
  const q = i.quote;
  const tx = q?.transactionRequest ?? null;
  if (!q || !tx) {
    for (const id of ALL) add(id, "UNKNOWN", "NO_EXECUTABLE_REQUEST");
    return none();
  }
  const age = i.now - q.quotedAt;
  add(
    "QUOTE_FRESH",
    !Number.isFinite(age) || age < 0
      ? "FAIL"
      : age <= EXECUTION_POLICY.maxQuoteAgeMs
        ? "PASS"
        : "FAIL",
    !Number.isFinite(age) || age < 0
      ? "QUOTE_TIME_INVALID"
      : age <= EXECUTION_POLICY.maxQuoteAgeMs
        ? "FRESH"
        : "QUOTE_STALE",
  );
  const value = quantity(tx.value ?? "0x0");
  const targetOk =
    lower(tx.to) === lower(CANARY_PINS.diamond.address) &&
    String(tx.chainId) === CANARY_SCOPE.sourceChainId &&
    value === 0n &&
    lower(tx.from) === owner &&
    q.tool === CANARY_SCOPE.tool;
  add(
    "TARGET",
    targetOk ? "PASS" : "FAIL",
    targetOk ? "PINNED_DIAMOND" : "TARGET_MISMATCH",
  );
  const call = decodeAcrossCall(tx.data);
  if (!call) {
    add("CALLDATA", "FAIL", "NOT_PINNED_CANONICAL_ACROSS_CALL");
    for (const id of ALL.slice(3)) add(id, "UNKNOWN", "CALLDATA_NOT_DECODED");
    return none();
  }
  const callOk =
    call.path === "swapAndStart" &&
    call.bridge === CANARY_SCOPE.tool &&
    call.referrer === ZERO &&
    !call.across.nonEvmAddress;
  add(
    "CALLDATA",
    callOk ? "PASS" : "FAIL",
    callOk ? call.path : "UNEXPECTED_BRIDGE_REFERRER_OR_ADDRESS_SHAPE",
  );
  // The facet enforces BridgeData.receiver == Across receiver only without a destination call; both are required here.
  const recipientOk =
    call.receiver === owner &&
    call.across.receiver === owner &&
    call.hasDestinationCall === false &&
    call.across.message === "0x";
  add(
    "RECIPIENT",
    recipientOk ? "PASS" : "FAIL",
    recipientOk ? "OWNER" : "RECIPIENT_NOT_OWNER_OR_DESTINATION_CALL",
  );
  add(
    "REFUND",
    call.across.refund === owner ? "PASS" : "FAIL",
    call.across.refund === owner ? "OWNER" : "REFUND_NOT_OWNER",
  );
  const usdcBase = lower(CANARY_PINS.usdc["8453"].address);
  const usdcArb = lower(CANARY_PINS.usdc["42161"].address);
  const assetsOk =
    call.sendingAssetId === usdcBase &&
    call.across.inputToken === usdcBase &&
    call.across.outputToken === usdcArb &&
    call.destinationChainId === CANARY_SCOPE.destinationChainId;
  add(
    "ASSETS",
    assetsOk ? "PASS" : "FAIL",
    assetsOk ? "USDC_BASE_TO_USDC_ARBITRUM" : "ASSET_OR_CHAIN_MISMATCH",
  );
  // Source steps: exactly one pinned fee collection, in the sent token, pulling exactly the amount sent.
  let feeTotal: bigint | null = 0n;
  let feeCode = "PINNED_FEE_ONLY";
  if (call.steps.length !== 1) feeCode = "UNEXPECTED_SOURCE_STEPS";
  for (const s of call.steps) {
    if (feeCode !== "PINNED_FEE_ONLY") break;
    if (
      !s.fees ||
      s.token !== usdcBase ||
      s.receivingToken !== usdcBase ||
      s.fromAmount !== amountIn
    ) {
      feeCode = "SOURCE_STEP_NOT_FEE";
      break;
    }
    for (const f of s.fees) {
      if (!CANARY_PINS.feeCollector.recipients.includes(f.recipient)) {
        feeCode = "UNEXPECTED_FEE_RECIPIENT";
        break;
      }
      feeTotal += f.amount;
    }
  }
  if (
    feeCode === "PINNED_FEE_ONLY" &&
    call.bridgedAmount !== amountIn - feeTotal
  )
    feeCode = "BRIDGED_AMOUNT_MISMATCH";
  const cost = amountIn - call.effectiveOutput;
  if (
    feeCode === "PINNED_FEE_ONLY" &&
    (cost <= 0n || cost * 10_000n > amountIn * BigInt(CANARY_SCOPE.maxCostBps))
  )
    feeCode = cost <= 0n ? "NO_COST_UNFILLABLE" : "COST_ABOVE_CANARY_BOUND";
  if (feeCode !== "PINNED_FEE_ONLY") feeTotal = null;
  add("FEES", feeCode === "PINNED_FEE_ONLY" ? "PASS" : "FAIL", feeCode);
  const quotedMin = quantity(q.estimate?.toAmountMin);
  const m = call.across.multiplier;
  // The relayer must keep a margin (a multiplier of 1:1 or more is a deposit no relayer fills, review F4).
  const minOutOk =
    quotedMin !== null &&
    call.effectiveOutput >= minOut &&
    call.effectiveOutput >= quotedMin &&
    m >= CANARY_SCOPE.minMultiplier &&
    m <= CANARY_SCOPE.maxMultiplier &&
    quantity(q.estimate?.fromAmount) === amountIn;
  add(
    "MIN_OUTPUT",
    minOutOk ? "PASS" : "FAIL",
    minOutOk
      ? "EFFECTIVE_OUTPUT_AT_LEAST_MINIMUM"
      : quotedMin === null
        ? "QUOTE_MINIMUM_UNREADABLE"
        : "EFFECTIVE_OUTPUT_BELOW_MINIMUM_OR_MULTIPLIER_OUT_OF_BOUNDS",
  );
  // The spender the owner approves is exactly the pinned Diamond (it pulls the USDC), for exactly the amount.
  const spenderOk =
    lower(q.estimate?.approvalAddress) === lower(CANARY_PINS.diamond.address);
  add(
    "SPENDER",
    spenderOk ? "PASS" : "FAIL",
    spenderOk ? "PINNED_DIAMOND_EXACT_AMOUNT" : "SPENDER_NOT_PINNED",
  );
  const nowSec = Math.floor(i.now / 1000);
  const window = call.across.fillDeadline - call.across.quoteTimestamp;
  // Exclusivity: none (0 and zero relayer) or a short offset to a non-zero EVM relayer (review F4).
  const x = call.across.exclusivityParameter;
  const exclusivityOk =
    (x === 0 && call.across.exclusiveRelayer === ZERO32) ||
    (x > 0 &&
      x <= CANARY_SCOPE.maxExclusivitySec &&
      call.across.exclusiveRelayer !== ZERO32);
  const deadlinesOk =
    Math.abs(nowSec - call.across.quoteTimestamp) <=
      CANARY_SCOPE.maxQuoteClockSkewSec &&
    window >= CANARY_SCOPE.minFillWindowSec &&
    window <= CANARY_SCOPE.maxFillWindowSec &&
    call.across.fillDeadline > nowSec &&
    exclusivityOk;
  add(
    "DEADLINES",
    deadlinesOk ? "PASS" : "FAIL",
    deadlinesOk
      ? "FILL_WINDOW_BOUNDED"
      : exclusivityOk
        ? "DEADLINE_OUT_OF_BOUNDS"
        : "EXCLUSIVITY_OUT_OF_BOUNDS",
  );
  // The gas limit the wallet would sign: well formed and bounded here; at least the simulated need in the engine.
  const gas = quantity(tx.gasLimit);
  const gasOk = gas !== null && gas > 0n && gas <= CANARY_SCOPE.maxGasLimit;
  add(
    "GAS_LIMIT",
    gasOk ? "PASS" : "FAIL",
    gasOk ? "BOUNDED" : "GAS_LIMIT_INVALID_OR_UNBOUNDED",
  );
  return {
    checks,
    call,
    feeTotal,
    gasLimit: gasOk ? gas!.toString() : null,
    ready: checks.every((c) => c.status === "PASS"),
  };
}
