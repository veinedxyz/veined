import {
  BridgeError,
  type Quote,
  ROUTE,
  type TransferRecord,
  recordSchema,
  sameAddress,
} from "../../core/model";
import {
  withVerifiedIntent,
  recordSubmission,
  sameIntentNamespace,
} from "./lifecycle";
import {
  validateUnsigned,
  type Deployment,
  type Unsigned,
} from "../../adapters/onebridge";
import {
  canaryRequestClock,
  commitCanaryDispatch,
  confirmCanaryPreparation,
  discardCanaryConfirmation,
  discardCanaryDispatchAuthority,
  refusedBeforeWallet,
  type WalletProviderAdapter,
} from "../wallet/adapter";
import {
  CANARY_APPROVAL_BOUNDS,
  OWNER_CANARY_APPROVAL,
  canaryDispatchProblem,
  canaryExactPreparation,
  canaryExactTransaction,
  canaryPreparedText,
  canaryWalletRequestProblem,
  type CanaryAction,
  type CanaryDispatchLimits,
} from "../../security/canary-approval";
import { sha256, stringToHex } from "viem";
// V1.9: the wallet is the active session's adapter (Privy external wallet, connect-only). The adapter is the only
// object that can ask the wallet to send, and only via sendCanonicalTransaction (field-by-field comparison).
export async function submit(
  provider: Pick<
    WalletProviderAdapter,
    "identity" | "sendCanonicalTransaction"
  >,
  tx: Unsigned,
  q: Quote,
  d: Deployment,
  context: {
    enabled: boolean;
    releaseApproved: boolean;
    revalidate: () => Promise<void>;
    observeHistory?: (
      claim: import("../../core/model").TransferRecord,
    ) => Promise<unknown>;
    persistUnknown: () => void | Promise<void>;
    persistHash: (hash: string) => void | Promise<void>;
    persistRejected: () => void | Promise<void>;
    intent?: TransferRecord;
  },
): Promise<string> {
  // No local signer and no bypass for a fixture. This is the only wallet write boundary.
  if (
    !context.enabled ||
    !context.releaseApproved ||
    q.mode !== "mainnet-readonly" ||
    !d.verified ||
    ROUTE.sourceContract === null ||
    ROUTE.destinationContract === null
  )
    throw new BridgeError("MAINNET_WRITE_DISABLED");
  if (!context.observeHistory)
    throw new BridgeError("HISTORY_REVALIDATION_REQUIRED");
  return withVerifiedIntent(q.account, q, context.observeHistory, async () => {
    await context.revalidate();
    const live = await provider.identity();
    if (
      live.account.toLowerCase() !== q.account.toLowerCase() ||
      live.chainId !== q.sourceChain
    )
      throw new BridgeError("IDENTITY_CHANGED");
    validateUnsigned(tx, q, d);
    const intent = recordSchema.parse(context.intent);
    if (
      intent.sourceHash ||
      !sameIntentNamespace(intent, q.account, q) ||
      !sameAddress(intent.recipient, q.recipient) ||
      !sameAddress(intent.token, q.token) ||
      intent.amount !== q.amount.toString() ||
      intent.expected !== q.expected.toString()
    )
      throw new BridgeError("INVALID_SUBMISSION_INTENT");
    const canonical = {
      from: tx.account,
      to: tx.to,
      data: tx.data,
      value: `0x${tx.value.toString(16)}`,
      chainId: `0x${tx.chainId.toString(16)}`,
    };
    return recordSubmission(
      () =>
        provider.sendCanonicalTransaction(
          canonical,
          { ...canonical },
          {
            gate: "otherbridge-submission",
          },
        ),
      {
        unknown: context.persistUnknown,
        hash: context.persistHash,
        rejected: context.persistRejected,
      },
      intent,
    );
  });
}

// G14 protected proposal B3 + G14 closure (PP1-AUDIT-01, H3) + follow-up F2 (R3) — the owner-signed canary at the SAME
// single wallet write boundary. With the disarmed owner record it refuses before anything else. It never builds a
// transaction, never switches networks, never signs a message and never asks twice.
const CANARY_FIELDS = Object.freeze([
  "chainId",
  "from",
  "to",
  "value",
  "data",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const);
export type CanaryWalletTransaction = Record<
  (typeof CANARY_FIELDS)[number],
  string
>;
/**
 * What the server's canary runtime prepared for ONE wallet step (hex quantities, exactly as the wallet receives
 * them), with the evidence that binds it: the owner approval, the server's record / review / attempt, both time
 * limits and the digest the server fixed over all of it (canaryPreparedText). None of it is chosen by the page.
 */
export interface CanaryPreparation {
  action: CanaryAction;
  record: string;
  /** Digest of the server review this step belongs to. */
  review: string;
  transaction: CanaryWalletTransaction;
  /** When the server authorization of this step ends (ms). */
  expiresAt: number;
  /** The owner approval (approvalId) the server prepared this step under. */
  approvalId: string;
  /** The server's id of this one attempt (the consumed authorization's nonce). */
  attempt: string;
  /** When the reviewed quote — the prepared plan — ends (ms). */
  quoteExpiresAt: number;
  /** sha256 of canaryPreparedText over everything above. */
  digest: string;
}
/** Names ONE durable write of ONE attempt: a late or repeated write can never be mistaken for another attempt's. */
export interface CanaryAttemptRef {
  record: string;
  action: CanaryAction;
  attempt: string;
  digest: string;
  /** Chosen by the page for this one call (16 random bytes): the server's conditional cleanup is keyed by it. */
  request: string;
}
export interface CanarySubmissionContext {
  /**
   * The server session this step belongs to (64 hex). G14 follow-up F2: the SERVER's confirmation of its own
   * preparation and its durable REQUESTED record are obtained by the wallet adapter itself, through its own fetch of
   * the same-origin API (obtainCanaryDispatchAuthority) — never through a callback the caller hands in.
   */
  session: string;
  /** The owner's own fresh gesture for THIS step (the browser's event.isTrusted and its time). */
  gesture: { trusted: boolean; at: number };
  /**
   * Records the hash. G14 follow-up F4 (`recorded`): the step counts as recorded ONLY when this resolves to exactly
   * `true` (the server committed the claim); `false`, anything else, a rejection or no answer in time = not recorded.
   * Recorded is not verified: the server verifies a claimed hash on both operators before the record moves.
   */
  persistHash: (
    hash: string,
    action: CanaryAction,
    ref: CanaryAttemptRef,
  ) => unknown;
  persistRejected: (ref: CanaryAttemptRef) => void | Promise<void>;
  /** A hash that arrives after the wait ended: recorded and tracked only — never a reason to ask the wallet again. */
  persistLateHash: (
    hash: string,
    action: CanaryAction,
    ref: CanaryAttemptRef,
  ) => void | Promise<void>;
  /**
   * The wallet was NOT asked for this attempt's write `ref.request`: the server makes the CONDITIONAL, atomic
   * transition "requested by exactly this write -> not requested" (and refuses that write if it arrives later). It
   * never touches another attempt or another write. Resolves only when the server confirmed it; a rejection, `false`
   * or no answer in time leaves the outcome unknown (H3). It can only cancel: it never grants anything.
   */
  persistNotRequested: (ref: CanaryAttemptRef) => unknown;
  /** Synchronous veto: false once the review this step belongs to is no longer the current one. Can only refuse. */
  current?: () => boolean;
  /** Aborted on an account / network / session change: nothing is requested after it. */
  signal?: AbortSignal;
}
/** How long the owner's gesture counts, and how long the page waits for the server and for the wallet. */
export const CANARY_GESTURE_MAX_AGE_MS = CANARY_APPROVAL_BOUNDS.gestureMaxAgeMs;
export const CANARY_CONFIRM_WAIT_MS = 10_000;
export const CANARY_WALLET_WAIT_MS = 120_000;
/**
 * Wallet steps already handed to a wallet in this runtime, keyed by the OWNER RECORD (approvalId) and the action —
 * never by a label the page chooses (review 1 F1): one APPROVE and one SEND per approval, whatever record name,
 * re-quote or retry the page presents. The value is the token of the call that holds the step: only that call can
 * give it back, so a late clean-up of an earlier call can never release a later call's step (H3).
 */
const canarySteps = new Map<string, symbol>();
/**
 * Approvals with a wallet step — or a durable record — whose outcome is not known (timeout, provider error, an answer
 * that is not a hash, a write the server did not confirm). Once set, no further canary step of that approval is
 * handed to any wallet in this runtime: an unclear outcome is resolved only by the server reading the chain (a
 * verified hash, or the step's own exact transaction found by its read-only search) — never by asking again; without
 * such evidence it stays unresolved. (The durable limits are the server's journals; this set is the page's own memory.)
 */
const canaryUncertain = new Set<string>();
const HASH = /^0x[0-9a-fA-F]{64}$/;
const refuse = (reason: string) =>
  Object.assign(new BridgeError("CANARY_REQUEST_REFUSED"), {
    reason,
    beforeWalletRequest: true as const,
  });
/** The digest of a preparation as the server fixes it (sha256 of the protected module's fixed-order text). */
export function canaryPreparationDigest(
  p: Omit<CanaryPreparation, "digest">,
): string {
  return sha256(
    stringToHex(
      canaryPreparedText({
        approvalId: p.approvalId,
        record: p.record,
        review: p.review,
        action: p.action,
        attempt: p.attempt,
        authorizationExpiresAt: p.expiresAt,
        quoteExpiresAt: p.quoteExpiresAt,
        transaction: p.transaction,
      }),
    ),
  ).slice(2);
}
/**
 * Runs `operation` with a bound: `{ ok: true, value }` when it settled in time, `{ ok: false }` when it rejected or
 * did not answer within `ms` (its outcome is then NOT known). Never throws, never waits longer than `ms`.
 */
type Bounded<T> = { ok: true; value: Awaited<T> } | { ok: false };
async function bounded<T>(
  operation: () => T | Promise<T>,
  ms: number,
): Promise<Bounded<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve()
        .then(operation)
        .then(
          (value): Bounded<T> => ({ ok: true, value: value as Awaited<T> }),
          (): Bounded<T> => ({ ok: false }),
        ),
      new Promise<Bounded<T>>((resolve) => {
        timer = setTimeout(() => resolve({ ok: false }), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const requestId = () => {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
};
/**
 * One canary wallet step (APPROVE or SEND — separate, single-use actions; an approval hash is never proof of the
 * transfer). Order:
 *   1. the protected owner record covers the exact request (its calldata included);
 *   2. the preparation is complete, names this owner approval, and its digest is the digest of its own fields;
 *   3. the action names the shape (APPROVE calls the token, SEND the pinned target);
 *   4. owner record window, server authorization, reviewed quote and the owner's fresh trusted gesture are alive
 *      (an early check on the page's copy; the adapter's check on the server's own values is the one that counts);
 *   5. this approval has no step of unknown outcome and has not used this action;
 *   6. the WALLET ADAPTER asks the server itself (follow-up F2, phase 1) for its own preparation of this attempt,
 *      confirmed field by field (bounded; nothing is written by it);
 *   7. live account and chain (no switch), the caller's abort signal and "still current" veto;
 *   8. the step is taken, and the adapter commits the server's DURABLE "requested" record of this write (phase 2) and
 *      mints the dispatch authority from that exact answer — committed before anything can reach a wallet. If that
 *      record's outcome is not known (H3: a write that timed out may still complete) the server is asked for the
 *      conditional clean-up of exactly that write; only when the server confirms it is the step given back.
 *      Otherwise the approval is marked uncertain: no retry;
 *   9. every time limit is checked AGAIN, and nothing is awaited between that check and the adapter call (a failed
 *      check discards the authority before the clean-up is asked);
 *  10. the adapter's canonical send under the canary gate with that authority — which re-reads the identity and then
 *      repeats the limits check on the server's own values, synchronously, immediately before the wallet request.
 * Outcome: a hash (`recorded` only when the server confirmed the claim), OWNER_REJECTED (wallet code 4001, definitive)
 * or SUBMISSION_UNCERTAIN (timeout, provider error, an answer that is not a hash). After an uncertain outcome nothing is
 * retried, the adapter keeps that wallet blocked, and no further canary step of the approval is requested; a late hash
 * or a late rejection is only recorded. No clean-up write waits without a bound.
 */
export async function submitCanary(
  provider: WalletProviderAdapter,
  preparedInput: CanaryPreparation,
  context: CanarySubmissionContext,
): Promise<{ action: CanaryAction; hash: string; recorded: boolean }> {
  // Review 1 F10: the same monotonic, never-backwards clock as the adapter's (a wall clock set back mid-flow cannot
  // stop time for the gesture / authorization checks of this flow).
  const clock = canaryRequestClock();
  let seen = clock();
  const now = () => (seen = clock(seen));
  const entered = now();
  // 1. The protected owner record (module constant; disarmed in this build) must cover the exact request.
  const page = canaryExactTransaction(preparedInput?.transaction);
  const problem = canaryWalletRequestProblem(
    OWNER_CANARY_APPROVAL,
    page ?? {},
    entered,
  );
  if (problem) throw refuse(problem);
  const approval = OWNER_CANARY_APPROVAL;
  // 2. Complete, bound to this owner approval, and digested over exactly its own fields.
  const prepared = canaryExactPreparation(preparedInput);
  if (!approval || !page || !prepared) throw refuse("PREPARATION_MALFORMED");
  if (prepared.approvalId !== approval.approvalId)
    throw refuse("PREPARATION_APPROVAL_MISMATCH");
  if (canaryPreparationDigest(prepared) !== prepared.digest)
    throw refuse("PREPARATION_DIGEST_MISMATCH");
  // 3. The action names the shape: APPROVE calls the token, SEND calls the pinned target (never the other way).
  const toToken =
    page.to.toLowerCase() === CANARY_APPROVAL_BOUNDS.token.toLowerCase();
  if ((prepared.action === "APPROVE") !== toToken)
    throw refuse("ACTION_TARGET_MISMATCH");
  // 4. Owner window, server authorization, reviewed quote and a fresh trusted owner gesture for this step.
  const gesture = Object.freeze({
    trusted: context?.gesture?.trusted,
    at: context?.gesture?.at,
  });
  const limits: CanaryDispatchLimits = Object.freeze({
    approvalId: prepared.approvalId,
    action: prepared.action,
    record: prepared.record,
    review: prepared.review,
    attempt: prepared.attempt,
    preparedDigest: prepared.digest,
    authorizationExpiresAt: prepared.expiresAt,
    quoteExpiresAt: prepared.quoteExpiresAt,
    gesture,
  });
  // Review 7 R7-7: the EARLY check runs before any server answer, so it can only use the page clock (a page clock off
  // by more than the slack refuses here, before anything is asked or written — liveness only). The LATE check below
  // judges in the server's time (the confirmation's measured offset), as the adapter does: "now" AND the owner's
  // click are both moved into server time (review 8 R8-2), so the gesture's age is the same in either clock.
  const alive = (offsetMs = 0) =>
    canaryDispatchProblem(
      OWNER_CANARY_APPROVAL,
      page,
      offsetMs === 0
        ? limits
        : {
            ...limits,
            gesture: {
              trusted: gesture.trusted,
              at: Number(gesture.at) + offsetMs,
            },
          },
      now() + offsetMs,
    );
  const early = alive();
  if (early) throw refuse(early);
  if (
    typeof context.session !== "string" ||
    !/^[0-9a-f]{64}$/.test(context.session) ||
    typeof context.persistHash !== "function" ||
    typeof context.persistRejected !== "function" ||
    typeof context.persistLateHash !== "function" ||
    typeof context.persistNotRequested !== "function" ||
    (context.current !== undefined && typeof context.current !== "function")
  )
    throw refuse("PREPARATION_CONTEXT_REQUIRED");
  const stopped = () =>
    context.signal?.aborted === true
      ? "IDENTITY_CHANGED"
      : context.current !== undefined && context.current() !== true
        ? "REVIEW_NO_LONGER_CURRENT"
        : null;
  // 5. Per owner record: no step while an earlier one is unresolved, and each action at most once.
  const step = `${approval.approvalId}:${prepared.action}`;
  const blocked = () =>
    canaryUncertain.has(approval.approvalId)
      ? "PREVIOUS_STEP_UNCERTAIN"
      : canarySteps.has(step)
        ? "STEP_ALREADY_REQUESTED"
        : null;
  const before = blocked() ?? stopped();
  if (before) throw refuse(before);
  // 6. The SERVER's own preparation for this attempt, asked by the wallet adapter itself (follow-up F2, phase 1:
  //    nothing is written by it). Bounded inside the adapter; never repaired here.
  const confirmed = await confirmCanaryPreparation(provider, {
    session: context.session,
    review: prepared.review,
    ref: {
      record: prepared.record,
      action: prepared.action,
      attempt: prepared.attempt,
      digest: prepared.digest,
    },
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!confirmed.ok) throw refuse(confirmed.code);
  // 7. Live wallet identity; a wrong network is refused, never switched here.
  let live: { account: string; chainId: number } | null = null;
  try {
    live = await provider.identity(context.signal);
  } catch {
    live = null;
  }
  if (
    !live ||
    live.account.toLowerCase() !== page.from.toLowerCase() ||
    live.chainId !== Number(CANARY_APPROVAL_BOUNDS.sourceChainId)
  ) {
    discardCanaryConfirmation(confirmed.confirmation);
    throw Object.assign(new BridgeError("IDENTITY_CHANGED"), {
      beforeWalletRequest: true as const,
    });
  }
  // 8. The step is taken (synchronously with its check), then the adapter commits the server's DURABLE "requested"
  //    record of this write and mints the dispatch authority from that answer (phase 2).
  const again = blocked() ?? stopped();
  if (again) {
    discardCanaryConfirmation(confirmed.confirmation);
    throw refuse(again);
  }
  const holder = Symbol(step);
  canarySteps.set(step, holder);
  const ref: CanaryAttemptRef = Object.freeze({
    record: prepared.record,
    action: prepared.action,
    attempt: prepared.attempt,
    digest: prepared.digest,
    request: requestId(),
  });
  /**
   * Nothing reached a wallet. The server is asked for the conditional clean-up of THIS write (bounded). Confirmed:
   * the step is given back — by this call only. Not confirmed: the outcome of the record is unknown, so the approval
   * is marked uncertain and nothing is retried (H3).
   */
  const notRequested = async (): Promise<boolean> => {
    const cleared = await bounded(
      () => context.persistNotRequested(ref),
      CANARY_CONFIRM_WAIT_MS,
    );
    // Review 1 F3: only an explicit `true` is the server's confirmation; anything else leaves the outcome unknown.
    if (!cleared.ok || cleared.value !== true) {
      canaryUncertain.add(approval.approvalId);
      return false;
    }
    if (canarySteps.get(step) === holder) canarySteps.delete(step);
    return true;
  };
  const obtained = await commitCanaryDispatch(confirmed.confirmation, {
    request: ref.request,
    gesture: { trusted: gesture.trusted === true, at: Number(gesture.at) },
    ...(context.signal ? { signal: context.signal } : {}),
  });
  if (!obtained.ok) {
    // Not minted. Review 7 R7-6: a DEFINITIVE refusal of the commit (the server answered that it wrote nothing) gives
    // the step back and reports the server's code; there is nothing to clean up. Otherwise (the write may have been
    // committed) only the server's conditional clean-up of exactly this write makes "not requested" true.
    if (obtained.written === false) {
      if (canarySteps.get(step) === holder) canarySteps.delete(step);
      throw refuse(obtained.code);
    }
    const cleared = await notRequested();
    throw refuse(cleared ? "RECORD_NOT_WRITTEN" : "RECORD_OUTCOME_UNKNOWN");
  }
  const authority = obtained.authority;
  // 9. Everything above took time. Owner window, authorization, quote, gesture, abort and the "still current" veto
  //    are checked again NOW, and nothing is awaited between this check and the adapter call.
  const late = alive(confirmed.offsetMs) ?? stopped();
  if (late) {
    discardCanaryDispatchAuthority(authority);
    throw refuse((await notRequested()) ? late : "RECORD_OUTCOME_UNKNOWN");
  }
  // 10. The single financial primitive. The adapter spends the authority, compares the server's object with the
  //    page's copy again, re-reads the identity, enforces one request per wallet, and repeats the limits check on the
  //    server's own values — after its own last await, in the same synchronous step as the wallet request.
  const request = provider.sendCanonicalTransaction(
    prepared.transaction,
    { ...page },
    {
      gate: "veined-owner-canary",
      ...(context.signal ? { signal: context.signal } : {}),
      canary: {
        authority,
        notBefore: seen,
        ...(context.current ? { current: context.current } : {}),
      },
    },
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waited = new Promise<"TIMEOUT">((resolve) => {
    timer = setTimeout(() => resolve("TIMEOUT"), CANARY_WALLET_WAIT_MS);
  });
  let result: unknown;
  try {
    result = await Promise.race([request, waited]);
  } catch (e) {
    // Only a refusal the adapter itself made before any wallet request leaves the step unspent (a wallet cannot
    // forge that marker, review 1 F11) — and only once the server confirmed the clean-up of this write.
    if (refusedBeforeWallet(e)) {
      if (await notRequested()) throw e;
      throw refuse("RECORD_OUTCOME_UNKNOWN");
    }
    if ((e as { code?: unknown })?.code === 4001) {
      // Definitive whatever happens to its record; the record write itself never waits without a bound.
      await bounded(() => context.persistRejected(ref), CANARY_CONFIRM_WAIT_MS);
      throw new BridgeError("OWNER_REJECTED");
    }
    canaryUncertain.add(approval.approvalId);
    throw new BridgeError("SUBMISSION_UNCERTAIN");
  } finally {
    clearTimeout(timer);
  }
  if (result === "TIMEOUT") {
    // The request may still be open in the wallet. What arrives later is recorded for tracking only.
    canaryUncertain.add(approval.approvalId);
    void request.then(
      (late) => {
        if (typeof late === "string" && HASH.test(late))
          void Promise.resolve()
            .then(() => context.persistLateHash(late, prepared.action, ref))
            .catch(() => undefined);
      },
      (e: unknown) => {
        if ((e as { code?: unknown })?.code === 4001)
          void Promise.resolve()
            .then(() => context.persistRejected(ref))
            .catch(() => undefined);
      },
    );
    throw new BridgeError("SUBMISSION_UNCERTAIN");
  }
  if (typeof result !== "string" || !HASH.test(result)) {
    canaryUncertain.add(approval.approvalId);
    throw new BridgeError("SUBMISSION_UNCERTAIN");
  }
  // The hash is returned even when recording it fails or does not answer in time; the caller sees that it was not
  // recorded (the server's journal then still reads "requested"; once the record is UNCERTAIN, the server's read-only
  // search finds the step's own EXACT transaction on chain — whichever hash it has — and adopts it through the
  // verified claim path, review 8 R8-1 / review 9 R9-1; content the owner edited in the wallet, more than one exact
  // transaction, or a reverted one — it emits no log — is never found or adopted: the record then stays UNCERTAIN with
  // attention, review 10 R10-1 / review 11 R11-1).
  const hash = result;
  const stored = await bounded(
    () => context.persistHash(hash, prepared.action, ref),
    CANARY_CONFIRM_WAIT_MS,
  );
  return {
    action: prepared.action,
    hash,
    // G14 follow-up F4: recorded ONLY on the server's explicit confirmation (exactly `true`).
    recorded: stored.ok && stored.value === true,
  };
}
