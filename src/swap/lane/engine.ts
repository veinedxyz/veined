import { existingAllowance } from "./existing-allowance";
// VEINED-FIN-LIVE-20261115-01: the swap lane ENGINE — review, single-use authorization, dispatch and settlement of
// the ONE route the protected record names (./scope.ts SWAP_LANE_ROUTES; ENABLED routes only). Server-side only. Every
// decision is made from server reads (the route's two operators, one block) and the route's pinned values; no client
// value reaches a transaction except the owner key (checked against its digest) and identifiers this engine handed out
// itself.
//
//   review(ownerKey)        pins + balances + allowance + fresh QuoterV2 quote + pool spot (price impact, either token
//                           order) + fees (the route's fee model) + eth_simulateV1 of the REMAINING sequence with balance
//                           deltas, on BOTH operators at the same block -> Guardian (server, on these facts) ->
//                           attestation (this process's key). Never ready for a request signer v5 would certainly
//                           refuse: operator heads further apart than the chain's limit, or (OP_STACK) a non-zero or
//                           unread operator fee.
//   authorize(reviewId, k)  a fresh review only; mints ONE HMAC token for this review and step (journaled AUTH).
//   dispatch(token, k)      re-checks the token and the review's freshness, builds the canonical transaction and runs
//                           the lane gate on its own bytes (a closed gate spends nothing); then spends the token (NONCE)
//                           and the step (USE: once per route/owner/record/step, ever) in one fsynced batch, mints a
//                           single-use dispatch authority and hands it to the signer adapter.
//                           Outcome SENT / REFUSED / UNCERTAIN is journaled; UNCERTAIN is never retried.
//                           Lanes review R2: all of it (and revoke) runs inside the ONE process-wide dispatch lock
//                           shared with the bridge lane (./dispatch-lock.ts), with everything single use and the review's
//                           freshness re-checked after the signer preflight.
//   track()                 receipts on both operators (agreement, depth, block-hash re-check for reorgs), then the
//                           settlement: pay token out == amount, receive token in >= reviewed minimum (from the
//                           receipt's own logs), allowance left == 0, final balances.
// Field and problem names keep the reviewed Base vocabulary: "usdc" = the route's pay token (Circle USDC), "weth" = the
// route's receive token (its canonical wrapped native token), "eth" = the chain's native balance.
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import {
  decodeFunctionResult,
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
import type { AssetFacts, SwapFacts } from "../../guardian/model";
import { ReviewAttestor } from "../../execution/server/canary/attestation";
import type { CanaryDurableStore } from "../../execution/server/canary/durable-store";
import {
  SWAP_LANE_KEY_DOMAIN,
  swapLaneGateState,
  type OwnerSwapLaneApproval,
  type SwapLaneStepFacts,
} from "./approval";
import {
  LANE_QUOTER_ABI,
  approveCalldata,
  minimumOutFor,
  quoteCalldata,
  spotOutFor,
  swapCalldata,
} from "./calldata";
import {
  ARBITRUM_NODE_INTERFACE,
  pinnedContracts,
  pinsOf,
  routePinProblems,
  type LaneRoutePins,
} from "./pins";
import {
  SWAP_LANE_SCOPE,
  maxHeadSkewOf,
  routeById,
  type SwapLaneRoute,
  type SwapLaneStep,
} from "./scope";
import { isQuantity, strictReceiptProblem } from "./receipts";
import {
  mintLaneDispatchAuthority,
  signerPreflightProblems,
  type LaneSignerResult,
  type LaneSignerStatus,
  type LaneTx,
} from "./signer-adapter";
import { withLaneDispatchLock } from "./dispatch-lock";

export class SwapLaneError extends Error {
  constructor(
    public code: string,
    public detail: readonly string[] = [],
  ) {
    super(code);
    this.name = "SwapLaneError";
  }
}
type Both<T> = {
  values: [T | null, T | null];
  agree: boolean;
  errors: string[];
};
/** The chain the engine reads (laneReadBoth on the record's route in production; a fake chain in tests). */
export interface LaneChain {
  both<T = unknown>(
    method: string,
    params: readonly unknown[],
    pick?: (x: unknown) => unknown,
  ): Promise<Both<T>>;
}
export interface LaneSigner {
  send(
    authority: unknown,
    tx: LaneTx,
    step: SwapLaneStep | "REVOKE",
  ): Promise<LaneSignerResult>;
  /** The signer's own status after a sync (signer v5 CONTRACT-v5.md); a throw = not available. */
  status(): Promise<LaneSignerStatus>;
}
export interface LaneDeps {
  /** Explicit server composition only; never an environment or client option. */
  reuseExistingAllowance?: boolean;
  store: CanaryDurableStore;
  record: Readonly<OwnerSwapLaneApproval>;
  keyDigest: string;
  chain: LaneChain;
  signer: LaneSigner;
  now?: () => number;
  gate?: typeof swapLaneGateState;
}
const ERC20 = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);
const FACTORY = parseAbi([
  "function getPool(address,address,uint24) view returns (address)",
]);
const NODE_INTERFACE = parseAbi([
  "function gasEstimateL1Component(address to, bool contractCreation, bytes data) payable returns (uint64 gasEstimateForL1, uint256 baseFee, uint256 l1BaseFeeEstimate)",
]);
/** First 32-byte word of an eth_call result as a bigint, else null. */
const firstWord = (x: unknown) =>
  typeof x === "string" && /^0x[0-9a-fA-F]{64,}$/.test(x)
    ? BigInt("0x" + x.slice(2, 66))
    : null;
const ORACLE = parseAbi([
  "function getL1Fee(bytes) view returns (uint256)",
  "function getOperatorFee(uint256) view returns (uint256)",
]);
const word = (a: string) =>
  a.toLowerCase().replace(/^0x/, "").padStart(64, "0");
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

export interface LaneReview {
  /** Existing permission, bound to this attested review; no new approval requested. */
  reusedAllowance?: string;
  reviewId: string;
  route: string;
  chainId: string;
  ready: boolean;
  step: SwapLaneStep | null;
  problems: string[];
  block: string;
  blockTime: number;
  readAt: number;
  expiresAt: number;
  amountIn: string;
  quoteOut: string;
  spotOut: string;
  priceImpactBps: number;
  slippageBps: number;
  amountOutMinimum: string;
  deadline: string;
  balances: { usdc: string; weth: string; eth: string; allowance: string };
  simulation: {
    usdcDelta: string;
    wethDelta: string;
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
  step: SwapLaneStep;
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
type DispatchRecord = {
  step: string;
  outcome: string;
  hash: string | null;
};
const handedOff = (d: { outcome?: unknown } | undefined) =>
  d?.outcome === "SENT" || d?.outcome === "UNCERTAIN";

export class SwapLaneEngine {
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
  readonly #d: LaneDeps;
  readonly #now: () => number;
  readonly #route: Readonly<SwapLaneRoute>;
  readonly #pins: Readonly<LaneRoutePins>;
  readonly #attestor = new ReviewAttestor();
  readonly #tokenKey = randomBytes(32);
  readonly #reviews = new Map<string, LaneReview>();
  constructor(d: LaneDeps) {
    // The engine serves exactly the route its record names, and only an ENABLED route with its own pin set.
    const route = routeById(d.record?.route);
    if (!route || route.status !== "ENABLED")
      throw new SwapLaneError("ROUTE_NOT_ENABLED");
    const pins = pinsOf(route.id);
    if (!pins || pins.route !== route.id)
      throw new SwapLaneError("PIN_SET_MISSING");
    this.#d = d;
    this.#now = d.now ?? Date.now;
    this.#route = route;
    this.#pins = pins;
  }
  get #rec() {
    return this.#d.record;
  }
  /** The route this engine serves (frozen table entry). */
  get route(): Readonly<SwapLaneRoute> {
    return this.#route;
  }
  #useKey(step: SwapLaneStep | "REVOKE") {
    return `${this.#route.id}:${lower(this.#rec.account)}:${this.#rec.approvalId}:${step}`;
  }
  #used(step: SwapLaneStep | "REVOKE") {
    return this.#d.store
      .of("USE")
      .some((e) => (e.data as { key?: string })?.key === this.#useKey(step));
  }
  /**
   * The recorded outcome of a step: the last DISPATCH entry of that step — except that a SENT or UNCERTAIN hand-off is
   * never shadowed by a later refusal of the same step (lanes review R2 NEW-1, defence in depth).
   */
  #dispatch(step: SwapLaneStep | "REVOKE"): DispatchRecord | undefined {
    const all = this.#d.store
      .of("DISPATCH")
      .map((e) => e.data as DispatchRecord)
      .filter((d) => d?.step === step);
    return all.filter(handedOff).at(-1) ?? all.at(-1);
  }
  /** The process-wide dispatch lock's name for this record (./dispatch-lock.ts). */
  get #lockKey() {
    return `SWAP:${this.#route.id}:${lower(this.#rec.account)}:${this.#rec.approvalId}`;
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
    step: SwapLaneStep | "REVOKE",
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
  #receipt(step: SwapLaneStep | "REVOKE") {
    return this.#d.store
      .of("RECEIPT")
      .filter((e) => (e.data as { step?: string }).step === step)
      .at(-1)?.data as
      | {
          step: string;
          status: string;
          block: string;
          blockHash: string;
          gasUsed: string;
          effectiveGasPrice: string;
          l1Fee: string;
        }
      | undefined;
  }
  checkKey(ownerKey: unknown) {
    if (typeof ownerKey !== "string" || !/^[0-9a-f]{64}$/.test(ownerKey))
      throw new SwapLaneError("OWNER_KEY_INVALID");
    const got = Buffer.from(
      createHash("sha256")
        .update(
          Buffer.from(
            stringToHex(`${SWAP_LANE_KEY_DOMAIN}:${ownerKey}`).slice(2),
            "hex",
          ),
        )
        .digest("hex"),
    );
    if (!timingSafeEqual(got, Buffer.from(this.#d.keyDigest)))
      throw new SwapLaneError("OWNER_KEY_MISMATCH");
  }
  /** The next step of the single sequence, or null when both are used. */
  nextStep(): SwapLaneStep | null {
    if (this.#d.reuseExistingAllowance && this.#used("SWAP")) return null;
    if (!this.#used("APPROVE") && !this.#reusingAllowance()) return "APPROVE";
    if (!this.#used("SWAP")) return "SWAP";
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

  // ------------------------------------------------------------------------------------------------ review
  async review(ownerKey: unknown): Promise<LaneReview> {
    this.checkKey(ownerKey);
    this.#existingAllowance = null;
    if (
      this.#d.reuseExistingAllowance &&
      !this.#used("APPROVE") &&
      !this.#dispatch("APPROVE") &&
      !this.#used("SWAP") &&
      !this.#dispatch("SWAP")
    )
      this.#existingAllowance = await existingAllowance(
        this.#d.chain,
        this.#rec.account,
        this.#route.pay.address,
        this.#route.router,
      );
    const rec = this.#rec,
      route = this.#route,
      pins = this.#pins,
      c = this.#d.chain,
      now = this.#now();
    const U = route.pay.address,
      W = route.receive.address,
      R = route.router;
    const P: string[] = [];
    if (now < rec.notBefore) P.push("NOT_YET_VALID");
    if (now >= rec.notAfter) P.push("APPROVAL_EXPIRED");
    const step = this.nextStep();
    if (step === null) P.push("LANE_ALREADY_USED");
    // fl1 final review NEW-3: a step marked used with no dispatch record (a crash between the two) is never reviewed
    // past: the signer journal and the chain must be reconciled read-only first.
    for (const s of ["APPROVE", "SWAP"] as const)
      if (this.#used(s) && !this.#dispatch(s))
        P.push(`LANE_RECOVERY_REQUIRED:${s}`);
    if (step === "SWAP" && !this.#reusingAllowance()) {
      const a = this.#receipt("APPROVE");
      if (!a) P.push("APPROVAL_NOT_FINAL");
      else if (a.status !== "0x1") P.push("APPROVAL_FAILED");
    }
    const owner = rec.account,
      amountIn = BigInt(rec.exactAmount);
    // One block both operators have: the lower head minus one.
    const heads = await c.both<string>("eth_blockNumber", [], () => null);
    if (heads.values.some((h) => big(h) === null))
      throw new SwapLaneError("HEAD_UNAVAILABLE");
    const hs = heads.values.map((h) => big(h) as bigint);
    // Signer v5 reads at one block of both operators and refuses heads further apart than the chain's limit: a review
    // the signer would certainly refuse is never ready (a refusal spends the step).
    const skewLimit = maxHeadSkewOf(route.chainId);
    const skew = hs[0] > hs[1] ? hs[0] - hs[1] : hs[1] - hs[0];
    if (skewLimit === null || skew > BigInt(skewLimit))
      P.push("OPERATOR_HEADS_TOO_FAR_APART");
    const blockN = (hs[0] < hs[1] ? hs[0] : hs[1]) - 1n;
    const B = hex(blockN);
    const blk = await c.both<{
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
        },
    );
    if (!blk.agree || !blk.values[0] || big(blk.values[0].timestamp) === null)
      throw new SwapLaneError("OPERATORS_DISAGREE", ["BLOCK"]);
    const blockTime = Number(BigInt(blk.values[0].timestamp)) * 1000;
    const age = blockAgeMs(now, blockTime);
    if (age === null) P.push("REVIEW_BLOCK_IN_FUTURE");
    else if (age > route.maxReviewBlockAgeSec * 1000)
      P.push("REVIEW_BLOCK_TOO_OLD");
    const baseFeeRead = big(blk.values[0].baseFeePerGas);
    if (baseFeeRead === null) P.push("BASE_FEE_UNPROVEN");
    const baseFee = baseFeeRead ?? 0n;
    // VEINED-MC1 review NIT-4: both operators must be on the route's chain.
    const chainIds = await c.both<string>("eth_chainId", [], () => null);
    if (readFailed(chainIds, isQty)) P.push("OPERATOR_READ_FAILED:CHAIN_ID");
    else if (chainIds.values.some((x) => big(x) !== BigInt(route.chainId)))
      P.push("OPERATOR_CHAIN_ID_MISMATCH");
    // VEINED-MC1 review MAJOR-1: the signer's own status (after a sync) — a step it would certainly refuse (anything in
    // flight or uncertain on any chain, another burner, a route it does not enable, a step it signed once, a session
    // about to end) is never ready.
    let signer: LaneSignerStatus | null = null;
    try {
      signer = await this.#d.signer.status();
    } catch {
      signer = null;
    }
    for (const r of signerPreflightProblems(signer, {
      account: owner,
      route: route.id,
      signerStep:
        step === null ? null : step === "SWAP" ? "EXECUTE" : "APPROVE",
      chainId: route.chainId,
      nowMs: now,
    }))
      P.push(`SIGNER_NOT_READY:${r}`);
    // VEINED-MC1 review MINOR-1: the nonce anchor is the SIGNER's. At the read block the owner's nonce (both operators,
    // "pending" equal to it) must be the signer's firstNonce on this chain plus every signature it made on this chain;
    // this lane's own SENT / UNCERTAIN dispatches can never exceed those signatures; and the record's firstNonce stays a
    // lower bound. Another lane of the same signer no longer breaks this anchor; a moved or second journal still does.
    const nonceAt = await c.both<string>("eth_getTransactionCount", [owner, B]);
    const noncePending = await c.both<string>("eth_getTransactionCount", [
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
    const sc = signer?.chains[route.chainId];
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
    // Pins: the pin set must describe this route, every code hash must be verified and unchanged, the pay token's
    // implementation slot, the factory's pool, the pool's tokens (in the route's order) and fee.
    const pinProblems: string[] = routePinProblems(route.id);
    let operatorsAgree = true;
    for (const p of pinnedContracts(pins)) {
      if (p.codehash === null) {
        pinProblems.push(`PIN_UNVERIFIED:${p.address}`);
        continue;
      }
      const code = await c.both<string>("eth_getCode", [p.address, B], (x) =>
        isCode(x) ? keccak256(x as Hex) : null,
      );
      if (readFailed(code, isCode)) {
        operatorsAgree = false;
        pinProblems.push(`OPERATOR_READ_FAILED:CODE:${p.address}`);
        continue;
      }
      if (!code.agree) {
        operatorsAgree = false;
        pinProblems.push(`CODE_DISAGREE:${p.address}`);
        continue;
      }
      if (
        typeof code.values[0] !== "string" ||
        keccak256(code.values[0] as Hex) !== p.codehash
      )
        pinProblems.push(`CODE_CHANGED:${p.address}`);
    }
    const implPin = pins.pay.implementation;
    if (implPin) {
      const impl = await c.both<string>("eth_getStorageAt", [
        U,
        implPin.slot,
        B,
      ]);
      if (readFailed(impl, isHex))
        pinProblems.push("OPERATOR_READ_FAILED:USDC_IMPLEMENTATION");
      else if (
        !impl.agree ||
        !same("0x" + String(impl.values[0]).slice(-40), implPin.address)
      )
        pinProblems.push("USDC_IMPLEMENTATION_CHANGED");
    }
    const call = async (to: string, data: string, from?: string) =>
      c.both<string>("eth_call", [from ? { from, to, data } : { to, data }, B]);
    const poolOf = await call(
      route.factory,
      encodeFunctionData({
        abi: FACTORY,
        functionName: "getPool",
        args: [U as Hex, W as Hex, route.poolFee],
      }),
    );
    if (readFailed(poolOf, isHex))
      pinProblems.push("OPERATOR_READ_FAILED:FACTORY_POOL");
    else if (
      !poolOf.agree ||
      !same("0x" + String(poolOf.values[0]).slice(-40), route.pool)
    )
      pinProblems.push("FACTORY_POOL_MISMATCH");
    const t0 = await call(route.pool, "0x0dfe1681"),
      t1 = await call(route.pool, "0xd21220a7"),
      fee = await call(route.pool, "0xddca3f43");
    const [want0, want1] = route.payIsToken0 ? [U, W] : [W, U];
    if ([t0, t1, fee].some((x) => readFailed(x, isHex)))
      pinProblems.push("OPERATOR_READ_FAILED:POOL_SHAPE");
    else if (
      !t0.agree ||
      !t1.agree ||
      !fee.agree ||
      !same("0x" + String(t0.values[0]).slice(-40), want0) ||
      !same("0x" + String(t1.values[0]).slice(-40), want1) ||
      big(fee.values[0]) !== BigInt(route.poolFee)
    )
      pinProblems.push("POOL_SHAPE_MISMATCH");
    P.push(...pinProblems);
    // Balances / allowance / nonce at this block.
    const usdcBal = await call(U, "0x70a08231" + word(owner)),
      wethBal = await call(W, "0x70a08231" + word(owner));
    const allowance = await call(U, "0xdd62ed3e" + word(owner) + word(R));
    const eth = await c.both<string>("eth_getBalance", [owner, B]);
    for (const [n, x] of [
      ["USDC", usdcBal],
      ["WETH", wethBal],
      ["ALLOWANCE", allowance],
      ["ETH", eth],
    ] as const)
      if (!x.agree) {
        operatorsAgree = false;
        P.push(`OPERATORS_DISAGREE:${n}`);
      }
    const usdc = big(usdcBal.values[0]) ?? 0n,
      weth = big(wethBal.values[0]) ?? 0n,
      allow = big(allowance.values[0]) ?? 0n,
      ethWei = big(eth.values[0]) ?? 0n;
    if (
      this.#d.reuseExistingAllowance &&
      this.#existingAllowance !== null &&
      allow !== this.#existingAllowance
    )
      P.push("ALLOWANCE_CHANGED_DURING_REVIEW");
    if (step === "APPROVE" && allow !== 0n && !this.#d.reuseExistingAllowance)
      P.push("ALLOWANCE_NOT_ZERO_BEFORE_APPROVE");
    if (
      step === "SWAP" &&
      (this.#reusingAllowance() ? allow < amountIn : allow !== amountIn)
    )
      P.push("ALLOWANCE_NOT_EXACT_BEFORE_SWAP");
    if (usdc < amountIn) P.push("USDC_BALANCE_BELOW_AMOUNT");
    // Fresh quote (QuoterV2) at this block on both operators, and the pool's spot price for the price impact.
    const q = await call(route.quoter, quoteCalldata(route, amountIn));
    let quoteOut = 0n;
    if (!q.agree || !q.values[0]) {
      operatorsAgree = false;
      P.push("QUOTE_OPERATORS_DISAGREE");
    } else
      try {
        quoteOut = (
          decodeFunctionResult({
            abi: LANE_QUOTER_ABI,
            functionName: "quoteExactInputSingle",
            data: q.values[0] as Hex,
          }) as readonly bigint[]
        )[0];
      } catch {
        P.push("QUOTE_UNREADABLE");
      }
    const s0 = await call(route.pool, "0x3850c7bd");
    let spotOut = 0n;
    if (!s0.agree || !s0.values[0]) {
      operatorsAgree = false;
      P.push("SPOT_OPERATORS_DISAGREE");
    } else {
      const sqrtP = big("0x" + (s0.values[0] as string).slice(2, 66)) ?? 0n;
      // The route's token order decides the direction (./calldata.ts spotOutFor).
      spotOut = spotOutFor(route, amountIn, sqrtP);
    }
    if (quoteOut <= 0n) P.push("NO_QUOTE");
    const impactBps =
      spotOut > 0n && quoteOut > 0n
        ? Number(
            ((spotOut - (quoteOut < spotOut ? quoteOut : spotOut)) * 10_000n) /
              spotOut,
          )
        : 10_000;
    if (impactBps > SWAP_LANE_SCOPE.maxPriceImpactBps)
      P.push("PRICE_IMPACT_ABOVE_LANE_LIMIT");
    const slippageBps = Math.min(
      SWAP_LANE_SCOPE.appliedSlippageBps,
      rec.maxSlippageBps,
    );
    const amountOutMinimum = minimumOutFor(quoteOut, slippageBps);
    const deadline = BigInt(
      Math.floor(now / 1000) + SWAP_LANE_SCOPE.deadlineSec,
    );
    // Simulation of the REMAINING sequence on both operators, with balance reads around it (no state override).
    const approveTx = {
      from: owner,
      to: U,
      data: approveCalldata(route, amountIn),
    };
    const swapTx = {
      from: owner,
      to: R,
      data: swapCalldata(route, {
        owner,
        amountIn,
        amountOutMinimum,
        deadline,
      }),
    };
    const reads = [
      { from: owner, to: U, data: "0x70a08231" + word(owner) },
      { from: owner, to: W, data: "0x70a08231" + word(owner) },
    ];
    const seq =
      step === "APPROVE"
        ? [approveTx, swapTx]
        : step === "SWAP"
          ? [swapTx]
          : [];
    let simulation: LaneReview["simulation"] = null;
    const gasUsed: Record<string, bigint> = {};
    if (seq.length && quoteOut > 0n) {
      const calls = [
        ...reads,
        ...seq,
        ...reads,
        { from: owner, to: U, data: "0xdd62ed3e" + word(owner) + word(R) },
      ];
      const sim = await c.both<
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
        const n = reads.length,
          m = seq.length;
        const v = (i: number) => big(res[i].returnData) ?? -1n;
        const usdcDelta = v(n + m) - v(0),
          wethDelta = v(n + m + 1) - v(1),
          allowanceAfter = v(n + m + 2);
        if (usdcDelta !== -amountIn) P.push("SIMULATED_USDC_DELTA_NOT_EXACT");
        if (wethDelta < amountOutMinimum)
          P.push("SIMULATED_WETH_BELOW_MINIMUM");
        const expectedAllowance =
          step === "SWAP" && this.#reusingAllowance() ? allow - amountIn : 0n;
        if (allowanceAfter !== expectedAllowance)
          P.push("SIMULATED_ALLOWANCE_LEFT");
        const res2 = sim.values[1]?.[0]?.calls;
        seq.forEach((t, i) => {
          const g0 = big(res[n + i].gasUsed) ?? 0n;
          const g1 = big(res2?.[n + i]?.gasUsed) ?? 0n;
          gasUsed[t === approveTx ? "APPROVE" : "SWAP"] = max(g0, g1);
        });
        simulation = {
          usdcDelta: usdcDelta.toString(),
          wethDelta: wethDelta.toString(),
          allowanceAfter: allowanceAfter.toString(),
          gasUsed: Object.fromEntries(
            Object.entries(gasUsed).map(([k, g]) => [k, g.toString()]),
          ),
        };
      }
    }
    // Fees: base fee of the read block (agreed), tip = higher of the two operators clamped to the route's
    // [minTipWei, maxTipWei], cap = 3 x base + tip.
    const tipR = await c.both<string>(
      "eth_maxPriorityFeePerGas",
      [],
      () => null,
    );
    const tips = tipR.values.map((t) => big(t) ?? 0n);
    const highTip = max(tips[0], tips[1]);
    // Review MAJOR-3: one operator cannot push the fee above the signer's ceiling (a certain refusal that would spend
    // the step): the tip is bounded, the cap keeps 3x base-fee headroom, and the ceiling is checked here.
    const tip =
      highTip > route.maxTipWei
        ? route.maxTipWei
        : highTip < route.minTipWei
          ? route.minTipWei
          : highTip;
    const maxFeePerGas = 3n * baseFee + tip;
    if (maxFeePerGas > route.maxFeePerGasWei)
      P.push("FEE_CAP_ABOVE_SIGNER_POLICY");
    // ARBITRUM fee model: the L1 component is charged as extra gas units, which eth_simulateV1's gasUsed may not
    // include; the step under review is also estimated on both operators (eth_estimateGas includes it), and the limit
    // is the larger of simulated x margin and estimate x margin. (The later step of an APPROVE review cannot be
    // estimated before the allowance exists; its own review estimates it.)
    const estimates: Record<string, bigint> = {};
    const arbL1: Record<string, bigint> = {};
    if (route.feeModel === "ARBITRUM" && step && gasUsed[step] !== undefined) {
      const t = step === "APPROVE" ? approveTx : swapTx;
      const est = await c.both<string>(
        "eth_estimateGas",
        [{ from: t.from, to: t.to, data: t.data }, B],
        () => null,
      );
      const e = est.values.map((x) => big(x));
      if (e.some((x) => x === null || x <= 0n)) {
        P.push(`GAS_ESTIMATE_UNPROVEN:${step}`);
        P.push("ARBITRUM_SIGNER_READS_UNAVAILABLE");
      } else estimates[step] = max(e[0] as bigint, e[1] as bigint);
      // VEINED-MC1 review MINOR-3: signer v5 also reads NodeInterface.gasEstimateL1Component on BOTH operators and
      // refuses without it (ARB_L1_COMPONENT_UNKNOWN): mirrored here, with its two rules on the limit and the estimate.
      const l1c = await c.both<string>(
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
    const limits: Record<string, bigint> = {};
    for (const [k, g] of Object.entries(gasUsed)) {
      let lim = (g * (10_000n + SWAP_LANE_SCOPE.gasMarginBps)) / 10_000n;
      if (estimates[k] !== undefined)
        lim = max(
          lim,
          (estimates[k] * (10_000n + SWAP_LANE_SCOPE.estimateMarginBps)) /
            10_000n,
        );
      const cap = k === "APPROVE" ? route.maxGas.APPROVE : route.maxGas.SWAP;
      if (lim > cap) P.push(`GAS_ABOVE_CAP:${k}`);
      if (lim < SWAP_LANE_SCOPE.minGas) P.push(`GAS_BELOW_FLOOR:${k}`);
      // signer v5: gas >= 21 000 + L1 component, and the estimate itself must include the L1 component
      if (arbL1[k] !== undefined) {
        if (lim < 21_000n + arbL1[k])
          P.push(`ARBITRUM_GAS_BELOW_L1_COMPONENT:${k}`);
        if (estimates[k] !== undefined && estimates[k] < arbL1[k])
          P.push(`ARBITRUM_ESTIMATE_EXCLUDES_L1:${k}`);
      }
      limits[k] = lim;
    }
    // OP_STACK fee model: the L1 data fee of the step under review, read from the GasPriceOracle on both operators for
    // the transaction serialized with THIS route's chain id. Other fee models have no separate L1 fee.
    let l1Fee = 0n;
    if (step && route.feeModel === "OP_STACK") {
      const t = step === "APPROVE" ? approveTx : swapTx;
      if (!pins.gasPriceOracle) P.push("L1_FEE_UNPROVEN");
      else {
        // VEINED-MC1 review NIT-3: serialized with the anchored nonce (as the signer serializes it).
        const unsigned = serializeTransaction({
          type: "eip1559",
          chainId: Number(route.chainId),
          nonce: Number(nonce ?? 0n),
          to: t.to as Hex,
          value: 0n,
          data: t.data as Hex,
          gas: limits[step] ?? 300_000n,
          maxFeePerGas,
          maxPriorityFeePerGas: tip,
        });
        const l1 = await c.both<string>(
          "eth_call",
          [
            {
              to: pins.gasPriceOracle,
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
        // Review MINOR-2: an unread L1 fee is a problem, never 0.
        if (l1.values.some((x) => big(x) === null)) P.push("L1_FEE_UNPROVEN");
        const vals = l1.values.map((x) => big(x) ?? 0n);
        l1Fee =
          max(vals[0], vals[1]) * BigInt(Object.keys(limits).length || 1) * 2n;
        // Signer v5 (Isthmus): GasPriceOracle.getOperatorFee(tx gas) must read 0 on BOTH operators, else the signer
        // refuses. The fee is non-decreasing in the gas, so 0 at the largest limit of this review is 0 for every step.
        const opGas = Object.values(limits).reduce(
          (a, g) => max(a, g),
          route.maxGas.SWAP,
        );
        const opFee = await c.both<string>(
          "eth_call",
          [
            {
              to: pins.gasPriceOracle,
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
      Object.values(limits).reduce((a, g) => a + g * maxFeePerGas, 0n) +
      l1Fee;
    if (worst > BigInt(rec.nativeGasBudgetWei)) P.push("GAS_BUDGET");
    if (ethWei < worst - spent) P.push("ETH_BELOW_WORST_CASE");
    // Guardian on the server's own facts (spender pinned by construction and re-checked from the built calldata).
    const asset = (address: string, symbol: string): AssetFacts => {
      const a = knownAsset(route.chainId, address, false);
      return {
        chainId: route.chainId,
        address,
        symbol,
        native: false,
        level: a?.level as AssetFacts["level"],
        risk: (a?.risk ?? []) as AssetFacts["risk"],
      };
    };
    const facts: SwapFacts = {
      kind: "swap",
      chainId: route.chainId,
      ecosystem: "EVM",
      sender: owner,
      recipient: owner,
      pay: asset(U, route.pay.symbol),
      receive: asset(W, route.receive.symbol),
      quote: {
        provider: "Uniswap",
        priceImpactBps: impactBps,
        slippageBps,
        hops: 1,
        splitCount: 1,
        amountOut: quoteOut.toString(),
        minAmountOut: amountOutMinimum.toString(),
        inputUsdMicros: null,
        outputUsdMicros: null,
        quotedAt: now,
        expiresAt: now + SWAP_LANE_SCOPE.reviewTtlSec * 1000,
        platformFee: "0",
      },
      approval: { kind: "ERC20", spender: R, amount: amountIn.toString() },
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
    const reviewId = "0x" + randomBytes(16).toString("hex");
    const out: LaneReview = {
      reviewId,
      route: route.id,
      chainId: route.chainId,
      ready: P.length === 0,
      step,
      problems: P,
      block: blockN.toString(),
      blockTime,
      readAt: now,
      expiresAt: now + SWAP_LANE_SCOPE.reviewTtlSec * 1000,
      amountIn: amountIn.toString(),
      quoteOut: quoteOut.toString(),
      spotOut: spotOut.toString(),
      priceImpactBps: impactBps,
      slippageBps,
      amountOutMinimum: amountOutMinimum.toString(),
      deadline: deadline.toString(),
      balances: {
        usdc: usdc.toString(),
        weth: weth.toString(),
        eth: ethWei.toString(),
        allowance: allow.toString(),
      },
      ...(this.#reusingAllowance()
        ? { reusedAllowance: allow.toString() }
        : {}),
      simulation,
      gas: {
        maxFeePerGas: maxFeePerGas.toString(),
        maxPriorityFeePerGas: tip.toString(),
        limits: Object.fromEntries(
          Object.entries(limits).map(([k, g]) => [k, g.toString()]),
        ),
        l1FeeWei: l1Fee.toString(),
        spentWei: spent.toString(),
        worstCaseTotalWei: worst.toString(),
        budgetWei: rec.nativeGasBudgetWei,
      },
      guardian,
      pins: { set: pins.set, problems: pinProblems },
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
      route: route.id,
      step,
      ready: out.ready,
      problems: P,
      block: out.block,
      quoteOut: out.quoteOut,
      amountOutMinimum: out.amountOutMinimum,
      priceImpactBps: impactBps,
      guardian,
      gas: out.gas,
      simulation,
      digest: sha(JSON.stringify(payload)),
    });
    return out;
  }
  #fresh(reviewId: unknown): LaneReview {
    const r =
      typeof reviewId === "string" ? this.#reviews.get(reviewId) : undefined;
    if (!r) throw new SwapLaneError("REVIEW_UNKNOWN");
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
      throw new SwapLaneError("REVIEW_NOT_ATTESTED");
    if (r.route !== this.#route.id)
      throw new SwapLaneError("REVIEW_OTHER_ROUTE");
    if (!r.ready || !r.step)
      throw new SwapLaneError("REVIEW_NOT_READY", r.problems);
    if (this.#now() >= r.expiresAt) throw new SwapLaneError("REVIEW_EXPIRED");
    if (
      r.reusedAllowance !==
      (this.#reusingAllowance()
        ? this.#existingAllowance?.toString()
        : undefined)
    )
      throw new SwapLaneError("ALLOWANCE_REVIEW_STALE");
    if (r.step !== this.nextStep())
      throw new SwapLaneError("REVIEW_STEP_STALE");
    return r;
  }
  // ------------------------------------------------------------------------------------------------ authorize
  #mac(t: Omit<Token, "mac">) {
    return createHmac("sha256", this.#tokenKey)
      .update(
        JSON.stringify([
          "veined.swap-lane.authorization.v1",
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
    if (this.#used(r.step!)) throw new SwapLaneError("STEP_ALREADY_USED");
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
      throw new SwapLaneError("TOKEN_INVALID");
    }
    if (!t || typeof t.mac !== "string" || !/^[0-9a-f]{64}$/.test(t.mac))
      throw new SwapLaneError("TOKEN_INVALID");
    const { mac, ...body } = t;
    if (!timingSafeEqual(Buffer.from(this.#mac(body)), Buffer.from(mac)))
      throw new SwapLaneError("TOKEN_INVALID");
    if (t.record !== this.#rec.approvalId)
      throw new SwapLaneError("TOKEN_RECORD_MISMATCH");
    if (this.#now() >= t.notAfter) throw new SwapLaneError("TOKEN_EXPIRED");
    if (this.#tokenSpent(t.id)) throw new SwapLaneError("TOKEN_REPLAYED");
    return t;
  }
  /**
   * Lanes review R2 NEW-1 / NEW-2: re-checked synchronously AFTER the preflight await, right before the step is spent.
   * The token and the review must still be fresh (a slow sync never spends a stale review), the token unspent, the
   * step unused and still next, and no other single-use entry may have been journaled since the checks began.
   */
  #recheck(t: Token, r: LaneReview, seen: JournalMark) {
    const now = this.#now();
    const after = ["AFTER_SIGNER_PREFLIGHT"];
    if (now >= t.notAfter) throw new SwapLaneError("TOKEN_EXPIRED", after);
    if (now >= r.expiresAt) throw new SwapLaneError("REVIEW_EXPIRED", after);
    if (this.#tokenSpent(t.id))
      throw new SwapLaneError("DISPATCH_DUPLICATE", ["TOKEN_REPLAYED"]);
    if (this.#used(t.step))
      throw new SwapLaneError("DISPATCH_DUPLICATE", ["STEP_ALREADY_USED"]);
    if (
      r.reusedAllowance !==
      (this.#reusingAllowance()
        ? this.#existingAllowance?.toString()
        : undefined)
    )
      throw new SwapLaneError("ALLOWANCE_REVIEW_STALE");
    if (t.step !== this.nextStep())
      throw new SwapLaneError("DISPATCH_DUPLICATE", ["REVIEW_STEP_STALE"]);
    if (this.#changedSince(seen))
      throw new SwapLaneError("DISPATCH_DUPLICATE", [
        "OTHER_DISPATCH_RECORDED",
      ]);
  }
  /** The signer preflight of one step: journaled (SIGNER_PREFLIGHT) and refused without spending unless clean. */
  async #preflight(signerStep: string, step: SwapLaneStep | "REVOKE") {
    let s: LaneSignerStatus | null = null;
    try {
      s = await this.#d.signer.status();
    } catch {
      s = null;
    }
    if (step === "SWAP" && this.#reusingAllowance()) {
      const current = await existingAllowance(
        this.#d.chain,
        this.#rec.account,
        this.#route.pay.address,
        this.#route.router,
      );
      if (current !== this.#existingAllowance)
        throw new SwapLaneError("ALLOWANCE_CHANGED_BEFORE_DISPATCH");
    }
    const reasons = signerPreflightProblems(s, {
      account: this.#rec.account,
      route: this.#route.id,
      signerStep,
      chainId: this.#route.chainId,
      nowMs: this.#now(),
    });
    this.#d.store.append("SIGNER_PREFLIGHT", {
      step,
      ok: reasons.length === 0,
      reasons,
      inFlight: s?.inFlight ?? null,
      uncertain: s?.uncertain ?? null,
      signedCount: s?.chains[this.#route.chainId]?.signedCount ?? null,
    });
    if (reasons.length)
      throw new SwapLaneError(
        "SIGNER_NOT_READY",
        reasons.map((r) => `SIGNER_NOT_READY:${r}`),
      );
  }
  // ------------------------------------------------------------------------------------------------ revoke
  /**
   * VEINED-MC1 review MINOR-5: the lane's own CLEANUP. ONE approve(router, 0), single use, allowed only after this
   * lane's APPROVE is final and successful AND its SWAP was refused before signing, failed on chain, or was never
   * dispatched within the record window, AND both operators show a remaining allowance > 0. Fresh reads at one block,
   * the route's fee model, the record budget, the gate (step REVOKE) and the signer preflight decide BEFORE anything is
   * spent; then USE + PREPARED in one batch and the CLEANUP hand-off. Nothing is ever resent.
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
      () => new SwapLaneError("DISPATCH_IN_PROGRESS"),
      async () => {
        const rec = this.#rec,
          route = this.#route,
          pins = this.#pins,
          c = this.#d.chain,
          now = this.#now();
        const owner = rec.account,
          U = route.pay.address,
          R = route.router;
        if (this.#used("REVOKE"))
          throw new SwapLaneError("REVOKE_ALREADY_USED");
        const seen = this.#mark();
        const P: string[] = [];
        for (const s of ["APPROVE", "SWAP"] as const)
          if (this.#used(s) && !this.#dispatch(s))
            P.push(`LANE_RECOVERY_REQUIRED:${s}`);
        const a = this.#receipt("APPROVE");
        if (!a || a.status !== "0x1")
          P.push("REVOKE_NOT_ALLOWED:APPROVE_NOT_FINAL");
        const d = this.#dispatch("SWAP"),
          x = this.#receipt("SWAP");
        const executeDead =
          (d &&
            (d.outcome === "REFUSED" ||
              d.outcome === "REFUSED_BEFORE_SIGNER")) ||
          (x && x.status === "0x0") ||
          (!this.#used("SWAP") && now >= rec.notAfter);
        if (!executeDead) P.push("REVOKE_NOT_ALLOWED:SWAP_NOT_DECIDED_FAILED");
        const heads = await c.both<string>("eth_blockNumber", [], () => null);
        if (heads.values.some((h) => big(h) === null))
          throw new SwapLaneError("HEAD_UNAVAILABLE");
        const hs = heads.values.map((h) => big(h) as bigint);
        const skewLimit = maxHeadSkewOf(route.chainId);
        if (
          skewLimit === null ||
          (hs[0] > hs[1] ? hs[0] - hs[1] : hs[1] - hs[0]) > BigInt(skewLimit)
        )
          P.push("OPERATOR_HEADS_TOO_FAR_APART");
        const B = hex((hs[0] < hs[1] ? hs[0] : hs[1]) - 1n);
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
          throw new SwapLaneError("OPERATORS_DISAGREE", ["BLOCK"]);
        const age = blockAgeMs(
          now,
          Number(BigInt(blk.values[0].timestamp)) * 1000,
        );
        if (age === null) P.push("REVIEW_BLOCK_IN_FUTURE");
        else if (age > route.maxReviewBlockAgeSec * 1000)
          P.push("REVIEW_BLOCK_TOO_OLD");
        const baseFee = big(blk.values[0].baseFeePerGas);
        if (baseFee === null) P.push("BASE_FEE_UNPROVEN");
        const chainIds = await c.both<string>("eth_chainId", [], () => null);
        if (readFailed(chainIds, isQty))
          P.push("OPERATOR_READ_FAILED:CHAIN_ID");
        else if (chainIds.values.some((y) => big(y) !== BigInt(route.chainId)))
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
        const sc = signer?.chains[route.chainId];
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
        const allowance = await c.both<string>("eth_call", [
          { to: U, data: "0xdd62ed3e" + word(owner) + word(R) },
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
          data: approveCalldata(route, 0n),
        };
        const sim = await c.both<
          { calls: { status: string; returnData: string; gasUsed: string }[] }[]
        >(
          "eth_simulateV1",
          [
            {
              blockStateCalls: [
                {
                  calls: [
                    revokeTx,
                    {
                      from: owner,
                      to: U,
                      data: "0xdd62ed3e" + word(owner) + word(R),
                    },
                  ],
                },
              ],
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
          highTip > route.maxTipWei
            ? route.maxTipWei
            : highTip < route.minTipWei
              ? route.minTipWei
              : highTip;
        const maxFeePerGas = 3n * (baseFee ?? 0n) + tip;
        if (maxFeePerGas > route.maxFeePerGasWei)
          P.push("FEE_CAP_ABOVE_SIGNER_POLICY");
        let limit =
          (gasUsed * (10_000n + SWAP_LANE_SCOPE.gasMarginBps)) / 10_000n;
        if (route.feeModel === "ARBITRUM") {
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
                  args: [U as Hex, false, revokeTx.data as Hex],
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
              (em * (10_000n + SWAP_LANE_SCOPE.estimateMarginBps)) / 10_000n,
            );
            if (limit < 21_000n + lm)
              P.push("ARBITRUM_GAS_BELOW_L1_COMPONENT:REVOKE");
            if (em < lm) P.push("ARBITRUM_ESTIMATE_EXCLUDES_L1:REVOKE");
          }
        }
        if (limit > route.maxGas.APPROVE) P.push("GAS_ABOVE_CAP:REVOKE");
        if (limit < SWAP_LANE_SCOPE.minGas) P.push("GAS_BELOW_FLOOR:REVOKE");
        let l1Fee = 0n;
        if (route.feeModel === "OP_STACK") {
          if (!pins.gasPriceOracle) P.push("L1_FEE_UNPROVEN");
          else {
            const unsigned = serializeTransaction({
              type: "eip1559",
              chainId: Number(route.chainId),
              nonce: Number(nonce ?? 0n),
              to: U as Hex,
              value: 0n,
              data: revokeTx.data as Hex,
              gas: limit,
              maxFeePerGas,
              maxPriorityFeePerGas: tip,
            });
            const l1 = await c.both<string>(
              "eth_call",
              [
                {
                  to: pins.gasPriceOracle,
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
                  to: pins.gasPriceOracle,
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
          P.push("ETH_BELOW_WORST_CASE");
        for (const r of signerPreflightProblems(signer, {
          account: owner,
          route: route.id,
          signerStep: "REVOKE",
          chainId: route.chainId,
          nowMs: now,
        }))
          P.push(`SIGNER_NOT_READY:${r}`);
        this.#d.store.append("REVOKE_REVIEW", {
          ready: P.length === 0,
          problems: P,
          block: B,
        });
        if (P.length)
          throw new SwapLaneError("REVOKE_NOT_READY", [...new Set(P)]);
        const tx: LaneTx = {
          chainId: route.chainHex,
          from: lower(owner),
          to: lower(U),
          value: "0x0",
          data: revokeTx.data,
          gas: hex(limit),
          maxFeePerGas: hex(maxFeePerGas),
          maxPriorityFeePerGas: hex(tip),
        };
        const facts: SwapLaneStepFacts = {
          route: route.id,
          step: "REVOKE",
          exactAmount: rec.exactAmount,
          tx,
          operatorsAgree: true,
          reviewAttested: true,
          guardianPassed: true,
          gasWorstCaseTotalWei: worst,
          now: this.#now(),
        };
        const gate = (this.#d.gate ?? swapLaneGateState)(facts);
        if (!gate.open) {
          this.#d.store.append("GATE_CLOSED", {
            step: "REVOKE",
            reasons: gate.reasons,
          });
          throw new SwapLaneError("SWAP_LANE_GATE_CLOSED", gate.reasons);
        }
        await this.#preflight("REVOKE", "REVOKE");
        // Lanes review R2 NEW-1 / NEW-2: after the preflight await, synchronously before anything is spent.
        if (this.#used("REVOKE"))
          throw new SwapLaneError("DISPATCH_DUPLICATE", [
            "REVOKE_ALREADY_USED",
          ]);
        if (this.#changedSince(seen))
          throw new SwapLaneError("DISPATCH_DUPLICATE", [
            "OTHER_DISPATCH_RECORDED",
          ]);
        if (this.#now() - now >= SWAP_LANE_SCOPE.reviewTtlSec * 1000)
          throw new SwapLaneError("REVIEW_EXPIRED", [
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
        const authority = mintLaneDispatchAuthority(facts);
        let out: LaneSignerResult;
        try {
          out = await this.#d.signer.send(authority, tx, "REVOKE");
        } catch (e) {
          const code =
            e && typeof e === "object" && "code" in e
              ? String((e as { code: unknown }).code)
              : "DISPATCH_FAILED";
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
    step: SwapLaneStep;
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
      () => new SwapLaneError("DISPATCH_IN_PROGRESS"),
      async () => {
        const t = this.#consume(rawToken);
        const r = this.#fresh(t.reviewId);
        if (r.step !== t.step) throw new SwapLaneError("TOKEN_STEP_MISMATCH");
        if (this.#used(t.step)) throw new SwapLaneError("STEP_ALREADY_USED");
        const seen = this.#mark();
        const rec = this.#rec,
          route = this.#route;
        const amountIn = BigInt(rec.exactAmount);
        const data =
          t.step === "APPROVE"
            ? approveCalldata(route, amountIn)
            : swapCalldata(route, {
                owner: rec.account,
                amountIn,
                amountOutMinimum: BigInt(r.amountOutMinimum),
                deadline: BigInt(r.deadline),
              });
        const tx: LaneTx = {
          chainId: route.chainHex,
          from: lower(rec.account),
          to: lower(t.step === "APPROVE" ? route.pay.address : route.router),
          value: "0x0",
          data,
          gas: hex(BigInt(r.gas.limits[t.step])),
          maxFeePerGas: hex(BigInt(r.gas.maxFeePerGas)),
          maxPriorityFeePerGas: hex(BigInt(r.gas.maxPriorityFeePerGas)),
        };
        const facts: SwapLaneStepFacts = {
          route: route.id,
          step: t.step,
          exactAmount: rec.exactAmount,
          tx,
          amountOutMinimum:
            t.step === "SWAP" ? BigInt(r.amountOutMinimum) : undefined,
          operatorsAgree: !r.problems.includes("OPERATORS_NOT_PROVEN"),
          reviewAttested: true,
          guardianPassed:
            r.guardian !== null &&
            r.guardian.level !== "BLOCK" &&
            r.guardian.level !== "HOLD",
          gasWorstCaseTotalWei: BigInt(r.gas.worstCaseTotalWei),
          now: this.#now(),
        };
        const gate = (this.#d.gate ?? swapLaneGateState)(facts);
        if (!gate.open) {
          this.#d.store.append("GATE_CLOSED", {
            step: t.step,
            reasons: gate.reasons,
          });
          throw new SwapLaneError("SWAP_LANE_GATE_CLOSED", gate.reasons);
        }
        // VEINED-MC1 review MAJOR-1: the signer's fresh status, BEFORE anything is spent: a step it would certainly refuse
        // is refused here, the token and the step stay unspent.
        await this.#preflight(
          t.step === "SWAP" ? "EXECUTE" : "APPROVE",
          t.step,
        );
        // Lanes review R2 NEW-1 / NEW-2: everything single use, and the review's freshness, again AFTER the await.
        this.#recheck(t, r, seen);
        // The step is spent BEFORE the hand-off on purpose (no resend, GOAL section 5): the adapter's own checks are
        // deterministic for an authority this engine just minted from the same facts, so a refusal there means a defect,
        // never a second chance. An uncertain hand-off blocks the lane (nonce anchor) until it is resolved read-only.
        // One fsynced batch: the token is spent and the step is used — before anything leaves the process.
        this.#d.store.batch(() => {
          this.#d.store.append("NONCE", { id: t.id });
          this.#d.store.append("USE", {
            key: this.#useKey(t.step),
            step: t.step,
            reviewId: r.reviewId,
          });
          this.#d.store.append("PREPARED", {
            step: t.step,
            tx,
            dataKeccak: keccak256(data as Hex),
            amountOutMinimum: r.amountOutMinimum,
            deadline: r.deadline,
            ...(r.reusedAllowance
              ? { reusedAllowance: r.reusedAllowance }
              : {}),
          });
        });
        const authority = mintLaneDispatchAuthority(facts);
        let res: LaneSignerResult;
        try {
          res = await this.#d.signer.send(authority, tx, t.step);
        } catch (e) {
          const code =
            e && typeof e === "object" && "code" in e
              ? String((e as { code: unknown }).code)
              : "DISPATCH_FAILED";
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
  async track(): Promise<{
    steps: Record<string, unknown>;
    state: string;
    settlement: unknown;
    allowance: { value: string | null; agree: boolean };
  }> {
    const c = this.#d.chain,
      rec = this.#rec,
      route = this.#route,
      owner = lower(rec.account);
    const U = route.pay.address,
      W = route.receive.address,
      R = route.router;
    const opStack = route.feeModel === "OP_STACK";
    const steps: Record<string, unknown> = {};
    let state = "NOT_STARTED";
    for (const step of [
      "APPROVE",
      "SWAP",
      ...(this.#dispatch("REVOKE") ? (["REVOKE"] as const) : []),
    ] as const) {
      const d = this.#dispatch(step);
      if (!d) {
        steps[step] = {
          state: this.#used(step)
            ? "UNCERTAIN_NO_DISPATCH_RECORD"
            : "NOT_DISPATCHED",
        };
        continue;
      }
      if (!d.hash || (d.outcome !== "SENT" && d.outcome !== "UNCERTAIN")) {
        steps[step] = {
          state:
            d.outcome === "REFUSED" || d.outcome === "REFUSED_BEFORE_SIGNER"
              ? "REFUSED"
              : "UNCERTAIN",
          hash: d.hash,
        };
        continue;
      }
      const known = this.#receipt(step);
      const rc = await c.both<{
        status: string;
        blockNumber: string;
        blockHash: string;
        gasUsed: string;
        effectiveGasPrice: string;
        l1Fee?: string;
        logs: { address: string; topics: string[]; data: string }[];
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
            // VEINED-MC1 review MINOR-4: every field signer v5 receiptVerdict compares
            n: (x as { blockNumber: string }).blockNumber,
            e: (x as { effectiveGasPrice: string }).effectiveGasPrice,
            h: lower(
              String((x as { transactionHash: string }).transactionHash),
            ),
            fr: lower(String((x as { from: string }).from)),
            to: lower(String((x as { to: string }).to)),
            l: (
              x as {
                logs: { address: string; topics: string[]; data: string }[];
              }
            ).logs?.map((k) => [lower(k.address), k.topics, k.data]),
            // OP_STACK: the L1 data fee (and the Isthmus operator fee fields) both operators must agree on — RAW, as
            // signer v5 receiptVerdict compares them (lanes review R2 NEW-5: an absent field and null differ; JSON keeps
            // a null and drops an absent field).
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
        steps[step] = {
          state:
            tx.values[0] || tx.values[1]
              ? "PENDING"
              : known
                ? "REORGED_OR_DROPPED"
                : "UNKNOWN_TO_BOTH_OPERATORS",
          hash: d.hash,
        };
        continue;
      }
      if (!rc.agree || !rc.values[0]) {
        steps[step] = { state: "OPERATORS_DISAGREE", hash: d.hash };
        continue;
      }
      const x = rc.values[0];
      const receiptProblem = strictReceiptProblem(
        x,
        d.hash,
        opStack,
        heads.values,
      );
      if (receiptProblem) {
        steps[step] = { state: receiptProblem, hash: d.hash };
        continue;
      }
      const conf = head - BigInt(x.blockNumber) + 1n;
      // Reorg check: the block at the receipt's height must still be the receipt's block on both operators — the raw
      // hash, as signer v5 compares it (lanes review R2 NEW-5).
      const at = await c.both<{ hash: string }>(
        "eth_getBlockByNumber",
        [x.blockNumber, false],
        (b) => b && (b as { hash: string }).hash,
      );
      if (!at.agree || !at.values[0] || at.values[0].hash !== x.blockHash) {
        steps[step] = { state: "REORGED", hash: d.hash };
        continue;
      }
      if (lower(x.from) !== owner) {
        steps[step] = { state: "DISCREPANCY_FROM", hash: d.hash };
        continue;
      }
      // Review MINOR-3: the hash must be THIS lane's prepared transaction (from, to, input on both operators).
      const prepared = this.#d.store
        .of("PREPARED")
        .filter((e) => (e.data as { step: string }).step === step)
        .at(-1)?.data as
        { tx?: { from: string; to: string; data: string } } | undefined;
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
      ) {
        steps[step] = { state: "DISCREPANCY_TX", hash: d.hash };
        continue;
      }
      // OP_STACK receipts carry the L1 data fee: without it the spend cannot be accounted for, so it never counts (a
      // signer v5 quantity: no leading zeros, lanes review R2 NEW-5).
      const l1FeeRead = opStack
        ? isQuantity(x.l1Fee)
          ? BigInt(x.l1Fee)
          : null
        : 0n;
      if (l1FeeRead === null) {
        steps[step] = { state: "RECEIPT_L1_FEE_UNPROVEN", hash: d.hash };
        continue;
      }
      if (conf < BigInt(route.confirmations)) {
        steps[step] = {
          state: "CONFIRMING",
          hash: d.hash,
          confirmations: conf.toString(),
          status: x.status,
        };
        continue;
      }
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
      steps[step] = {
        state: x.status === "0x1" ? "FINAL_SUCCESS" : "FINAL_FAILED",
        hash: d.hash,
        confirmations: conf.toString(),
        block: BigInt(x.blockNumber).toString(),
        logs: x.logs,
      };
    }
    let settlement: unknown = null;
    const a = steps.APPROVE as { state: string } | undefined,
      s = steps.SWAP as
        | {
            state: string;
            logs?: { address: string; topics: string[]; data: string }[];
            block?: string;
            hash?: string;
          }
        | undefined;
    // Approval first: while the approval is not final and successful, its own state IS the lane state (a refused,
    // uncertain, pending or reorged approval is never hidden behind the swap's "not dispatched").
    const preparedSwap = this.#d.store
      .of("PREPARED")
      .filter((e) => (e.data as { step?: string }).step === "SWAP")
      .at(-1)?.data as { reusedAllowance?: string } | undefined;
    const reused = preparedSwap?.reusedAllowance;
    const approvalSkipped =
      this.#d.reuseExistingAllowance &&
      !!reused &&
      BigInt(reused) >= BigInt(rec.exactAmount) &&
      !this.#used("APPROVE") &&
      !this.#dispatch("APPROVE");
    if (a?.state === "FINAL_FAILED") state = "APPROVAL_FAILED";
    else if (a && a.state !== "FINAL_SUCCESS" && !approvalSkipped)
      state = `APPROVE_${a.state}`;
    else if (s?.state === "FINAL_FAILED") state = "SWAP_FAILED";
    else if (s?.state === "FINAL_SUCCESS" && s.logs) {
      const minOut = BigInt(
        (
          this.#d.store
            .of("PREPARED")
            .filter((e) => (e.data as { step: string }).step === "SWAP")
            .at(-1)?.data as { amountOutMinimum: string }
        ).amountOutMinimum,
      );
      const transfers = s.logs
        .map((l) => {
          try {
            return {
              address: lower(l.address),
              ...decodeEventLog({
                abi: ERC20,
                topics: l.topics as [Hex, ...Hex[]],
                data: l.data as Hex,
              }),
            };
          } catch {
            return null;
          }
        })
        .filter(
          (e): e is NonNullable<typeof e> => !!e && e.eventName === "Transfer",
        );
      const tr = transfers as unknown as {
        address: string;
        args: { from: string; to: string; value: bigint };
      }[];
      const usdcOut = tr
        .filter((e) => e.address === lower(U) && lower(e.args.from) === owner)
        .reduce((acc, e) => acc + e.args.value, 0n);
      const wethIn = tr
        .filter((e) => e.address === lower(W) && lower(e.args.to) === owner)
        .reduce((acc, e) => acc + e.args.value, 0n);
      const B = hex(BigInt(s.block!));
      const allowance = await c.both<string>("eth_call", [
        { to: U, data: "0xdd62ed3e" + word(owner) + word(R) },
        B,
      ]);
      const problems: string[] = [];
      if (usdcOut !== BigInt(rec.exactAmount))
        problems.push("USDC_OUT_NOT_EXACT");
      if (wethIn < minOut) problems.push("WETH_IN_BELOW_MINIMUM");
      const expectedLeft = reused
        ? BigInt(reused) - BigInt(rec.exactAmount)
        : 0n;
      if (
        readFailed(allowance, isQty) ||
        !allowance.agree ||
        big(allowance.values[0]) !== expectedLeft
      )
        problems.push("ALLOWANCE_LEFT_OR_UNPROVEN");
      settlement = {
        usdcOut: usdcOut.toString(),
        wethIn: wethIn.toString(),
        minOut: minOut.toString(),
        allowanceAfter: String(big(allowance.values[0])),
        problems,
      };
      state = problems.length === 0 ? "SETTLED_VERIFIED" : "DISCREPANCY";
      if (state === "SETTLED_VERIFIED" && !this.#d.store.of("SETTLED").length)
        this.#d.store.append("SETTLED", {
          state,
          settlement,
          swapHash: s.hash,
        });
    } else if (s?.state) state = `SWAP_${s.state}`;
    const allowanceNow = await c.both<string>("eth_call", [
      { to: U, data: "0xdd62ed3e" + word(owner) + word(R) },
      hex(
        (await c.both<string>("eth_blockNumber", [], () => null)).values
          .map((h) => big(h) ?? 0n)
          .reduce((a, b) => (a < b ? a : b)) - 1n,
      ),
    ]);
    const allowance = {
      value: allowanceNow.agree ? String(big(allowanceNow.values[0])) : null,
      agree: allowanceNow.agree,
    };
    for (const k of Object.keys(steps))
      delete (steps[k] as { logs?: unknown }).logs;
    return { steps, state, settlement, allowance };
  }
}
