// G7 post-send observer classification (pure, read-only). Given what the observer READ about a future pilot source
// transaction, decide the tracking status. It never resends, never releases a pending payout, never contacts anyone:
// any abnormal state ends in MANUAL_REVIEW_REQUIRED with instructions. Elapsed time alone never means "failed".

export const TRACK_STATUSES = [
  "SOURCE_PENDING",
  "SOURCE_CONFIRMED",
  "SETTLEMENT_PENDING",
  "DESTINATION_PENDING",
  "COMPLETED",
  "MANUAL_REVIEW_REQUIRED",
] as const;
export type TrackStatus = (typeof TRACK_STATUSES)[number];

// Observation-derived policy (NOT an SLA): historical ONE->BSC settlement took 14-27 s in the V1.6 proofs and the
// G7-prep window. Normal window ~10x the observed maximum; escalation after 30 minutes. Never "failed" by time.
export const SETTLEMENT_POLICY = {
  normalWindowSeconds: 300,
  escalateAfterSeconds: 1800,
  sourceConfirmations: 64,
  label: "historical observation-derived policy, not a guarantee or SLA",
} as const;

export interface TrackInput {
  elapsedSeconds: number;
  source: {
    found: boolean;
    endpointsAgree: boolean;
    status: "0x1" | "0x0" | null;
    canonical: boolean;
    decodeError?: string;
    decoded?: {
      index: string;
      recipient: string;
      amount: string;
      destinationChain: number;
    };
  };
  expected: { account: string; recipient: string; amount: string };
  destination?: {
    searched: boolean;
    event: "BridgeFinalized" | "BridgePending" | null;
    receiptSuccess?: boolean;
    finalized?: boolean;
    payoutExact?: boolean;
    implementationConsistent?: boolean;
    decodeError?: string;
  };
}
export interface TrackResult {
  status: TrackStatus;
  reasons: string[];
  nextStep: string;
  autoRetry: false;
  autoRelease: false;
}

const NO_RESEND =
  "Do NOT resend or retry the source transaction. Reconcile first (receipt, nonce, replacement, explorer).";
const result = (
  status: TrackStatus,
  reasons: string[],
  nextStep: string,
): TrackResult => ({
  status,
  reasons,
  nextStep,
  autoRetry: false,
  autoRelease: false,
});

export function classifyTracking(i: TrackInput): TrackResult {
  const s = i.source;
  const late = i.elapsedSeconds > SETTLEMENT_POLICY.escalateAfterSeconds;
  if (!s.found)
    return late
      ? result(
          "MANUAL_REVIEW_REQUIRED",
          ["SOURCE_RECEIPT_NOT_FOUND_AFTER_ESCALATION_THRESHOLD"],
          NO_RESEND,
        )
      : result(
          "SOURCE_PENDING",
          [
            "SOURCE_RECEIPT_NOT_FOUND_YET (a wallet 'submitted' screen is not proof)",
          ],
          "Re-run the read-only tracker later. " + NO_RESEND,
        );
  if (!s.endpointsAgree)
    return result(
      "MANUAL_REVIEW_REQUIRED",
      ["SOURCE_ENDPOINTS_DISAGREE"],
      "Compare both official ONE endpoints and the explorer. " + NO_RESEND,
    );
  if (s.status === "0x0")
    return result(
      "MANUAL_REVIEW_REQUIRED",
      ["SOURCE_REVERTED (only gas is spent)"],
      "Re-quote from scratch with a NEW owner approval. " + NO_RESEND,
    );
  if (s.decodeError || !s.decoded)
    return result(
      "MANUAL_REVIEW_REQUIRED",
      [`SOURCE_EVENT_INVALID:${s.decodeError ?? "missing"}`],
      NO_RESEND,
    );
  const lower = (x: string) => x.toLowerCase();
  const mismatch = [
    s.decoded.destinationChain !== 56 && "DESTINATION_CHAIN",
    lower(s.decoded.recipient) !== lower(i.expected.recipient) && "RECIPIENT",
    s.decoded.amount !== i.expected.amount && "AMOUNT",
  ].filter((x): x is string => typeof x === "string");
  if (mismatch.length)
    return result(
      "MANUAL_REVIEW_REQUIRED",
      mismatch.map((m) => `SOURCE_${m}_MISMATCH`),
      "The confirmed source transfer differs from the approved package. " +
        NO_RESEND,
    );
  if (!s.canonical)
    return result(
      "SOURCE_PENDING",
      [`SOURCE_AWAITING_CANONICAL_CONFIRMATION index=${s.decoded.index}`],
      "Wait for canonical confirmation; re-run the tracker.",
    );
  const d = i.destination;
  if (!d || !d.searched)
    return result(
      "SOURCE_CONFIRMED",
      [`SOURCE_CONFIRMED index=${s.decoded.index}`],
      "Search BSC for BridgeFinalized/BridgePending(fromChainID=612055, index).",
    );
  if (d.event === null)
    return late
      ? result(
          "MANUAL_REVIEW_REQUIRED",
          ["SETTLEMENT_NOT_OBSERVED_AFTER_ESCALATION_THRESHOLD (not failed)"],
          "Re-check validator set/threshold/pauses; prepare the support packet; escalate to the operator with the source proof. " +
            NO_RESEND,
        )
      : result(
          "SETTLEMENT_PENDING",
          [
            i.elapsedSeconds > SETTLEMENT_POLICY.normalWindowSeconds
              ? "OUTSIDE_NORMAL_OBSERVATION_WINDOW (not failed)"
              : "WITHIN_NORMAL_OBSERVATION_WINDOW",
          ],
          "Re-run the read-only tracker later. " + NO_RESEND,
        );
  if (d.decodeError)
    return result(
      "MANUAL_REVIEW_REQUIRED",
      [`DESTINATION_EVENT_INVALID:${d.decodeError}`],
      "Preserve proofs; prepare the support packet.",
    );
  if (d.event === "BridgePending")
    return result(
      late ? "MANUAL_REVIEW_REQUIRED" : "DESTINATION_PENDING",
      ["DESTINATION_HELD_AS_PENDING"],
      "Inspect getPendingArguments(612055, index) status/reason. releasePending may be permissionless only when the reason has cleared; any release transaction is a NEW write requiring separate owner approval. Never call it automatically.",
    );
  if (d.implementationConsistent === false)
    return result(
      "MANUAL_REVIEW_REQUIRED",
      ["DESTINATION_IMPLEMENTATION_DRIFT"],
      "Route drift at payout time: preserve proofs and escalate.",
    );
  if (!d.receiptSuccess || !d.payoutExact)
    return result(
      "MANUAL_REVIEW_REQUIRED",
      ["DESTINATION_PAYOUT_NOT_EXACT"],
      "Preserve proofs; prepare the support packet.",
    );
  if (!d.finalized)
    return result(
      "DESTINATION_PENDING",
      ["DESTINATION_AWAITING_FINALIZED_TAG"],
      "Re-run the tracker after BSC finality.",
    );
  return result(
    "COMPLETED",
    ["BRIDGE_FINALIZED_AND_EXACT_CROSS_TRANSFER_ON_FINALIZED_BSC_BLOCK"],
    "Build the payout proof and fill the pilot record.",
  );
}
