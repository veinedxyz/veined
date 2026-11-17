import type { VerifiedTransaction } from "../activity/model";
export type ScanStatus =
  | "SUBMITTED"
  | "PENDING"
  | "UNKNOWN"
  | "CONFIRMED"
  | "FAILED"
  | "SOURCE_CONFIRMED"
  | "FILL_PENDING"
  | "SETTLED_VERIFIED"
  | "REFUND_PENDING"
  | "REFUSED";
export interface ScanRecord {
  id: string;
  account: string;
  chainId: "8453" | "42161";
  hash: string | null;
  kind: string;
  provenance: "VEINED_SUBMISSION" | "HISTORICAL_IMPORT" | "PUBLIC_HASH_LOOKUP";
  status: ScanStatus;
  observedAt: number;
  updatedAt: number;
  route?: string;
  provider?: string;
  recipient?: string;
  sourceHash?: string;
  destinationHash?: string;
  sourceStatus?: "SOURCE_CONFIRMED";
  error?: string;
  transaction?: VerifiedTransaction;
  tracking?: Record<string, unknown>;
}
export function recordMatches(r: ScanRecord, address: string) {
  return r.account === address.toLowerCase();
}
export function lifecycle(
  step: string,
  tracking: Record<string, unknown>,
): ScanStatus {
  const steps = tracking.steps as
    Record<string, { state?: string }> | undefined;
  const s = steps?.[step]?.state ?? "UNKNOWN";
  if (/FAILED/.test(s)) return "FAILED";
  if (/REFUSED/.test(s)) return "REFUSED";
  if (step === "APPROVE")
    return s === "FINAL_SUCCESS"
      ? "CONFIRMED"
      : /PENDING|CONFIRMING/.test(s)
        ? "PENDING"
        : "UNKNOWN";
  const overall = String(tracking.state);
  if (overall === "SETTLED_VERIFIED") return "SETTLED_VERIFIED";
  if (overall === "REFUND_PENDING") return "REFUND_PENDING";
  if (overall === "DESTINATION_PENDING") return "FILL_PENDING";
  if (/UNKNOWN|UNCERTAIN|DISCREPANCY|DISAGREE|REORG/.test(s + overall))
    return "UNKNOWN";
  if (s === "FINAL_SUCCESS") return "SOURCE_CONFIRMED";
  return "PENDING";
}
