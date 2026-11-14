// G13: the execution record. Pure and deterministic: every observation or owner action is an event; `apply` checks it
// against the legal edges (model.ts TRANSITIONS) and the invariants below, and appends it to a hash-chained audit log.
// Invariants enforced here, independent of any screen (hardened after the Phase 3 review, F04–F07, F16):
//   - the review shown must be recomputed from THIS record's plan, server Guardian verdict and preflight report;
//   - nothing is submitted without an owner authorization for exactly this review, record, action and account, used
//     once, with enough quote time left;
//   - one main transaction per record: once a main hash exists no new SEND authorization is accepted; a replacement is
//     only accepted as the SAME intent (speed-up: the hash joins the intent set) — anything else ends the record;
//   - every observation must name a hash of this intent (original or speed-up); an unrelated hash is refused;
//   - once a wallet prompt may be open, expiry moves the record to UNCERTAIN (a hash returned later is still recorded);
//     UNCERTAIN never accepts a new authorization and resolves only by a hash or a timeout with the nonce unchanged;
//   - a re-quote after an approval may not change the account, kind, pay asset, amount or approval spender;
//   - a delivery below the plan's minimum is a DISCREPANCY; "completed" exists only as RECONCILED.
// The audit chain is TAMPER-EVIDENT (verifyAudit replays the transitions and the hash links); detecting a cut-off tail
// needs the head (length + last hash) anchored outside this record — auditHead() returns it for that purpose.
import { digest } from "./canonical";
import {
  EXECUTION_POLICY,
  TRANSITIONS,
  type ExecutionPlan,
  type LifecycleState,
} from "./model";
import {
  authorizationProblem,
  planDigest,
  reviewDigest,
  type OwnerAuthorization,
} from "./binding";
import { planProblem } from "./plan-check";
import { CHECK_IDS, preflightDigest, type Check } from "./preflight";

/** G14 (review N5): a structurally exact preflight report — every check id once, a known status, a code. */
function reportProblem(r: unknown): boolean {
  if (!r || typeof r !== "object") return true;
  const o = r as { checks?: unknown; now?: unknown };
  if (!Number.isSafeInteger(o.now) || !Array.isArray(o.checks)) return true;
  if (o.checks.length !== CHECK_IDS.length) return true;
  return o.checks.some(
    (c: unknown, i) =>
      !c ||
      typeof c !== "object" ||
      Object.keys(c).length !== 3 ||
      (c as Check).id !== CHECK_IDS[i] ||
      !["PASS", "FAIL", "UNKNOWN"].includes((c as Check).status) ||
      typeof (c as Check).code !== "string",
  );
}

export type TxRole = "approval" | "main";
export type ExecutionEvent =
  | { type: "QUOTE_READ"; at: number; plan: ExecutionPlan }
  | {
      type: "PREFLIGHT";
      at: number;
      plan: string;
      ready: boolean;
      digest: string;
      failed: string[];
      /**
       * G14 (review N5): the report itself. `ready`, `failed` and `digest` are RECOMPUTED from it here; a caller's
       * claim that disagrees with its own report is refused. This proves consistency, not authorship: who produced
       * the report is checked by the server engine's attestation (server/canary/attestation.ts).
       */
      report: { checks: Check[]; now: number };
    }
  | {
      type: "GUARDIAN";
      at: number;
      plan: string;
      level: string;
      digest: string;
      quoteId: string;
    }
  | { type: "REVIEW_SHOWN"; at: number; review: string }
  | { type: "OWNER_AUTHORIZED"; at: number; authorization: OwnerAuthorization }
  | { type: "OWNER_REJECTED"; at: number }
  | { type: "WALLET_UNCERTAIN"; at: number }
  | {
      type: "TX_SUBMITTED";
      at: number;
      role: TxRole;
      hash: string;
      nonce: string;
    }
  | {
      type: "TX_REPLACED";
      at: number;
      role: TxRole;
      replaced: string;
      hash: string;
      sameIntent: boolean;
    }
  | {
      type: "TX_CONFIRMED";
      at: number;
      role: TxRole;
      hash: string;
      block: string;
      blockHash: string;
      confirmations: number;
    }
  | { type: "TX_FAILED"; at: number; role: TxRole; hash: string }
  | {
      type: "TX_DROPPED";
      at: number;
      role: TxRole;
      hash: string;
      unseenForMs: number;
    }
  | { type: "UNCERTAIN_TIMEOUT"; at: number; accountNonceUnchanged: boolean }
  | { type: "REORG"; at: number; role: TxRole; hash: string }
  | { type: "REOBSERVED"; at: number; role: TxRole; hash: string }
  | {
      type: "DESTINATION";
      at: number;
      status:
        | "PENDING"
        | "DELIVERED"
        | "PARTIAL"
        | "FAILED"
        | "REFUND_PENDING"
        | "REFUNDED";
      hash?: string;
      amount?: string;
    }
  | { type: "RECONCILED"; at: number; ok: boolean; detail: string }
  | { type: "EXPIRED"; at: number }
  | { type: "BLOCK"; at: number; reason: string };

export interface AuditEntry {
  seq: number;
  at: number;
  type: ExecutionEvent["type"];
  state: LifecycleState;
  /** The event without bulky fields (the plan is represented by its digest). */
  event: Record<string, unknown>;
  prev: string;
  hash: string;
}
export interface ExecutionRecord {
  id: string;
  state: LifecycleState;
  plan: ExecutionPlan | null;
  planHash: string | null;
  guardian: { level: string; digest: string } | null;
  preflight: { ready: boolean; digest: string } | null;
  review: string | null;
  pending: {
    action: OwnerAuthorization["action"];
    nonce: string;
    review: string;
    expiresAt: number;
  } | null;
  usedNonces: string[];
  /** The hash currently tracked per role. */
  hashes: {
    approval: string | null;
    main: string | null;
    destination: string | null;
  };
  /** Every hash of the same intent per role (the original plus same-intent replacements). */
  intent: { approval: string[]; main: string[] };
  uncertainSince: number | null;
  /** The block the main transaction was confirmed in (a different block later = it was reorganised; round 4, S1). */
  sourceBlock: { number: string; hash: string } | null;
  /** When the main transaction was seen reorganised out: the drop window runs from here (round 4, S1). */
  reorgedAt: number | null;
  /**
   * The last time the main transaction was seen (submission, a receipt, a reorg, a re-observation or a same-intent
   * replacement). A transaction is DROPPED only after a full window unseen since then (review round 5, T1).
   */
  lastSeenAt: number | null;
  /** The same anchor for the approval transaction (review round 6, U2). */
  approvalSeenAt: number | null;
  delivered: string | null;
  audit: AuditEntry[];
}
export class LifecycleError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "LifecycleError";
  }
}
const GENESIS = "0".repeat(64);
const HASH = /^0x[0-9a-fA-F]{64}$/;
const NEAR_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const same = (a: string | null | undefined, b: string | null | undefined) =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export function newRecord(id: string): ExecutionRecord {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new LifecycleError("INVALID_ID");
  return {
    id,
    state: "DRAFT",
    plan: null,
    planHash: null,
    guardian: null,
    preflight: null,
    review: null,
    pending: null,
    usedNonces: [],
    hashes: { approval: null, main: null, destination: null },
    intent: { approval: [], main: [] },
    uncertainSince: null,
    sourceBlock: null,
    reorgedAt: null,
    lastSeenAt: null,
    approvalSeenAt: null,
    delivered: null,
    audit: [],
  };
}
function sanitized(e: ExecutionEvent): Record<string, unknown> {
  if (e.type === "QUOTE_READ")
    return {
      type: e.type,
      at: e.at,
      plan: planDigest(e.plan),
      quoteId: e.plan.quoteId,
    };
  if (e.type === "OWNER_AUTHORIZED")
    return {
      type: e.type,
      at: e.at,
      action: e.authorization.action,
      review: e.authorization.review,
      record: e.authorization.record,
      nonce: e.authorization.nonce,
      expiresAt: e.authorization.expiresAt,
    };
  return { ...e };
}
const confirmationsNeeded = (chain: string) =>
  EXECUTION_POLICY.confirmations[chain] ??
  EXECUTION_POLICY.confirmations.default;
const PRE_WALLET: readonly LifecycleState[] = [
  "QUOTED",
  "PREFLIGHT_PASSED",
  "GUARDIAN_PASSED",
  "REVIEWED",
];
const submittedState = (role: TxRole): LifecycleState =>
  role === "approval" ? "APPROVAL_SUBMITTED" : "SUBMITTED";
/** The "last seen" anchor of a role (review rounds 5 T1, 6 U2). */
const seen = (role: TxRole, at: number): Partial<ExecutionRecord> =>
  role === "main" ? { lastSeenAt: at } : { approvalSeenAt: at };

function next(
  r: ExecutionRecord,
  e: ExecutionEvent,
): { state: LifecycleState; patch: Partial<ExecutionRecord> } {
  const plan = r.plan;
  const needPlan = () => {
    if (!plan) throw new LifecycleError("NO_PLAN");
    return plan;
  };
  const inIntent = (role: TxRole, hash: string) =>
    r.intent[role].some((h) => same(h, hash));
  switch (e.type) {
    case "QUOTE_READ": {
      if (r.state !== "DRAFT" && r.state !== "APPROVAL_CONFIRMED")
        throw new LifecycleError("QUOTE_NOT_EXPECTED");
      // Strict plan shape (review round 3, R7): a malformed number is refused here, never thrown on later.
      if (planProblem(e.plan)) throw new LifecycleError("PLAN_INVALID");
      if (e.plan.platformFeeBps !== EXECUTION_POLICY.platformFeeBps)
        throw new LifecycleError("PLATFORM_FEE_NOT_ALLOWED");
      if (e.plan.executable !== true)
        throw new LifecycleError("DRY_QUOTE_NOT_EXECUTABLE");
      if (r.plan) {
        const a = r.plan,
          b = e.plan;
        // After an approval the fresh quote must still be the same transfer (review F16b).
        if (
          !same(a.account, b.account) ||
          a.kind !== b.kind ||
          a.pay.chainId !== b.pay.chainId ||
          !same(a.pay.address, b.pay.address) ||
          a.amountIn !== b.amountIn ||
          // After the approval the fresh plan needs none (the allowance covers it, review N2 / round 3 R9) and the
          // call must be pulled by exactly the spender that was approved (round 3, R1).
          b.approval !== null ||
          !a.approval ||
          !same(a.approval.spender, b.spender)
        )
          throw new LifecycleError("PLAN_IDENTITY_CHANGED");
      }
      return {
        state: "QUOTED",
        patch: {
          plan: e.plan,
          planHash: planDigest(e.plan),
          guardian: null,
          preflight: null,
          review: null,
          pending: null,
        },
      };
    }
    case "PREFLIGHT":
      if (r.state !== "QUOTED")
        throw new LifecycleError("PREFLIGHT_NOT_EXPECTED");
      if (typeof e.ready !== "boolean" || !/^[0-9a-f]{64}$/.test(e.digest))
        throw new LifecycleError("INVALID_OBSERVATION");
      if (e.plan !== r.planHash)
        throw new LifecycleError("PREFLIGHT_PLAN_MISMATCH");
      // G14 (review N5): the claim must be what the report itself says.
      if (reportProblem(e.report))
        throw new LifecycleError("PREFLIGHT_REPORT_INVALID");
      {
        const ready = e.report.checks.every((c) => c.status === "PASS");
        const failed = e.report.checks
          .filter((c) => c.status !== "PASS")
          .map((c) => c.id);
        if (
          e.ready !== ready ||
          e.digest !== preflightDigest(e.plan, e.report.checks, e.report.now) ||
          !Array.isArray(e.failed) ||
          e.failed.length !== failed.length ||
          e.failed.some((x, i) => x !== failed[i])
        )
          throw new LifecycleError("PREFLIGHT_CLAIM_MISMATCH");
      }
      return e.ready
        ? {
            state: "PREFLIGHT_PASSED",
            patch: { preflight: { ready: true, digest: e.digest } },
          }
        : {
            state: "BLOCKED",
            patch: { preflight: { ready: false, digest: e.digest } },
          };
    case "GUARDIAN": {
      if (r.state !== "PREFLIGHT_PASSED")
        throw new LifecycleError("GUARDIAN_NOT_EXPECTED");
      if (e.plan !== r.planHash || e.quoteId !== needPlan().quoteId)
        throw new LifecycleError("GUARDIAN_QUOTE_MISMATCH");
      // HOLD and BLOCK stop the record; CLEAR and CAUTION may continue to the owner's review.
      const pass = e.level === "CLEAR" || e.level === "CAUTION";
      return {
        state: pass ? "GUARDIAN_PASSED" : "BLOCKED",
        patch: { guardian: { level: e.level, digest: e.digest } },
      };
    }
    case "REVIEW_SHOWN": {
      if (r.state !== "GUARDIAN_PASSED")
        throw new LifecycleError("REVIEW_NOT_EXPECTED");
      // The review is recomputed from this record, never taken from the caller (review F04).
      const expected = reviewDigest(
        r.planHash!,
        r.guardian!.digest,
        r.preflight!.digest,
      );
      if (e.review !== expected) throw new LifecycleError("REVIEW_MISMATCH");
      return { state: "REVIEWED", patch: { review: expected } };
    }
    case "OWNER_AUTHORIZED": {
      const p = needPlan();
      if (r.state === "UNCERTAIN")
        throw new LifecycleError("UNCERTAIN_NO_NEW_SIGNATURE");
      if (r.state !== "REVIEWED")
        throw new LifecycleError("AUTHORIZATION_NOT_EXPECTED");
      if (r.hashes.main !== null)
        throw new LifecycleError("MAIN_ALREADY_SUBMITTED");
      const action = p.approval && !r.hashes.approval ? "APPROVE" : "SEND";
      const problem = authorizationProblem(e.authorization, {
        action,
        review: r.review ?? "",
        record: r.id,
        account: p.account,
        now: e.at,
        used: new Set(r.usedNonces),
      });
      if (problem) throw new LifecycleError(problem);
      if (p.expiresAt - e.at < EXECUTION_POLICY.minRemainingMs)
        throw new LifecycleError("QUOTE_TOO_CLOSE_TO_EXPIRY");
      return {
        state:
          action === "APPROVE"
            ? "AWAITING_APPROVAL_SIGNATURE"
            : "AWAITING_SIGNATURE",
        patch: {
          pending: {
            action,
            nonce: e.authorization.nonce,
            review: e.authorization.review,
            expiresAt: e.authorization.expiresAt,
          },
          usedNonces: [...r.usedNonces, e.authorization.nonce],
        },
      };
    }
    case "OWNER_REJECTED":
      // A definitive wallet rejection (EIP-1193 code 4001) only; UNCERTAIN is not a rejection (review F06d).
      if (
        r.state !== "AWAITING_APPROVAL_SIGNATURE" &&
        r.state !== "AWAITING_SIGNATURE"
      )
        throw new LifecycleError("REJECTION_NOT_EXPECTED");
      return { state: "OWNER_REJECTED", patch: { pending: null } };
    case "WALLET_UNCERTAIN":
      if (
        r.state !== "AWAITING_APPROVAL_SIGNATURE" &&
        r.state !== "AWAITING_SIGNATURE"
      )
        throw new LifecycleError("UNCERTAIN_NOT_EXPECTED");
      return { state: "UNCERTAIN", patch: { uncertainSince: e.at } };
    case "TX_SUBMITTED": {
      if (!HASH.test(e.hash)) throw new LifecycleError("INVALID_HASH");
      const role = e.role;
      const expected =
        role === "approval"
          ? "AWAITING_APPROVAL_SIGNATURE"
          : "AWAITING_SIGNATURE";
      if (r.hashes[role] !== null)
        throw new LifecycleError("DUPLICATE_SUBMISSION");
      if (r.state !== expected && r.state !== "UNCERTAIN")
        throw new LifecycleError(
          r.state === "SUBMITTED" || r.state === "APPROVAL_SUBMITTED"
            ? "DUPLICATE_SUBMISSION"
            : "SUBMISSION_NOT_AUTHORIZED",
        );
      if (
        !r.pending ||
        r.pending.nonce !== e.nonce ||
        (r.pending.action === "APPROVE") !== (role === "approval")
      )
        throw new LifecycleError("SUBMISSION_NOT_AUTHORIZED");
      return {
        state: submittedState(role),
        patch: {
          pending: null,
          uncertainSince: null,
          hashes: { ...r.hashes, [role]: e.hash },
          intent: { ...r.intent, [role]: [e.hash] },
          ...seen(role, e.at),
        },
      };
    }
    case "TX_REPLACED": {
      // A reorged-out main transaction can still be replaced (review round 3, N6): same intent -> tracked again as
      // SUBMITTED under the new hash; another transaction took the nonce -> REPLACED (needs attention).
      const reorged = r.state === "REORGED" && e.role === "main";
      if (
        (r.state !== submittedState(e.role) && !reorged) ||
        !inIntent(e.role, e.replaced)
      )
        throw new LifecycleError("REPLACEMENT_NOT_EXPECTED");
      if (!HASH.test(e.hash)) throw new LifecycleError("INVALID_HASH");
      // A speed-up of the same intent keeps tracking under the new hash; a different intent consumed the nonce: end.
      return e.sameIntent === true
        ? {
            state: reorged ? "SUBMITTED" : r.state,
            patch: {
              hashes: { ...r.hashes, [e.role]: e.hash },
              intent: { ...r.intent, [e.role]: [...r.intent[e.role], e.hash] },
              ...seen(e.role, e.at),
            },
          }
        : { state: "REPLACED", patch: {} };
    }
    case "TX_CONFIRMED": {
      const p = needPlan();
      // Strict observation fields (review N4): a missing or non-numeric count is never "confirmed".
      if (
        !Number.isSafeInteger(e.confirmations) ||
        e.confirmations < 0 ||
        !HASH.test(e.blockHash) ||
        !/^\d{1,20}$/.test(e.block)
      )
        throw new LifecycleError("INVALID_OBSERVATION");
      const deep = e.confirmations >= confirmationsNeeded(p.sourceChainId);
      // Already confirmed (round 4, S1): the same block is a repeated observation; a DIFFERENT block means the
      // transaction was reorganised and re-included — it is followed again from REORGED until it is deep enough.
      if (
        e.role === "main" &&
        (r.state === "SOURCE_CONFIRMED" ||
          r.state === "DESTINATION_PENDING" ||
          r.state === "REFUND_PENDING")
      ) {
        if (!same(r.hashes.main, e.hash))
          throw new LifecycleError("CONFIRMATION_NOT_EXPECTED");
        if (r.sourceBlock && same(r.sourceBlock.hash, e.blockHash))
          return { state: r.state, patch: { lastSeenAt: e.at } };
        return {
          state: "REORGED",
          patch: { reorgedAt: e.at, sourceBlock: null, lastSeenAt: e.at },
        };
      }
      // A repeated observation of the confirmed approval changes nothing (round 5, T2).
      if (
        e.role === "approval" &&
        r.state === "APPROVAL_CONFIRMED" &&
        same(r.hashes.approval, e.hash)
      )
        return { state: r.state, patch: { approvalSeenAt: e.at } };
      const reorged = r.state === "REORGED" && e.role === "main";
      if (
        (r.state !== submittedState(e.role) && !reorged) ||
        !inIntent(e.role, e.hash)
      )
        throw new LifecycleError("CONFIRMATION_NOT_EXPECTED");
      if (!deep)
        return {
          state: reorged ? "SUBMITTED" : r.state,
          patch: {
            hashes: { ...r.hashes, [e.role]: e.hash },
            ...seen(e.role, e.at),
          },
        };
      return {
        state:
          e.role === "approval" ? "APPROVAL_CONFIRMED" : "SOURCE_CONFIRMED",
        patch: {
          hashes: { ...r.hashes, [e.role]: e.hash },
          ...(e.role === "main"
            ? {
                sourceBlock: { number: e.block, hash: e.blockHash },
                reorgedAt: null,
                lastSeenAt: e.at,
              }
            : { approvalSeenAt: e.at }),
        },
      };
    }
    case "TX_FAILED":
      // A reverted receipt is mined (the nonce is used): definitive for any hash of the intent — also when the
      // reorganised transaction is re-mined and reverts this time (round 4, S1).
      if (
        (r.state !== submittedState(e.role) &&
          !(r.state === "REORGED" && e.role === "main")) ||
        !inIntent(e.role, e.hash)
      )
        throw new LifecycleError("OBSERVATION_NOT_EXPECTED");
      return { state: "SOURCE_FAILED", patch: {} };
    case "TX_DROPPED":
      // Only the hash currently tracked, unseen for the whole drop window (a dropped old speed-up hash is not an end).
      // A reorged main transaction that is never mined again ends here too, after the same window (review N6).
      if (!(
        (r.state === submittedState(e.role) &&
          same(r.hashes[e.role], e.hash)) ||
        (r.state === "REORGED" && e.role === "main" && inIntent("main", e.hash))
      ))
        throw new LifecycleError("OBSERVATION_NOT_EXPECTED");
      if (!(e.unseenForMs >= EXECUTION_POLICY.dropAfterMs))
        throw new LifecycleError("NOT_DROPPED_YET");
      // The window runs from the LAST time this record saw the transaction — its submission, a receipt or the reorg
      // (round 4 S1, round 5 T1) — whatever the caller's own count says.
      {
        // Per role (round 6, U2); a record without the anchor fails closed (round 6, U4).
        const seenAt = e.role === "main" ? r.lastSeenAt : r.approvalSeenAt;
        if (
          typeof seenAt !== "number" ||
          !(e.at - seenAt >= EXECUTION_POLICY.dropAfterMs)
        )
          throw new LifecycleError("NOT_DROPPED_YET");
      }
      return { state: "DROPPED", patch: {} };
    case "UNCERTAIN_TIMEOUT":
      if (r.state !== "UNCERTAIN" || r.uncertainSince === null)
        throw new LifecycleError("OBSERVATION_NOT_EXPECTED");
      if (
        e.accountNonceUnchanged !== true ||
        e.at - r.uncertainSince < EXECUTION_POLICY.dropAfterMs
      )
        throw new LifecycleError("NOT_DROPPED_YET");
      return { state: "DROPPED", patch: { pending: null } };
    case "REORG": {
      if (e.role === "main") {
        if (
          (r.state !== "SOURCE_CONFIRMED" &&
            r.state !== "DESTINATION_PENDING" &&
            r.state !== "REFUND_PENDING") ||
          !same(r.hashes.main, e.hash)
        )
          throw new LifecycleError("REORG_NOT_EXPECTED");
        // The confirming block is gone: forget it, and keep when it was last seen (round 5, T1/T2).
        return {
          state: "REORGED",
          patch: { reorgedAt: e.at, sourceBlock: null, lastSeenAt: e.at },
        };
      }
      if (r.state !== "APPROVAL_CONFIRMED" || !same(r.hashes.approval, e.hash))
        throw new LifecycleError("REORG_NOT_EXPECTED");
      return { state: "APPROVAL_SUBMITTED", patch: { approvalSeenAt: e.at } };
    }
    case "REOBSERVED":
      // A sighting of the transaction — in the mempool, or again after a reorg (round 6, U1): it refreshes when the
      // record last saw it, so a long-pending transaction is not DROPPED on the first poll that misses it.
      if (
        r.state === "REORGED" &&
        e.role === "main" &&
        inIntent("main", e.hash)
      )
        return {
          state: "SUBMITTED",
          patch: { hashes: { ...r.hashes, main: e.hash }, lastSeenAt: e.at },
        };
      if (r.state === submittedState(e.role) && same(r.hashes[e.role], e.hash))
        return { state: r.state, patch: seen(e.role, e.at) };
      throw new LifecycleError("REOBSERVE_NOT_EXPECTED");
    case "DESTINATION": {
      const p = needPlan();
      if (
        r.state !== "SOURCE_CONFIRMED" &&
        r.state !== "DESTINATION_PENDING" &&
        r.state !== "REFUND_PENDING"
      )
        throw new LifecycleError("DESTINATION_NOT_EXPECTED");
      if (e.status === "PENDING")
        return { state: "DESTINATION_PENDING", patch: {} };
      if (e.status === "FAILED")
        return { state: "DESTINATION_FAILED", patch: {} };
      if (e.status === "REFUND_PENDING")
        return { state: "REFUND_PENDING", patch: {} };
      // A refund is recorded only with the amount read on chain (review F16e); it still needs the owner's attention.
      // A refund of nothing is not a refund (round 4, S2): the amount read must be above zero.
      if (e.status === "REFUNDED") {
        if (!e.amount || !/^[1-9]\d{0,77}$/.test(e.amount))
          throw new LifecycleError("REFUND_AMOUNT_REQUIRED");
        return { state: "REFUNDED", patch: { delivered: e.amount } };
      }
      // Anything but a delivery report is refused here (round 5, T3): no unknown status can reach SETTLED.
      if (e.status !== "DELIVERED" && e.status !== "PARTIAL")
        throw new LifecycleError("INVALID_OBSERVATION");
      const amount =
        e.amount && /^\d{1,78}$/.test(e.amount) ? BigInt(e.amount) : null;
      // Destination hashes are validated per destination (review F16g): EVM 32-byte hex, NEAR base58.
      const hashOk = (h?: string) =>
        !!h &&
        (p.kind === "NEAR_INTENTS"
          ? NEAR_HASH.test(h) || HASH.test(h)
          : HASH.test(h));
      if (e.status === "DELIVERED" && p.kind !== "EVM_SWAP" && !hashOk(e.hash))
        throw new LifecycleError("DESTINATION_HASH_REQUIRED");
      // A delivery is only recorded with the amount actually read on the destination chain (never assumed).
      if (e.status === "DELIVERED" && amount === null)
        throw new LifecycleError("DESTINATION_AMOUNT_REQUIRED");
      // A bridge's destination transaction is never the source transaction (review F16g).
      if (
        p.kind !== "EVM_SWAP" &&
        e.hash &&
        (same(e.hash, r.hashes.main) || same(e.hash, r.hashes.approval))
      )
        throw new LifecycleError("DESTINATION_HASH_IS_SOURCE");
      if (
        e.status === "PARTIAL" ||
        amount === null ||
        amount < BigInt(p.minimumOut)
      )
        return {
          state: "DISCREPANCY",
          patch: {
            hashes: { ...r.hashes, destination: e.hash ?? null },
            delivered: e.amount ?? null,
          },
        };
      return {
        state: "SETTLED",
        patch: {
          hashes: { ...r.hashes, destination: e.hash ?? null },
          delivered: e.amount!,
        },
      };
    }
    case "RECONCILED":
      if (r.state !== "SETTLED")
        throw new LifecycleError("RECONCILE_NOT_EXPECTED");
      return { state: e.ok === true ? "RECONCILED" : "DISCREPANCY", patch: {} };
    case "EXPIRED": {
      const p = needPlan();
      if (
        r.state === "AWAITING_APPROVAL_SIGNATURE" ||
        r.state === "AWAITING_SIGNATURE"
      ) {
        // A wallet prompt may still be open: not an end — a hash it returns later is still recorded (review F06c).
        if (e.at < p.expiresAt && !(r.pending && e.at >= r.pending.expiresAt))
          throw new LifecycleError("NOT_EXPIRED");
        return { state: "UNCERTAIN", patch: { uncertainSince: e.at } };
      }
      if (!PRE_WALLET.includes(r.state))
        throw new LifecycleError("EXPIRY_NOT_EXPECTED");
      if (e.at < p.expiresAt) throw new LifecycleError("NOT_EXPIRED");
      return { state: "EXPIRED", patch: { pending: null } };
    }
    case "BLOCK":
      if (!PRE_WALLET.includes(r.state) && r.state !== "DRAFT")
        throw new LifecycleError("BLOCK_NOT_EXPECTED");
      return { state: "BLOCKED", patch: { pending: null } };
    default:
      throw new LifecycleError("UNKNOWN_EVENT");
  }
}
const ROLES: readonly unknown[] = ["approval", "main"];
const STRING_FIELDS = [
  "hash",
  "replaced",
  "blockHash",
  "block",
  "nonce",
  "amount",
  "digest",
  "plan",
  "review",
] as const;
const ROLE_EVENTS = new Set([
  "TX_SUBMITTED",
  "TX_REPLACED",
  "TX_CONFIRMED",
  "TX_FAILED",
  "TX_DROPPED",
  "REORG",
  "REOBSERVED",
]);
const BOOLEAN_FIELDS = ["sameIntent", "ok", "ready", "accountNonceUnchanged"];
const NUMBER_FIELDS = ["unseenForMs", "confirmations"];
/** Structurally malformed events are refused with a code, never thrown on (review rounds 5 T4, 6 U3). */
function eventProblem(e: unknown): string | null {
  if (!e || typeof e !== "object") return "INVALID_OBSERVATION";
  const o = e as Record<string, unknown>;
  if (typeof o.type !== "string") return "UNKNOWN_EVENT";
  if ((ROLE_EVENTS.has(o.type) || "role" in o) && !ROLES.includes(o.role))
    return "INVALID_OBSERVATION";
  if (
    o.type === "OWNER_AUTHORIZED" &&
    (!o.authorization || typeof o.authorization !== "object")
  )
    return "INVALID_OBSERVATION";
  // G14 (review round 7, V2): a hand-made authorization with non-string fields is refused with a code, never thrown on.
  if (o.type === "OWNER_AUTHORIZED") {
    const a = o.authorization as Record<string, unknown>;
    if (
      ["action", "review", "record", "account", "nonce"].some(
        (k) => typeof a[k] !== "string",
      ) ||
      !Number.isSafeInteger(a.issuedAt) ||
      !Number.isSafeInteger(a.expiresAt)
    )
      return "INVALID_OBSERVATION";
  }
  if (o.type === "PREFLIGHT" && (!o.report || typeof o.report !== "object"))
    return "INVALID_OBSERVATION";
  for (const k of BOOLEAN_FIELDS)
    if (k in o && typeof o[k] !== "boolean") return "INVALID_OBSERVATION";
  for (const k of NUMBER_FIELDS)
    if (k in o && (typeof o[k] !== "number" || !Number.isFinite(o[k])))
      return "INVALID_OBSERVATION";
  if ("reason" in o && typeof o.reason !== "string")
    return "INVALID_OBSERVATION";
  if ("detail" in o && typeof o.detail !== "string")
    return "INVALID_OBSERVATION";
  if (
    "failed" in o &&
    !(Array.isArray(o.failed) && o.failed.every((x) => typeof x === "string"))
  )
    return "INVALID_OBSERVATION";
  for (const k of STRING_FIELDS)
    if (
      k in o &&
      o[k] !== undefined &&
      !(k === "plan" && o.type === "QUOTE_READ") &&
      typeof o[k] !== "string"
    )
      return "INVALID_OBSERVATION";
  return null;
}
/** Applies one event; returns a NEW record (the input is never mutated). */
export function apply(r: ExecutionRecord, e: ExecutionEvent): ExecutionRecord {
  const problem = eventProblem(e);
  if (problem) throw new LifecycleError(problem);
  if (!Number.isFinite(e.at) || e.at < (r.audit.at(-1)?.at ?? 0))
    throw new LifecycleError("CLOCK_WENT_BACK");
  const { state, patch } = next(r, e);
  if (state !== r.state && !TRANSITIONS[r.state].includes(state))
    throw new LifecycleError(`ILLEGAL_${r.state}_TO_${state}`);
  const prev = r.audit.at(-1)?.hash ?? GENESIS;
  const seq = r.audit.length;
  let event: Record<string, unknown>, hash: string;
  try {
    event = sanitized(e);
    hash = digest({
      seq,
      at: e.at,
      type: e.type,
      state,
      event,
      prev,
      id: r.id,
    });
  } catch {
    throw new LifecycleError("INVALID_OBSERVATION");
  }
  const entry: AuditEntry = {
    seq,
    at: e.at,
    type: e.type,
    state,
    event,
    prev,
    hash,
  };
  return { ...r, ...patch, state, audit: [...r.audit, entry] };
}
/** The head to anchor outside the record (owner report, signed note, insert-only store): truncation is then detectable. */
export function auditHead(r: Pick<ExecutionRecord, "audit">): {
  length: number;
  hash: string;
} {
  return { length: r.audit.length, hash: r.audit.at(-1)?.hash ?? GENESIS };
}
/**
 * Tamper-evident verification: every entry commits to its predecessor and content, and every recorded state change is
 * a legal edge from DRAFT onward (a fabricated QUOTED -> RECONCILED chain fails). With an `anchor` (see auditHead) a
 * removed tail is detected too. Returns the first bad sequence number.
 */
export function verifyAudit(
  id: string,
  audit: readonly AuditEntry[],
  anchor?: { length: number; hash: string },
): { ok: true } | { ok: false; at: number } {
  let prev = GENESIS;
  let state: LifecycleState = "DRAFT";
  for (let i = 0; i < audit.length; i++) {
    const a = audit[i];
    let expect: string;
    try {
      expect = digest({
        seq: a.seq,
        at: a.at,
        type: a.type,
        state: a.state,
        event: a.event,
        prev: a.prev,
        id,
      });
    } catch {
      return { ok: false, at: i };
    }
    if (a.seq !== i || a.prev !== prev || a.hash !== expect)
      return { ok: false, at: i };
    if (a.state !== state && !TRANSITIONS[state].includes(a.state))
      return { ok: false, at: i };
    if (a.event.type !== a.type) return { ok: false, at: i };
    // Round-2 review (F07): time never moves backwards and each entry's time is its event's time.
    if (
      !Number.isFinite(a.at) ||
      a.event.at !== a.at ||
      (i > 0 && a.at < audit[i - 1].at)
    )
      return { ok: false, at: i };
    prev = a.hash;
    state = a.state;
  }
  if (anchor && (anchor.length !== audit.length || anchor.hash !== prev))
    return { ok: false, at: Math.min(audit.length, anchor.length) };
  return { ok: true };
}
