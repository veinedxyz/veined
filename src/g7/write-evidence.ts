// Monotonic execution evidence owned by the guarded runtime; capability/preparation never increments it.
import { G7_READ_METHODS } from "./policy";

export const EXECUTION_COUNTERS = [
  "walletRequestAttempts",
  "walletRequestsIssued",
  "prohibitedRpcAttempts",
  "signingRequests",
  "approvals",
  "permits",
  "broadcasts",
  "rawTransactions",
  "deploys",
  "feeCollections",
] as const;
export type ExecutionCounter = (typeof EXECUTION_COUNTERS)[number];
export type ExecutionSnapshot = Readonly<
  Record<ExecutionCounter | "stateOverrides", number>
>;
const reads = new Set<string>(G7_READ_METHODS);
export class ExecutionEvidence {
  private counters = Object.fromEntries(
    [...EXECUTION_COUNTERS, "stateOverrides"].map((k) => [k, 0]),
  ) as Record<ExecutionCounter | "stateOverrides", number>;
  record(kind: ExecutionCounter | "stateOverrides") {
    this.counters[kind]++;
  }
  recordRpcAttempt(method: string, params: unknown[]) {
    if (!reads.has(method)) {
      this.record("prohibitedRpcAttempts");
      if (/sign/i.test(method)) this.record("signingRequests");
      if (/sendRaw/i.test(method)) this.record("rawTransactions");
      if (/send/i.test(method)) this.record("broadcasts");
    }
    if (
      (method === "eth_call" || method === "eth_estimateGas") &&
      Array.isArray(params) &&
      params.length > 2
    )
      this.record("stateOverrides");
  }
  snapshot(): ExecutionSnapshot {
    return Object.freeze({ ...this.counters });
  }
  restore(evidence: ExecutionSnapshot) {
    for (const key of [...EXECUTION_COUNTERS, "stateOverrides"] as const) {
      const value = evidence[key];
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error("INVALID_PERSISTED_EXECUTION_EVIDENCE");
      this.counters[key] = Math.max(this.counters[key], value);
    }
  }
}
export function noWriteReasons(evidence: ExecutionSnapshot) {
  return EXECUTION_COUNTERS.flatMap((key) =>
    Number.isSafeInteger(evidence?.[key]) && evidence[key] === 0
      ? []
      : [`EXECUTION_EVIDENCE:${key}:${String(evidence?.[key])}`],
  );
}
