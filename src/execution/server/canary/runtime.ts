// G14 closure: THE server runtime of the owner-signed canary — the ONE place the canary engine is constructed.
// Server only. NEW protected-inventory file (the safety scans refuse a CanaryEngine built anywhere else).
// What is composed here, and from what (nothing is injectable by an environment variable, a cookie, a header, a query
// string or a request body; the only parameter is the store directory, given in code):
//   gate          the protected canary gate (server/gate.ts canaryGateState) for every wallet step, and CLOSED as soon
//                 as the durable store cannot be written;
//   reads         the two-operator pool (rpc-pool.ts) through the protected Swap transport's canary capability;
//   quote         the protected routing adapter's own canary quote (routing-core.ts, provenance kept by H1);
//   Guardian      the deterministic server Guardian, computed HERE from the server's own plan (never a client value);
//   persistence   one CanaryDurableStore (OS writer lock, fsync before any answer): consumed nonces, single-use lines,
//                 audit anchors, lifecycle events, prepared steps, attempt states, hash claims, receipts, review reads;
//   attestations  this process's MAC key (a restart invalidates every review and token; consumed nonces stay
//                 consumed because they are journaled).
// While the canary gate is structurally CLOSED (no owner record, or CANARY_LIVE_WIRING false — both, in this build)
// the API never reaches this module for a write and the store is never opened.
// Proof boundaries, stated: the account a client names is not cryptographically proven to be its wallet — it is bound
// to the owner record and the session here, the transaction's `from` is that account, and the wallet adapter re-reads
// the live wallet identity at the last instant (a wallet only signs for an account whose key it holds). The page cannot
// verify the server's MAC; its trust boundary is the same-origin server answer. Nothing here signs, holds a key,
// broadcasts or retries a transaction; a restart never asks a wallet anything.
import { randomBytes, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import {
  decodeEventLog,
  keccak256,
  parseAbi,
  sha256,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import { routingCore } from "../../../adapters/routing-core";
import { knownAsset } from "../../../assets/registry";
import { review as guardianReview } from "../../../guardian/verdict";
import type { AssetFacts, BridgeFacts } from "../../../guardian/model";
import {
  CANARY_APPROVAL_BOUNDS,
  OWNER_CANARY_APPROVAL,
  OWNER_CANARY_KEY_SHA256,
  approvalRecordProblems,
  canaryPreparedText,
  type CanaryAction,
} from "../../../security/canary-approval";
import { CANARY_RPC_POOL } from "../../../swap/server/config";
import { EXECUTION_POLICY, labelOf, TERMINAL } from "../../model";
import type { ExecutionEvent, ExecutionRecord } from "../../lifecycle";
import { CANARY_PINS } from "../../canary/pins";
import { CANARY_SCOPE } from "../../canary/scope";
import { decodeAcrossCall } from "../../canary/across-decoder";
import type { SourceRead } from "../../canary/chain-reads";
import type { ChainLog } from "../../canary/settlement";
import { canaryGateState, type CanaryGateFacts } from "../gate";
import { CanaryEngine, CanaryError } from "./engine";
import { CanaryAuthorizationStore } from "./authorization-store";
import { ReviewAttestor } from "./attestation";
import {
  AuditAnchorLog,
  verifyAnchored,
  type AnchorEntry,
} from "./audit-anchor";
import {
  CanaryDurableStore,
  StoreError,
  ownerHeadProblem,
} from "./durable-store";
import {
  readBalancesAtBlockPair,
  readBalancesAtHead,
  readCanaryReview,
  readDestinationPinsPair,
  readLogsPair,
  readNoncePair,
  readNonceAtBlockPair,
  readReceiptPair,
  readTransactionPair,
  simulatePair,
  type PoolBlock,
  type PoolReceipt,
  type PoolTransaction,
} from "./rpc-pool";

export class CanaryRuntimeError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "CanaryRuntimeError";
  }
}
/**
 * Whether the canary is structurally ARMED: the protected owner record is a well-formed record and the protected
 * wiring constant is true. Nothing else — no request, variable or switch — can make this true. In this build: false.
 */
export function canaryArmed(): { armed: boolean; reasons: string[] } {
  const reasons: string[] = canaryGateState().reasons.filter(
    (r) => r !== "CANARY_FACTS_MISSING",
  );
  // A record that is present but not well formed arms nothing (review 1 F11).
  if (
    OWNER_CANARY_APPROVAL !== null &&
    approvalRecordProblems(OWNER_CANARY_APPROVAL).length > 0
  )
    reasons.push("OWNER_RECORD_MALFORMED");
  // Review 3 N12: without the owner's key digest nobody could be told from the owner: not armed.
  if (
    typeof OWNER_CANARY_KEY_SHA256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(OWNER_CANARY_KEY_SHA256)
  )
    reasons.push("OWNER_KEY_MISSING");
  return { armed: reasons.length === 0, reasons };
}
/** The digest the protected constant OWNER_CANARY_KEY_SHA256 holds for an owner key (fixed prefix, SHA-256). */
export const ownerKeyDigest = (key: string) =>
  sha256(stringToHex(`veined.canary.owner-key.v1:${key}`)).slice(2);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const MAX_SESSIONS = 64;
/** States only a CONFIRMED main deposit leads to (a reorg of it leads elsewhere first). */
const DEPOSIT_CONFIRMED: ReadonlySet<string> = new Set([
  "SOURCE_CONFIRMED",
  "DESTINATION_PENDING",
  "REFUND_PENDING",
  "SETTLED",
  "RECONCILED",
  "DESTINATION_FAILED",
  "REFUNDED",
  "DISCREPANCY",
]);
/**
 * Notes that need the owner's attention (G14 follow-up: every undecided search, every standing or unknown allowance,
 * every speed-up not yet reconciled, every transaction seen after its record ended, every definitive negative end).
 */
export const ATTENTION_NOTE =
  /^(NONCE_USED|STORE_|REFUND_CANDIDATE|ALLOWANCE_NOT_ZERO|ALLOWANCE_UNKNOWN|ALLOWANCE_MAY_STAND|ALLOWANCE_STANDS|REPLACED_BY_OTHER|REPLACEMENT_SEARCH:(?!FOUND)|REPLACEMENT_SEARCH_|RECORD_STAYS_ACTIVE|INTENT_LOG_ABSENT|CONSUMING_TRANSACTION|TX_MINED_AFTER_END|SPEED_UP_TRACKED)/;
/** G14 follow-up F1: how many candidate transactions one tracking call may read in the replacement search. */
export const CANDIDATE_READS_PER_CALL = 8;
const lower = (v: unknown) => (typeof v === "string" ? v.toLowerCase() : "");
const hexToDec = (v: string) => BigInt(v).toString();
/** The digest the page and the adapter carry (sha256 of the protected module's fixed-order text). */
const preparedDigest = (p: Parameters<typeof canaryPreparedText>[0]) =>
  sha256(stringToHex(canaryPreparedText(p))).slice(2);
/** What is journaled for a resume key (the key itself never is). */
const keyHash = (key: string) =>
  sha256(stringToHex(`veined.canary.resume.v1:${key}`)).slice(2);

export interface Preparation {
  action: CanaryAction;
  record: string;
  review: string;
  transaction: Readonly<Record<string, string>>;
  expiresAt: number;
  approvalId: string;
  attempt: string;
  quoteExpiresAt: number;
  digest: string;
}
export type AttemptState =
  | "PREPARED"
  | "REQUESTED"
  | "NOT_REQUESTED"
  | "HASH_CLAIMED"
  | "SUBMITTED"
  | "HASH_REJECTED"
  | "REJECTED"
  | "UNCERTAIN"
  /** A verified hash that arrived after the record had already ended (needs the owner's eye, review 1 F5). */
  | "HASH_AFTER_END"
  /** The step's nonce was consumed by an identified transaction of ANOTHER intent (review 2 N1). */
  | "REPLACED"
  /** The step's nonce was consumed by a transaction neither operator could identify (needs the owner's eye). */
  | "NONCE_CONSUMED_UNIDENTIFIED";
interface Attempt {
  attempt: string;
  record: string;
  action: CanaryAction;
  digest: string;
  state: AttemptState;
  request: string | null;
  /** Request ids whose write was cancelled by the server (a later write with one of them is refused, H3). */
  cancelled: string[];
  hash: string | null;
  /** Prepared before the last restart of this process: never confirmed again. */
  restored: boolean;
  preparation: Preparation;
  /** The account nonce the approved account had when the step was reviewed (decimal), when it was read. */
  accountNonce: string | null;
  /** The nonce of the verified transaction of this attempt (replacement detection, review 1 F7). */
  txNonce: string | null;
  /**
   * Review 3 N10: journaled the first time both operators show the step's nonce consumed while its transaction is
   * gone; cleared only when the same-intent replacement was found. While set, every view needs attention.
   */
  nonceConsumed: boolean;
  /**
   * G14 follow-up F1: the chain evidence a definitive negative end rests on (journaled with the attempt's
   * NONCE_CONSUMED_UNIDENTIFIED line), or null.
   */
  evidence: Record<string, unknown> | null;
}
/** G14 follow-up F3: the latest two-operator allowance read for a record (owner -> pinned spender, Base USDC). */
interface AllowanceRead {
  status: "ZERO" | "NONZERO" | "UNKNOWN";
  value: string | null;
  block: string | null;
  at: number;
}
interface ReviewReads {
  record: string;
  at: number;
  baseBefore: [SourceRead | null, SourceRead | null];
  arbBefore: [SourceRead | null, SourceRead | null];
  arbStartBlock: string | null;
  nonce: string | null;
}
export interface CanaryReviewView {
  record: string;
  session: string;
  ready: boolean;
  state: string;
  label: string;
  needsApproval: boolean;
  planDigest: string | null;
  review: string | null;
  plan: {
    account: string;
    sourceChainId: string;
    destinationChainId: string;
    amountIn: string;
    expectedOut: string;
    minimumOut: string;
    ownerMinimumOut: string;
    target: string;
    spender: string;
    fees: { name: string; amount: string }[];
    quoteExpiresAt: number;
  } | null;
  gas: {
    budgetWei: string;
    spentWei: string | null;
    remainingStepsWei: string | null;
    l1FeeWei: string | null;
    note: string;
  };
  guardian: { level: string; digest: string } | null;
  checks: { id: string; status: string; code: string }[];
  gate: { state: string; reasons: string[] };
  /**
   * Review 2 N2: handed out ONCE, by the review that started this record. Only its hash is journaled; with it (and
   * only with it) canary-resume binds a session that may take wallet steps. Without it a resume can only observe.
   */
  resumeKey: string | null;
}
/** What a session may do: STEP = the reviewing page (or a resume with its key); OBSERVE = tracking only. */
type SessionMode = "STEP" | "OBSERVE";

const FILLED_RELAY_TOPIC = keccak256(
  toHex(
    "FilledRelay(bytes32,bytes32,uint256,uint256,uint256,uint256,uint256,uint32,uint32,bytes32,bytes32,bytes32,bytes32,bytes32,(bytes32,bytes32,uint256,uint8))",
  ),
);
const pad = (address: string) =>
  "0x" + address.slice(2).toLowerCase().padStart(64, "0");
const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
const DEPOSIT_ABI = parseAbi([
  "event FundsDeposited(bytes32 inputToken, bytes32 outputToken, uint256 inputAmount, uint256 outputAmount, uint256 indexed destinationChainId, uint256 indexed depositId, uint32 quoteTimestamp, uint32 fillDeadline, uint32 exclusivityDeadline, bytes32 indexed depositor, bytes32 recipient, bytes32 exclusiveRelayer, bytes message)",
]);
/** The deposit of a source receipt: the pinned Base pool's FundsDeposited (the last one decoded), or null. */
function depositOf(
  receipt: PoolReceipt,
): { depositId: bigint; fillDeadline: number } | null {
  let out: { depositId: bigint; fillDeadline: number } | null = null;
  for (const l of receipt.logs)
    if (lower(l.address) === lower(CANARY_PINS.spokePools["8453"].address))
      try {
        const x = decodeEventLog({
          abi: DEPOSIT_ABI,
          data: l.data as Hex,
          topics: l.topics as [Hex, ...Hex[]],
        });
        out = {
          depositId: x.args.depositId,
          fillDeadline: Number(x.args.fillDeadline),
        };
      } catch {
        // another event
      }
  return out;
}

export class CanaryRuntime {
  readonly #store: CanaryDurableStore;
  readonly #engine: CanaryEngine;
  readonly #attempts = new Map<string, Attempt>();
  readonly #sessions = new Map<string, { account: string; record: string }>();
  /** Observe-only sessions (a resume without the record's key): their own bounded map, so they never evict a STEP one. */
  readonly #observers = new Map<string, { account: string; record: string }>();
  /** sha256 of each record's resume key (journaled RESUME_KEY); the key itself is never stored (review 2 N2). */
  readonly #resumeKeys = new Map<string, string>();
  /** One hash verification in flight per attempt (review 2 N3). */
  readonly #verifying = new Map<string, Promise<void>>();
  readonly #reads = new Map<string, ReviewReads>();
  readonly #receipts = new Map<string, PoolReceipt>();
  readonly #cursor = new Map<string, string>();
  readonly #refundCursor = new Map<string, string>();
  /** Refund-candidate logs of windows the refund scan already moved past (review 2 N7). */
  readonly #refundLogs = new Map<string, ChainLog[]>();
  /** Where the forward search for a replacing transaction continues (per attempt, review 3 N10). */
  readonly #replacementCursor = new Map<string, string>();
  /** When the replacement search of an attempt first could not decide (journaled; cleared by a decided call). */
  readonly #undecidedSince = new Map<string, number>();
  /** G14 follow-up F1: the latest reason the replacement search of an attempt could not decide (journaled). */
  readonly #undecidedReason = new Map<string, string>();
  /** Review 13 R13-2: the tracking call of a record in progress (calls of one record are serialised). */
  readonly #tracking = new Map<string, Promise<unknown>>();
  /** Review 9 R9-2: the one exact own-transaction match found so far by an OWN search (journaled OWN_CANDIDATE). */
  readonly #ownHit = new Map<string, string>();
  /** Review 8 R8-4: the agreed block at which an attempt's nonce was FIRST seen consumed (journaled with the mark). */
  readonly #consumedAt = new Map<string, { number: string; hash: string }>();
  /** G14 follow-up F1: candidate transactions of an attempt's search already read and found not to be its nonce. */
  readonly #checked = new Map<string, Set<string>>();
  /** G14 follow-up F3: the latest allowance read per record (journaled ALLOWANCE). */
  readonly #allowance = new Map<string, AllowanceRead>();
  #restoreProblem: string | null = null;
  readonly restoredAt: number;

  constructor(dir: string) {
    this.#store = CanaryDurableStore.open(dir);
    const store = this.#store;
    const values = (type: string) => store.of(type).map((e) => e.data);
    const nonces = values("NONCE").map((d) => (d as { nonce: string }).nonce);
    let anchors: AuditAnchorLog;
    try {
      anchors = new AuditAnchorLog(
        { append: (e) => void store.append("ANCHOR", e) },
        values("ANCHOR") as AnchorEntry[],
      );
    } catch {
      this.#restoreProblem = "ANCHOR_CHAIN_BROKEN";
      anchors = new AuditAnchorLog({
        append: () => {
          throw new CanaryRuntimeError("STORE_NEEDS_ATTENTION");
        },
      });
    }
    this.#engine = new CanaryEngine({
      gate: (facts?: CanaryGateFacts) => this.#gate(facts),
      authorizations: new CanaryAuthorizationStore({
        append: (nonce) => void store.append("NONCE", { nonce }),
        load: () => nonces,
      }),
      attestor: new ReviewAttestor(),
      anchors,
      uses: {
        durable: true,
        append: (line) => void store.append("USE", { line }),
        load: () =>
          store.of("USE").map((e) => (e.data as { line: string }).line),
      },
      simulate: (request, block) =>
        simulatePair(request, block, AbortSignal.timeout(20_000)),
      pool: CANARY_RPC_POOL,
      approvalCostWei: (owner) => this.#approvalCost(owner),
      events: (record, event) => void store.append("EVENT", { record, event }),
    });
    // Rebuild: records from their events, attempts, review reads, receipts and scan cursors.
    const byRecord = new Map<string, ExecutionEvent[]>();
    for (const d of values("EVENT") as {
      record: string;
      event: ExecutionEvent;
    }[])
      byRecord.set(d.record, [...(byRecord.get(d.record) ?? []), d.event]);
    try {
      for (const [id, events] of byRecord) this.#engine.restore(id, events);
    } catch {
      this.#restoreProblem ??= "RECORD_REPLAY_FAILED";
    }
    for (const e of store.entries()) {
      const d = e.data as Record<string, unknown>;
      if (e.type === "PREPARED") {
        const p = d.preparation as Preparation;
        this.#attempts.set(p.attempt, {
          attempt: p.attempt,
          record: p.record,
          action: p.action,
          digest: p.digest,
          state: "PREPARED",
          request: null,
          cancelled: [],
          hash: null,
          restored: true,
          preparation: p,
          accountNonce: (d.accountNonce as string | null) ?? null,
          txNonce: null,
          nonceConsumed: false,
          evidence: null,
        });
      } else if (e.type === "ATTEMPT") {
        const a = this.#attempts.get(d.attempt as string);
        if (!a) {
          this.#restoreProblem ??= "ATTEMPT_WITHOUT_PREPARATION";
          continue;
        }
        if (d.cancelAhead === true) {
          a.cancelled.push(d.request as string);
          continue;
        }
        a.state = d.state as AttemptState;
        if (d.state === "NOT_REQUESTED") {
          a.cancelled.push(d.request as string);
          if (a.request === d.request) a.request = null;
        } else if (typeof d.request === "string") a.request = d.request;
        if (typeof d.hash === "string") a.hash = d.hash;
        if (typeof d.nonce === "string") a.txNonce = d.nonce;
        if (d.evidence && typeof d.evidence === "object")
          a.evidence = d.evidence as Record<string, unknown>;
      } else if (e.type === "REPLACEMENT") {
        // A same-intent replacement (speed-up) found on both operators: the attempt is tracked under the new hash.
        const a = this.#attempts.get(d.attempt as string);
        if (a && typeof d.hash === "string") {
          a.hash = d.hash;
          a.nonceConsumed = false;
        }
      } else if (e.type === "NONCE_CONSUMED") {
        const a = this.#attempts.get(d.attempt as string);
        if (a) a.nonceConsumed = d.cleared !== true;
        if (d.cleared === true) this.#consumedAt.delete(d.attempt as string);
        else if (typeof d.block === "string" && typeof d.blockHash === "string")
          this.#consumedAt.set(d.attempt as string, {
            number: d.block,
            hash: d.blockHash,
          });
      } else if (e.type === "REPLACEMENT_CURSOR")
        this.#replacementCursor.set(d.attempt as string, d.block as string);
      else if (e.type === "OWN_CANDIDATE" && typeof d.hash === "string")
        this.#ownHit.set(d.attempt as string, d.hash);
      else if (e.type === "SEARCH_UNDECIDED") {
        if (typeof d.at === "number") {
          this.#undecidedSince.set(d.attempt as string, d.at);
          if (typeof d.reason === "string")
            this.#undecidedReason.set(d.attempt as string, d.reason);
        } else {
          this.#undecidedSince.delete(d.attempt as string);
          this.#undecidedReason.delete(d.attempt as string);
        }
      } else if (e.type === "REPLACEMENT_CHECKED") {
        const set = this.#checked.get(d.attempt as string) ?? new Set<string>();
        for (const h of (d.hashes as string[]) ?? []) set.add(h);
        this.#checked.set(d.attempt as string, set);
      } else if (e.type === "ALLOWANCE")
        this.#allowance.set(d.record as string, d.read as AllowanceRead);
      else if (e.type === "RESUME_KEY")
        this.#resumeKeys.set(d.record as string, d.hash as string);
      else if (e.type === "REVIEW_READS")
        this.#reads.set(d.record as string, d as unknown as ReviewReads);
      else if (e.type === "RECEIPT") {
        const r = d.receipt as PoolReceipt;
        this.#receipts.set(r.hash, r);
      } else if (e.type === "CURSOR")
        this.#cursor.set(d.record as string, d.block as string);
      else if (e.type === "REFUND_CURSOR") {
        this.#refundCursor.set(d.record as string, d.block as string);
        if (Array.isArray(d.logs) && d.logs.length)
          this.#refundLogs.set(d.record as string, [
            ...(this.#refundLogs.get(d.record as string) ?? []),
            ...(d.logs as ChainLog[]),
          ]);
      }
    }
    this.restoredAt = Date.now();
  }
  // ---------------------------------------------------------------------------------------------- state & checks
  get store() {
    return this.#store;
  }
  /** The engine's gate with the runtime's own lock: a store that cannot be written closes everything. */
  #gate(facts?: CanaryGateFacts) {
    const g = canaryGateState(facts);
    if (this.#store.writable && this.#restoreProblem === null) return g;
    return {
      ...g,
      state: "CLOSED" as const,
      open: false,
      reasons: [
        ...g.reasons,
        `STORE:${this.#restoreProblem ?? this.#store.problem ?? this.#store.status}` as never,
      ],
    };
  }
  #requireArmed() {
    if (!canaryArmed().armed) throw new CanaryRuntimeError("WRITE_DISABLED");
  }
  #requireWritable() {
    this.#requireArmed();
    if (!this.#store.writable || this.#restoreProblem !== null)
      throw new CanaryRuntimeError("STORE_NEEDS_ATTENTION");
  }
  get #readOnly() {
    return !this.#store.writable || this.#restoreProblem !== null;
  }
  #record(): Readonly<NonNullable<typeof OWNER_CANARY_APPROVAL>> {
    const r = OWNER_CANARY_APPROVAL;
    if (!r || approvalRecordProblems(r).length)
      throw new CanaryRuntimeError("WRITE_DISABLED");
    return r;
  }
  /**
   * The session of a request. A wallet step (and a re-review) needs a STEP session; tracking also accepts an OBSERVE
   * session (a resume without the record's key, review 2 N2). An observe-only session never takes a wallet step.
   */
  #session(token: unknown, record: string, allowed: SessionMode = "STEP") {
    const t =
      typeof token === "string" && /^[0-9a-f]{64}$/.test(token) ? token : null;
    const s = t
      ? (this.#sessions.get(t) ??
        (allowed === "OBSERVE" ? this.#observers.get(t) : undefined))
      : undefined;
    if (!s && t && this.#observers.has(t))
      throw new CanaryRuntimeError("SESSION_OBSERVE_ONLY");
    if (!s || s.record !== record)
      throw new CanaryRuntimeError("SESSION_INVALID");
    const r = this.#record();
    if (lower(s.account) !== lower(r.account))
      throw new CanaryRuntimeError("SESSION_INVALID");
    return s;
  }
  #batch<T>(fn: () => T): T {
    try {
      return this.#store.batch(fn);
    } catch (e) {
      if (e instanceof StoreError)
        throw new CanaryRuntimeError("STORE_NEEDS_ATTENTION");
      throw e;
    }
  }
  #approvalCost(owner: string): string | null {
    for (const r of this.#engine.records())
      if (lower(r.plan?.account) === lower(owner) && r.hashes.approval) {
        const receipt = this.#receipts.get(lower(r.hashes.approval));
        // Only a receipt the server itself read for a hash it recorded proves what the approval cost.
        if (!receipt || !receipt.success || receipt.l1FeeWei === null)
          return null;
        return (
          BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) +
          BigInt(receipt.l1FeeWei)
        ).toString();
      }
    return null;
  }
  // ---------------------------------------------------------------------------------------------- review
  /**
   * A fresh server review of the canary for the owner record's account and exact amount. Read-only towards the
   * chain; it records the reviewed plan (lifecycle steps, anchors) only when every check passed. A record id may be
   * given only to re-review a record whose exact approval was confirmed (the main step's fresh review).
   */
  async review(
    i: {
      account: string;
      chainId: string;
      amount: string;
      record?: string;
      session?: string;
      /** The owner's own canary key (review 3 N12): needed to START (or take up again) a record. */
      ownerKey?: string;
    },
    signal: AbortSignal,
  ): Promise<CanaryReviewView> {
    this.#requireWritable();
    const owner = this.#record();
    if (
      lower(i.account) !== lower(owner.account) ||
      i.amount !== owner.exactAmount
    )
      throw new CanaryRuntimeError("NOT_THE_APPROVED_CANARY");
    let id: string;
    /** True when the owner (by key) takes a record up: a new one, or the one whose exact approval is confirmed. */
    let byOwnerKey = false;
    if (i.record !== undefined) {
      this.#session(i.session, i.record);
      const existing = this.#engine.record(i.record);
      if (!existing || existing.state !== "APPROVAL_CONFIRMED")
        throw new CanaryRuntimeError("RECORD_NOT_RE_REVIEWABLE");
      id = i.record;
    } else {
      // Review 3 N12: the account and the amount are public. Only the owner's key starts a record.
      // The key is 32 random bytes as 64 hex characters (review 4 R4-5: never a passphrase), compared in constant time.
      if (
        typeof i.ownerKey !== "string" ||
        !/^[0-9a-f]{64}$/.test(i.ownerKey) ||
        typeof OWNER_CANARY_KEY_SHA256 !== "string" ||
        !/^[0-9a-f]{64}$/.test(OWNER_CANARY_KEY_SHA256) ||
        !timingSafeEqual(
          Buffer.from(ownerKeyDigest(i.ownerKey), "hex"),
          Buffer.from(OWNER_CANARY_KEY_SHA256, "hex"),
        )
      )
        throw new CanaryRuntimeError("OWNER_KEY_INVALID");
      byOwnerKey = true;
      // Review 3 N11: a reviewed plan that ran out without a wallet step ends EXPIRED (it never blocks the owner).
      this.#expireStale(Date.now());
      // Review 2 R1 / review 3 N11: the owner's record whose exact approval is confirmed is taken up again by the
      // owner's key from any browser (its main step's fresh review) — never a second record next to it.
      const confirmed = this.#engine
        .records()
        .find(
          (r) =>
            lower(r.plan?.account) === lower(owner.account) &&
            r.state === "APPROVAL_CONFIRMED",
        );
      id = confirmed?.id ?? `canary-${randomBytes(12).toString("hex")}`;
    }
    const quote = await routingCore.canaryExecutableQuote(
      {
        source: CANARY_APPROVAL_BOUNDS.sourceChainId,
        destination: CANARY_APPROVAL_BOUNDS.destinationChainId,
        sourceAsset: CANARY_APPROVAL_BOUNDS.token,
        destinationAsset: CANARY_APPROVAL_BOUNDS.destinationToken,
        amount: owner.exactAmount,
        sourceAddress: owner.account,
        destinationAddress: owner.account,
      },
      signal,
    );
    const tr = quote.transactionRequest;
    const reads = await readCanaryReview(
      {
        owner: owner.account,
        selector: tr.data.slice(0, 10),
        amountIn: owner.exactAmount,
        call: { to: tr.to, data: tr.data, gas: hexToDec(tr.gasLimit) },
      },
      signal,
    );
    const arb = await readBalancesAtHead("42161", owner.account, signal).catch(
      () => ({ balances: [null, null] as [null, null], head: null }),
    );
    const now = Date.now();
    const guardian = this.#guardian(owner.account, owner.exactAmount, tr.data);
    // The wallet: bound to the owner record's account and to this session (see the proof boundary at the top).
    const walletBound =
      lower(i.account) === lower(owner.account) &&
      i.chainId === CANARY_APPROVAL_BOUNDS.sourceChainId;
    const r = await this.#engine.review({
      record: id,
      owner: owner.account,
      amountIn: owner.exactAmount,
      minimumOut: owner.minimumOut,
      now,
      wallet: {
        account: walletBound ? owner.account : null,
        chainId: walletBound ? CANARY_APPROVAL_BOUNDS.sourceChainId : null,
        proven: walletBound,
      },
      quote,
      pins: reads.pins,
      balances: reads.balances,
      fees: reads.fees,
      l1FeeWei: reads.l1FeeWei,
      guardian,
    });
    // Review 1 F6: without an agreed destination baseline (both Arbitrum operators, one head) the canary could never
    // settle or reconcile, so the review is not ready.
    const arbOk =
      arb.head !== null &&
      !!arb.balances[0] &&
      !!arb.balances[1] &&
      typeof arb.balances[0].values.usdc === "string" &&
      arb.balances[0].values.usdc === arb.balances[1].values.usdc;
    const destination = {
      id: "DESTINATION_BASELINE",
      status: arbOk ? "PASS" : "UNKNOWN",
      code: arbOk ? "ARBITRUM_BASELINE_AGREED" : "ARBITRUM_BASELINE_NOT_AGREED",
    };
    const ready = r.ready && arbOk;
    let state = this.#engine.record(id)?.state ?? "DRAFT";
    // Review 2 N2: the record's resume key is created with the record (never for a re-review) and handed out once.
    const resumeKey =
      ready && byOwnerKey ? randomBytes(32).toString("hex") : null;
    if (ready) {
      const rr: ReviewReads = {
        record: id,
        at: now,
        baseBefore: reads.balances,
        arbBefore: arb.balances,
        arbStartBlock: arb.head?.number ?? null,
        nonce: reads.nonce,
      };
      // Review 4 R4-6: an old plan that ran out while this review was reading ends here, not at the next attempt.
      if (byOwnerKey) this.#expireStale(Date.now());
      this.#batch(() => {
        this.#engine.start(id, now);
        this.#store.append("REVIEW_READS", rr);
        if (resumeKey)
          this.#store.append("RESUME_KEY", {
            record: id,
            hash: keyHash(resumeKey),
          });
      });
      // The runtime's own maps change only after the commit (review 2 N4).
      this.#reads.set(id, rr);
      if (resumeKey) this.#resumeKeys.set(id, keyHash(resumeKey));
      state = this.#engine.record(id)!.state;
    }
    const session =
      i.session && this.#sessions.get(i.session)?.record === id
        ? i.session
        : randomBytes(32).toString("hex");
    this.#sessions.set(session, { account: owner.account, record: id });
    // A bounded number of open sessions (the oldest is forgotten first; it only ends that page's binding).
    while (this.#sessions.size > MAX_SESSIONS)
      this.#sessions.delete(this.#sessions.keys().next().value!);
    const facts = this.#engine.stepFacts(id, now);
    const gas = facts?.step.gas ?? null;
    const remaining = gas
      ? gas.remaining
          .reduce((a, s) => a + BigInt(s.gasLimit) * BigInt(s.maxFeePerGas), 0n)
          .toString()
      : null;
    const plan = r.plan;
    return {
      record: id,
      session,
      ready,
      state,
      label: labelOf(state as never),
      needsApproval: r.needsApproval,
      planDigest: r.planHash,
      review: this.#engine.record(id)?.review ?? null,
      plan: plan
        ? {
            account: plan.account,
            sourceChainId: plan.sourceChainId,
            destinationChainId: plan.destinationChainId,
            amountIn: plan.amountIn,
            expectedOut: plan.expectedOut,
            minimumOut: plan.minimumOut,
            ownerMinimumOut: owner.minimumOut,
            target: CANARY_PINS.diamond.address,
            spender: CANARY_PINS.diamond.address,
            fees: plan.fees.map((f) => ({ name: f.name, amount: f.amount })),
            quoteExpiresAt: plan.expiresAt,
          }
        : null,
      gas: {
        budgetWei: owner.nativeGasBudgetWei,
        spentWei: gas?.spentWei ?? null,
        remainingStepsWei: remaining,
        l1FeeWei: gas?.l1FeeWei ?? null,
        note: "L2_EXECUTION_AT_FEE_CAP_PLUS_L1_DATA_FEE_ESTIMATE",
      },
      guardian,
      checks: [...r.checks, destination].map((c) => ({
        id: c.id,
        status: c.status,
        code: c.code,
      })),
      gate: (() => {
        const g = this.#gate(facts);
        return { state: g.state, reasons: [...g.reasons] };
      })(),
      resumeKey,
    };
  }
  /** The server Guardian on the server's own canary plan facts (deterministic; no client value enters). */
  #guardian(owner: string, amount: string, data: string) {
    const call = decodeAcrossCall(data);
    const out = call
      ? (call.bridgedAmount * call.across.multiplier) / 10n ** 18n
      : null;
    const facts = (chainId: string, address: string): AssetFacts => {
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
    const f: BridgeFacts = {
      kind: "bridge",
      sourceChain: CANARY_SCOPE.sourceChainId,
      destinationChain: CANARY_SCOPE.destinationChainId,
      sender: owner,
      recipient: owner,
      pay: facts("8453", CANARY_PINS.usdc["8453"].address),
      receive: facts("42161", CANARY_PINS.usdc["42161"].address),
      route: {
        steps: [
          { tool: "across", catalogBound: true, destinationSignature: false },
        ],
        durationSeconds: 60,
        // Same token, same decimals on both ends: the share the route keeps, read from the calldata itself.
        priceImpact:
          out === null || BigInt(amount) === 0n
            ? null
            : Number(BigInt(amount) - out) / Number(BigInt(amount)),
        warnings: 0,
        valid: true,
        inputUsd: null,
        outputUsd: null,
        costUsd: null,
      },
      known: [owner],
    };
    const v = guardianReview(f);
    return { level: v.level, digest: v.digest };
  }
  // ---------------------------------------------------------------------------------------------- wallet steps
  authorize(i: { session: string; record: string; trustedGesture: boolean }) {
    this.#requireWritable();
    this.#session(i.session, i.record);
    return this.#engine.authorize(i.record, {
      now: Date.now(),
      trustedGesture: i.trustedGesture === true,
    });
  }
  /** Consumes the token, journals the single use and the prepared step in ONE durable commit, then answers. */
  prepare(i: { session: string; record: string; token: unknown }): Preparation {
    this.#requireWritable();
    this.#session(i.session, i.record);
    const owner = this.#record();
    const now = Date.now();
    const out = this.#batch(() => {
      this.#engine.prepare(i.record, i.token, now);
      const r = this.#engine.record(i.record)!;
      const request = this.#engine.walletRequest(i.record);
      const action: CanaryAction =
        r.pending!.action === "APPROVE" ? "APPROVE" : "SEND";
      const body = {
        action,
        record: i.record,
        review: r.review!,
        transaction: { ...request },
        expiresAt: r.pending!.expiresAt,
        approvalId: owner.approvalId,
        attempt: r.pending!.nonce,
        quoteExpiresAt: r.plan!.expiresAt,
      };
      const preparation: Preparation = Object.freeze({
        ...body,
        digest: preparedDigest({
          approvalId: body.approvalId,
          record: body.record,
          review: body.review,
          action: body.action,
          attempt: body.attempt,
          authorizationExpiresAt: body.expiresAt,
          quoteExpiresAt: body.quoteExpiresAt,
          transaction: body.transaction,
        }),
      });
      // The approved account's nonce at this step's own (fresh) review: a hash claimed for the step must not use a
      // lower one, and an uncertain step is resolved by comparing against it (read-only).
      const accountNonce = this.#reads.get(i.record)?.nonce ?? null;
      this.#store.append("PREPARED", { preparation, accountNonce });
      return { preparation, accountNonce, action };
    });
    // Known to the runtime only once it is durable (review 2 N4).
    this.#attempts.set(out.preparation.attempt, {
      attempt: out.preparation.attempt,
      record: i.record,
      action: out.action,
      digest: out.preparation.digest,
      state: "PREPARED",
      request: null,
      cancelled: [],
      hash: null,
      restored: false,
      preparation: out.preparation,
      accountNonce: out.accountNonce,
      txNonce: null,
      nonceConsumed: false,
      evidence: null,
    });
    return out.preparation;
  }
  /**
   * Review 3 N11: a record of the owner that was reviewed but never reached a wallet step, and whose plan (quote) has
   * run out, ends EXPIRED. Nothing was handed to a wallet for it, so this is a definitive end; the owner can review
   * again (a standing exact allowance is used by the next record's own review).
   */
  #expireStale(now: number) {
    for (const r of this.#engine.records())
      if (
        (r.state === "QUOTED" ||
          r.state === "PREFLIGHT_PASSED" ||
          r.state === "GUARDIAN_PASSED" ||
          r.state === "REVIEWED") &&
        r.plan &&
        now >= r.plan.expiresAt
      )
        this.#batch(() =>
          this.#engine.observe(r.id, { type: "EXPIRED", at: now }),
        );
  }
  /** The server's own time limits of a prepared step (the page and the adapter check them again, last). */
  #lapsed(p: Preparation): string | null {
    const now = Date.now();
    const owner = OWNER_CANARY_APPROVAL;
    if (!owner || now < owner.notBefore || now >= owner.notAfter)
      return "APPROVAL_EXPIRED";
    if (now >= p.expiresAt) return "AUTHORIZATION_EXPIRED";
    if (now >= p.quoteExpiresAt) return "QUOTE_EXPIRED";
    return null;
  }
  #attempt(ref: {
    record: string;
    action: unknown;
    attempt: unknown;
    digest: unknown;
  }) {
    const a =
      typeof ref.attempt === "string"
        ? this.#attempts.get(ref.attempt)
        : undefined;
    if (
      !a ||
      a.record !== ref.record ||
      a.action !== ref.action ||
      a.digest !== ref.digest
    )
      throw new CanaryRuntimeError("ATTEMPT_UNKNOWN");
    return a;
  }
  /** The server's own preparation, compared field by field with what the page names; never re-built. */
  confirm(i: {
    session: string;
    record: string;
    action: CanaryAction;
    review: string;
    attempt: string;
    digest: string;
  }): Preparation {
    this.#requireWritable();
    this.#session(i.session, i.record);
    const a = this.#attempt(i);
    const r = this.#engine.record(i.record);
    if (a.restored) throw new CanaryRuntimeError("PREPARED_BEFORE_RESTART");
    if (
      a.preparation.review !== i.review ||
      !r ||
      r.review !== i.review ||
      !r.pending ||
      r.pending.nonce !== i.attempt ||
      (r.state !== "AWAITING_APPROVAL_SIGNATURE" &&
        r.state !== "AWAITING_SIGNATURE")
    )
      throw new CanaryRuntimeError("PREPARATION_NOT_CURRENT");
    const lapsed = this.#lapsed(a.preparation);
    if (lapsed) throw new CanaryRuntimeError(lapsed);
    // Once the server marked an attempt NOT_REQUESTED it is never requested again (review 1 F12).
    if (a.state !== "PREPARED")
      throw new CanaryRuntimeError("ATTEMPT_ALREADY_REQUESTED");
    const stored = this.#engine.walletRequest(i.record);
    if (
      Object.keys(stored).some(
        (k) =>
          stored[k as keyof typeof stored] !== a.preparation.transaction[k],
      )
    )
      throw new CanaryRuntimeError("PREPARATION_MISMATCH");
    return a.preparation;
  }
  /**
   * The durable attempt journal (H3). Every transition is conditional on the attempt's current state AND the write's
   * own request id, and is committed (fsync) before the answer:
   *   requested      PREPARED                  -> REQUESTED(request)   (refused for a cancelled request id)
   *   not-requested  REQUESTED(same request)   -> NOT_REQUESTED        (an unknown request id is cancelled ahead)
   *   hash/late-hash REQUESTED(same) | UNCERTAIN(same) -> HASH_CLAIMED, verified against the chain before SUBMITTED
   *   rejected       REQUESTED(same)           -> REJECTED (definitive, 4001)
   *   uncertain      REQUESTED(same)           -> UNCERTAIN (no new request, ever)
   * A clean-up can never touch another write's state; an old write that arrives late cannot revive anything.
   */
  async write(i: {
    session: string;
    kind:
      | "requested"
      | "not-requested"
      | "hash"
      | "late-hash"
      | "rejected"
      | "uncertain";
    ref: {
      record: string;
      action: CanaryAction;
      attempt: string;
      digest: string;
      request: string;
    };
    hash?: string;
  }): Promise<{
    ok: boolean;
    state: AttemptState;
    code?: string;
    attempt?: string;
    digest?: string;
    request?: string;
  }> {
    this.#requireWritable();
    // A hash claim is bound by the attempt reference itself (attempt nonce + prepared digest + the write's request
    // id) and is verified against both operators before it counts, so a page whose session died with a server
    // restart can still report the hash it got (review 1 F1). Every other kind needs the live session.
    if (i.kind !== "hash" && i.kind !== "late-hash")
      this.#session(i.session, i.ref.record);
    const a = this.#attempt(i.ref);
    const req = i.ref.request;
    if (typeof req !== "string" || !/^[0-9a-f]{32}$/.test(req))
      throw new CanaryRuntimeError("INVALID_REQUEST");
    const put = (state: AttemptState, extra: Record<string, unknown> = {}) =>
      this.#store.append("ATTEMPT", {
        attempt: a.attempt,
        request: req,
        state,
        at: Date.now(),
        ...extra,
      });
    const refuse = (code: string) => ({ ok: false, state: a.state, code });
    switch (i.kind) {
      case "requested": {
        if (a.restored) return refuse("PREPARED_BEFORE_RESTART");
        if (a.cancelled.includes(req)) return refuse("REQUEST_CANCELLED");
        if (a.state !== "PREPARED") return refuse("ATTEMPT_ALREADY_REQUESTED");
        const lapsed = this.#lapsed(a.preparation);
        if (lapsed) return refuse(lapsed);
        this.#batch(() => put("REQUESTED"));
        a.state = "REQUESTED";
        a.request = req;
        // G14 follow-up F2: the committed answer names exactly the attempt, the prepared digest and the write it
        // committed — the wallet adapter's dispatch authority is minted only from this answer (adapter.ts).
        return {
          ok: true,
          state: a.state,
          attempt: a.attempt,
          digest: a.digest,
          request: req,
        };
      }
      case "not-requested": {
        if (a.state === "REQUESTED" && a.request === req) {
          this.#batch(() => put("NOT_REQUESTED"));
          a.state = "NOT_REQUESTED";
          a.request = null;
          a.cancelled.push(req);
          return { ok: true, state: a.state };
        }
        // The write it cancels has not arrived (or arrived nowhere): it is cancelled AHEAD, so it can never count.
        if (
          a.request !== req &&
          (a.state === "PREPARED" || a.state === "NOT_REQUESTED")
        ) {
          this.#batch(() =>
            put(a.state === "PREPARED" ? "PREPARED" : "NOT_REQUESTED", {
              cancelAhead: true,
            }),
          );
          a.cancelled.push(req);
          // A cancel-ahead entry does not change the state; it only bars this request id.
          return { ok: true, state: a.state };
        }
        return refuse("CLEANUP_NOT_OWN_WRITE");
      }
      case "rejected": {
        if (a.state !== "REQUESTED" || a.request !== req)
          return refuse("NOT_REQUESTED_BY_THIS_WRITE");
        this.#batch(() => {
          this.#engine.observe(a.record, {
            type: "OWNER_REJECTED",
            at: Date.now(),
          });
          put("REJECTED");
        });
        a.state = "REJECTED";
        return { ok: true, state: a.state };
      }
      case "uncertain": {
        if (a.state !== "REQUESTED" || a.request !== req)
          return refuse("NOT_REQUESTED_BY_THIS_WRITE");
        this.#batch(() => {
          const r = this.#engine.record(a.record);
          if (
            r &&
            (r.state === "AWAITING_APPROVAL_SIGNATURE" ||
              r.state === "AWAITING_SIGNATURE")
          )
            this.#engine.observe(a.record, {
              type: "WALLET_UNCERTAIN",
              at: Date.now(),
            });
          put("UNCERTAIN");
        });
        a.state = "UNCERTAIN";
        return { ok: true, state: a.state };
      }
      case "hash":
      case "late-hash": {
        const hash = i.hash;
        if (typeof hash !== "string" || !HASH.test(hash))
          throw new CanaryRuntimeError("INVALID_REQUEST");
        if (
          a.request !== req ||
          !(
            a.state === "REQUESTED" ||
            (i.kind === "late-hash" && a.state === "UNCERTAIN")
          )
        )
          return refuse("NOT_REQUESTED_BY_THIS_WRITE");
        this.#batch(() => put("HASH_CLAIMED", { hash: hash.toLowerCase() }));
        a.state = "HASH_CLAIMED";
        a.hash = hash.toLowerCase();
        await this.#verifyClaim(a, AbortSignal.timeout(15_000));
        return { ok: true, state: a.state };
      }
    }
  }
  /**
   * A claimed hash becomes SUBMITTED only when both operators show that transaction with exactly the prepared step's
   * sender, target, calldata and zero value (and, when the reviewed nonce is known, a nonce not below it). A different
   * transaction is HASH_REJECTED (needs attention); a transaction not visible yet stays claimed (tracked later).
   */
  async #verifyClaim(a: Attempt, signal: AbortSignal) {
    // Review 2 N3: one verification per attempt at a time (a page's hash write and a tracking call can overlap).
    const running = this.#verifying.get(a.attempt);
    if (running) return running;
    const p = this.#verifyClaimOnce(a, signal).finally(() =>
      this.#verifying.delete(a.attempt),
    );
    this.#verifying.set(a.attempt, p);
    return p;
  }
  async #verifyClaimOnce(a: Attempt, signal: AbortSignal) {
    if (a.state !== "HASH_CLAIMED" || !a.hash) return;
    const claimed = a.hash;
    const t = await readTransactionPair("8453", claimed, signal).catch(() => ({
      status: "UNKNOWN" as const,
      transaction: null,
    }));
    if (t.status !== "AGREE" || !t.transaction) return;
    // The attempt may have moved while the operators answered: only the same claim, still claimed, is decided.
    if (a.state !== "HASH_CLAIMED" || a.hash !== claimed) return;
    const p = a.preparation.transaction;
    const tx = t.transaction;
    const same =
      tx.from === lower(p.from) &&
      tx.to === lower(p.to) &&
      tx.input === lower(p.data) &&
      tx.value === "0" &&
      (a.accountNonce === null || BigInt(tx.nonce) >= BigInt(a.accountNonce));
    const role = a.action === "APPROVE" ? "approval" : "main";
    const next = this.#batch(
      (): { state: AttemptState; nonce: string | null } => {
        if (a.state !== "HASH_CLAIMED" || a.hash !== claimed)
          return { state: a.state, nonce: a.txNonce };
        const put = (
          state: AttemptState,
          extra: Record<string, unknown> = {},
        ) => {
          this.#store.append("ATTEMPT", {
            attempt: a.attempt,
            request: a.request,
            state,
            hash: claimed,
            at: Date.now(),
            ...extra,
          });
          return { state, nonce: (extra.nonce as string | undefined) ?? null };
        };
        if (!same) return put("HASH_REJECTED");
        // The record already carries exactly this hash for this role (another call recorded it): that is the same
        // submission, not a late one (review 2 N3).
        const r = this.#engine.record(a.record);
        if (lower(r?.hashes[role]) === lower(claimed))
          return put("SUBMITTED", { nonce: tx.nonce });
        try {
          this.#engine.observe(a.record, {
            type: "TX_SUBMITTED",
            at: Date.now(),
            role,
            hash: claimed,
            nonce: a.attempt,
          });
        } catch (e) {
          // The record cannot take the hash (it has ended, or is in a state this event does not fit — since review 7
          // R7-3 an uncertain wait never ends a record, so this is the fail-closed guard, not the usual path): the real,
          // verified hash is kept for the owner, the record is not moved, and tracking keeps working (review 1 F5).
          if (!(e instanceof Error) || e.name !== "LifecycleError") throw e;
          return put("HASH_AFTER_END", { nonce: tx.nonce, code: e.message });
        }
        return put("SUBMITTED", { nonce: tx.nonce });
      },
    );
    // The attempt moves only after the commit (review 2 N4).
    a.state = next.state;
    if (next.nonce !== null) a.txNonce = next.nonce;
  }
  // ---------------------------------------------------------------------------------------------- tracking
  /**
   * Read-only tracking of one record: source receipts (both operators), replacement / drop / reorg, the claimed hash,
   * destination fill, refund candidates and the final reconciliation. It only ever OBSERVES; it never asks a wallet,
   * re-sends or re-prepares anything.
   */
  async track(i: { session: string; record: string }, signal: AbortSignal) {
    this.#requireArmed();
    this.#session(i.session, i.record, "OBSERVE");
    // Review 2 R2: a store that cannot be written is still OBSERVED — both operators are read for the record's hashes
    // and the account nonce — and shown with what was read; nothing is written, nothing moves.
    if (this.#readOnly)
      return this.view(i.record, [
        `STORE_READ_ONLY:${this.#restoreProblem ?? this.#store.problem ?? this.#store.status}`,
        ...(await this.#observeReadOnly(i.record, signal)),
      ]);
    // Review 13 R13-2: tracking calls of one record run one after another (each takes its time after the previous one
    // has written; the lifecycle refuses time going back).
    const previous = this.#tracking.get(i.record) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() => this.#track(i.record, signal));
    this.#tracking.set(i.record, run);
    try {
      return await run;
    } finally {
      if (this.#tracking.get(i.record) === run) this.#tracking.delete(i.record);
    }
  }
  /** Read-only chain observation of one record (both operators); the notes say what was seen, nothing is recorded. */
  async #observeReadOnly(record: string, signal: AbortSignal) {
    const r = this.#engine.record(record);
    if (!r) return [];
    const owner = this.#record();
    const hashes = new Map<string, "APPROVAL" | "MAIN">();
    for (const role of ["approval", "main"] as const)
      if (r.hashes[role])
        hashes.set(
          lower(r.hashes[role]),
          role === "approval" ? "APPROVAL" : "MAIN",
        );
    for (const a of this.#attempts.values())
      if (a.record === record && a.hash && !hashes.has(lower(a.hash)))
        hashes.set(lower(a.hash), a.action === "APPROVE" ? "APPROVAL" : "MAIN");
    const notes: string[] = [];
    for (const [hash, role] of hashes) {
      const rc = await readReceiptPair("8453", hash, signal).catch(() => null);
      notes.push(
        !rc
          ? `CHAIN_${role}:UNKNOWN:${hash}`
          : rc.status === "AGREE" && rc.receipt
            ? `CHAIN_${role}:${rc.receipt.success ? "MINED_SUCCESS" : "MINED_REVERTED"}:${hash}:${rc.receipt.blockNumber}`
            : `CHAIN_${role}:${rc.status}:${hash}`,
      );
    }
    const n = await readNoncePair("8453", owner.account, signal).catch(
      () => null,
    );
    notes.push(`CHAIN_NONCE:${n?.nonce ?? "UNKNOWN"}`);
    return notes;
  }
  /**
   * Review 1 F1 / review 2 N2 — after a restart or a reload the owner's records are reached again: the same
   * account / amount check as a review, then a fresh session is bound to an existing record of that account (the
   * named one, or the latest) and the rebuilt view is returned. Nothing is asked of a wallet, nothing is re-prepared.
   * The session may take wallet steps (STEP) ONLY when the request carries that record's resume key — handed once to
   * the page that started the record; its hash is journaled, so it survives a restart. Without the key the session
   * can only observe (OBSERVE): the account and the amount are public, so naming them proves nothing. Observe-only
   * sessions live in their own bounded map and never evict a STEP session.
   */
  resume(i: {
    account: string;
    amount: string;
    record?: string;
    resumeKey?: string;
  }) {
    this.#requireArmed();
    const owner = this.#record();
    if (
      lower(i.account) !== lower(owner.account) ||
      i.amount !== owner.exactAmount
    )
      throw new CanaryRuntimeError("NOT_THE_APPROVED_CANARY");
    if (i.resumeKey !== undefined && i.record === undefined)
      throw new CanaryRuntimeError("RESUME_KEY_INVALID");
    const mine = this.#engine
      .records()
      .filter((r) => lower(r.plan?.account) === lower(owner.account))
      .sort((x, y) => (x.audit.at(-1)?.at ?? 0) - (y.audit.at(-1)?.at ?? 0));
    const r =
      i.record !== undefined
        ? mine.find((x) => x.id === i.record)
        : mine.at(-1);
    if (i.record !== undefined && !r)
      throw new CanaryRuntimeError("UNKNOWN_RECORD");
    if (!r)
      return {
        session: null,
        record: null,
        mode: null,
        newer: null,
        store: this.recovery().store,
        restoreProblem: this.#restoreProblem,
      };
    const expected = this.#resumeKeys.get(r.id);
    const keyed =
      typeof i.resumeKey === "string" &&
      /^[0-9a-f]{64}$/.test(i.resumeKey) &&
      expected !== undefined &&
      keyHash(i.resumeKey) === expected;
    if (i.resumeKey !== undefined && !keyed)
      throw new CanaryRuntimeError("RESUME_KEY_INVALID");
    const mode: SessionMode = keyed ? "STEP" : "OBSERVE";
    // G14 follow-up F4 (review 3 N16): a browser's resume slot may name an older record while a newer one of the
    // same account exists (started in another browser). The answer names the newer one, so the page can observe it
    // instead of staying bound to the old one; the binding itself is unchanged (the key only ever names its record).
    const latest = mine.at(-1);
    const newer = latest && latest.id !== r.id ? latest.id : null;
    const map = mode === "STEP" ? this.#sessions : this.#observers;
    const session = randomBytes(32).toString("hex");
    map.set(session, { account: owner.account, record: r.id });
    while (map.size > MAX_SESSIONS) map.delete(map.keys().next().value!);
    return {
      session,
      record: r.id,
      mode,
      newer,
      view: this.view(
        r.id,
        this.#readOnly
          ? [
              `STORE_READ_ONLY:${this.#restoreProblem ?? this.#store.problem ?? this.#store.status}`,
            ]
          : [],
      ),
      store: this.recovery().store,
      restoreProblem: this.#restoreProblem,
    };
  }
  async #track(record: string, signal: AbortSignal) {
    const owner = this.#record();
    const notes: string[] = [];
    for (const a of this.#attempts.values())
      if (a.record === record && a.state === "HASH_CLAIMED")
        await this.#verifyClaim(a, signal);
    this.#expireStale(Date.now());
    let r = this.#engine.record(record);
    if (!r) throw new CanaryRuntimeError("UNKNOWN_RECORD");
    const now = Date.now();
    // An authorization that ended while a wallet prompt may be open: UNCERTAIN, never an end.
    if (
      (r.state === "AWAITING_APPROVAL_SIGNATURE" ||
        r.state === "AWAITING_SIGNATURE") &&
      r.pending &&
      now >= r.pending.expiresAt
    )
      r = this.#batch(() =>
        this.#engine.observe(record, { type: "EXPIRED", at: now }),
      );
    if (r.state === "UNCERTAIN") {
      const a = [...this.#attempts.values()].find(
        (x) => x.record === record && x.attempt === r!.pending?.nonce,
      );
      const n = await readNoncePair("8453", owner.account, signal).catch(
        () => ({ nonce: null, head: null }),
      );
      if (n.nonce === null || !a || a.accountNonce === null)
        notes.push("NONCE_NOT_PROVEN");
      else if (BigInt(n.nonce) > BigInt(a.accountNonce)) {
        notes.push(
          a.state === "HASH_REJECTED"
            ? "NONCE_USED_CLAIMED_HASH_REJECTED"
            : a.hash
              ? "NONCE_USED_CLAIMED_HASH_NOT_SEEN"
              : "NONCE_USED_HASH_UNKNOWN",
        );
        // Review 8 R8-1: the step's hash never reached the server (an answer lost, a page closed with the prompt open),
        // but the account nonce moved. The step's OWN transaction is looked for on both operators, read only (the
        // bounded log search below, mode OWN: exactly the prepared sender, target, calldata, zero value and a nonce not
        // below the reviewed one, in final blocks). Exactly one match is claimed and adopted through the SAME verified
        // claim path a page's hash takes (#verifyClaim: content, not who reported it); anything else changes nothing
        // and the record stays UNCERTAIN with the owner's attention. Nothing is requested, signed or sent.
        // Review 9 R9-1: the same holds for a step whose hash DID reach the server but was never seen on both
        // operators (HASH_CLAIMED: a wallet speed-up or resubmit before inclusion) or did not match (HASH_REJECTED):
        // the step's own exact transaction is looked for in the same way and adopted in place of that claim.
        // Review 9 R9-2: "exactly one" means one over the COMPLETE final range from the review block (the search
        // journals its match and only answers FOUND once that range is read); and the attempt and the record are
        // checked again after the search's wait, inside the write.
        const searchable = (x: Attempt) =>
          x.state === "UNCERTAIN" ||
          x.state === "REQUESTED" ||
          x.state === "HASH_CLAIMED" ||
          x.state === "HASH_REJECTED";
        if (searchable(a)) {
          const before = { state: a.state, hash: a.hash };
          const own = await this.#findReplacement(
            a,
            a.action === "APPROVE" ? "approval" : "main",
            n.head,
            n.head,
            signal,
            "OWN",
          );
          notes.push(
            `OWN_TRANSACTION_SEARCH:${own.status}${own.status === "UNKNOWN" ? ":" + own.reason : ""}`,
          );
          // Review 11 R11-1: what "not found" can mean, stated (the search reads the log the step's intent emits): the
          // step was not confirmed (yet), or it was confirmed with edited content, or its transaction was mined but
          // REVERTED (a reverted transaction emits no log, so it cannot be found this way).
          if (own.status === "NOT_FOUND")
            notes.push(
              "OWN_TRANSACTION_NOT_FOUND:NOT_CONFIRMED_OR_EDITED_OR_REVERTED",
            );
          const claimed =
            own.status === "FOUND" ? own.hash.toLowerCase() : null;
          const adopt =
            claimed !== null &&
            this.#batch(() => {
              if (
                !searchable(a) ||
                a.state !== before.state ||
                a.hash !== before.hash ||
                this.#engine.record(record)?.state !== "UNCERTAIN"
              )
                return false;
              this.#store.append("ATTEMPT", {
                attempt: a.attempt,
                request: a.request,
                state: "HASH_CLAIMED",
                hash: claimed,
                source: "CHAIN_SEARCH",
                at: Date.now(),
              });
              return true;
            });
          if (adopt && claimed) {
            a.state = "HASH_CLAIMED";
            a.hash = claimed;
            await this.#verifyClaim(a, signal);
            notes.push(`OWN_TRANSACTION_FOUND_ON_CHAIN:${claimed}`);
            // Review 12 R12-2: the verified claim recorded its own (later) time; nothing more is observed in THIS call
            // with this call's earlier time (the lifecycle refuses time going back). The next call follows the step.
            return this.view(record, notes);
          }
        }
        // Review 10 R10-1: the account's nonce moved while the step is undecided — something of the owner executed
        // (possibly this step with content the owner edited in the wallet, e.g. another approval amount, which the
        // search above never adopts). The standing allowance to the pinned spender is read (two operators, one
        // block) and shown in every view, as for an ended record: known zero, known non-zero or unknown.
        if (r.state === "UNCERTAIN")
          notes.push(
            `ALLOWANCE_READ_WHILE_UNCERTAIN:${(await this.#readAllowance(record, signal)).status}`,
          );
      } else if (
        r.uncertainSince !== null &&
        now - r.uncertainSince >= EXECUTION_POLICY.dropAfterMs
      )
        // G14 follow-up (review 7 R7-3): elapsed time is not evidence. An unanswered wallet prompt can still be
        // confirmed at any time, so the record is never ended by time: it stays UNCERTAIN, needs the owner's
        // attention, and is read again on every tracking call (a late hash is still verified and adopted).
        notes.push(
          `UNCERTAIN_NONCE_UNCHANGED_FOR_MS:${now - r.uncertainSince}`,
          "RECORD_STAYS_ACTIVE_PROMPT_MAY_STILL_BE_CONFIRMED",
        );
    }
    const role = r.state === "APPROVAL_SUBMITTED" ? "approval" : "main";
    if (
      r.state === "APPROVAL_SUBMITTED" ||
      r.state === "SUBMITTED" ||
      r.state === "REORGED" ||
      r.state === "SOURCE_CONFIRMED" ||
      r.state === "DESTINATION_PENDING" ||
      r.state === "REFUND_PENDING"
    ) {
      const hash = r.hashes[role]!;
      const rc = await readReceiptPair("8453", hash, signal);
      if (rc.status === "AGREE" && rc.receipt && rc.confirmations !== null) {
        this.#clearNonceConsumed(record, hash, now);
        const receipt = rc.receipt;
        if (
          !this.#receipts.has(receipt.hash) ||
          this.#receipts.get(receipt.hash)!.blockHash !== receipt.blockHash
        )
          this.#batch(() => this.#store.append("RECEIPT", { receipt }));
        this.#receipts.set(receipt.hash, receipt);
        // Review 8 R8-4: a REVERTED receipt ends the record (SOURCE_FAILED) only at the confirmation depth TX_CONFIRMED
        // needs; a shallower revert is tracked on (a reorganisation can still change it).
        if (
          !receipt.success &&
          rc.confirmations < EXECUTION_POLICY.confirmations["8453"]
        ) {
          notes.push(`TX_REVERTED_AWAITING_DEPTH:${rc.confirmations}`);
          return this.view(record, notes);
        }
        const ev: ExecutionEvent = receipt.success
          ? {
              type: "TX_CONFIRMED",
              at: now,
              role,
              hash,
              block: receipt.blockNumber,
              blockHash: receipt.blockHash,
              confirmations: rc.confirmations,
            }
          : { type: "TX_FAILED", at: now, role, hash };
        try {
          r = this.#batch(() => this.#engine.observe(record, ev));
        } catch (e) {
          if (!(e instanceof Error) || !/NOT_EXPECTED/.test(e.message)) throw e;
        }
      } else if (
        rc.status === "ABSENT" &&
        (r.state === "SUBMITTED" ||
          r.state === "APPROVAL_SUBMITTED" ||
          r.state === "REORGED")
      ) {
        const t = await readTransactionPair("8453", hash, signal).catch(() => ({
          status: "UNKNOWN" as const,
          transaction: null,
        }));
        if (t.status === "AGREE") this.#clearNonceConsumed(record, hash, now);
        if (t.status === "AGREE")
          r = this.#batch(() =>
            this.#engine.observe(record, {
              type: "REOBSERVED",
              at: now,
              role,
              hash,
            }),
          );
        else if (t.status === "ABSENT") {
          const seen = role === "main" ? r.lastSeenAt : r.approvalSeenAt;
          const lapsed =
            seen !== null && now - seen >= EXECUTION_POLICY.dropAfterMs;
          // Review 1 F7 / review 2 N1: the transaction is gone. If its nonce was consumed by ANOTHER transaction it
          // was replaced, not dropped: that transaction is looked for on both operators (by the log its intent must
          // emit). Same intent (a speed-up) -> tracked on under the new hash; another intent -> REPLACED; the intent's
          // log proven absent over the complete agreed range up to (at least) the block the nonce was seen consumed
          // at, after the drop window -> the record ends DROPPED with the attempt marked NONCE_CONSUMED_UNIDENTIFIED.
          // All but a found same-intent speed-up (the same request under a new hash, tracked on) are shown as needing
          // the owner's attention, in every view, until they are resolved. While the nonce is NOT consumed, nothing
          // ends the record (review 7 R7-3): the signed transaction can still be broadcast and mined.
          const mine = [...this.#attempts.values()].find(
            (x) => x.record === record && lower(x.hash) === lower(hash),
          );
          const nonce = await readNoncePair(
            "8453",
            owner.account,
            signal,
          ).catch(() => ({ nonce: null, head: null }));
          const consumed =
            !!mine?.txNonce &&
            nonce.nonce !== null &&
            BigInt(nonce.nonce) > BigInt(mine.txNonce);
          // Review 9 R9-3: the nonce reads unused again (a reorganisation took the consuming transaction away): the
          // earlier sighting and its mark no longer hold; a later consumption is a new first sighting.
          if (
            !consumed &&
            mine?.nonceConsumed &&
            mine.txNonce !== null &&
            nonce.nonce !== null &&
            BigInt(nonce.nonce) <= BigInt(mine.txNonce)
          ) {
            this.#clearNonceConsumed(record, hash, now);
            notes.push("NONCE_UNUSED_AGAIN");
          }
          if (consumed && mine) {
            notes.push("NONCE_USED_BY_ANOTHER_TRANSACTION");
            // Review 3 N10: journaled once, so every later view (resume, recovery, inspection) carries it.
            if (!mine.nonceConsumed) {
              this.#batch(() =>
                this.#store.append("NONCE_CONSUMED", {
                  attempt: mine.attempt,
                  hash,
                  at: now,
                  block: nonce.head?.number ?? null,
                  blockHash: nonce.head?.hash ?? null,
                }),
              );
              mine.nonceConsumed = true;
              if (nonce.head)
                this.#consumedAt.set(mine.attempt, {
                  number: nonce.head.number,
                  hash: nonce.head.hash,
                });
            }
            // Review 8 R8-4: the block the nonce was FIRST seen consumed at (journaled; a later sighting is later).
            const seenConsumedAt =
              this.#consumedAt.get(mine.attempt) ?? nonce.head;
            const found = await this.#findReplacement(
              mine,
              role,
              seenConsumedAt,
              nonce.head,
              signal,
            );
            notes.push(`REPLACEMENT_SEARCH:${found.status}`);
            // G14 follow-up F1 (R6-1 / G14-CLOSURE-AUDIT-01): an undecided search is NEVER evidence. UNKNOWN (an
            // operator that does not answer or does not agree, an incomplete window, a time-out) and SCANNING (a
            // search still on its way to the head) keep the record in its active state, with the journaled
            // attention mark, and the read-only search continues on the next tracking call from its journaled
            // cursor — however many calls fail and however much time passes. The mark (first undecided time and
            // its latest reason) is journaled when it starts and when its reason changes, so restart, resume and
            // inspection show it; any call that is not UNKNOWN clears it. Nothing here can request, prepare, retry
            // or re-broadcast anything.
            const since = this.#undecidedSince.get(mine.attempt);
            if (found.status === "UNKNOWN") {
              if (
                since === undefined ||
                this.#undecidedReason.get(mine.attempt) !== found.reason
              ) {
                const at = since ?? now;
                this.#batch(() =>
                  this.#store.append("SEARCH_UNDECIDED", {
                    attempt: mine.attempt,
                    at,
                    reason: found.reason,
                  }),
                );
                this.#undecidedSince.set(mine.attempt, at);
                this.#undecidedReason.set(mine.attempt, found.reason);
              }
              notes.push(`REPLACEMENT_SEARCH_UNDECIDED:${found.reason}`);
            } else if (since !== undefined) {
              this.#batch(() =>
                this.#store.append("SEARCH_UNDECIDED", {
                  attempt: mine.attempt,
                  at: null,
                }),
              );
              this.#undecidedSince.delete(mine.attempt);
              this.#undecidedReason.delete(mine.attempt);
            }
            if (found.status === "FOUND") {
              const out = this.#batch(() => {
                const rec = this.#engine.observe(record, {
                  type: "TX_REPLACED",
                  at: now,
                  role,
                  replaced: hash,
                  hash: found.hash,
                  sameIntent: found.sameIntent,
                });
                if (found.sameIntent)
                  this.#store.append("REPLACEMENT", {
                    attempt: mine.attempt,
                    replaced: hash,
                    hash: found.hash,
                    nonce: mine.txNonce,
                    at: now,
                  });
                else
                  this.#store.append("ATTEMPT", {
                    attempt: mine.attempt,
                    request: mine.request,
                    state: "REPLACED",
                    hash,
                    replacedBy: found.hash,
                    nonce: mine.txNonce,
                    at: now,
                  });
                return rec;
              });
              r = out;
              if (found.sameIntent) {
                mine.hash = found.hash;
                mine.nonceConsumed = false;
              } else mine.state = "REPLACED";
              notes.push(
                `${found.sameIntent ? "REPLACED_BY_SAME_INTENT" : "REPLACED_BY_OTHER_INTENT"}:${found.hash}`,
              );
            } else if (lapsed && found.status === "NOT_FOUND") {
              // The ONE definitive negative end of the canary runtime (F1; reviews 7, 8, 12, 13): both operators state
              // the owner's nonce already consumed AT the final block T (read by number at T, at least the Base
              // confirmation depth below their common head — review 13 R13-1), and both agree, over the COMPLETE range
              // from the step's review block to T, that no transaction of the owner with this nonce emitted the log the
              // step's intent must emit (and the not-final tail above T holds none either). The consuming transaction
              // is mined at or before T, so the step's intent did not execute under this nonce, and the nonce can never
              // be used again: the record ends
              // DROPPED. What consumed the nonce is NOT identified (not proven a cancellation, not proven another
              // intent): the attempt is marked NONCE_CONSUMED_UNIDENTIFIED, the evidence (including N) is journaled
              // with it, and the record keeps needing the owner's attention; tracking it afterwards still reads its
              // hashes (read only).
              const evidence = {
                rule: "INTENT_LOG_ABSENT_OVER_COMPLETE_AGREED_RANGE",
                from: found.from,
                to: found.to,
                agreedHead: found.head,
                agreedHeadHash: found.headHash,
                confirmationDepth: found.depth,
                notFinalTailReadTo: found.tailTo,
                finalBlockHash: found.finalBlockHash,
                nonceAtFinalBlock: found.nonceAtFinal,
                consumedNonce: mine.txNonce,
                accountNonce: nonce.nonce,
                consumedSeenAtBlock: found.nonceBlock,
                consumedSeenAtHash: found.nonceBlockHash,
                unseenForMs: now - seen!,
              };
              r = this.#batch(() => {
                const rec = this.#engine.observe(record, {
                  type: "TX_DROPPED",
                  at: now,
                  role,
                  hash,
                  unseenForMs: now - seen!,
                });
                this.#store.append("ATTEMPT", {
                  attempt: mine.attempt,
                  request: mine.request,
                  state: "NONCE_CONSUMED_UNIDENTIFIED",
                  hash,
                  nonce: mine.txNonce,
                  evidence,
                  at: now,
                });
                return rec;
              });
              mine.state = "NONCE_CONSUMED_UNIDENTIFIED";
              mine.evidence = evidence;
              notes.push(
                `INTENT_LOG_ABSENT_TO_BLOCK:${found.to}`,
                "CONSUMING_TRANSACTION_UNIDENTIFIED",
              );
            } else
              notes.push(
                found.status === "NOT_FOUND"
                  ? "REPLACEMENT_SEARCH_NOT_FOUND_BEFORE_DROP_WINDOW"
                  : "RECORD_STAYS_ACTIVE_SEARCH_CONTINUES",
              );
          } else if (nonce.nonce === null) notes.push("NONCE_NOT_PROVEN");
          else if (lapsed)
            // Review 7 R7-3: ABSENT on both operators while its nonce is still unused. The signed transaction can
            // still be broadcast and mined, so elapsed time does not end the record: it stays active, needs the
            // owner's attention and is read again on every tracking call; it ends only on chain evidence (mined,
            // reverted, or its nonce consumed and the search above decided).
            notes.push(
              `TX_ABSENT_NONCE_UNUSED_FOR_MS:${now - seen!}`,
              "RECORD_STAYS_ACTIVE_TX_MAY_STILL_BE_MINED",
            );
        }
      } else if (rc.status === "ABSENT" && r.sourceBlock) {
        // The confirmed transaction is no longer in any block both operators know: reorganised.
        r = this.#batch(() =>
          this.#engine.observe(record, {
            type: "REORG",
            at: now,
            role: "main",
            hash,
          }),
        );
      } else notes.push(`RECEIPT_${rc.status}`);
    }
    if (
      r.state === "SOURCE_CONFIRMED" ||
      r.state === "DESTINATION_PENDING" ||
      r.state === "REFUND_PENDING"
    )
      r = await this.#settle(r, notes, signal);
    const reconcilesNow = r.state === "SETTLED";
    if (r.state === "SETTLED") r = await this.#reconcile(r, notes, signal);
    // G14 follow-up F1 / F3 — an ENDED record is still observed, read only: a DROPPED record's own hashes (a
    // transaction of a dropped record that is mined after all — a reorganisation — is shown, never adopted; DROPPED
    // itself only ever rests on a consumed nonce, review 7 R7-3, so there is no later nonce use to report), and for
    // every ended record that is not RECONCILED the owner's standing allowance to the pinned spender (two operators,
    // one block): known zero, known non-zero or unknown — never assumed zero. A RECONCILED record whose read was
    // UNKNOWN or NONZERO is read again (review 7 R7-5, review 8 R8-3: an owner revocation is seen). Nothing is
    // written but the read itself.
    if (
      TERMINAL.has(r.state) &&
      (r.state !== "RECONCILED" ||
        (!reconcilesNow && this.#allowance.get(record)?.status !== "ZERO"))
    ) {
      if (r.state === "DROPPED") {
        const seen = await this.#observeReadOnly(record, signal);
        notes.push(...seen);
        for (const n of seen) {
          const m =
            /^CHAIN_(APPROVAL|MAIN):MINED_(SUCCESS|REVERTED):(0x[0-9a-f]{64})/.exec(
              n,
            );
          if (m) notes.push(`TX_MINED_AFTER_END:${m[1]}:${m[3]}`);
        }
      }
      await this.#readAllowance(record, signal);
    }
    return this.view(record, notes);
  }
  /**
   * G14 follow-up F3: the owner's USDC allowance to the pinned spender on Base, read from both operators at their
   * common head. ZERO / NONZERO only when both operators state the same value at one agreed block; anything else is
   * UNKNOWN (never 0). A read that differs from the last one is journaled, so every later view shows it.
   */
  async #readAllowance(
    record: string,
    signal: AbortSignal,
    base?: Awaited<ReturnType<typeof readBalancesAtHead>> | null,
  ): Promise<AllowanceRead> {
    const b =
      base === undefined
        ? await readBalancesAtHead(
            "8453",
            this.#record().account,
            signal,
          ).catch(() => null)
        : base;
    const v0 = b?.balances[0]?.values.allowance;
    const v1 = b?.balances[1]?.values.allowance;
    const read: AllowanceRead =
      b && b.head && typeof v0 === "string" && /^\d+$/.test(v0) && v0 === v1
        ? {
            status: v0 === "0" ? "ZERO" : "NONZERO",
            value: v0,
            block: b.head.number,
            at: Date.now(),
          }
        : {
            status: "UNKNOWN",
            value: null,
            block: b?.head?.number ?? null,
            at: Date.now(),
          };
    const prev = this.#allowance.get(record);
    if (!prev || prev.status !== read.status || prev.value !== read.value) {
      this.#batch(() => this.#store.append("ALLOWANCE", { record, read }));
      this.#allowance.set(record, read);
    }
    return read;
  }
  /** Review 4 R4-4: the attempt's own transaction is seen again (mined or back in the mempool): the mark goes. */
  #clearNonceConsumed(record: string, hash: string, at: number) {
    const a = [...this.#attempts.values()].find(
      (x) =>
        x.record === record && lower(x.hash) === lower(hash) && x.nonceConsumed,
    );
    if (!a) return;
    const undecided = this.#undecidedSince.has(a.attempt);
    this.#batch(() => {
      this.#store.append("NONCE_CONSUMED", {
        attempt: a.attempt,
        hash,
        cleared: true,
        at,
      });
      // Review 5 R5-1: the search this mark belonged to is over.
      if (undecided)
        this.#store.append("SEARCH_UNDECIDED", {
          attempt: a.attempt,
          at: null,
        });
    });
    a.nonceConsumed = false;
    this.#undecidedSince.delete(a.attempt);
    this.#undecidedReason.delete(a.attempt);
    this.#consumedAt.delete(a.attempt);
  }
  /**
   * Review 2 N1: the ONE transaction of the owner that consumed a step's nonce, identified on BOTH operators by the
   * log its intent must emit — APPROVE: the Base USDC Approval owner -> Diamond; SEND: the pinned Base SpokePool's
   * FundsDeposited with depositor = owner — from the step's review block on, in bounded windows.
   * Review 8 R8-4: the windows walked with a journaled cursor are FINAL blocks only (at least the Base confirmation
   * depth below the agreed head, the depth TX_CONFIRMED needs), so a window read once is not re-read after a
   * reorganisation.
   * mode REPLACEMENT (a step with a hash whose nonce another transaction consumed): FOUND = an owner transaction with
   *   the step's nonce (sameIntent = the prepared target, calldata and zero value exactly; two mined transactions of
   *   one nonce cannot exist). NOT_FOUND only when (1) the final range reaches `nonceBlock`, the agreed block at which
   *   the nonce was first seen consumed (review 7 R7-2), (2) the agreed head is at or past `currentSeen`, this call's
   *   own sighting of the consumed nonce, and (3) review 9 R9-3: the NOT-final tail (final, head] — read again on every
   *   call, never journaled — holds no owner transaction of that nonce either; so a consuming transaction a
   *   reorganisation moved above the final range is still found. A same-intent match in that tail is FOUND (tracked
   *   on); another intent there decides nothing until it is final. A log of the attempt's own hash in range decides
   *   nothing (its receipt read absent: an operator gap).
   * mode OWN (review 8 R8-1 / review 9 R9-1: an UNCERTAIN step whose account nonce moved): FOUND = exactly ONE owner
   *   transaction with a nonce not below the reviewed one and EXACTLY the prepared target, calldata and zero value
   *   over the COMPLETE final range from the review block (review 9 R9-2: a match is journaled as OWN_CANDIDATE and
   *   FOUND is answered only once the whole final range is read; a second exact match is MORE_THAN_ONE_CANDIDATE);
   *   the caller adopts it only through the verified claim path. NOT_FOUND decides nothing in this mode.
   */
  async #findReplacement(
    a: Attempt,
    role: "approval" | "main",
    nonceBlock: { number: string; hash: string } | null,
    currentSeen: { number: string; hash: string } | null,
    signal: AbortSignal,
    mode: "REPLACEMENT" | "OWN" = "REPLACEMENT",
  ): Promise<
    | { status: "FOUND"; hash: string; sameIntent: boolean }
    | {
        status: "NOT_FOUND";
        from: string;
        to: string;
        head: string;
        headHash: string;
        depth: string;
        tailTo: string;
        nonceBlock: string;
        nonceBlockHash: string;
        finalBlockHash?: string;
        nonceAtFinal?: string;
      }
    | { status: "SCANNING"; cursor: string }
    | { status: "UNKNOWN"; reason: string }
  > {
    const owner = this.#record();
    const reads = this.#reads.get(a.record);
    const from =
      reads?.baseBefore[0]?.block?.number ??
      reads?.baseBefore[1]?.block?.number ??
      null;
    if (!from || !/^\d{1,20}$/.test(from))
      return { status: "UNKNOWN", reason: "REVIEW_BLOCK_UNKNOWN" };
    if (mode === "REPLACEMENT" && a.txNonce === null)
      return { status: "UNKNOWN", reason: "TX_NONCE_UNKNOWN" };
    if (mode === "OWN" && a.accountNonce === null)
      return { status: "UNKNOWN", reason: "ACCOUNT_NONCE_UNKNOWN" };
    if (!nonceBlock || !/^\d{1,20}$/.test(nonceBlock.number))
      return { status: "UNKNOWN", reason: "NONCE_BLOCK_UNKNOWN" };
    const head =
      (await readNoncePair("8453", owner.account, signal).catch(() => null))
        ?.head ?? null;
    if (!head) return { status: "UNKNOWN", reason: "HEAD_NOT_AGREED" };
    if (
      mode === "REPLACEMENT" &&
      (!currentSeen || BigInt(head.number) < BigInt(currentSeen.number))
    )
      return { status: "UNKNOWN", reason: "SEARCH_HEAD_BEHIND_NONCE_BLOCK" };
    const depth = BigInt(EXECUTION_POLICY.confirmations["8453"]);
    const final = BigInt(head.number) - depth;
    const undecided = () =>
      mode === "OWN"
        ? "NO_NEW_FINAL_BLOCK"
        : BigInt(head.number) < BigInt(nonceBlock.number)
          ? "SEARCH_HEAD_BEHIND_NONCE_BLOCK"
          : final < BigInt(nonceBlock.number)
            ? "NONCE_BLOCK_NOT_FINAL"
            : "CURSOR_AHEAD_OF_FINAL_HEAD";
    const p = a.preparation.transaction;
    const exact = (tx: PoolTransaction) =>
      tx.to === lower(p.to) && tx.input === lower(p.data) && tx.value === "0";
    const ours = (tx: PoolTransaction) =>
      tx.from === lower(owner.account) &&
      (mode === "OWN"
        ? BigInt(tx.nonce) >= BigInt(a.accountNonce!) && exact(tx)
        : BigInt(tx.nonce) === BigInt(a.txNonce!));
    const filter = (lo: bigint, hi: bigint) =>
      role === "approval"
        ? {
            address: CANARY_PINS.usdc["8453"].address,
            topics: [
              CANARY_PINS.topics.approval,
              pad(owner.account),
              pad(CANARY_PINS.diamond.address),
            ],
            fromBlock: lo.toString(),
            toBlock: hi.toString(),
          }
        : {
            address: CANARY_PINS.spokePools["8453"].address,
            topics: [
              CANARY_PINS.topics.fundsDeposited,
              word(42161n),
              null,
              pad(owner.account),
            ],
            fromBlock: lo.toString(),
            toBlock: hi.toString(),
          };
    const checked = this.#checked.get(a.attempt) ?? new Set<string>();
    let candidateReads = 0;
    /**
     * One agreed log read of [lo, hi] and the candidate transactions in it (each read with agreement; the ones that
     * are not this step's are journaled and never read again; at most CANDIDATE_READS_PER_CALL reads per call).
     */
    const readRange = async (
      lo: bigint,
      hi: bigint,
    ): Promise<
      | { kind: "READ"; hits: PoolTransaction[]; complete: boolean }
      | { kind: "UNKNOWN"; reason: string }
    > => {
      const logs = await readLogsPair("8453", filter(lo, hi), signal).catch(
        () => null,
      );
      if (!logs || logs.status !== "AGREE" || !logs.logs)
        return { kind: "UNKNOWN", reason: "LOGS_NOT_AGREED" };
      const inRange = [
        ...new Set(logs.logs.map((l) => lower(l.transactionHash))),
      ];
      if (mode === "REPLACEMENT" && a.hash && inRange.includes(lower(a.hash)))
        return { kind: "UNKNOWN", reason: "OWN_HASH_LOG_IN_RANGE" };
      const hits: PoolTransaction[] = [];
      const notOurs: string[] = [];
      const seen = this.#checked.get(a.attempt) ?? checked;
      for (const h of inRange.filter((x) => !seen.has(x))) {
        if (candidateReads >= CANDIDATE_READS_PER_CALL) {
          this.#journalChecked(a.attempt, notOurs);
          return { kind: "READ", hits, complete: false };
        }
        candidateReads++;
        const t = await readTransactionPair("8453", h, signal).catch(
          () => null,
        );
        if (!t || t.status !== "AGREE" || !t.transaction) {
          this.#journalChecked(a.attempt, notOurs);
          return { kind: "UNKNOWN", reason: "CANDIDATE_NOT_AGREED" };
        }
        if (ours(t.transaction)) hits.push(t.transaction);
        else notOurs.push(h);
      }
      this.#journalChecked(a.attempt, notOurs);
      return { kind: "READ", hits, complete: true };
    };
    const moveCursor = (next: bigint) => {
      this.#batch(() =>
        this.#store.append("REPLACEMENT_CURSOR", {
          attempt: a.attempt,
          block: next.toString(),
        }),
      );
      this.#replacementCursor.set(a.attempt, next.toString());
    };
    // Review 3 N10: the final range is walked forward from the review block in windows of 5,000 blocks with a
    // journaled cursor (at most four windows per call); a window both operators agree on is never read again.
    // G14 follow-up F1 (stray-log volume): a window may hold many logs of the owner's OTHER transactions; a crowded
    // window is worked through over several calls (SCANNING, progress kept) instead of failing on every call.
    let lo = BigInt(this.#replacementCursor.get(a.attempt) ?? from);
    if (lo > final + 1n) return { status: "UNKNOWN", reason: undecided() };
    for (let w = 0; w < 4 && lo <= final; w++) {
      const hi = final < lo + 4_999n ? final : lo + 4_999n;
      const got = await readRange(lo, hi);
      if (got.kind === "UNKNOWN")
        return { status: "UNKNOWN", reason: got.reason };
      if (mode === "REPLACEMENT" && got.hits.length > 0) {
        if (got.hits.length > 1)
          return { status: "UNKNOWN", reason: "MORE_THAN_ONE_CANDIDATE" };
        return {
          status: "FOUND",
          hash: got.hits[0].hash,
          sameIntent: exact(got.hits[0]),
        };
      }
      if (mode === "OWN")
        for (const tx of got.hits) {
          const known = this.#ownHit.get(a.attempt);
          if (known && known !== lower(tx.hash))
            return { status: "UNKNOWN", reason: "MORE_THAN_ONE_CANDIDATE" };
          if (!known) {
            this.#batch(() =>
              this.#store.append("OWN_CANDIDATE", {
                attempt: a.attempt,
                hash: lower(tx.hash),
              }),
            );
            this.#ownHit.set(a.attempt, lower(tx.hash));
          }
        }
      if (!got.complete) return { status: "SCANNING", cursor: lo.toString() };
      // Review 4 R4-1: this final window was read with agreement and holds no transaction of that nonce (mode OWN: its
      // one match, if any, is journaled) — whatever other logs it holds — so the cursor moves past it.
      moveCursor(hi + 1n);
      lo = hi + 1n;
    }
    if (lo <= final) return { status: "SCANNING", cursor: lo.toString() };
    // The COMPLETE final range [review block, final] is read.
    if (mode === "OWN") {
      const one = this.#ownHit.get(a.attempt);
      return one
        ? { status: "FOUND", hash: one, sameIntent: true }
        : {
            status: "NOT_FOUND",
            from,
            to: final.toString(),
            head: head.number,
            headHash: head.hash,
            depth: depth.toString(),
            tailTo: final.toString(),
            nonceBlock: nonceBlock.number,
            nonceBlockHash: nonceBlock.hash,
          };
    }
    // Review 9 R9-3: the not-final tail (final, head], read again on every call (never journaled as a cursor). A
    // same-intent match there is followed; another intent there decides nothing until it is final; an incomplete read
    // (the per-call budget) decides nothing either.
    const tailDecision = async (
      fromBlock: bigint,
      toBlock: bigint,
    ): Promise<
      | { status: "FOUND"; hash: string; sameIntent: true }
      | { status: "SCANNING"; cursor: string }
      | { status: "UNKNOWN"; reason: string }
      | null
    > => {
      if (fromBlock > toBlock) return null;
      const tail = await readRange(fromBlock, toBlock);
      if (tail.kind === "UNKNOWN")
        return { status: "UNKNOWN", reason: tail.reason };
      if (tail.hits.length > 1)
        return { status: "UNKNOWN", reason: "MORE_THAN_ONE_CANDIDATE" };
      if (tail.hits.length === 1)
        return exact(tail.hits[0])
          ? { status: "FOUND", hash: tail.hits[0].hash, sameIntent: true }
          : { status: "UNKNOWN", reason: "OTHER_INTENT_NOT_FINAL" };
      if (!tail.complete) return { status: "SCANNING", cursor: lo.toString() };
      return null;
    };
    const firstTail = await tailDecision(final + 1n, BigInt(head.number));
    if (firstTail) return firstTail;
    if (final < BigInt(nonceBlock.number))
      return { status: "UNKNOWN", reason: undecided() };
    // Review 10 R10-2 / review 11 R11-3 / review 12 R12-1: the negative end rests on one chain view, without needing a
    // still chain (Base adds a block every 2 s). After the tail, the nonce and the head are read again: the nonce must
    // still be consumed (a reorganisation that put the consuming transaction back into the mempool decides nothing),
    // the head must not have gone below the one the decision started from, and then the WHOLE not-final tail is read
    // again up to that new head (a same-intent transaction there is followed). Finally (review 13 R13-1) the nonce is
    // read AT the final block: only if it is already consumed there is the consumer inside the final range read above.
    // Not covered: a reorganisation deeper than the confirmation depth (the depth TX_CONFIRMED trusts), or one that
    // happens after the last read of this call.
    const again = await readNoncePair("8453", owner.account, signal).catch(
      () => null,
    );
    if (
      !again?.head ||
      again.nonce === null ||
      BigInt(again.nonce) <= BigInt(a.txNonce!)
    )
      return { status: "UNKNOWN", reason: "NONCE_NOT_CONSUMED_AT_DECISION" };
    if (BigInt(again.head.number) < BigInt(head.number))
      return { status: "UNKNOWN", reason: "HEAD_WENT_BACK_DURING_DECISION" };
    const secondTail = await tailDecision(
      final + 1n,
      BigInt(again.head.number),
    );
    if (secondTail) return secondTail;
    // Review 13 R13-1: the premise of the end itself, read at the FINAL block (not inferred from the first sighting,
    // whose block a reorganisation can replace): both operators state the owner's nonce at block `final` already past
    // the step's nonce — so the consuming transaction lies in the final range read above. Otherwise nothing is decided.
    const atFinal = await readNonceAtBlockPair(
      "8453",
      owner.account,
      final.toString(),
      signal,
    ).catch(() => null);
    if (
      !atFinal?.block ||
      atFinal.nonce === null ||
      BigInt(atFinal.nonce) <= BigInt(a.txNonce!)
    )
      return {
        status: "UNKNOWN",
        reason: "NONCE_NOT_CONSUMED_AT_FINAL_BLOCK",
      };
    return {
      status: "NOT_FOUND",
      from,
      to: final.toString(),
      head: head.number,
      headHash: head.hash,
      depth: depth.toString(),
      tailTo: again.head.number,
      nonceBlock: nonceBlock.number,
      nonceBlockHash: nonceBlock.hash,
      finalBlockHash: atFinal.block.hash,
      nonceAtFinal: atFinal.nonce,
    };
  }
  /** Journals candidates read with agreement that are NOT the attempt's nonce (never read again; restart-proof). */
  #journalChecked(attempt: string, hashes: string[]) {
    if (hashes.length === 0) return;
    this.#batch(() =>
      this.#store.append("REPLACEMENT_CHECKED", { attempt, hashes }),
    );
    const set = this.#checked.get(attempt) ?? new Set<string>();
    for (const h of hashes) set.add(h);
    this.#checked.set(attempt, set);
  }
  async #settle(r: ExecutionRecord, notes: string[], signal: AbortSignal) {
    const owner = this.#record();
    const receipt = r.hashes.main
      ? this.#receipts.get(lower(r.hashes.main))
      : undefined;
    if (!receipt) return r;
    // The deposit of THIS transaction (pinned pool, one FundsDeposited) gives the id the fill must repeat.
    const deposit = depositOf(receipt);
    const depositId = deposit?.depositId ?? null;
    const fillDeadline = deposit?.fillDeadline ?? null;
    const reads = this.#reads.get(r.id);
    if (depositId === null || !reads?.arbStartBlock) {
      notes.push("DEPOSIT_OR_DESTINATION_START_UNKNOWN");
      return r;
    }
    const start = this.#cursor.get(r.id) ?? reads.arbStartBlock;
    const head =
      (
        await readBalancesAtHead("42161", owner.account, signal).catch(
          () => null,
        )
      )?.head ?? null;
    if (!head) return r;
    // Review 14 R14-1: a fill counts only in a FINAL destination block (head minus the Arbitrum confirmation depth,
    // one block stricter than TX_CONFIRMED's count), so a settled record never rests on a fill a shallow reorganisation
    // can undo; the reconciliation that may end it reads at final blocks too (review 15 R15-1, #reconcile). A
    // not-yet-final fill is read again on a later call.
    const finalArb =
      BigInt(head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);
    // No final destination block past the start yet: no fill is read (none can count), but the source side (refund
    // candidates after the deadline) is still looked at below.
    const destinationFinal = finalArb >= BigInt(start);
    if (!destinationFinal) notes.push("DESTINATION_NOT_FINAL_YET");
    const to =
      finalArb < BigInt(start) + 4_999n ? finalArb : BigInt(start) + 4_999n;
    const fills: Awaited<ReturnType<typeof readLogsPair>> = destinationFinal
      ? await readLogsPair(
          "42161",
          {
            address: CANARY_PINS.spokePools["42161"].address,
            topics: [FILLED_RELAY_TOPIC, word(8453n), word(depositId)],
            fromBlock: start,
            toBlock: to.toString(),
          },
          signal,
        )
      : ({ status: "AGREE", logs: [] } as unknown as Awaited<
          ReturnType<typeof readLogsPair>
        >);
    if (fills.status !== "AGREE" || !fills.logs) {
      notes.push("DESTINATION_LOGS_NOT_AGREED");
      return r;
    }
    let destinationLogs: ChainLog[] = [...fills.logs];
    for (const block of new Set(fills.logs.map((l) => l.blockNumber))) {
      const pay = await readLogsPair(
        "42161",
        {
          address: CANARY_PINS.usdc["42161"].address,
          topics: [CANARY_PINS.topics.transfer, null, pad(owner.account)],
          fromBlock: block,
          toBlock: block,
        },
        signal,
      );
      if (pay.status !== "AGREE" || !pay.logs) {
        notes.push("FILL_PAYMENT_NOT_AGREED");
        return r;
      }
      destinationLogs = [...destinationLogs, ...pay.logs];
    }
    let sourceRefundLogs: ChainLog[] = [];
    if (
      fills.logs.length === 0 &&
      fillDeadline !== null &&
      Date.now() / 1000 > fillDeadline
    ) {
      const baseHead =
        (await readNoncePair("8453", owner.account, signal).catch(() => null))
          ?.head ?? null;
      // Review 1 F7: refunds arrive after the deadline, in later bundles: the scan continues from a persisted
      // cursor, 5,000 blocks per call, from the block after the deposit up to the FINAL Base block (review 14 R14-1:
      // the Base confirmation depth below the agreed head).
      const baseFinal = baseHead
        ? BigInt(baseHead.number) -
          BigInt(EXECUTION_POLICY.confirmations["8453"])
        : null;
      if (baseFinal !== null && baseFinal > BigInt(receipt.blockNumber)) {
        const from = BigInt(
          this.#refundCursor.get(r.id) ??
            (BigInt(receipt.blockNumber) + 1n).toString(),
        );
        const until = baseFinal < from + 4_999n ? baseFinal : from + 4_999n;
        const refunds = await readLogsPair(
          "8453",
          {
            address: CANARY_PINS.usdc["8453"].address,
            topics: [
              CANARY_PINS.topics.transfer,
              pad(CANARY_PINS.spokePools["8453"].address),
              pad(owner.account),
            ],
            fromBlock: from.toString(),
            toBlock: until.toString(),
          },
          signal,
        );
        const earlier = this.#refundLogs.get(r.id) ?? [];
        if (refunds.status === "AGREE" && refunds.logs) {
          sourceRefundLogs = [...earlier, ...refunds.logs];
          // Review 2 N7: the cursor moves past every fully scanned window; the window's candidate logs travel with
          // the cursor entry, so a later real refund is still scanned and every earlier candidate is still judged.
          if (until < baseFinal) {
            const next = (until + 1n).toString();
            const found = refunds.logs;
            this.#batch(() =>
              this.#store.append("REFUND_CURSOR", {
                record: r.id,
                block: next,
                logs: found,
              }),
            );
            this.#refundCursor.set(r.id, next);
            if (found.length)
              this.#refundLogs.set(r.id, [...earlier, ...found]);
          }
        } else {
          notes.push("REFUND_LOGS_NOT_AGREED");
          sourceRefundLogs = earlier;
        }
      } else sourceRefundLogs = this.#refundLogs.get(r.id) ?? [];
    }
    const pins = await readDestinationPinsPair(signal).catch(
      () => [null, null] as const,
    );
    const pinsAgree =
      pins[0] &&
      pins[1] &&
      JSON.stringify(pins[0].source.values) ===
        JSON.stringify(pins[1].source.values) &&
      pins[0].source.block?.hash === pins[1].source.block?.hash
        ? pins[0]
        : null;
    const out = this.#batch(() => {
      if (destinationFinal && fills.logs!.length === 0 && to < finalArb) {
        this.#store.append("CURSOR", {
          record: r.id,
          block: (to + 1n).toString(),
        });
        this.#cursor.set(r.id, (to + 1n).toString());
      }
      return this.#engine.settle(r.id, {
        sourceLogs: receipt.logs,
        destinationLogs,
        sourceRefundLogs,
        destinationPins: pinsAgree,
        nowSec: Math.floor(Date.now() / 1000),
        at: Date.now(),
      });
    });
    notes.push(`SETTLEMENT:${out.settlement.status}:${out.settlement.code}`);
    if (out.settlement.status === "REFUNDED")
      notes.push("REFUND_CANDIDATE_IDENTITY_UNPROVEN");
    return out.record;
  }
  async #reconcile(r: ExecutionRecord, notes: string[], signal: AbortSignal) {
    const owner = this.#record();
    const reads = this.#reads.get(r.id);
    if (!reads) return r;
    const [base, arb] = await Promise.all([
      readBalancesAtHead("8453", owner.account, signal).catch(() => null),
      readBalancesAtHead("42161", owner.account, signal).catch(() => null),
    ]);
    if (!base || !arb) return r;
    const out = await this.#reconcileAtFinal(r, notes, signal, base, arb);
    // G14 follow-up F3: known zero, known non-zero or unknown (an unreadable or disagreeing read is never zero).
    // Review 16 R16-1: read on EVERY call that reached the head reads — also while the verdict waits for final blocks —
    // from the head read already in hand (the allowance is a warning; depth never hides it).
    const allowance = await this.#readAllowance(r.id, signal, base);
    if (allowance.status === "NONZERO") notes.push("ALLOWANCE_NOT_ZERO_AFTER");
    else if (allowance.status === "UNKNOWN")
      notes.push("ALLOWANCE_UNKNOWN_AFTER");
    return out;
  }
  /** The reconciliation verdict at the FINAL block of each chain (review 15 R15-1); the record unchanged until then. */
  async #reconcileAtFinal(
    r: ExecutionRecord,
    notes: string[],
    signal: AbortSignal,
    base: Awaited<ReturnType<typeof readBalancesAtHead>>,
    arb: Awaited<ReturnType<typeof readBalancesAtHead>>,
  ): Promise<ExecutionRecord> {
    const owner = this.#record();
    const reads = this.#reads.get(r.id)!;
    if (!base.head || !arb.head) {
      notes.push("RECONCILIATION_HEAD_UNREAD");
      return r;
    }
    // Review 15 R15-1: the reconciliation verdict ENDS the record (RECONCILED or DISCREPANCY), so its balances are read
    // at the FINAL block of each chain (the confirmation depth below the agreed head, by number on both operators) and
    // only once that block holds the evidence it reconciles: the deposit's block on Base, and on Arbitrum the fill
    // itself, read again (same window as the settlement) up to the final block. Before that nothing ends; it is read
    // again on a later call. A head that went back (a lagging operator) therefore cannot hide the fill or the deposit.
    const receipt = r.hashes.main
      ? this.#receipts.get(lower(r.hashes.main))
      : undefined;
    const deposit = receipt ? depositOf(receipt) : null;
    const fillHash = r.hashes.destination;
    if (!receipt || !deposit || !fillHash || !reads.arbStartBlock) {
      notes.push("RECONCILIATION_EVIDENCE_UNKNOWN");
      return r;
    }
    const baseFinal =
      BigInt(base.head.number) - BigInt(EXECUTION_POLICY.confirmations["8453"]);
    const arbFinal =
      BigInt(arb.head.number) - BigInt(EXECUTION_POLICY.confirmations["42161"]);
    const from = BigInt(this.#cursor.get(r.id) ?? reads.arbStartBlock);
    if (baseFinal < BigInt(receipt.blockNumber) || arbFinal < from) {
      notes.push("RECONCILIATION_NOT_FINAL_YET");
      return r;
    }
    const to = arbFinal < from + 4_999n ? arbFinal : from + 4_999n;
    const fill = await readLogsPair(
      "42161",
      {
        address: CANARY_PINS.spokePools["42161"].address,
        topics: [FILLED_RELAY_TOPIC, word(8453n), word(deposit.depositId)],
        fromBlock: from.toString(),
        toBlock: to.toString(),
      },
      signal,
    ).catch(() => null);
    if (
      fill?.status !== "AGREE" ||
      !fill.logs?.some((l) => lower(l.transactionHash) === lower(fillHash))
    ) {
      notes.push("RECONCILIATION_NOT_FINAL_YET");
      return r;
    }
    const [baseAt, arbAt] = await Promise.all([
      readBalancesAtBlockPair(
        "8453",
        owner.account,
        baseFinal.toString(),
        signal,
      ).catch(() => null),
      readBalancesAtBlockPair(
        "42161",
        owner.account,
        arbFinal.toString(),
        signal,
      ).catch(() => null),
    ]);
    if (!baseAt?.block || !arbAt?.block) {
      notes.push("RECONCILIATION_FINAL_BLOCK_UNREAD");
      return r;
    }
    const out = this.#batch(() =>
      this.#engine.reconcile(r.id, {
        baseBefore: reads.baseBefore,
        baseAfter: baseAt.balances,
        arbBefore: reads.arbBefore,
        arbAfter: arbAt.balances,
        at: Date.now(),
      }),
    );
    notes.push(`RECONCILIATION:${out.check.status}:${out.check.code}`);
    return out.record;
  }
  // ---------------------------------------------------------------------------------------------- views & recovery
  /** What a screen (and the owner) may see about one record. Only RECONCILED reads completed. */
  view(record: string, notes: string[] = []) {
    const r = this.#engine.record(record);
    if (!r) throw new CanaryRuntimeError("UNKNOWN_RECORD");
    const attempts = [...this.#attempts.values()]
      .filter((a) => a.record === record)
      .map((a) => ({
        attempt: a.attempt,
        action: a.action,
        state: a.state,
        hash: a.hash,
        restored: a.restored,
        recovery: recoveryClass(a),
        nonceConsumed: a.nonceConsumed,
        // G14 follow-up F1: where the read-only replacement search stands — journaled, so restart / resume /
        // inspection show the same — and the chain evidence of a definitive end, if any.
        search:
          a.nonceConsumed ||
          this.#replacementCursor.has(a.attempt) ||
          this.#checked.has(a.attempt)
            ? {
                cursor: this.#replacementCursor.get(a.attempt) ?? null,
                undecidedSince: this.#undecidedSince.get(a.attempt) ?? null,
                reason: this.#undecidedReason.get(a.attempt) ?? null,
                checkedCandidates: this.#checked.get(a.attempt)?.size ?? 0,
              }
            : null,
        evidence: a.evidence,
      }));
    const anchored = verifyAnchored(r, this.#engineAnchors());
    const receipts = [r.hashes.approval, r.hashes.main]
      .filter((h): h is string => !!h)
      .map((h) => this.#receipts.get(lower(h)))
      .filter((x): x is PoolReceipt => !!x);
    const spent = receipts.every((x) => x.l1FeeWei !== null)
      ? receipts
          .reduce(
            (a, x) =>
              a +
              BigInt(x.gasUsed) * BigInt(x.effectiveGasPrice) +
              BigInt(x.l1FeeWei!),
            0n,
          )
          .toString()
      : null;
    // Review 2 N4: after a failed commit this process's memory may be ahead of the journal. Nothing it holds is then
    // shown as durable, and nothing reads completed; the owner sees the journal again after a restart.
    const notDurable = this.#store.status === "FAILED";
    // G14 follow-up F3 (R6-2 + review 5 R5-4 remainder): what the owner's standing allowance to the pinned spender
    // is after a record ended — from the latest two-operator read (journaled), never assumed zero:
    //   read ZERO -> nothing to say; read NONZERO -> ALLOWANCE_STANDS_AFTER_END; read UNKNOWN -> ..._UNKNOWN_...;
    //   not read yet -> a CONFIRMED deposit spent the exact allowance (nothing to say until a read shows otherwise);
    //   otherwise, when this record sent its own approval OR its review found an allowance already standing (one
    //   left by an earlier record), ALLOWANCE_MAY_STAND_AFTER_END. Revoking it stays the owner's own decision.
    const allowance = this.#allowanceView(r);
    const standing =
      TERMINAL.has(r.state) && r.state !== "RECONCILED"
        ? allowance.status === "NONZERO"
          ? [`ALLOWANCE_STANDS_AFTER_END:${allowance.value}`]
          : allowance.status === "UNKNOWN"
            ? ["ALLOWANCE_UNKNOWN_AFTER_END"]
            : allowance.status === "MAY_STAND_UNREAD"
              ? ["ALLOWANCE_MAY_STAND_AFTER_END"]
              : []
        : r.state === "RECONCILED"
          ? allowance.status === "NONZERO"
            ? ["ALLOWANCE_NOT_ZERO_AFTER"]
            : allowance.status === "UNKNOWN"
              ? ["ALLOWANCE_UNKNOWN_AFTER"]
              : []
          : // Review 10 R10-1: an UNCERTAIN record whose allowance was read (its account nonce moved).
            r.state === "UNCERTAIN" && this.#allowance.has(r.id)
            ? allowance.status === "NONZERO"
              ? [`ALLOWANCE_STANDS_WHILE_UNCERTAIN:${allowance.value}`]
              : allowance.status === "UNKNOWN"
                ? ["ALLOWANCE_UNKNOWN_WHILE_UNCERTAIN"]
                : []
            : [];
    // Review 8 R8-5: a step's transaction the SERVER has not seen for the drop window keeps the record active and
    // needs attention in EVERY view (resume, recovery), not only in a tracking answer — derived from the record.
    const seenAt =
      r.state === "APPROVAL_SUBMITTED"
        ? r.approvalSeenAt
        : r.state === "SUBMITTED" || r.state === "REORGED"
          ? r.lastSeenAt
          : null;
    const unseen =
      typeof seenAt === "number" &&
      Date.now() - seenAt >= EXECUTION_POLICY.dropAfterMs
        ? [
            `TX_UNSEEN_BY_THE_SERVER_SINCE:${seenAt}`,
            "RECORD_STAYS_ACTIVE_TX_MAY_STILL_BE_MINED",
          ]
        : [];
    // G14 follow-up F4 (review 3 N17): a same-intent replacement (speed-up) stays visible in EVERY view — the record
    // follows a hash the owner's wallet changed (its gas fields may differ from the review) — and needs the owner's
    // eye until the record is RECONCILED.
    const speedUps = (["approval", "main"] as const)
      .filter((role) => r.intent[role].length > 1)
      .map((role) =>
        r.state === "RECONCILED"
          ? `SPEED_UP_RECONCILED:${role.toUpperCase()}:${r.intent[role].length - 1}`
          : `SPEED_UP_TRACKED:${role.toUpperCase()}:${r.intent[role].length - 1}`,
      );
    const shownNotes = [
      ...new Set([
        ...(notDurable
          ? [`STORE_FAILED_MEMORY_NOT_DURABLE:${this.#store.problem}`]
          : []),
        ...standing,
        ...unseen,
        ...speedUps,
        ...attempts.flatMap((a) =>
          a.nonceConsumed && a.search?.undecidedSince != null
            ? [`REPLACEMENT_SEARCH_UNDECIDED_SINCE:${a.search.undecidedSince}`]
            : [],
        ),
        ...notes,
      ]),
    ];
    return {
      record,
      state: r.state,
      label: labelOf(r.state),
      completed: r.state === "RECONCILED" && !notDurable,
      notDurable,
      needsAttention:
        notDurable ||
        labelOf(r.state) === "NEEDS_ATTENTION" ||
        attempts.some(
          (a) =>
            a.recovery === "UNCERTAIN" ||
            a.recovery === "HASH_REJECTED" ||
            a.recovery === "HASH_AFTER_END" ||
            a.recovery === "PREPARED_BEFORE_RESTART" ||
            a.recovery === "REPLACED" ||
            a.recovery === "NONCE_CONSUMED_UNIDENTIFIED" ||
            a.nonceConsumed,
        ) ||
        shownNotes.some((n) => ATTENTION_NOTE.test(n)),
      store: { status: this.#store.status, writable: this.#store.writable },
      terminal: TERMINAL.has(r.state),
      hashes: { ...r.hashes },
      delivered: r.delivered,
      attempts,
      gasSpentWei: spent,
      audit: { anchored: anchored.ok, head: this.#store.head() },
      allowance,
      notes: shownNotes,
    };
  }
  /** G14 follow-up F3: the allowance a view states (see view()); a read is the only source of ZERO / NONZERO. */
  #allowanceView(r: ExecutionRecord): {
    status:
      | "ZERO"
      | "NONZERO"
      | "UNKNOWN"
      | "EXPECTED_ZERO_UNREAD"
      | "MAY_STAND_UNREAD"
      | "NOT_READ";
    value: string | null;
    block: string | null;
  } {
    const read = this.#allowance.get(r.id);
    if (read)
      return { status: read.status, value: read.value, block: read.block };
    if (DEPOSIT_CONFIRMED.has(r.state))
      return { status: "EXPECTED_ZERO_UNREAD", value: null, block: null };
    const reads = this.#reads.get(r.id);
    const atReview = [reads?.baseBefore[0], reads?.baseBefore[1]].map(
      (x) => x?.values.allowance,
    );
    const stoodAtReview =
      typeof atReview[0] === "string" &&
      atReview[0] === atReview[1] &&
      atReview[0] !== "0";
    return {
      status:
        r.hashes.approval || stoodAtReview ? "MAY_STAND_UNREAD" : "NOT_READ",
      value: null,
      block: null,
    };
  }
  #engineAnchors(): AnchorEntry[] {
    return this.#store.of("ANCHOR").map((e) => e.data as AnchorEntry);
  }
  /** Read-only recovery report: every record and attempt as rebuilt from the store. Nothing is asked of a wallet. */
  recovery() {
    return {
      store: {
        status: this.#store.status,
        problem: this.#store.problem,
        writable: this.#store.writable,
        head: this.#store.head(),
      },
      restoreProblem: this.#restoreProblem,
      records: this.#engine.records().map((r) => this.view(r.id)),
    };
  }
  /** Checks the store against the head the owner keeps outside the system (honest append = ok; rewrite = refused). */
  verifyOwnerHead(ownerHead: { length: number; hash: string }) {
    return ownerHeadProblem(this.#store.entries(), ownerHead);
  }
  close() {
    this.#store.close();
  }
}
/** How a restart classifies an attempt (no class asks a wallet anything; UNCERTAIN is resolved by reading only). */
export function recoveryClass(a: { state: AttemptState; restored: boolean }) {
  // After a restart a step that was handed towards a wallet without a recorded answer is UNCERTAIN: it may be open
  // in the wallet or mined. A step that was prepared but never requested is spent (single use) and is never
  // confirmed again. Neither is ever re-requested. An UNCERTAIN step leaves that state only on chain evidence: its own
  // EXACT transaction found by the read-only search (review 8 R8-1; also when a claimed hash was never seen or was
  // rejected, review 9 R9-1) — exactly one over the complete final range — or a verified hash. It stays UNCERTAIN
  // (attention; its allowance read and shown once the nonce moved) and keeps the account's canary closed, with no
  // in-product exit (owner steps), when (review 10 R10-1, review 11 R11-1): nothing of the step ever appears on chain;
  // the owner confirmed the prompt with edited content (e.g. another approval amount: never adopted, it is not the
  // step); more than one exact transaction exists; or the step's own transaction was mined but REVERTED without its
  // hash reaching the server (a reverted transaction emits no log, so the log search cannot find it).
  if (a.restored && a.state === "REQUESTED") return "UNCERTAIN";
  if (a.restored && a.state === "PREPARED") return "PREPARED_BEFORE_RESTART";
  return a.state;
}

// ---------------------------------------------------------------------------------------------- the one runtime
let current: CanaryRuntime | null = null;
/** Where the server keeps the canary store when nothing else was set up in code (never read from the environment). */
export const DEFAULT_CANARY_STORE_DIR = () =>
  join(process.cwd(), ".veined-canary-store");
/**
 * Opens THE runtime of this process with an explicit store directory. Once per process: a second call is refused
 * (there is no way to swap the composition later). Refused while the canary is not armed.
 */
export function openCanaryRuntime(o: { dir: string }): CanaryRuntime {
  if (current) throw new CanaryRuntimeError("RUNTIME_EXISTS");
  if (!canaryArmed().armed) throw new CanaryRuntimeError("WRITE_DISABLED");
  current = new CanaryRuntime(o.dir);
  return current;
}
/** The runtime of this process (opened on first use at the default directory). Refused while not armed. */
export function canaryRuntime(): CanaryRuntime {
  if (!canaryArmed().armed) throw new CanaryRuntimeError("WRITE_DISABLED");
  return current ?? openCanaryRuntime({ dir: DEFAULT_CANARY_STORE_DIR() });
}
/**
 * Review 2 R2: when the store cannot be OPENED at all (another live writer holds its lock, or the directory cannot be
 * used) what it holds is still shown, read-only — no lock is taken, nothing is written: the journal's verified
 * prefix, each record's last lifecycle event and each attempt's last state. All of it needs the owner's attention.
 */
export function canaryStoreInspection(
  dir: string = DEFAULT_CANARY_STORE_DIR(),
) {
  let j: ReturnType<typeof CanaryDurableStore.inspect>;
  try {
    j = CanaryDurableStore.inspect(dir);
  } catch {
    return {
      store: { status: "UNREADABLE", problem: null, entries: 0 },
      records: [],
      attempts: [],
      needsAttention: true,
    };
  }
  const records = new Map<
    string,
    { record: string; lastEvent: string; at: number | null }
  >();
  const attempts = new Map<
    string,
    {
      attempt: string;
      record: string;
      state: string;
      hash: string | null;
      nonceConsumed: boolean;
      search: {
        cursor: string | null;
        undecidedSince: number | null;
        reason: string | null;
        checkedCandidates: number;
      };
      evidence: unknown;
    }
  >();
  const allowance = new Map<string, unknown>();
  for (const e of j.entries) {
    const d = e.data as Record<string, unknown>;
    if (e.type === "EVENT") {
      const ev = d.event as { type?: unknown; at?: unknown };
      records.set(String(d.record), {
        record: String(d.record),
        lastEvent: String(ev?.type),
        at: typeof ev?.at === "number" ? ev.at : null,
      });
    } else if (e.type === "PREPARED") {
      const p = d.preparation as Preparation;
      attempts.set(p.attempt, {
        attempt: p.attempt,
        record: p.record,
        state: "PREPARED",
        hash: null,
        nonceConsumed: false,
        search: {
          cursor: null,
          undecidedSince: null,
          reason: null,
          checkedCandidates: 0,
        },
        evidence: null,
      });
    } else if (e.type === "ATTEMPT" && d.cancelAhead !== true) {
      const a = attempts.get(String(d.attempt));
      if (a) {
        a.state = String(d.state);
        if (typeof d.hash === "string") a.hash = d.hash;
        if (d.evidence) a.evidence = d.evidence;
      }
    } else if (e.type === "REPLACEMENT_CURSOR") {
      const a = attempts.get(String(d.attempt));
      if (a) a.search.cursor = String(d.block);
    } else if (e.type === "SEARCH_UNDECIDED") {
      const a = attempts.get(String(d.attempt));
      if (a) {
        a.search.undecidedSince = typeof d.at === "number" ? d.at : null;
        a.search.reason =
          typeof d.at === "number" && typeof d.reason === "string"
            ? d.reason
            : null;
      }
    } else if (e.type === "REPLACEMENT_CHECKED") {
      const a = attempts.get(String(d.attempt));
      if (a && Array.isArray(d.hashes))
        a.search.checkedCandidates += d.hashes.length;
    } else if (e.type === "ALLOWANCE") {
      allowance.set(String(d.record), d.read);
    } else if (e.type === "REPLACEMENT") {
      const a = attempts.get(String(d.attempt));
      if (a && typeof d.hash === "string") {
        a.hash = d.hash;
        a.nonceConsumed = false;
      }
    } else if (e.type === "NONCE_CONSUMED") {
      const a = attempts.get(String(d.attempt));
      if (a) a.nonceConsumed = d.cleared !== true;
    }
  }
  return {
    store: {
      status: j.status,
      problem: j.problem,
      entries: j.entries.length,
      head: j.entries.at(-1)?.hash ?? null,
    },
    records: [...records.values()].map((r) => ({
      ...r,
      // Review 8 R8-5: how long the journal has held no new event of the record (the 503 view shows it).
      lastEventAgeMs: r.at === null ? null : Math.max(0, Date.now() - r.at),
      allowance: allowance.get(r.record) ?? null,
    })),
    attempts: [...attempts.values()],
    needsAttention: true,
  };
}
/** Closes THE runtime (releases the writer lock). The next use opens it again from the store. */
export function closeCanaryRuntime() {
  current?.close();
  current = null;
}
// The error classes the API maps to public codes.
export { CanaryError, StoreError };
