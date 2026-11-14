export type ReserveEvidence =
  | {
      verified: true;
      spendableBaseUnits: bigint;
      observedAtBlock: bigint;
      method: string;
      evidence: string[];
    }
  | { verified: false; reason: string; missingEvidence: string[] };

// Custody and an accounting upper bound cannot establish executable liquidity. Without a live pinned
// snapshot that reconciles every pending and in-flight obligation the reserve is unverified.
// Both implementations are reproduced byte-for-byte since V1.6; src/g5/reserve.ts holds the model.
export function currentReserveEvidence(
  reasons: string[] = [],
): ReserveEvidence {
  return {
    verified: false,
    reason: "SPENDABLE_RESERVE_NOT_RECONCILED_AT_PINNED_BLOCK",
    missingEvidence: [
      "Complete pending and in-flight obligation enumeration at a pinned block",
      ...reasons,
    ],
  };
}
