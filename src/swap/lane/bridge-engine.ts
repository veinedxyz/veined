import { existingAllowance } from "./existing-allowance";
// VEINED-MC1 (BRIDGE LANE): the bridge lane ENGINE — review, single-use authorization, dispatch and settlement of the
// ONE pair the protected record names (./bridge-scope.ts BRIDGE_LANE_PAIRS; ENABLED pairs only). Server-side only.
// Every decision is made from server reads (the pair's source chain and destination chain, two operators each, one
// block each) and the pinned values; no client value reaches a transaction except the owner key (checked against its
// digest) and identifiers this engine handed out itself. The bridge calldata itself comes from ONE fresh LI.FI quote
// and is accepted only when it decodes exactly and every field is bound to the pair and the record.
//
//   review(ownerKey)        LI.FI quote (from = to = owner) -> the quote's own facts -> exact decode + bindings ->
//                           source pins on BOTH source operators at one block (Diamond, the facet the Diamond routes the
//                           selector to, FeeCollector, SPOKEPOOL() = pinned SpokePool + implementation, USDC +
//                           implementation) -> destination SpokePool + USDC pins on BOTH destination operators ->
//                           balances, allowance, nonce anchor -> eth_simulateV1 of the REMAINING sequence with the USDC
//                           delta and the allowance after -> fees (the source chain's fee model, as the swap lane;
//                           OP_STACK L1 fee + operator fee 0; ARBITRUM estimate) -> Guardian BridgeFacts -> attestation.
//                           Never ready for a step signer v5 would certainly refuse (a refusal spends the step).
//   authorize(reviewId, k)  a fresh review only; mints ONE HMAC token for this review and step (journaled AUTH).
//   dispatch(token, k)      token check -> the gate on the transaction's own bytes (a closed gate spends nothing) ->
//                           ONE fsynced batch of NONCE + USE + PREPARED -> a single-use dispatch authority -> the signer
//                           adapter ({lane: "BRIDGE", route, step}). SENT / REFUSED / UNCERTAIN is journaled; nothing is
//                           ever resent. Lanes review R2: all of it (and revoke) runs inside the ONE process-wide
//                           dispatch lock shared with the swap lane (./dispatch-lock.ts), with the signer preflight
//                           before the batch and everything single use and the review's freshness re-checked after it.
//   track()                 source receipts on both operators (depth = signer v5 confirmations, block-hash re-check,
//                           the hash bound to PREPARED) -> FundsDeposited of the pinned source SpokePool (depositor =
//                           recipient = owner, the reviewed amounts) -> FilledRelay(originChainId, depositId) of the
//                           pinned destination SpokePool, searched on BOTH destination operators in <= 100-block windows
//                           from the destination head recorded in PREPARED at dispatch (the attested review's destination
//                           block, <= 20 s earlier: a superset of the range; final blocks only, resumable cursor) -> the fill
//                           receipt pays the owner >= the minimum in destination USDC -> SETTLED_VERIFIED (the ONLY
//                           state journaled as settled). Past the fill deadline with no fill: REFUND_PENDING.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  parseAbi,
  serializeTransaction,
  stringToHex,
  type Hex,
} from "viem";
import { knownAsset } from "../../assets/registry";
import { review as guardianReview } from "../../guardian/verdict";
import type { AssetFacts, BridgeFacts } from "../../guardian/model";
import { ReviewAttestor } from "../../execution/server/canary/attestation";
import type { CanaryDurableStore } from "../../execution/server/canary/durable-store";
import {
  BRIDGE_LANE_KEY_DOMAIN,
  bridgeLaneGateState,
  type BridgeLaneStepFacts,
  type OwnerBridgeLaneApproval,
} from "./bridge-approval";
import {
  bridgeApproveCalldata,
  bridgeCallProblems,
  bridgeQuoteProblems,
} from "./bridge-calldata";
import {
  BRIDGE_ACROSS_FACET,
  BRIDGE_LANE_PIN_SET,
  BRIDGE_LANE_SELECTORS,
  BRIDGE_LANE_TOPICS,
  BRIDGE_LIFI_DIAMOND,
  bridgePinProblems,
  bridgePinsOf,
  destinationCodePins,
  sourceCodePins,
  type BridgeChainPins,
} from "./bridge-pins";
import {
  BRIDGE_LANE_PAIRS,
  BRIDGE_LANE_SCOPE,
  bridgeChainById,
  pairById,
  type BridgeLaneChain,
  type BridgeLanePair,
  type BridgeLaneStep,
} from "./bridge-scope";
import {
  mintBridgeDispatchAuthority,
  signerPreflightProblems,
  type LaneSignerResult,
  type LaneSignerStatus,
  type LaneTx,
} from "./signer-adapter";
import { ARBITRUM_NODE_INTERFACE } from "./pins";
import { isQuantity, strictReceiptProblem } from "./receipts";
import { withLaneDispatchLock } from "./dispatch-lock";

export class BridgeLaneError extends Error {
  constructor(
    public code: string,
    public detail: readonly string[] = [],
  ) {
    super(code);
    this.name = "BridgeLaneError";
  }
}
type Both<T> = {
  values: [T | null, T | null];
  agree: boolean;
  errors: string[];
};
/** One chain of the pair (bridgeReadBoth on that chain in production; a fake chain in tests). */
export interface BridgeChainReader {
  both<T = unknown>(
    method: string,
    params: readonly unknown[],
    pick?: (x: unknown) => unknown,
  ): Promise<Both<T>>;
}
export interface BridgeLaneChains {
  source: BridgeChainReader;
  destination: BridgeChainReader;
  /** The ONE LI.FI quote of the record's pair for the record's account (transport-built fixed query). */
  quote(): Promise<unknown>;
}
export interface BridgeLaneSigner {
  send(
    authority: unknown,
    tx: LaneTx,
    step: BridgeLaneStep | "REVOKE",
  ): Promise<LaneSignerResult>;
  /** The signer's own status after a sync (signer v5 CONTRACT-v5.md); a throw = not available. */
  status(): Promise<LaneSignerStatus>;
}
export interface BridgeLaneDeps {
  /** Explicit server composition only; never an environment or client option. */
  reuseExistingAllowance?: boolean;
  store: CanaryDurableStore;
  record: Readonly<OwnerBridgeLaneApproval>;
  keyDigest: string;
  chains: BridgeLaneChains;
  signer: BridgeLaneSigner;
  now?: () => number;
  gate?: typeof bridgeLaneGateState;
}
const ERC20 = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
export const BRIDGE_SETTLEMENT_ABI = parseAbi([
  "event FilledRelay(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 repaymentChainId, uint256 indexed originChainId, uint256 indexed depositId, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 exclusiveRelayer, bytes32 indexed relayer, bytes32 depositor, bytes32 recipient, bytes32 messageHash, (bytes32 updatedRecipient, bytes32 updatedMessageHash, uint256 updatedOutputAmount, uint8 fillType) relayExecutionInfo)",
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);
const ORACLE = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);
const NODE_INTERFACE = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
const firstWord = (x: unknown) =>
  typeof x === "string" && /^0x[0-9a-fA-F]{64,}$/.test(x)
    ? BigInt("0x" + x.slice(2, 66))
    : null;
const LOUPE = parseAbi([
  "function facetAddress(bytes4 selector) view returns (address)",
]);
const word = (a: string | bigint) =>
  typeof a === "bigint"
    ? a.toString(16).padStart(64, "0")
    : a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
const hex = (n: bigint) => "0x" + n.toString(16);
const lower = (a: string) => a.toLowerCase();
const same = (a: unknown, b: string) =>
  typeof a === "string" && a.toLowerCase() === b.toLowerCase();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const big = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v) ? BigInt(v) : null;
const max = (a: bigint, b: bigint) => (a > b ? a : b);
// Dry-review item 8: a read that FAILED on either operator (a transport or RPC error, no answer, or a malformed answer)
// is reported as OPERATOR_READ_FAILED:<what>; the mismatch codes are kept for values BOTH operators did answer. Either
// way the review is not ready.
const readFailed = (
  x: { values: readonly unknown[]; errors: readonly string[] },
  wellFormed: (v: unknown) => boolean,
) => x.errors.length > 0 || !x.values.every((v) => wellFormed(v));
const isHex = (v: unknown) =>
  typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v);
const isQty = (v: unknown) => big(v) !== null;
const isCode = (v: unknown) =>
  typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);
/** signer v5 (policy-v5.mjs: blockAgeSec >= -15): a read block at most this far ahead of the host clock is fresh. */
const BLOCK_FUTURE_TOLERANCE_MS = 15_000;
/** The read block's age against the host clock: null when the block is further ahead than the signer accepts; a block
 * slightly ahead (host clock behind the chain) counts as age 0, never a negative age. */
const blockAgeMs = (now: number, blockTime: number) =>
  blockTime - now > BLOCK_FUTURE_TOLERANCE_MS
    ? null
    : Math.max(0, now - blockTime);
const min = (a: bigint, b: bigint) => (a < b ? a : b);
const b32 = (x: string) => `0x${x.slice(-40)}`.toLowerCase();
const ZERO32 = "0x" + "0".repeat(64);
const codeOf = (e: unknown) =>
  e && typeof e === "object" && "code" in e
    ? String((e as { code: unknown }).code)
    : "FAILED";

export interface BridgeLaneReview {
  /** Existing permission, bound to this attested review; no new approval requested. */
  reusedAllowance?: string;
  reviewId: string;
  route: string;
  sourceChainId: string;
  destinationChainId: string;
  ready: boolean;
  step: BridgeLaneStep | null;
  problems: string[];
  /** The source read block (decimal). */
  block: string;
  blockTime: number;
  /** The destination read block (decimal): the fill search starts here. */
  destinationBlock: string | null;
  readAt: number;
  expiresAt: number;
  amountIn: string;
  minimumOut: string;
  bridged: string | null;
  feeTotal: string | null;
  effectiveOutput: string | null;
  costBps: number | null;
  /** The reviewed bridge calldata (the LI.FI quote's bytes, exactly decoded and bound), or null. */
  data: string | null;
  quote: {
    transactionId: string;
    quoteTimestamp: number;
    fillDeadline: number;
    exclusivityParameter: number;
    gasLimit: string | null;
    quotedMinimum: string | null;
  } | null;
  balances: { usdc: string; allowance: string; native: string };
  simulation: {
    usdcDelta: string;
    allowanceAfter: string;
    gasUsed: Record<string, string>;
  } | null;
  gas: {
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    limits: Record<string, string>;
    l1FeeWei: string;
    spentWei: string;
    worstCaseTotalWei: string;
    budgetWei: string;
  };
  guardian: { level: string; digest: string; findings: string[] } | null;
  pins: { set: string; problems: string[] };
  attestation?: unknown;
}
interface Token {
  id: string;
  reviewId: string;
  step: BridgeLaneStep;
  record: string;
  notAfter: number;
  mac: string;
}
/** The single-use entries of the journal at one moment (lanes review R2 NEW-1: nothing may change during the lock). */
interface JournalMark {
  nonces: number;
  uses: number;
  dispatches: number;
}
type DispatchRecord = { step: string; outcome: string; hash: string | null };
const handedOff = (d: { outcome?: unknown } | undefined) =>
  d?.outcome === "SENT" || d?.outcome === "UNCERTAIN";
interface ChainLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash?: string;
  blockNumber?: string;
  blockHash?: string;
  logIndex?: string;
  removed?: boolean;
}
interface Prepared {
  reusedAllowance?: string;
  step: BridgeLaneStep;
  tx: LaneTx;
  dataKeccak: string;
  minimumOut: string;
  effectiveOutput: string | null;
  bridged: string | null;
  fillDeadline: number | null;
  destinationFromBlock: string | null;
}
interface FillSearch {
  status:
    "FOUND" | "PENDING" | "PAST_DEADLINE" | "DISCREPANCY" | "UNSEARCHABLE";
  detail: string | null;
  /** The last destination block searched on both operators (inclusive), or null. */
  cursor: bigint | null;
  windows: number;
  fill: { hash: string; amount: bigint; log: ChainLog } | null;
}
export interface BridgeDeposit {
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
  sourceBlock: string;
  sourceHash: string;
}

export class BridgeLaneEngine {
  #existingAllowance: bigint | null = null;
  #reusingAllowance() {
    return (
      this.#d.reuseExistingAllowance === true &&
      this.#existingAllowance !== null &&
      this.#existingAllowance >= BigInt(this.#rec.exactAmount) &&
      !this.#used("APPROVE") &&
      !this.#dispatch("APPROVE")
    );
  }
  readonly #d: BridgeLaneDeps;
  readonly #now: () => number;
  readonly #pair: Readonly<BridgeLanePair>;
  readonly #S: Readonly<BridgeLaneChain>;
  readonly #D: Readonly<BridgeLaneChain>;
  readonly #sp: Readonly<BridgeChainPins>;
  readonly #dp: Readonly<BridgeChainPins>;
  readonly #attestor = new ReviewAttestor();
  readonly #tokenKey = randomBytes(32);
  readonly #reviews = new Map<string, BridgeLaneReview>();
  constructor(d: BridgeLaneDeps) {
    // The engine serves exactly the pair its record names, and only an ENABLED pair of two pinned ENABLED chains.
    const pair = pairById(d.record?.route);
    if (!pair || pair.status !== "ENABLED")
      throw new BridgeLaneError("ROUTE_NOT_ENABLED");
    const S = bridgeChainById(pair.source),
      D = bridgeChainById(pair.destination);
    if (!S || !D || S.status !== "ENABLED" || D.status !== "ENABLED")
      throw new BridgeLaneError("ROUTE_NOT_ENABLED");
    const sp = bridgePinsOf(S.chainId),
      dp = bridgePinsOf(D.chainId);
    if (!sp || !dp || sp.chainId !== S.chainId || dp.chainId !== D.chainId)
      throw new BridgeLaneError("PIN_SET_MISSING");
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.#pair = pair;
    this.#S = S;
    this.#D = D;
    this.#sp = sp;
    this.#dp = dp;
  }
  get #rec() {
    return this.#d.record;
  }
  /** The pair this engine serves (frozen table entry). */
  get pair(): Readonly<BridgeLanePair> {
    return this.#pair;
  }
  #useKey(step: BridgeLaneStep | "REVOKE") {
    return `${this.#pair.id}:${lower(this.#rec.account)}:${this.#rec.approvalId}:${step}`;
  }
  #used(step: BridgeLaneStep | "REVOKE") {
    return this.#d.store
      .of("USE")
      .some((e) => (e.data as { key?: string })?.key === this.#useKey(step));
  }
  #last<T>(type: string, step?: BridgeLaneStep | "REVOKE"): T | undefined {
    return this.#d.store
      .of(type)
      .filter(
        (e) =>
          step === undefined || (e.data as { step?: string }).step === step,
      )
      .at(-1)?.data as T | undefined;
  }
  /**
   * The recorded outcome of a step: the last DISPATCH entry of that step — except that a SENT or UNCERTAIN hand-off is
   * never shadowed by a later refusal of the same step (lanes review R2 NEW-1, defence in depth).
   */
  #dispatch(step: BridgeLaneStep | "REVOKE"): DispatchRecord | undefined {
    const all = this.#d.store
      .of("DISPATCH")
      .map((e) => e.data as DispatchRecord)
      .filter((d) => d?.step === step);
    return all.filter(handedOff).at(-1) ?? all.at(-1);
  }
  /** The process-wide dispatch lock's name for this record (./dispatch-lock.ts). */
  get #lockKey() {
    return `BRIDGE:${this.#pair.id}:${lower(this.#rec.account)}:${this.#rec.approvalId}`;
  }
  #mark(): JournalMark {
    const s = this.#d.store;
    return {
      nonces: s.of("NONCE").length,
      uses: s.of("USE").length,
      dispatches: s.of("DISPATCH").length + s.of("DISPATCH_DUPLICATE").length,
    };
  }
  #changedSince(m: JournalMark) {
    const n = this.#mark();
    return (
      n.nonces !== m.nonces ||
      n.uses !== m.uses ||
      n.dispatches !== m.dispatches
    );
  }
  #tokenSpent(id: string) {
    return this.#d.store
      .of("NONCE")
      .some((e) => (e.data as { id?: string }).id === id);
  }
  /**
   * The outcome of ONE hand-off (lanes review R2 NEW-1, defence in depth). A step that already holds a SENT or
   * UNCERTAIN dispatch, or a receipt, keeps it: another hand-off of the same step (the lock and the single-use checks
   * make one impossible) is journaled apart as DISPATCH_DUPLICATE and never becomes the step's outcome. Returns true
   * when the outcome was kept apart.
   */
  #recordDispatch(
    step: BridgeLaneStep | "REVOKE",
    entry: {
      outcome: string;
      hash: string | null;
      code?: string;
      problems: readonly string[];
    },
  ): boolean {
    const kept =
      handedOff(this.#dispatch(step)) || this.#receipt(step) !== undefined;
    this.#d.store.append(kept ? "DISPATCH_DUPLICATE" : "DISPATCH", {
      step,
      ...entry,
    });
    return kept;
  }
  #receipt(step: BridgeLaneStep | "REVOKE") {
    return this.#last<{
      step: string;
      status: string;
      block: string;
      blockHash: string;
      gasUsed: string;
      effectiveGasPrice: string;
      l1Fee: string;
    }>("RECEIPT", step);
  }
  checkKey(ownerKey: unknown) {
    if (typeof ownerKey !== "string" || !/^[0-9a-f]{64}$/.test(ownerKey))
      throw new BridgeLaneError("OWNER_KEY_INVALID");
    const got = Buffer.from(
      createHash("sha256")
        .update(
          Buffer.from(
            stringToHex(`${BRIDGE_LANE_KEY_DOMAIN}:${ownerKey}`).slice(2),
            "hex",
          ),
        )
        .digest("hex"),
    );
    if (!timingSafeEqual(got, Buffer.from(this.#d.keyDigest)))
      throw new BridgeLaneError("OWNER_KEY_MISMATCH");
  }
  /** The next step of the single sequence, or null when both are used. */
  nextStep(): BridgeLaneStep | null {
    if (this.#d.reuseExistingAllowance && this.#used("EXECUTE")) return null;
    if (!this.#used("APPROVE") && !this.#reusingAllowance()) return "APPROVE";
    if (!this.#used("EXECUTE")) return "EXECUTE";
    return null;
  }
  #spentWei(): bigint {
    let s = 0n;
    for (const e of this.#d.store.of("RECEIPT")) {
      const d = e.data as {
        gasUsed: string;
        effectiveGasPrice: string;
        l1Fee: string;
      };
      s += BigInt(d.gasUsed) * BigInt(d.effectiveGasPrice) + BigInt(d.l1Fee);
    }
    return s;
  }
  /** Code hashes (and proxy implementation slots) of `list` at block `B` on both operators of `c`. */
  async #pinsAt(
    c: BridgeChainReader,
    B: string,
    list: readonly { address: string; codehash: string | null }[],
    slots: readonly {
      proxy: string;
      slot: string;
      address: string;
      code: string;
    }[],
    prefix: string,
  ): Promise<{ problems: string[]; agree: boolean }> {
    const out: string[] = [];
    let agree = true;
    for (const p of list) {
      if (p.codehash === null) {
        out.push(`${prefix}PIN_UNVERIFIED:${p.address}`);
        continue;
      }
      const code = await c.both<string>("eth_getCode", [p.address, B], (x) =>
        typeof x === "string" && /^0x([0-9a-fA-F]{2})*$/.test(x)
          ? keccak256(x as Hex)
          : null,
      );
      if (readFailed(code, isCode)) {
        agree = false;
        out.push(`OPERATOR_READ_FAILED:${prefix}CODE:${p.address}`);
        continue;
      }
      if (!code.agree) {
        agree = false;
        out.push(`${prefix}CODE_DISAGREE:${p.address}`);
        continue;
      }
      if (
        typeof code.values[0] !== "string" ||
        !/^0x([0-9a-fA-F]{2})*$/.test(code.values[0]) ||
        keccak256(code.values[0] as Hex) !== p.codehash
      )
        out.push(`${prefix}CODE_CHANGED:${p.address}`);
    }
    for (const s of slots) {
      const v = await c.both<string>("eth_getStorageAt", [s.proxy, s.slot, B]);
      if (!v.agree) agree = false;
      if (readFailed(v, isHex))
        out.push(
          `OPERATOR_READ_FAILED:${prefix}${s.code.replace(/_CHANGED$/, "")}`,
        );
      else if (
        !v.agree ||
        !same("0x" + String(v.values[0]).slice(-40), s.address)
      )
        out.push(`${prefix}${s.code}`);
    }
    return { problems: out, agree };
  }

  // ------------------------------------------------------------------------------------------------ review
  async review(ownerKey: unknown): Promise<BridgeLaneReview> {
    this.checkKey(ownerKey);
    this.#existingAllowance = null;
    if (
      this.#d.reuseExistingAllowance &&
      !this.#used("APPROVE") &&
      !this.#dispatch("APPROVE") &&
      !this.#used("EXECUTE") &&
      !this.#dispatch("EXECUTE")
    )
      this.#existingAllowance = await existingAllowance(
        this.#d.chains.source,
        this.#rec.account,
        this.#S.usdc.address,
        BRIDGE_LIFI_DIAMOND,
      );
    const rec = this.#rec,
      pair = this.#pair,
      S = this.#S,
      D = this.#D,
      sp = this.#sp,
      src = this.#d.chains.source,
      dst = this.#d.chains.destination,
      now = this.#now();
    const nowSec = Math.floor(now / 1000);
    const owner = rec.account,
      amount = BigInt(rec.exactAmount),
      minimumOut = BigInt(rec.minimumOut);
    const U = S.usdc.address,
      DIAMOND = BRIDGE_LIFI_DIAMOND;
    const P: string[] = [];
    let operatorsAgree = true;
    if (now < rec.notBefore) P.push("NOT_YET_VALID");
    if (now >= rec.notAfter) P.push("APPROVAL_EXPIRED");
    const step = this.nextStep();
    if (step === null) P.push("LANE_ALREADY_USED");
    // A step marked used with no dispatch record (a crash between the two) is never reviewed past: the signer journal
    // and the chain must be reconciled read-only first.
    for (const s of ["APPROVE", "EXECUTE"] as const)
      if (this.#used(s) && !this.#dispatch(s))
        P.push(`LANE_RECOVERY_REQUIRED:${s}`);
    if (step === "EXECUTE" && !this.#reusingAllowance()) {
      const a = this.#receipt("APPROVE");
      if (!a) P.push("APPROVAL_NOT_FINAL");
      else if (a.status !== "0x1") P.push("APPROVAL_FAILED");
    }
    // ---- 1-3. the fresh LI.FI quote, the quote itself, the exact calldata and every binding --------------------------
    // (no quote is spent on a lane whose steps are both used: LI.FI's public quota is small)
    let quote: unknown = null;
    if (step !== null)
      try {
        quote = await this.#d.chains.quote();
      } catch (e) {
        P.push(`QUOTE_UNAVAILABLE:${codeOf(e)}`);
      }
    const qv = bridgeQuoteProblems(pair, quote, owner);
    if (quote !== null) P.push(...qv.problems);
    const bind = qv.data
      ? bridgeCallProblems(pair, qv.data, {
          owner,
          exactAmount: amount,
          minimumOut,
          maxCostBps: rec.maxCostBps,
          nowSec,
        })
      : null;
    if (bind) P.push(...bind.problems);
    if (
      bind?.effectiveOutput != null &&
      qv.quotedMinimum !== null &&
      bind.effectiveOutput < qv.quotedMinimum
    )
      P.push("QUOTE_MINIMUM_ABOVE_CALLDATA_OUTPUT");
    const data = bind?.call ? qv.data : null;
    // ---- source: one block both operators have (the lower head minus one), head skew, age, base fee ----------------
    const heads = await src.both<string>("eth_blockNumber", [], () => null);
    if (heads.values.some((h) => big(h) === null))
      throw new BridgeLaneError("HEAD_UNAVAILABLE");
    const hs = heads.values.map((h) => big(h) as bigint);
    if (
      (hs[0] > hs[1] ? hs[0] - hs[1] : hs[1] - hs[0]) >
      BigInt(S.maxHeadSkewBlocks)
    )
      P.push("OPERATOR_HEADS_TOO_FAR_APART");
    const blockN = min(hs[0], hs[1]) - 1n;
    const B = hex(blockN);
    const blk = await src.both<{
      hash: string;
      timestamp: string;
      baseFeePerGas: string;
    }>(
      "eth_getBlockByNumber",
      [B, false],
      (x) =>
        x && {
          h: (x as { hash: string }).hash,
          b: (x as { baseFeePerGas: string }).baseFeePerGas,
          t: (x as { timestamp: string }).timestamp,
        },
    );
    if (!blk.agree || !blk.values[0] || big(blk.values[0].timestamp) === null)
      throw new BridgeLaneError("OPERATORS_DISAGREE", ["BLOCK"]);
    const blockTime = Number(BigInt(blk.values[0].timestamp)) * 1000;
    const age = blockAgeMs(now, blockTime);
    if (age === null) P.push("REVIEW_BLOCK_IN_FUTURE");
    else if (age > S.maxReviewBlockAgeSec * 1000)
      P.push("REVIEW_BLOCK_TOO_OLD");
    const baseFeeRead = big(blk.values[0].baseFeePerGas);
    if (baseFeeRead === null) P.push("BASE_FEE_UNPROVEN");
    const baseFee = baseFeeRead ?? 0n;
    // ---- review NIT-4: both operators of both chains are on the pair's chains -------------------------------------------
    const srcIds = await src.both<string>("eth_chainId", [], () => null);
    if (readFailed(srcIds, isQty)) P.push("OPERATOR_READ_FAILED:CHAIN_ID");
    else if (srcIds.values.some((x) => big(x) !== BigInt(S.chainId)))
      P.push("OPERATOR_CHAIN_ID_MISMATCH");
    const dstIds = await dst.both<string>("eth_chainId", [], () => null);
    if (readFailed(dstIds, isQty))
      P.push("OPERATOR_READ_FAILED:DESTINATION_CHAIN_ID");
    else if (dstIds.values.some((x) => big(x) !== BigInt(D.chainId)))
      P.push("DESTINATION_OPERATOR_CHAIN_ID_MISMATCH");
    // ---- review MAJOR-1: the signer's own status (after a sync): a step it would certainly refuse is never ready -----
    let signer: LaneSignerStatus | null = null;
    try {
      signer = await this.#d.signer.status();
    } catch {
      signer = null;
    }
    for (const r of signerPreflightProblems(signer, {
      account: owner,
      route: pair.id,
      signerStep: step,
      chainId: S.chainId,
      nowMs: now,
    }))
      P.push(`SIGNER_NOT_READY:${r}`);
    // ---- 7 / review MINOR-1: the SIGNER's nonce anchor on the source chain: chain nonce = the signer's firstNonce +
    // its signatures on this chain; this lane's own SENT / UNCERTAIN dispatches never exceed them; record firstNonce is a
    // lower bound (another lane of the same signer no longer breaks the anchor).
    const nonceAt = await src.both<string>("eth_getTransactionCount", [
      owner,
      B,
    ]);
    const noncePending = await src.both<string>("eth_getTransactionCount", [
      owner,
      "pending",
    ]);
    const mayHaveUsed = this.#d.store
      .of("DISPATCH")
      .filter((e) =>
        ["SENT", "UNCERTAIN"].includes(
          String((e.data as { outcome?: unknown }).outcome),
        ),
      ).length;
    const sc = signer?.chains[S.chainId];
    const nonce = big(nonceAt.values[0]);
    if (readFailed(nonceAt, isQty) || readFailed(noncePending, isQty))
      P.push("OPERATOR_READ_FAILED:NONCE");
    else if (
      !nonceAt.agree ||
      !noncePending.agree ||
      nonce === null ||
      nonce !== big(noncePending.values[0]) ||
      !sc ||
      nonce !== sc.firstNonce + BigInt(sc.signedCount) ||
      mayHaveUsed > sc.signedCount ||
      nonce < BigInt(rec.firstNonce)
    )
      P.push("NONCE_NOT_ANCHORED_TO_JOURNAL");
    // ---- 4. source pins on both operators at B, including the facet the Diamond routes the selector to ---------------
    const pinProblems: string[] = [
      ...bridgePinProblems(S.chainId),
      ...bridgePinProblems(D.chainId),
    ];
    const srcPins = await this.#pinsAt(
      src,
      B,
      sourceCodePins(sp),
      [
        {
          proxy: sp.usdc.address,
          slot: sp.usdc.implementation.slot,
          address: sp.usdc.implementation.address,
          code: "USDC_IMPLEMENTATION_CHANGED",
        },
        {
          proxy: sp.spokePool.address,
          slot: sp.spokePool.implementation.slot,
          address: sp.spokePool.implementation.address,
          code: "SPOKEPOOL_IMPLEMENTATION_CHANGED",
        },
      ],
      "",
    );
    pinProblems.push(...srcPins.problems);
    if (!srcPins.agree) operatorsAgree = false;
    const call = async (to: string, d: string) =>
      src.both<string>("eth_call", [{ to, data: d }, B]);
    const facet = await call(
      DIAMOND,
      encodeFunctionData({
        abi: LOUPE,
        functionName: "facetAddress",
        args: [BRIDGE_LANE_SELECTORS.bridge as Hex],
      }),
    );
    if (!facet.agree) operatorsAgree = false;
    if (readFailed(facet, isHex))
      pinProblems.push("OPERATOR_READ_FAILED:FACET");
    else if (
      !facet.agree ||
      !same("0x" + String(facet.values[0]).slice(-40), BRIDGE_ACROSS_FACET)
    )
      pinProblems.push("FACET_REROUTED");
    const spoke = await call(sp.facet.address, BRIDGE_LANE_SELECTORS.spokePool);
    if (!spoke.agree) operatorsAgree = false;
    if (readFailed(spoke, isHex))
      pinProblems.push("OPERATOR_READ_FAILED:SPOKEPOOL");
    else if (
      !spoke.agree ||
      !same("0x" + String(spoke.values[0]).slice(-40), sp.spokePool.address)
    )
      pinProblems.push("SPOKEPOOL_CHANGED");
    // ---- 4b. destination SpokePool and USDC pins on both destination operators ---------------------------------------
    let destinationBlock: string | null = null;
    const dHeads = await dst.both<string>("eth_blockNumber", [], () => null);
    if (dHeads.values.some((h) => big(h) === null)) {
      operatorsAgree = false;
      pinProblems.push("DESTINATION_HEAD_UNAVAILABLE");
    } else {
      const dh = dHeads.values.map((h) => big(h) as bigint);
      if (
        (dh[0] > dh[1] ? dh[0] - dh[1] : dh[1] - dh[0]) >
        BigInt(D.maxHeadSkewBlocks)
      )
        P.push("DESTINATION_OPERATOR_HEADS_TOO_FAR_APART");
      const DB = min(dh[0], dh[1]) - 1n;
      destinationBlock = DB.toString();
      const dPins = await this.#destinationPins(dst, hex(DB));
      pinProblems.push(...dPins.problems);
      if (!dPins.agree) operatorsAgree = false;
    }
    P.push(...pinProblems);
    // ---- balances / allowance / native at B ---------------------------------------------------------------------------
    const usdcBal = await call(U, "0x70a08231" + word(owner));
    const allowance = await call(U, "0xdd62ed3e" + word(owner) + word(DIAMOND));
    const native = await src.both<string>("eth_getBalance", [owner, B]);
    for (const [n, x] of [
      ["USDC", usdcBal],
      ["ALLOWANCE", allowance],
      ["NATIVE", native],
    ] as const)
      if (!x.agree) {
        operatorsAgree = false;
        P.push(`OPERATORS_DISAGREE:${n}`);
      }
    const usdc = big(usdcBal.values[0]) ?? 0n,
      allow = big(allowance.values[0]) ?? 0n,
      nativeWei = big(native.values[0]) ?? 0n;
    if (
      this.#d.reuseExistingAllowance &&
      this.#existingAllowance !== null &&
      allow !== this.#existingAllowance
    )
      P.push("ALLOWANCE_CHANGED_DURING_REVIEW");
    if (step === "APPROVE" && allow !== 0n && !this.#d.reuseExistingAllowance)
      P.push("ALLOWANCE_NOT_ZERO_BEFORE_APPROVE");
    if (
      step === "EXECUTE" &&
      (this.#reusingAllowance() ? allow < amount : allow !== amount)
    )
      P.push("ALLOWANCE_NOT_EXACT_BEFORE_EXECUTE");
    if (usdc < amount) P.push("USDC_BALANCE_BELOW_AMOUNT");
    // ---- 5. eth_simulateV1 of the REMAINING sequence on both source operators ----------------------------------------
    const approveTx = {
      from: owner,
      to: U,
      data: bridgeApproveCalldata(amount),
    };
    const bridgeTx = data ? { from: owner, to: DIAMOND, data } : null;
    const seq: {
      step: BridgeLaneStep;
      t: { from: string; to: string; data: string };
    }[] = !bridgeTx
      ? []
      : step === "APPROVE"
        ? [
            { step: "APPROVE", t: approveTx },
            { step: "EXECUTE", t: bridgeTx },
          ]
        : step === "EXECUTE"
          ? [{ step: "EXECUTE", t: bridgeTx }]
          : [];
    let simulation: BridgeLaneReview["simulation"] = null;
    const gasUsed: Partial<Record<BridgeLaneStep, bigint>> = {};
    if (seq.length) {
      const balance = { from: owner, to: U, data: "0x70a08231" + word(owner) };
      const calls = [
        balance,
        ...seq.map((s) => s.t),
        balance,
        {
          from: owner,
          to: U,
          data: "0xdd62ed3e" + word(owner) + word(DIAMOND),
        },
      ];
      const sim = await src.both<
        { calls: { status: string; returnData: string; gasUsed: string }[] }[]
      >(
        "eth_simulateV1",
        [
          {
            blockStateCalls: [{ calls }],
            validation: false,
            traceTransfers: false,
          },
          B,
        ],
        (x) =>
          Array.isArray(x) &&
          (
            x as { calls: { status: string; returnData: string }[] }[]
          )[0]?.calls?.map((k) => [k.status, k.returnData]),
      );
      const res = sim.values[0]?.[0]?.calls;
      if (!sim.agree || !res || res.length !== calls.length) {
        operatorsAgree = false;
        P.push("SIMULATION_OPERATORS_DISAGREE");
      } else if (res.some((k) => k.status !== "0x1"))
        P.push("SIMULATION_REVERTED");
      else {
        const m = seq.length;
        const v = (i: number) => big(res[i].returnData) ?? -1n;
        const usdcDelta = v(1 + m) - v(0),
          allowanceAfter = v(2 + m);
        if (usdcDelta !== -amount) P.push("SIMULATED_USDC_DELTA_NOT_EXACT");
        const expectedAllowance =
          step === "EXECUTE" && this.#reusingAllowance() ? allow - amount : 0n;
        if (allowanceAfter !== expectedAllowance)
          P.push("SIMULATED_ALLOWANCE_LEFT");
        const res2 = sim.values[1]?.[0]?.calls;
        seq.forEach((s, i) => {
          const g0 = big(res[1 + i].gasUsed) ?? 0n;
          const g1 = big(res2?.[1 + i]?.gasUsed) ?? 0n;
          gasUsed[s.step] = max(g0, g1);
        });
        simulation = {
          usdcDelta: usdcDelta.toString(),
          allowanceAfter: allowanceAfter.toString(),
          gasUsed: Object.fromEntries(
            Object.entries(gasUsed).map(([k, g]) => [k, String(g)]),
          ),
        };
      }
    }
    // ---- 6. fees: the source chain's fee model, as the swap lane, never looser than signer v5 ------------------------
    const tipR = await src.both<string>(
      "eth_maxPriorityFeePerGas",
      [],
      () => null,
    );
    const tips = tipR.values.map((t) => big(t) ?? 0n);
    const highTip = max(tips[0], tips[1]);
    const tip =
      highTip > S.maxTipWei
        ? S.maxTipWei
        : highTip < S.minTipWei
          ? S.minTipWei
          : highTip;
    const maxFeePerGas = 3n * baseFee + tip;
    if (maxFeePerGas > S.maxFeePerGasWei) P.push("FEE_CAP_ABOVE_SIGNER_POLICY");
    const estimates: Partial<Record<BridgeLaneStep, bigint>> = {};
    const arbL1: Partial<Record<BridgeLaneStep, bigint>> = {};
    if (S.feeModel === "ARBITRUM" && step && gasUsed[step] !== undefined) {
      const t = seq[0].t;
      const est = await src.both<string>(
        "eth_estimateGas",
        [{ from: t.from, to: t.to, data: t.data }, B],
        () => null,
      );
      const e = est.values.map((x) => big(x));
      if (e.some((x) => x === null || x <= 0n)) {
        P.push(`GAS_ESTIMATE_UNPROVEN:${step}`);
        P.push("ARBITRUM_SIGNER_READS_UNAVAILABLE");
      } else estimates[step] = max(e[0] as bigint, e[1] as bigint);
      // review MINOR-3: signer v5's NodeInterface.gasEstimateL1Component read, on BOTH operators, with its two rules
      const l1c = await src.both<string>(
        "eth_call",
        [
          {
            to: ARBITRUM_NODE_INTERFACE,
            data: encodeFunctionData({
              abi: NODE_INTERFACE,
              functionName: "gasEstimateL1Component",
              args: [t.to as Hex, false, t.data as Hex],
            }),
          },
          B,
        ],
        () => null,
      );
      const l1g = l1c.values.map(firstWord);
      if (l1g.some((x) => x === null))
        P.push("ARBITRUM_SIGNER_READS_UNAVAILABLE");
      else arbL1[step] = max(l1g[0] as bigint, l1g[1] as bigint);
    }
    const limits: Partial<Record<BridgeLaneStep, bigint>> = {};
    for (const s of seq) {
      const g = gasUsed[s.step];
      if (g === undefined) continue;
      let lim = (g * (10_000n + BRIDGE_LANE_SCOPE.gasMarginBps)) / 10_000n;
      const est = estimates[s.step];
      if (est !== undefined)
        lim = max(
          lim,
          (est * (10_000n + BRIDGE_LANE_SCOPE.estimateMarginBps)) / 10_000n,
        );
      if (lim > S.maxGas[s.step]) P.push(`GAS_ABOVE_CAP:${s.step}`);
      if (lim < BRIDGE_LANE_SCOPE.minGas) P.push(`GAS_BELOW_FLOOR:${s.step}`);
      const l1 = arbL1[s.step];
      if (l1 !== undefined) {
        if (lim < 21_000n + l1)
          P.push(`ARBITRUM_GAS_BELOW_L1_COMPONENT:${s.step}`);
        if (est !== undefined && est < l1)
          P.push(`ARBITRUM_ESTIMATE_EXCLUDES_L1:${s.step}`);
      }
      limits[s.step] = lim;
    }
    let l1Fee = 0n;
    if (step && S.feeModel === "OP_STACK") {
      if (!sp.gasPriceOracle) P.push("L1_FEE_UNPROVEN");
      else {
        // The L1 data fee of EVERY remaining transaction (the bridge calldata is ~20x the approval), x 2 (signer v5
        // reserves twice the larger operator's value).
        for (const [i, s] of seq.entries()) {
          // review NIT-3: each remaining transaction serialized with its own anchored nonce, as the signer does
          const unsigned = serializeTransaction({
            type: "eip1559",
            chainId: Number(S.chainId),
            nonce: Number(nonce ?? 0n) + i,
            to: s.t.to as Hex,
            value: 0n,
            data: s.t.data as Hex,
            gas: limits[s.step] ?? S.maxGas[s.step],
            maxFeePerGas,
            maxPriorityFeePerGas: tip,
          });
          const l1 = await src.both<string>(
            "eth_call",
            [
              {
                to: sp.gasPriceOracle,
                data: encodeFunctionData({
                  abi: ORACLE,
                  functionName: "getL1Fee",
                  args: [unsigned],
                }),
              },
              B,
            ],
            () => null,
          );
          if (l1.values.some((x) => big(x) === null)) P.push("L1_FEE_UNPROVEN");
          const vals = l1.values.map((x) => big(x) ?? 0n);
          l1Fee += max(vals[0], vals[1]) * 2n;
        }
        // Signer v5 (Isthmus): getOperatorFee(tx gas) must be 0 on both operators; non-decreasing in the gas, so 0 at
        // the largest gas of this review is 0 for every step.
        const opGas = Object.values(limits).reduce(
          (a, g) => max(a, g as bigint),
          S.maxGas.EXECUTE,
        );
        const opFee = await src.both<string>(
          "eth_call",
          [
            {
              to: sp.gasPriceOracle,
              data: encodeFunctionData({
                abi: ORACLE,
                functionName: "getOperatorFee",
                args: [opGas],
              }),
            },
            B,
          ],
          () => null,
        );
        if (readFailed(opFee, isHex))
          P.push("OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE");
        else if (opFee.values.some((x) => big(x) !== 0n))
          P.push("OP_STACK_OPERATOR_FEE_NONZERO");
      }
    }
    const spent = this.#spentWei();
    const worst =
      spent +
      Object.values(limits).reduce(
        (a, g) => a + (g as bigint) * maxFeePerGas,
        0n,
      ) +
      l1Fee;
    if (worst > BigInt(rec.nativeGasBudgetWei)) P.push("GAS_BUDGET");
    if (nativeWei < worst - spent) P.push("NATIVE_BELOW_WORST_CASE");
    // ---- 8. Guardian BridgeFacts (the canary's shape), on the server's own facts -------------------------------------
    const asset = (chainId: string, address: string): AssetFacts => {
      const a = knownAsset(chainId, address, false);
      return {
        chainId,
        address,
        symbol: "USDC",
        native: false,
        level: a?.level as AssetFacts["level"],
        risk: (a?.risk ?? []) as AssetFacts["risk"],
      };
    };
    const inU = 10n ** BigInt(S.usdc.decimals),
      outU = 10n ** BigInt(D.usdc.decimals);
    const effective = bind?.effectiveOutput ?? null;
    const facts: BridgeFacts = {
      kind: "bridge",
      sourceChain: S.chainId,
      destinationChain: D.chainId,
      sender: owner,
      recipient: owner,
      pay: asset(S.chainId, U),
      receive: asset(D.chainId, D.usdc.address),
      route: {
        steps: [
          { tool: "across", catalogBound: true, destinationSignature: false },
        ],
        durationSeconds: 60,
        // Same token on both ends: the share the route keeps, read from the calldata itself (decimals-normalised).
        priceImpact:
          effective === null
            ? null
            : Number(amount * outU - effective * inU) / Number(amount * outU),
        warnings: 0,
        valid: true,
        inputUsd: null,
        outputUsd: null,
        costUsd: null,
      },
      known: [owner],
    };
    const v = guardianReview(facts, now);
    const guardian = {
      level: v.level,
      digest: v.digest,
      findings: v.findings.map((f) => `${f.code}:${f.severity}`),
    };
    if (v.level === "BLOCK" || v.level === "HOLD")
      P.push(`BLOCKED_BY_GUARDIAN:${v.level}`);
    if (!operatorsAgree) P.push("OPERATORS_NOT_PROVEN");
    // ---- 9. attestation -------------------------------------------------------------------------------------------------
    const reviewId = "0x" + randomBytes(16).toString("hex");
    const a = bind?.call?.across;
    const out: BridgeLaneReview = {
      reviewId,
      route: pair.id,
      sourceChainId: S.chainId,
      destinationChainId: D.chainId,
      ready: P.length === 0,
      step,
      problems: P,
      block: blockN.toString(),
      blockTime,
      destinationBlock,
      readAt: now,
      expiresAt: now + BRIDGE_LANE_SCOPE.reviewTtlSec * 1000,
      amountIn: amount.toString(),
      minimumOut: minimumOut.toString(),
      bridged: bind?.call ? bind.call.bridged.toString() : null,
      feeTotal: bind?.feeTotal != null ? bind.feeTotal.toString() : null,
      effectiveOutput: effective !== null ? effective.toString() : null,
      costBps: bind?.costBps ?? null,
      data,
      quote:
        bind?.call && a
          ? {
              transactionId: bind.call.transactionId,
              quoteTimestamp: a.quoteTimestamp,
              fillDeadline: a.fillDeadline,
              exclusivityParameter: a.exclusivityParameter,
              gasLimit: qv.gasLimit !== null ? qv.gasLimit.toString() : null,
              quotedMinimum:
                qv.quotedMinimum !== null ? qv.quotedMinimum.toString() : null,
            }
          : null,
      balances: {
        usdc: usdc.toString(),
        allowance: allow.toString(),
        native: nativeWei.toString(),
      },
      ...(this.#reusingAllowance()
        ? { reusedAllowance: allow.toString() }
        : {}),
      simulation,
      gas: {
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: tip.toString(),
        limits: Object.fromEntries(
          Object.entries(limits).map(([k, g]) => [k, String(g)]),
        ),
        l1FeeWei: l1Fee.toString(),
        spentWei: spent.toString(),
        worstCaseTotalWei: worst.toString(),
        budgetWei: rec.nativeGasBudgetWei,
      },
      guardian,
      pins: { set: BRIDGE_LANE_PIN_SET, problems: pinProblems },
    };
    const { attestation: _a, ...payload } = out;
    void _a;
    out.attestation = this.#attestor.attest(
      "GUARDIAN",
      rec.approvalId,
      reviewId,
      payload,
      now,
    );
    this.#reviews.set(reviewId, out);
    this.#d.store.append("REVIEW", {
      reviewId,
      route: pair.id,
      step,
      ready: out.ready,
      problems: P,
      block: out.block,
      destinationBlock,
      effectiveOutput: out.effectiveOutput,
      costBps: out.costBps,
      dataKeccak: data ? keccak256(data as Hex) : null,
      guardian,
      gas: out.gas,
      simulation,
      digest: sha(JSON.stringify(payload)),
    });
    return out;
  }
  /** The destination SpokePool + USDC (code and implementation) at block DB on both destination operators. */
  #destinationPins(dst: BridgeChainReader, DB: string) {
    const dp = this.#dp;
    return this.#pinsAt(
      dst,
      DB,
      destinationCodePins(dp),
      [
        {
          proxy: dp.usdc.address,
          slot: dp.usdc.implementation.slot,
          address: dp.usdc.implementation.address,
          code: "USDC_IMPLEMENTATION_CHANGED",
        },
        {
          proxy: dp.spokePool.address,
          slot: dp.spokePool.implementation.slot,
          address: dp.spokePool.implementation.address,
          code: "SPOKEPOOL_IMPLEMENTATION_CHANGED",
        },
      ],
      "DESTINATION_",
    );
  }
  #fresh(reviewId: unknown): BridgeLaneReview {
    const r =
      typeof reviewId === "string" ? this.#reviews.get(reviewId) : undefined;
    if (!r) throw new BridgeLaneError("REVIEW_UNKNOWN");
    const { attestation, ...payload } = r;
    if (
      !this.#attestor.verify(
        attestation,
        "GUARDIAN",
        this.#rec.approvalId,
        r.reviewId,
        payload,
      )
    )
      throw new BridgeLaneError("REVIEW_NOT_ATTESTED");
    if (r.route !== this.#pair.id)
      throw new BridgeLaneError("REVIEW_OTHER_ROUTE");
    if (!r.ready || !r.step)
      throw new BridgeLaneError("REVIEW_NOT_READY", r.problems);
    if (this.#now() >= r.expiresAt) throw new BridgeLaneError("REVIEW_EXPIRED");
    if (
      r.reusedAllowance !==
      (this.#reusingAllowance()
        ? this.#existingAllowance?.toString()
        : undefined)
    )
      throw new BridgeLaneError("ALLOWANCE_REVIEW_STALE");
    if (r.step !== this.nextStep())
      throw new BridgeLaneError("REVIEW_STEP_STALE");
    return r;
  }
  // ------------------------------------------------------------------------------------------------ authorize
  #mac(t: Omit<Token, "mac">) {
    return createHmac("sha256", this.#tokenKey)
      .update(
        JSON.stringify([
          "veined.bridge-lane.authorization.v1",
          t.id,
          t.reviewId,
          t.step,
          t.record,
          t.notAfter,
        ]),
      )
      .digest("hex");
  }
  authorize(reviewId: unknown, ownerKey: unknown): string {
    this.checkKey(ownerKey);
    const r = this.#fresh(reviewId);
    if (this.#used(r.step!)) throw new BridgeLaneError("STEP_ALREADY_USED");
    const t: Omit<Token, "mac"> = {
      id: randomBytes(16).toString("hex"),
      reviewId: r.reviewId,
      step: r.step!,
      record: this.#rec.approvalId,
      notAfter: Math.min(r.expiresAt, this.#rec.notAfter),
    };
    const token: Token = { ...t, mac: this.#mac(t) };
    this.#d.store.append("AUTH", {
      id: t.id,
      reviewId: t.reviewId,
      step: t.step,
      notAfter: t.notAfter,
    });
    return Buffer.from(JSON.stringify(token)).toString("base64url");
  }
  #consume(raw: unknown): Token {
    let t: Token;
    try {
      t = JSON.parse(
        Buffer.from(String(raw), "base64url").toString("utf8"),
      ) as Token;
    } catch {
      throw new BridgeLaneError("TOKEN_INVALID");
    }
    if (!t || typeof t.mac !== "string" || !/^[0-9a-f]{64}$/.test(t.mac))
      throw new BridgeLaneError("TOKEN_INVALID");
    const { mac, ...body } = t;
    if (!timingSafeEqual(Buffer.from(this.#mac(body)), Buffer.from(mac)))
      throw new BridgeLaneError("TOKEN_INVALID");
    if (t.record !== this.#rec.approvalId)
      throw new BridgeLaneError("TOKEN_RECORD_MISMATCH");
    if (this.#now() >= t.notAfter) throw new BridgeLaneError("TOKEN_EXPIRED");
    if (this.#tokenSpent(t.id)) throw new BridgeLaneError("TOKEN_REPLAYED");
    return t;
  }
  /**
   * Lanes review R2 NEW-1 / NEW-2: re-checked synchronously AFTER the preflight await, right before the step is spent.
   * The token and the review must still be fresh (a slow sync never spends a stale review), the token unspent, the
   * step unused and still next, and no other single-use entry may have been journaled since the checks began.
   */
  #recheck(t: Token, r: BridgeLaneReview, seen: JournalMark) {
    const now = this.#now();
    const after = ["AFTER_SIGNER_PREFLIGHT"];
    if (now >= t.notAfter) throw new BridgeLaneError("TOKEN_EXPIRED", after);
    if (now >= r.expiresAt) throw new BridgeLaneError("REVIEW_EXPIRED", after);
    if (this.#tokenSpent(t.id))
      throw new BridgeLaneError("DISPATCH_DUPLICATE", ["TOKEN_REPLAYED"]);
    if (this.#used(t.step))
      throw new BridgeLaneError("DISPATCH_DUPLICATE", ["STEP_ALREADY_USED"]);
    if (
      r.reusedAllowance !==
      (this.#reusingAllowance()
        ? this.#existingAllowance?.toString()
        : undefined)
    )
      throw new BridgeLaneError("ALLOWANCE_REVIEW_STALE");
    if (t.step !== this.nextStep())
      throw new BridgeLaneError("DISPATCH_DUPLICATE", ["REVIEW_STEP_STALE"]);
    if (this.#changedSince(seen))
      throw new BridgeLaneError("DISPATCH_DUPLICATE", [
        "OTHER_DISPATCH_RECORDED",
      ]);
  }
  /** Other bridge pairs from this source chain share the Diamond allowance: a revoke must never clear theirs. */
  #sameSpender(): { approve: string; execute: string; revoke: string }[] {
    return Object.keys(BRIDGE_LANE_PAIRS)
      .filter(
        (id) =>
          id !== this.#pair.id &&
          BRIDGE_LANE_PAIRS[id].source === this.#S.chainId,
      )
      .map((id) => ({
        approve: `${id}:APPROVE`,
        execute: `${id}:EXECUTE`,
        revoke: `${id}:REVOKE`,
      }));
  }
  /** The signer preflight of one step: journaled (SIGNER_PREFLIGHT) and refused without spending unless clean. */
  async #preflight(step: BridgeLaneStep | "REVOKE") {
    let s: LaneSignerStatus | null = null;
    try {
      s = await this.#d.signer.status();
    } catch {
      s = null;
    }
    if (step === "EXECUTE" && this.#reusingAllowance()) {
      const current = await existingAllowance(
        this.#d.chains.source,
        this.#rec.account,
        this.#S.usdc.address,
        BRIDGE_LIFI_DIAMOND,
      );
      if (current !== this.#existingAllowance)
        throw new BridgeLaneError("ALLOWANCE_CHANGED_BEFORE_DISPATCH");
    }
    const reasons = signerPreflightProblems(s, {
      account: this.#rec.account,
      route: this.#pair.id,
      signerStep: step,
      chainId: this.#S.chainId,
      nowMs: this.#now(),
      ...(step === "REVOKE" ? { blockedBy: this.#sameSpender() } : {}),
    });
    this.#d.store.append("SIGNER_PREFLIGHT", {
      step,
      ok: reasons.length === 0,
      reasons,
      inFlight: s?.inFlight ?? null,
      uncertain: s?.uncertain ?? null,
      signedCount: s?.chains[this.#S.chainId]?.signedCount ?? null,
    });
    if (reasons.length)
      throw new BridgeLaneError(
        "SIGNER_NOT_READY",
        reasons.map((r) => `SIGNER_NOT_READY:${r}`),
      );
  }
  // ------------------------------------------------------------------------------------------------ revoke
  /**
   * review MINOR-5: the lane's own CLEANUP. ONE approve(Diamond, 0), single use, allowed only after this lane's APPROVE
   * is final and successful AND its EXECUTE was refused before signing, failed on chain, or was never dispatched within
   * the record window, AND both source operators show a remaining allowance > 0. Fresh reads at one block, the source
   * chain's fee model, the record budget, the gate (step REVOKE) and the signer preflight (which also refuses while
   * another pair from this chain holds an unexecuted Diamond approval) decide BEFORE anything is spent; then USE +
   * PREPARED in one batch and the CLEANUP hand-off. Nothing is ever resent.
   */
  async revoke(ownerKey: unknown): Promise<{
    step: "REVOKE";
    outcome: string;
    hash: string | null;
    problems: string[];
  }> {
    this.checkKey(ownerKey);
    // Lanes review R2 NEW-1: the whole revoke — single-use check, reads, gate, preflight, USE + PREPARED, hand-off,
    // outcome — runs inside the process-wide dispatch lock (a concurrent second revoke: DISPATCH_IN_PROGRESS).
    return withLaneDispatchLock(
      this.#lockKey,
      () => new BridgeLaneError("DISPATCH_IN_PROGRESS"),
      async () => {
        const rec = this.#rec,
          S = this.#S,
          sp = this.#sp,
          c = this.#d.chains.source,
          now = this.#now();
        const owner = rec.account,
          U = S.usdc.address,
          DIAMOND = BRIDGE_LIFI_DIAMOND;
        if (this.#used("REVOKE"))
          throw new BridgeLaneError("REVOKE_ALREADY_USED");
        const seen = this.#mark();
        const P: string[] = [];
        for (const s of ["APPROVE", "EXECUTE"] as const)
          if (this.#used(s) && !this.#dispatch(s))
            P.push(`LANE_RECOVERY_REQUIRED:${s}`);
        const a = this.#receipt("APPROVE");
        if (!a || a.status !== "0x1")
          P.push("REVOKE_NOT_ALLOWED:APPROVE_NOT_FINAL");
        const d = this.#dispatch("EXECUTE"),
          x = this.#receipt("EXECUTE");
        const executeDead =
          (d &&
            (d.outcome === "REFUSED" ||
              d.outcome === "REFUSED_BEFORE_SIGNER")) ||
          (x && x.status === "0x0") ||
          (!this.#used("EXECUTE") && now >= rec.notAfter);
        if (!executeDead)
          P.push("REVOKE_NOT_ALLOWED:EXECUTE_NOT_DECIDED_FAILED");
        const heads = await c.both<string>("eth_blockNumber", [], () => null);
        if (heads.values.some((h) => big(h) === null))
          throw new BridgeLaneError("HEAD_UNAVAILABLE");
        const hs = heads.values.map((h) => big(h) as bigint);
        if (
          (hs[0] > hs[1] ? hs[0] - hs[1] : hs[1] - hs[0]) >
          BigInt(S.maxHeadSkewBlocks)
        )
          P.push("OPERATOR_HEADS_TOO_FAR_APART");
        const B = hex(min(hs[0], hs[1]) - 1n);
        const blk = await c.both<{
          hash: string;
          timestamp: string;
          baseFeePerGas: string;
        }>(
          "eth_getBlockByNumber",
          [B, false],
          (y) =>
            y && {
              h: (y as { hash: string }).hash,
              b: (y as { baseFeePerGas: string }).baseFeePerGas,
            },
        );
        if (
          !blk.agree ||
          !blk.values[0] ||
          big(blk.values[0].timestamp) === null
        )
          throw new BridgeLaneError("OPERATORS_DISAGREE", ["BLOCK"]);
        const age = blockAgeMs(
          now,
          Number(BigInt(blk.values[0].timestamp)) * 1000,
        );
        if (age === null) P.push("REVIEW_BLOCK_IN_FUTURE");
        else if (age > S.maxReviewBlockAgeSec * 1000)
          P.push("REVIEW_BLOCK_TOO_OLD");
        const baseFee = big(blk.values[0].baseFeePerGas);
        if (baseFee === null) P.push("BASE_FEE_UNPROVEN");
        const ids = await c.both<string>("eth_chainId", [], () => null);
        if (readFailed(ids, isQty)) P.push("OPERATOR_READ_FAILED:CHAIN_ID");
        else if (ids.values.some((y) => big(y) !== BigInt(S.chainId)))
          P.push("OPERATOR_CHAIN_ID_MISMATCH");
        let signer: LaneSignerStatus | null = null;
        try {
          signer = await this.#d.signer.status();
        } catch {
          signer = null;
        }
        const nonceAt = await c.both<string>("eth_getTransactionCount", [
          owner,
          B,
        ]);
        const noncePending = await c.both<string>("eth_getTransactionCount", [
          owner,
          "pending",
        ]);
        const sc = signer?.chains[S.chainId];
        const nonce = big(nonceAt.values[0]);
        const mine = this.#d.store
          .of("DISPATCH")
          .filter((e) =>
            ["SENT", "UNCERTAIN"].includes(
              String((e.data as { outcome?: unknown }).outcome),
            ),
          ).length;
        if (readFailed(nonceAt, isQty) || readFailed(noncePending, isQty))
          P.push("OPERATOR_READ_FAILED:NONCE");
        else if (
          !nonceAt.agree ||
          !noncePending.agree ||
          nonce === null ||
          nonce !== big(noncePending.values[0]) ||
          !sc ||
          nonce !== sc.firstNonce + BigInt(sc.signedCount) ||
          mine > sc.signedCount ||
          nonce < BigInt(rec.firstNonce)
        )
          P.push("NONCE_NOT_ANCHORED_TO_JOURNAL");
        const allowanceCall = {
          from: owner,
          to: U,
          data: "0xdd62ed3e" + word(owner) + word(DIAMOND),
        };
        const allowance = await c.both<string>("eth_call", [
          { to: U, data: allowanceCall.data },
          B,
        ]);
        const left = big(allowance.values[0]);
        if (readFailed(allowance, isQty))
          P.push("OPERATOR_READ_FAILED:ALLOWANCE");
        else if (!allowance.agree || left === null)
          P.push("OPERATORS_DISAGREE:ALLOWANCE");
        else if (left === 0n) P.push("REVOKE_NOT_NEEDED");
        const revokeTx = {
          from: owner,
          to: U,
          data: bridgeApproveCalldata(0n),
        };
        const sim = await c.both<
          { calls: { status: string; returnData: string; gasUsed: string }[] }[]
        >(
          "eth_simulateV1",
          [
            {
              blockStateCalls: [{ calls: [revokeTx, allowanceCall] }],
              validation: false,
              traceTransfers: false,
            },
            B,
          ],
          (y) =>
            Array.isArray(y) &&
            (
              y as { calls: { status: string; returnData: string }[] }[]
            )[0]?.calls?.map((k) => [k.status, k.returnData]),
        );
        const res = sim.values[0]?.[0]?.calls;
        let gasUsed = 0n;
        if (!sim.agree || !res || res.length !== 2)
          P.push("SIMULATION_OPERATORS_DISAGREE");
        else if (res.some((k) => k.status !== "0x1"))
          P.push("SIMULATION_REVERTED");
        else {
          if ((big(res[1].returnData) ?? -1n) !== 0n)
            P.push("SIMULATED_ALLOWANCE_LEFT");
          gasUsed = max(
            big(res[0].gasUsed) ?? 0n,
            big(sim.values[1]?.[0]?.calls?.[0]?.gasUsed) ?? 0n,
          );
        }
        const tipR = await c.both<string>(
          "eth_maxPriorityFeePerGas",
          [],
          () => null,
        );
        const tips = tipR.values.map((y) => big(y) ?? 0n);
        const highTip = max(tips[0], tips[1]);
        const tip =
          highTip > S.maxTipWei
            ? S.maxTipWei
            : highTip < S.minTipWei
              ? S.minTipWei
              : highTip;
        const maxFeePerGas = 3n * (baseFee ?? 0n) + tip;
        if (maxFeePerGas > S.maxFeePerGasWei)
          P.push("FEE_CAP_ABOVE_SIGNER_POLICY");
        let limit =
          (gasUsed * (10_000n + BRIDGE_LANE_SCOPE.gasMarginBps)) / 10_000n;
        if (S.feeModel === "ARBITRUM") {
          const est = await c.both<string>(
            "eth_estimateGas",
            [{ ...revokeTx }, B],
            () => null,
          );
          const l1c = await c.both<string>(
            "eth_call",
            [
              {
                to: ARBITRUM_NODE_INTERFACE,
                data: encodeFunctionData({
                  abi: NODE_INTERFACE,
                  functionName: "gasEstimateL1Component",
                  args: [U as Hex, false, revokeTx.data],
                }),
              },
              B,
            ],
            () => null,
          );
          const e = est.values.map((y) => big(y));
          const l = l1c.values.map(firstWord);
          if (e.some((y) => y === null || y <= 0n) || l.some((y) => y === null))
            P.push("ARBITRUM_SIGNER_READS_UNAVAILABLE");
          else {
            const em = max(e[0] as bigint, e[1] as bigint),
              lm = max(l[0] as bigint, l[1] as bigint);
            limit = max(
              limit,
              (em * (10_000n + BRIDGE_LANE_SCOPE.estimateMarginBps)) / 10_000n,
            );
            if (limit < 21_000n + lm)
              P.push("ARBITRUM_GAS_BELOW_L1_COMPONENT:REVOKE");
            if (em < lm) P.push("ARBITRUM_ESTIMATE_EXCLUDES_L1:REVOKE");
          }
        }
        if (limit > S.maxGas.APPROVE) P.push("GAS_ABOVE_CAP:REVOKE");
        if (limit < BRIDGE_LANE_SCOPE.minGas) P.push("GAS_BELOW_FLOOR:REVOKE");
        let l1Fee = 0n;
        if (S.feeModel === "OP_STACK") {
          if (!sp.gasPriceOracle) P.push("L1_FEE_UNPROVEN");
          else {
            const unsigned = serializeTransaction({
              type: "eip1559",
              chainId: Number(S.chainId),
              nonce: Number(nonce ?? 0n),
              to: U as Hex,
              value: 0n,
              data: revokeTx.data,
              gas: limit,
              maxFeePerGas,
              maxPriorityFeePerGas: tip,
            });
            const l1 = await c.both<string>(
              "eth_call",
              [
                {
                  to: sp.gasPriceOracle,
                  data: encodeFunctionData({
                    abi: ORACLE,
                    functionName: "getL1Fee",
                    args: [unsigned],
                  }),
                },
                B,
              ],
              () => null,
            );
            if (l1.values.some((y) => big(y) === null))
              P.push("L1_FEE_UNPROVEN");
            const v = l1.values.map((y) => big(y) ?? 0n);
            l1Fee = max(v[0], v[1]) * 2n;
            const opFee = await c.both<string>(
              "eth_call",
              [
                {
                  to: sp.gasPriceOracle,
                  data: encodeFunctionData({
                    abi: ORACLE,
                    functionName: "getOperatorFee",
                    args: [limit],
                  }),
                },
                B,
              ],
              () => null,
            );
            if (readFailed(opFee, isHex))
              P.push("OPERATOR_READ_FAILED:OP_STACK_OPERATOR_FEE");
            else if (opFee.values.some((y) => big(y) !== 0n))
              P.push("OP_STACK_OPERATOR_FEE_NONZERO");
          }
        }
        const spent = this.#spentWei();
        const worst = spent + limit * maxFeePerGas + l1Fee;
        if (worst > BigInt(rec.nativeGasBudgetWei)) P.push("GAS_BUDGET");
        const native = await c.both<string>("eth_getBalance", [owner, B]);
        if (!native.agree || (big(native.values[0]) ?? 0n) < worst - spent)
          P.push("NATIVE_BELOW_WORST_CASE");
        for (const r of signerPreflightProblems(signer, {
          account: owner,
          route: this.#pair.id,
          signerStep: "REVOKE",
          chainId: S.chainId,
          nowMs: now,
          blockedBy: this.#sameSpender(),
        }))
          P.push(`SIGNER_NOT_READY:${r}`);
        this.#d.store.append("REVOKE_REVIEW", {
          ready: P.length === 0,
          problems: P,
          block: B,
        });
        if (P.length)
          throw new BridgeLaneError("REVOKE_NOT_READY", [...new Set(P)]);
        const tx: LaneTx = {
          chainId: S.chainHex,
          from: lower(owner),
          to: lower(U),
          value: "0x0",
          data: revokeTx.data,
          gas: hex(limit),
          maxFeePerGas: hex(maxFeePerGas),
          maxPriorityFeePerGas: hex(tip),
        };
        const facts: BridgeLaneStepFacts = {
          route: this.#pair.id,
          step: "REVOKE",
          exactAmount: rec.exactAmount,
          tx,
          operatorsAgree: true,
          reviewAttested: true,
          guardianPassed: true,
          gasWorstCaseTotalWei: worst,
          now: this.#now(),
        };
        const gate = (this.#d.gate ?? bridgeLaneGateState)(facts);
        if (!gate.open) {
          this.#d.store.append("GATE_CLOSED", {
            step: "REVOKE",
            reasons: gate.reasons,
          });
          throw new BridgeLaneError("BRIDGE_LANE_GATE_CLOSED", gate.reasons);
        }
        await this.#preflight("REVOKE");
        // Lanes review R2 NEW-1 / NEW-2: after the preflight await, synchronously before anything is spent.
        if (this.#used("REVOKE"))
          throw new BridgeLaneError("DISPATCH_DUPLICATE", [
            "REVOKE_ALREADY_USED",
          ]);
        if (this.#changedSince(seen))
          throw new BridgeLaneError("DISPATCH_DUPLICATE", [
            "OTHER_DISPATCH_RECORDED",
          ]);
        if (this.#now() - now >= BRIDGE_LANE_SCOPE.reviewTtlSec * 1000)
          throw new BridgeLaneError("REVIEW_EXPIRED", [
            "REVOKE",
            "AFTER_SIGNER_PREFLIGHT",
          ]);
        this.#d.store.batch(() => {
          this.#d.store.append("USE", {
            key: this.#useKey("REVOKE"),
            step: "REVOKE",
          });
          this.#d.store.append("PREPARED", {
            step: "REVOKE",
            tx,
            dataKeccak: keccak256(tx.data as Hex),
          });
        });
        const authority = mintBridgeDispatchAuthority(facts);
        let out: LaneSignerResult;
        try {
          out = await this.#d.signer.send(authority, tx, "REVOKE");
        } catch (e) {
          const code = codeOf(e) === "FAILED" ? "DISPATCH_FAILED" : codeOf(e);
          const apart = this.#recordDispatch("REVOKE", {
            outcome: "REFUSED_BEFORE_SIGNER",
            hash: null,
            code,
            problems: [],
          });
          return {
            step: "REVOKE" as const,
            outcome: "REFUSED_BEFORE_SIGNER",
            hash: null,
            problems: apart ? [code, "DUPLICATE_KEPT_APART"] : [code],
          };
        }
        const apart = this.#recordDispatch("REVOKE", {
          outcome: out.outcome,
          hash: out.hash,
          problems: out.problems,
        });
        return {
          step: "REVOKE" as const,
          outcome: out.outcome,
          hash: out.hash,
          problems: apart
            ? [...out.problems, "DUPLICATE_KEPT_APART"]
            : out.problems,
        };
      },
    );
  }
  // ------------------------------------------------------------------------------------------------ dispatch
  async dispatch(
    rawToken: unknown,
    ownerKey: unknown,
  ): Promise<{
    step: BridgeLaneStep;
    outcome: string;
    hash: string | null;
    problems: string[];
  }> {
    this.checkKey(ownerKey);
    // Lanes review R2 NEW-1: single-use / replay / expiry checks -> preflight -> NONCE + USE + PREPARED -> hand-off ->
    // outcome, alone in this process (./dispatch-lock.ts). A second dispatch of this record while one is running or
    // queued (a double click, a retry) is refused at once: DISPATCH_IN_PROGRESS, before anything else.
    return withLaneDispatchLock(
      this.#lockKey,
      () => new BridgeLaneError("DISPATCH_IN_PROGRESS"),
      async () => {
        const t = this.#consume(rawToken);
        const r = this.#fresh(t.reviewId);
        if (r.step !== t.step) throw new BridgeLaneError("TOKEN_STEP_MISMATCH");
        if (this.#used(t.step)) throw new BridgeLaneError("STEP_ALREADY_USED");
        const seen = this.#mark();
        const rec = this.#rec,
          S = this.#S;
        const amount = BigInt(rec.exactAmount);
        if (t.step === "EXECUTE" && !r.data)
          throw new BridgeLaneError("REVIEW_NOT_READY", ["NO_BRIDGE_CALLDATA"]);
        const data =
          t.step === "APPROVE"
            ? bridgeApproveCalldata(amount)
            : (r.data as string);
        const limit = r.gas.limits[t.step];
        if (limit === undefined)
          throw new BridgeLaneError("REVIEW_NOT_READY", ["NO_GAS_LIMIT"]);
        const tx: LaneTx = {
          chainId: S.chainHex,
          from: lower(rec.account),
          to: lower(
            t.step === "APPROVE" ? S.usdc.address : BRIDGE_LIFI_DIAMOND,
          ),
          value: "0x0",
          data,
          gas: hex(BigInt(limit)),
          maxFeePerGas: hex(BigInt(r.gas.maxFeePerGas)),
          maxPriorityFeePerGas: hex(BigInt(r.gas.maxPriorityFeePerGas)),
        };
        const facts: BridgeLaneStepFacts = {
          route: this.#pair.id,
          step: t.step,
          exactAmount: rec.exactAmount,
          tx,
          operatorsAgree: !r.problems.includes("OPERATORS_NOT_PROVEN"),
          reviewAttested: true,
          guardianPassed:
            r.guardian !== null &&
            r.guardian.level !== "BLOCK" &&
            r.guardian.level !== "HOLD",
          gasWorstCaseTotalWei: BigInt(r.gas.worstCaseTotalWei),
          now: this.#now(),
        };
        const gate = (this.#d.gate ?? bridgeLaneGateState)(facts);
        if (!gate.open) {
          this.#d.store.append("GATE_CLOSED", {
            step: t.step,
            reasons: gate.reasons,
          });
          throw new BridgeLaneError("BRIDGE_LANE_GATE_CLOSED", gate.reasons);
        }
        // review MAJOR-1: the signer's fresh status BEFORE anything is spent (a certain refusal never burns the step).
        await this.#preflight(t.step);
        // Lanes review R2 NEW-1 / NEW-2: everything single use, and the review's freshness, again AFTER the await.
        this.#recheck(t, r, seen);
        // The step is spent BEFORE the hand-off on purpose (no resend): one fsynced batch, before anything leaves.
        const prepared: Prepared = {
          step: t.step,
          tx,
          dataKeccak: keccak256(data as Hex),
          minimumOut: rec.minimumOut,
          effectiveOutput: r.effectiveOutput,
          bridged: r.bridged,
          fillDeadline: r.quote?.fillDeadline ?? null,
          destinationFromBlock: r.destinationBlock,
          ...(r.reusedAllowance ? { reusedAllowance: r.reusedAllowance } : {}),
        };
        this.#d.store.batch(() => {
          this.#d.store.append("NONCE", { id: t.id });
          this.#d.store.append("USE", {
            key: this.#useKey(t.step),
            step: t.step,
            reviewId: r.reviewId,
          });
          this.#d.store.append("PREPARED", prepared);
        });
        const authority = mintBridgeDispatchAuthority(facts);
        let res: LaneSignerResult;
        try {
          res = await this.#d.signer.send(authority, tx, t.step);
        } catch (e) {
          const code = codeOf(e) === "FAILED" ? "DISPATCH_FAILED" : codeOf(e);
          const problems =
            e && typeof e === "object" && "problems" in e
              ? [...((e as { problems: readonly string[] }).problems ?? [])]
              : [];
          const apart = this.#recordDispatch(t.step, {
            outcome: "REFUSED_BEFORE_SIGNER",
            hash: null,
            code,
            problems,
          });
          return {
            step: t.step,
            outcome: "REFUSED_BEFORE_SIGNER",
            hash: null,
            problems: apart
              ? [code, ...problems, "DUPLICATE_KEPT_APART"]
              : [code, ...problems],
          };
        }
        const apart = this.#recordDispatch(t.step, {
          outcome: res.outcome,
          hash: res.hash,
          problems: res.problems,
        });
        return {
          step: t.step,
          outcome: res.outcome,
          hash: res.hash,
          problems: apart
            ? [...res.problems, "DUPLICATE_KEPT_APART"]
            : res.problems,
        };
      },
    );
  }
  // ------------------------------------------------------------------------------------------------ track
  /** One source step's receipt, decided on both source operators (as the swap lane). */
  async #sourceStep(step: BridgeLaneStep | "REVOKE"): Promise<
    Record<string, unknown> & {
      state: string;
      hash?: string | null;
      logs?: ChainLog[];
      block?: string;
    }
  > {
    const c = this.#d.chains.source,
      S = this.#S,
      owner = lower(this.#rec.account);
    const opStack = S.feeModel === "OP_STACK";
    const d = this.#dispatch(step);
    if (!d)
      return {
        state: this.#used(step)
          ? "UNCERTAIN_NO_DISPATCH_RECORD"
          : "NOT_DISPATCHED",
      };
    if (!d.hash || (d.outcome !== "SENT" && d.outcome !== "UNCERTAIN"))
      return {
        state:
          d.outcome === "REFUSED" || d.outcome === "REFUSED_BEFORE_SIGNER"
            ? "REFUSED"
            : "UNCERTAIN",
        hash: d.hash,
      };
    const known = this.#receipt(step);
    const rc = await c.both<{
      status: string;
      blockNumber: string;
      blockHash: string;
      gasUsed: string;
      effectiveGasPrice: string;
      l1Fee?: string;
      logs: ChainLog[];
      from: string;
      to: string;
    }>(
      "eth_getTransactionReceipt",
      [d.hash],
      (x) =>
        x && {
          s: (x as { status: string }).status,
          b: (x as { blockHash: string }).blockHash,
          g: (x as { gasUsed: string }).gasUsed,
          // review MINOR-4: every field signer v5 receiptVerdict compares
          n: (x as { blockNumber: string }).blockNumber,
          e: (x as { effectiveGasPrice: string }).effectiveGasPrice,
          h: lower(String((x as { transactionHash: string }).transactionHash)),
          fr: lower(String((x as { from: string }).from)),
          to: lower(String((x as { to: string }).to)),
          l: (x as { logs: ChainLog[] }).logs?.map((k) => [
            lower(k.address),
            k.topics,
            k.data,
          ]),
          // lanes review R2 NEW-5: RAW, as signer v5 receiptVerdict compares them (an absent field and null differ)
          ...(opStack
            ? {
                f: (x as { l1Fee?: unknown }).l1Fee,
                os: (x as { operatorFeeScalar?: unknown }).operatorFeeScalar,
                oc: (x as { operatorFeeConstant?: unknown })
                  .operatorFeeConstant,
              }
            : {}),
        },
    );
    const heads = await c.both<string>("eth_blockNumber", [], () => null);
    const head = heads.values
      .map((h) => (isQuantity(h) ? BigInt(h) : 0n))
      .reduce((a, b) => (a < b ? a : b));
    if (!rc.values[0] && !rc.values[1]) {
      const tx = await c.both(
        "eth_getTransactionByHash",
        [d.hash],
        (x) => x && (x as { hash: string }).hash,
      );
      return {
        state:
          tx.values[0] || tx.values[1]
            ? "PENDING"
            : known
              ? "REORGED_OR_DROPPED"
              : "UNKNOWN_TO_BOTH_OPERATORS",
        hash: d.hash,
      };
    }
    if (!rc.agree || !rc.values[0])
      return { state: "OPERATORS_DISAGREE", hash: d.hash };
    const x = rc.values[0];
    const receiptProblem = strictReceiptProblem(
      x,
      d.hash,
      opStack,
      heads.values,
    );
    if (receiptProblem) return { state: receiptProblem, hash: d.hash };
    const conf = head - BigInt(x.blockNumber) + 1n;
    // The raw block hash on both operators, as signer v5 compares it (lanes review R2 NEW-5).
    const at = await c.both<{ hash: string }>(
      "eth_getBlockByNumber",
      [x.blockNumber, false],
      (b) => b && (b as { hash: string }).hash,
    );
    if (!at.agree || !at.values[0] || at.values[0].hash !== x.blockHash)
      return { state: "REORGED", hash: d.hash };
    if (lower(x.from) !== owner)
      return { state: "DISCREPANCY_FROM", hash: d.hash };
    // The hash must be THIS lane's prepared transaction (from, to, input on both operators).
    const prepared = this.#last<Prepared>("PREPARED", step);
    const onChain = await c.both<{ from: string; to: string; input: string }>(
      "eth_getTransactionByHash",
      [d.hash],
      (t) =>
        t && [
          lower((t as { from: string }).from),
          lower(String((t as { to: string }).to)),
          lower((t as { input: string }).input),
        ],
    );
    const t0 = onChain.values[0];
    if (
      !prepared?.tx ||
      lower(String(x.to)) !== lower(prepared.tx.to) ||
      !onChain.agree ||
      !t0 ||
      lower(t0.from) !== lower(prepared.tx.from) ||
      lower(String(t0.to)) !== lower(prepared.tx.to) ||
      lower(t0.input) !== lower(prepared.tx.data)
    )
      return { state: "DISCREPANCY_TX", hash: d.hash };
    const l1FeeRead = opStack
      ? isQuantity(x.l1Fee)
        ? BigInt(x.l1Fee)
        : null
      : 0n;
    if (l1FeeRead === null)
      return { state: "RECEIPT_L1_FEE_UNPROVEN", hash: d.hash };
    if (conf < BigInt(S.confirmations))
      return {
        state: "CONFIRMING",
        hash: d.hash,
        confirmations: conf.toString(),
        status: x.status,
      };
    if (!known || known.blockHash !== x.blockHash)
      this.#d.store.append("RECEIPT", {
        step,
        hash: d.hash,
        status: x.status,
        block: BigInt(x.blockNumber).toString(),
        blockHash: x.blockHash,
        gasUsed: BigInt(x.gasUsed).toString(),
        effectiveGasPrice: BigInt(x.effectiveGasPrice).toString(),
        l1Fee: l1FeeRead.toString(),
      });
    return {
      state: x.status === "0x1" ? "FINAL_SUCCESS" : "FINAL_FAILED",
      hash: d.hash,
      confirmations: conf.toString(),
      block: BigInt(x.blockNumber).toString(),
      logs: x.logs,
    };
  }
  /** The deposit of the mined bridge transaction: exactly one FundsDeposited of the pinned source SpokePool, bound. */
  #deposit(
    logs: readonly ChainLog[],
    hash: string,
    block: string,
    prepared: Prepared,
  ): { deposit: BridgeDeposit | null; problem: string | null } {
    const S = this.#S,
      D = this.#D,
      owner = lower(this.#rec.account);
    const pool = lower(this.#sp.spokePool.address);
    const found: (BridgeDeposit & { destinationChainId: string })[] = [];
    let usdcOut = 0n;
    for (const l of logs) {
      if (
        lower(l.address) === lower(S.usdc.address) &&
        l.topics?.[0] === BRIDGE_LANE_TOPICS.transfer
      )
        try {
          const t = decodeEventLog({
            abi: ERC20,
            data: l.data as Hex,
            topics: l.topics as [Hex, ...Hex[]],
          });
          if (lower(t.args.from) === owner) usdcOut += t.args.value;
        } catch {
          // not a transfer
        }
      if (
        lower(l.address) !== pool ||
        l.topics?.[0] !== BRIDGE_LANE_TOPICS.fundsDeposited
      )
        continue;
      try {
        const x = decodeEventLog({
          abi: BRIDGE_SETTLEMENT_ABI,
          data: l.data as Hex,
          topics: l.topics as [Hex, ...Hex[]],
        });
        if (x.eventName !== "FundsDeposited") continue;
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
          messageHash:
            lower(a.message) === "0x" ? ZERO32 : keccak256(a.message),
          sourceBlock: block,
          sourceHash: lower(hash),
          destinationChainId: a.destinationChainId.toString(),
        });
      } catch {
        // not a deposit
      }
    }
    if (found.length !== 1)
      return {
        deposit: null,
        problem: found.length ? "MULTIPLE_DEPOSITS" : "DEPOSIT_NOT_FOUND",
      };
    const { destinationChainId, ...d } = found[0];
    const bad =
      destinationChainId !== D.chainId ||
      b32(d.depositor) !== owner ||
      b32(d.recipient) !== owner ||
      b32(d.inputToken) !== lower(S.usdc.address) ||
      b32(d.outputToken) !== lower(D.usdc.address) ||
      d.messageHash !== ZERO32 ||
      prepared.bridged === null ||
      d.inputAmount !== prepared.bridged ||
      prepared.effectiveOutput === null ||
      d.outputAmount !== prepared.effectiveOutput ||
      BigInt(d.outputAmount) < BigInt(prepared.minimumOut) ||
      prepared.fillDeadline === null ||
      d.fillDeadline !== prepared.fillDeadline;
    if (bad)
      return { deposit: null, problem: "DEPOSIT_NOT_THE_REVIEWED_RELAY" };
    if (usdcOut !== BigInt(this.#rec.exactAmount))
      return { deposit: null, problem: "SOURCE_USDC_OUT_NOT_EXACT" };
    return { deposit: d, problem: null };
  }
  /** Does this FilledRelay log fill EXACTLY the deposit (every relay field, executed as deposited)? */
  #fills(
    l: ChainLog,
    dep: BridgeDeposit,
    minimumOut: bigint,
  ): { amount: bigint; belowMinimum: boolean } | null {
    if (
      l.removed === true ||
      lower(l.address) !== lower(this.#dp.spokePool.address)
    )
      return null;
    try {
      const x = decodeEventLog({
        abi: BRIDGE_SETTLEMENT_ABI,
        data: l.data as Hex,
        topics: l.topics as [Hex, ...Hex[]],
      });
      if (x.eventName !== "FilledRelay") return null;
      const a = x.args,
        info = a.relayExecutionInfo;
      const ok =
        a.originChainId === BigInt(this.#S.chainId) &&
        a.depositId.toString() === dep.depositId &&
        lower(a.inputToken) === dep.inputToken &&
        lower(a.outputToken) === dep.outputToken &&
        a.inputAmount.toString() === dep.inputAmount &&
        a.outputAmount.toString() === dep.outputAmount &&
        lower(a.depositor) === dep.depositor &&
        lower(a.recipient) === dep.recipient &&
        lower(a.exclusiveRelayer) === dep.exclusiveRelayer &&
        Number(a.fillDeadline) === dep.fillDeadline &&
        Number(a.exclusivityDeadline) === dep.exclusivityDeadline &&
        lower(a.messageHash) === dep.messageHash &&
        // Executed as deposited (VEINED never signs a speed-up). A slow fill (type 2) pays what Across computed.
        lower(info.updatedRecipient) === dep.recipient &&
        lower(info.updatedMessageHash) === dep.messageHash &&
        (Number(info.fillType) === 2 ||
          info.updatedOutputAmount.toString() === dep.outputAmount);
      // review NIT-2: a slow fill (type 2, root-based: it cannot be fabricated) of THIS relay below the minimum is a
      // delivery below the minimum — a DISCREPANCY, never "no fill" (which would later read as refund pending).
      return ok
        ? {
            amount: info.updatedOutputAmount,
            belowMinimum: info.updatedOutputAmount < minimumOut,
          }
        : null;
    } catch {
      return null;
    }
  }
  /**
   * The fill search on the destination: FilledRelay(originChainId = source, depositId) of the pinned destination
   * SpokePool, on BOTH destination operators, in <= 100-block windows from the journaled cursor (initially the review's
   * destination block), FINAL blocks only (>= the destination chain's confirmations). Any window the operators do not
   * both answer identically stops the search without advancing it. Once a searched block lies past the fill deadline
   * with no fill (Across refuses fills after it), no fill can come any more: PAST_DEADLINE, no further reads.
   */
  async #searchFill(
    dep: BridgeDeposit,
    prepared: Prepared,
    minimumOut: bigint,
  ): Promise<FillSearch> {
    const dst = this.#d.chains.destination,
      D = this.#D;
    const done = (
      status: FillSearch["status"],
      detail: string | null,
      cursor: bigint | null,
      windows = 0,
      fill: FillSearch["fill"] = null,
    ): FillSearch => ({ status, detail, cursor, windows, fill });
    if (prepared.destinationFromBlock === null)
      return done("UNSEARCHABLE", "NO_START_BLOCK", null);
    const scans = this.#d.store.of("FILL_SCAN");
    const last = scans.at(-1)?.data as
      { to: string; timestamp: number | null } | undefined;
    let cursor = last
      ? BigInt(last.to)
      : BigInt(prepared.destinationFromBlock) - 1n;
    if (
      typeof last?.timestamp === "number" &&
      last.timestamp > dep.fillDeadline
    )
      return done("PAST_DEADLINE", null, cursor);
    const heads = await dst.both<string>("eth_blockNumber", [], () => null);
    if (heads.values.some((h) => big(h) === null))
      return done("PENDING", "DESTINATION_HEAD_UNAVAILABLE", cursor);
    const dh = heads.values.map((h) => big(h) as bigint);
    const final = min(dh[0], dh[1]) - BigInt(D.confirmations) + 1n;
    const pickLogs = (x: unknown) =>
      Array.isArray(x)
        ? (x as ChainLog[]).map((l) => [
            lower(String(l.address)),
            l.topics,
            l.data,
            lower(String(l.transactionHash)),
            String(l.blockNumber),
            lower(String(l.blockHash)),
            String(l.logIndex),
            l.removed === true,
          ])
        : null;
    const startCursor = cursor;
    let windows = 0;
    let detail: string | null = null;
    let fill: FillSearch["fill"] = null;
    while (
      cursor + 1n <= final &&
      windows < BRIDGE_LANE_SCOPE.maxLogWindowsPerTrack
    ) {
      const from = cursor + 1n;
      const to = min(
        from + BigInt(BRIDGE_LANE_SCOPE.logWindowBlocks) - 1n,
        final,
      );
      windows++;
      const logs = await dst.both<ChainLog[]>(
        "eth_getLogs",
        [
          {
            address: this.#dp.spokePool.address,
            fromBlock: hex(from),
            toBlock: hex(to),
            topics: [
              BRIDGE_LANE_TOPICS.filledRelay,
              "0x" + word(BigInt(this.#S.chainId)),
              "0x" + word(BigInt(dep.depositId)),
            ],
          },
        ],
        pickLogs,
      );
      if (logs.errors.length || !Array.isArray(logs.values[0])) {
        detail = "FILL_SEARCH_UNREADABLE";
        break;
      }
      if (!logs.agree) {
        detail = "FILL_SEARCH_OPERATORS_DISAGREE";
        break;
      }
      const matches = logs.values[0]
        .map((l) => ({ l, f: this.#fills(l, dep, minimumOut) }))
        .filter((m) => m.f !== null);
      if (
        new Set(matches.map((m) => lower(String(m.l.transactionHash)))).size > 1
      )
        return done("DISCREPANCY", "MULTIPLE_MATCHING_FILLS", cursor, windows);
      if (matches.some((m) => m.f!.belowMinimum))
        return done(
          "DISCREPANCY",
          "DISCREPANCY_FILL_BELOW_MINIMUM",
          cursor,
          windows,
        );
      if (matches.length) {
        fill = {
          hash: lower(String(matches[0].l.transactionHash)),
          amount: matches[0].f!.amount,
          log: matches[0].l,
        };
        break;
      }
      cursor = to;
    }
    if (cursor > startCursor) {
      // Progress, journaled once per call (with the agreed timestamp of the last searched block): the next track()
      // resumes after `to`.
      const b = await dst.both<{ hash: string; timestamp: string }>(
        "eth_getBlockByNumber",
        [hex(cursor), false],
        (x) =>
          x && {
            h: (x as { hash: string }).hash,
            t: (x as { timestamp: string }).timestamp,
          },
      );
      const timestamp =
        b.agree && b.values[0] && big(b.values[0].timestamp) !== null
          ? Number(BigInt(b.values[0].timestamp))
          : null;
      this.#d.store.append("FILL_SCAN", {
        from: (startCursor + 1n).toString(),
        to: cursor.toString(),
        timestamp,
      });
      if (
        !fill &&
        detail === null &&
        timestamp !== null &&
        timestamp > dep.fillDeadline
      )
        return done("PAST_DEADLINE", null, cursor, windows);
    }
    if (fill) return done("FOUND", null, cursor, windows, fill);
    return done("PENDING", detail, cursor, windows);
  }
  /** The fill transaction itself on both destination operators: final, not reorged, paying the owner >= minimum. */
  async #verifyFill(
    fill: { hash: string; amount: bigint; log: ChainLog },
    minimumOut: bigint,
  ): Promise<{
    state: "SETTLED_VERIFIED" | "DISCREPANCY" | "PENDING";
    code: string;
    paid: bigint | null;
    block: string | null;
  }> {
    const dst = this.#d.chains.destination,
      D = this.#D,
      owner = lower(this.#rec.account);
    const rc = await dst.both<{
      status: string;
      blockNumber: string;
      blockHash: string;
      logs: ChainLog[];
    }>(
      "eth_getTransactionReceipt",
      [fill.hash],
      (x) =>
        x && {
          s: (x as { status: string }).status,
          b: (x as { blockHash: string }).blockHash,
          l: (x as { logs: ChainLog[] }).logs?.map((k) => [
            lower(k.address),
            k.topics,
            k.data,
          ]),
        },
    );
    if (!rc.agree || !rc.values[0])
      return {
        state: "PENDING",
        code: "FILL_RECEIPT_NOT_AGREED",
        paid: null,
        block: null,
      };
    const x = rc.values[0];
    if (x.status !== "0x1")
      return {
        state: "DISCREPANCY",
        code: "FILL_RECEIPT_FAILED",
        paid: null,
        block: null,
      };
    if (
      typeof fill.log.blockHash === "string" &&
      lower(fill.log.blockHash) !== lower(x.blockHash)
    )
      return {
        state: "PENDING",
        code: "FILL_REORGED",
        paid: null,
        block: null,
      };
    const heads = await dst.both<string>("eth_blockNumber", [], () => null);
    const head = heads.values
      .map((h) => big(h) ?? 0n)
      .reduce((a, b) => (a < b ? a : b));
    if (head - BigInt(x.blockNumber) + 1n < BigInt(D.confirmations))
      return {
        state: "PENDING",
        code: "FILL_CONFIRMING",
        paid: null,
        block: null,
      };
    const at = await dst.both<{ hash: string }>(
      "eth_getBlockByNumber",
      [x.blockNumber, false],
      (b) => b && (b as { hash: string }).hash,
    );
    if (
      !at.agree ||
      !at.values[0] ||
      lower(at.values[0].hash) !== lower(x.blockHash)
    )
      return {
        state: "PENDING",
        code: "FILL_REORGED",
        paid: null,
        block: null,
      };
    const logs = Array.isArray(x.logs) ? x.logs : [];
    if (
      !logs.some(
        (l) =>
          lower(l.address) === lower(fill.log.address) &&
          JSON.stringify(l.topics) === JSON.stringify(fill.log.topics) &&
          lower(l.data) === lower(fill.log.data),
      )
    )
      return {
        state: "DISCREPANCY",
        code: "FILL_LOG_NOT_IN_RECEIPT",
        paid: null,
        block: null,
      };
    let paid = 0n;
    for (const l of logs) {
      if (
        lower(l.address) !== lower(D.usdc.address) ||
        l.topics?.[0] !== BRIDGE_LANE_TOPICS.transfer
      )
        continue;
      try {
        const t = decodeEventLog({
          abi: ERC20,
          data: l.data as Hex,
          topics: l.topics as [Hex, ...Hex[]],
        });
        if (lower(t.args.to) === owner) paid += t.args.value;
      } catch {
        // not a transfer
      }
    }
    const block = BigInt(x.blockNumber).toString();
    if (paid === 0n)
      return {
        state: "DISCREPANCY",
        code: "FILL_NOT_PAID_TO_OWNER",
        paid,
        block,
      };
    if (paid < minimumOut)
      return {
        state: "DISCREPANCY",
        code: "DISCREPANCY_FILL_BELOW_MINIMUM",
        paid,
        block,
      };
    if (paid < fill.amount)
      return {
        state: "DISCREPANCY",
        code: "FILL_UNDERPAID_TO_OWNER",
        paid,
        block,
      };
    // The destination pins re-read now (a SpokePool or USDC changed since the review never settles as verified).
    const dh = heads.values.map((h) => big(h) ?? 0n);
    const DB = hex(min(dh[0], dh[1]) - 1n);
    const pins = await this.#destinationPins(dst, DB);
    if (pins.problems.length || !pins.agree)
      return {
        state: "DISCREPANCY",
        code: `DESTINATION_PINS:${pins.problems.join(",") || "OPERATORS_DISAGREE"}`,
        paid,
        block,
      };
    return { state: "SETTLED_VERIFIED", code: "FILLED_TO_OWNER", paid, block };
  }
  async track(): Promise<{
    steps: Record<string, unknown>;
    state: string;
    deposit: BridgeDeposit | null;
    destination: unknown;
    settlement: unknown;
    allowance: { value: string | null; agree: boolean };
  }> {
    const src = this.#d.chains.source,
      owner = lower(this.#rec.account),
      U = this.#S.usdc.address;
    const steps: Record<string, Record<string, unknown>> = {};
    for (const step of ["APPROVE", "EXECUTE"] as const)
      steps[step] = await this.#sourceStep(step);
    // review MINOR-5: the lane's own CLEANUP, when one was dispatched (its spend counts against the budget)
    if (this.#dispatch("REVOKE"))
      steps.REVOKE = await this.#sourceStep("REVOKE");
    const a = steps.APPROVE as { state: string },
      e = steps.EXECUTE as {
        state: string;
        hash?: string | null;
        logs?: ChainLog[];
        block?: string;
      };
    let state: string;
    let deposit: BridgeDeposit | null = null;
    let destination: unknown = null;
    let settlement: unknown = null;
    // Approval first: while it is not final and successful, its own state IS the lane state.
    const reused = this.#last<Prepared>("PREPARED", "EXECUTE")?.reusedAllowance;
    const approvalSkipped =
      this.#d.reuseExistingAllowance &&
      !!reused &&
      BigInt(reused) >= BigInt(this.#rec.exactAmount) &&
      !this.#used("APPROVE") &&
      !this.#dispatch("APPROVE");
    if (a.state === "FINAL_FAILED") state = "APPROVAL_FAILED";
    else if (a.state !== "FINAL_SUCCESS" && !approvalSkipped)
      state = `APPROVE_${a.state}`;
    else if (e.state === "NOT_DISPATCHED") state = "EXECUTE_NOT_DISPATCHED";
    else if (e.state === "REFUSED") state = "EXECUTE_REFUSED";
    else if (e.state === "FINAL_FAILED") state = "SOURCE_FAILED";
    else if (e.state.startsWith("DISCREPANCY")) state = "DISCREPANCY";
    else if (e.state !== "FINAL_SUCCESS" || !e.logs || !e.hash || !e.block)
      state = "SOURCE_PENDING";
    else {
      const prepared = this.#last<Prepared>("PREPARED", "EXECUTE")!;
      const minimumOut = BigInt(prepared.minimumOut);
      const dep = this.#deposit(e.logs, e.hash, e.block, prepared);
      // The allowance after the bridge, at its block, on both operators: exactly 0.
      const left = await src.both<string>("eth_call", [
        {
          to: U,
          data: "0xdd62ed3e" + word(owner) + word(BRIDGE_LIFI_DIAMOND),
        },
        hex(BigInt(e.block)),
      ]);
      const expectedLeft = prepared.reusedAllowance
        ? BigInt(prepared.reusedAllowance) - BigInt(this.#rec.exactAmount)
        : 0n;
      const allowanceLeft =
        readFailed(left, isQty) ||
        !left.agree ||
        big(left.values[0]) !== expectedLeft;
      if (!dep.deposit) {
        state = "DISCREPANCY";
        settlement = { problems: [dep.problem] };
      } else if (allowanceLeft) {
        deposit = dep.deposit;
        state = "DISCREPANCY";
        settlement = { problems: ["ALLOWANCE_LEFT_OR_UNPROVEN"] };
      } else {
        deposit = dep.deposit;
        if (!this.#d.store.of("DEPOSIT").length)
          this.#d.store.append("DEPOSIT", deposit);
        const search = await this.#searchFill(deposit, prepared, minimumOut);
        destination = {
          from: prepared.destinationFromBlock,
          cursor: search.cursor !== null ? search.cursor.toString() : null,
          windows: search.windows,
          detail: search.detail,
        };
        if (search.status === "FOUND" && search.fill) {
          const v = await this.#verifyFill(search.fill, minimumOut);
          settlement = {
            fillHash: search.fill.hash,
            fillBlock: v.block,
            delivered: v.paid !== null ? v.paid.toString() : null,
            fillAmount: search.fill.amount.toString(),
            minimumOut: minimumOut.toString(),
            code: v.code,
            problems: v.state === "SETTLED_VERIFIED" ? [] : [v.code],
          };
          state = v.state === "PENDING" ? "DESTINATION_PENDING" : v.state;
          if (
            state === "SETTLED_VERIFIED" &&
            !this.#d.store.of("SETTLED").length
          )
            this.#d.store.append("SETTLED", {
              state,
              settlement,
              sourceHash: e.hash,
              fillHash: search.fill.hash,
            });
        } else if (search.status === "DISCREPANCY") {
          state = "DISCREPANCY";
          settlement = { problems: [search.detail] };
        } else if (search.status === "PAST_DEADLINE") {
          state = "REFUND_PENDING";
          settlement = { refund: await this.#refundEvidence(deposit) };
        } else state = "DESTINATION_PENDING";
      }
    }
    const allowanceNow = await src.both<string>("eth_call", [
      { to: U, data: "0xdd62ed3e" + word(owner) + word(BRIDGE_LIFI_DIAMOND) },
      hex(
        (await src.both<string>("eth_blockNumber", [], () => null)).values
          .map((h) => big(h) ?? 0n)
          .reduce((x, y) => (x < y ? x : y)) - 1n,
      ),
    ]);
    const allowance = {
      value: allowanceNow.agree ? String(big(allowanceNow.values[0])) : null,
      agree: allowanceNow.agree,
    };
    for (const k of Object.keys(steps)) delete steps[k].logs;
    return { steps, state, deposit, destination, settlement, allowance };
  }
  /**
   * Refund evidence on the source chain, if found (informational only; never journaled as settled): the owner's source
   * USDC balance now, against the balance right after the deposit, rose by at least the bridged amount.
   */
  async #refundEvidence(dep: BridgeDeposit) {
    const src = this.#d.chains.source,
      owner = this.#rec.account,
      U = this.#S.usdc.address;
    const at = async (B: string) =>
      src.both<string>("eth_call", [
        { to: U, data: "0x70a08231" + word(owner) },
        B,
      ]);
    const before = await at(hex(BigInt(dep.sourceBlock)));
    const heads = await src.both<string>("eth_blockNumber", [], () => null);
    const nowB = hex(
      heads.values.map((h) => big(h) ?? 0n).reduce((x, y) => (x < y ? x : y)) -
        1n,
    );
    const after = await at(nowB);
    const b0 = before.agree ? big(before.values[0]) : null,
      b1 = after.agree ? big(after.values[0]) : null;
    if (b0 === null || b1 === null)
      return { evidence: null, code: "BALANCES_NOT_AGREED" };
    return b1 - b0 >= BigInt(dep.inputAmount)
      ? {
          evidence: "SOURCE_USDC_BALANCE_ROSE",
          code: "BALANCE_EVIDENCE_ONLY",
          rise: (b1 - b0).toString(),
        }
      : { evidence: null, code: "NO_REFUND_SEEN_YET" };
  }
}
