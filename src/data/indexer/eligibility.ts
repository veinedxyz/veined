import { independent } from "../registry/rpc-provenance";
import type { ApprovedEndpoint } from "../rpc/pool";
import type {
  Checkpoint,
  IndexVerification,
  WitnessSummary,
} from "../store/types";
// V1.5 Tier A release eligibility. FULL_INDEXED_DEVELOPMENT is honest local indexing;
// FULL_INDEXED_RELEASE_ELIGIBLE additionally needs every V1.5 integrity condition AND release-approved
// RPC terms. Engineering readiness (all but terms) is reported separately, never as release.
export type IndexReleaseLevel =
  "FULL_INDEXED_RELEASE_ELIGIBLE" | "FULL_INDEXED_DEVELOPMENT" | "NOT_INDEXED";
export type EligibilityBlocker =
  | "NO_HEALTHY_PRIMARY"
  | "NO_INDEPENDENT_WITNESS"
  | "UNWITNESSED_WINDOWS"
  | "LOG_CONSENSUS_UNRESOLVED"
  | "INDEX_INTEGRITY"
  | "INDEX_LAGGING"
  | "BALANCE_RESOLVER_UNAVAILABLE"
  | "RPC_TERMS_NOT_APPROVED";
export interface IndexEligibility {
  chainId: string;
  level: IndexReleaseLevel;
  engineeringEligible: boolean;
  witnessVerified: boolean;
  paused: boolean;
  blockers: EligibilityBlocker[];
  independentOperators: number;
  releaseApprovedOperators: number;
  windows: number;
  trustedWindows: number;
  developmentWindows: number;
  unwitnessedWindows: number;
  liveIndexedThrough: string | null;
  historicalIndexedFrom: string | null;
  historicalComplete: boolean;
}
const logCapable = (e: ApprovedEndpoint) => e.supportsLogs && e.maxLogRange > 0;
// Size of the largest set of mutually independent, witness-eligible, log-capable operators.
export function independentOperatorCount(endpoints: ApprovedEndpoint[]) {
  const groups = new Set<string>();
  for (const e of endpoints)
    if (logCapable(e) && e.witnessEligible && e.operatorGroup)
      groups.add(e.operatorGroup);
  // Distinct known groups are pairwise independent by definition of `independent`.
  return groups.size;
}
export function indexEligibility(input: {
  chainId: string;
  endpoints: ApprovedEndpoint[];
  checkpoint: Checkpoint | null | undefined;
  witness: WitnessSummary | null | undefined;
  verification?: IndexVerification | null;
  resolverOk?: boolean | null;
  indexCurrent: boolean;
  releaseAllowed?: (e: ApprovedEndpoint) => boolean;
}): IndexEligibility {
  const cp = input.checkpoint;
  const w = input.witness;
  const started = !!cp && cp.indexedThroughBlock >= cp.indexedFromBlock;
  const blockers: EligibilityBlocker[] = [];
  const healthy = input.endpoints.filter(logCapable);
  if (!healthy.length) blockers.push("NO_HEALTHY_PRIMARY");
  const operators = independentOperatorCount(input.endpoints);
  if (operators < 2) blockers.push("NO_INDEPENDENT_WITNESS");
  const windows = w?.windows ?? 0,
    trusted = w?.trustedWindows ?? 0;
  if (!started || windows === 0 || trusted !== windows)
    blockers.push("UNWITNESSED_WINDOWS");
  if (cp?.haltedReason) blockers.push("LOG_CONSENSUS_UNRESOLVED");
  const v = input.verification;
  if (
    v &&
    (v.missingRanges.length ||
      v.duplicateLogKeys ||
      v.orphanRecords ||
      v.checkpointMismatch ||
      v.blockHashInconsistencies ||
      v.disputedCommittedWindows ||
      v.invalidCheckpointState?.length)
  )
    blockers.push("INDEX_INTEGRITY");
  if (!input.indexCurrent) blockers.push("INDEX_LAGGING");
  if (input.resolverOk === false) blockers.push("BALANCE_RESOLVER_UNAVAILABLE");
  const approved = input.endpoints.filter(
    (e) =>
      logCapable(e) &&
      e.witnessEligible &&
      (input.releaseAllowed ?? (() => false))(e),
  );
  const approvedOperators = new Set(approved.map((e) => e.operatorGroup!)).size;
  const pairApproved = approved.some((a) =>
    approved.some((b) => independent(a, b)),
  );
  if (!pairApproved) blockers.push("RPC_TERMS_NOT_APPROVED");
  const engineering = blockers.filter((b) => b !== "RPC_TERMS_NOT_APPROVED");
  return {
    chainId: input.chainId,
    level: !started
      ? "NOT_INDEXED"
      : blockers.length === 0
        ? "FULL_INDEXED_RELEASE_ELIGIBLE"
        : "FULL_INDEXED_DEVELOPMENT",
    engineeringEligible: started && engineering.length === 0,
    witnessVerified: started && windows > 0 && trusted === windows,
    paused: !!cp?.haltedReason,
    blockers,
    independentOperators: operators,
    releaseApprovedOperators: approvedOperators,
    windows,
    trustedWindows: trusted,
    developmentWindows: w?.developmentWindows ?? 0,
    unwitnessedWindows: w?.unwitnessedWindows ?? 0,
    liveIndexedThrough: started ? cp!.indexedThroughBlock.toString() : null,
    historicalIndexedFrom: cp ? cp.indexedFromBlock.toString() : null,
    historicalComplete: !!cp?.historicalComplete,
  };
}
