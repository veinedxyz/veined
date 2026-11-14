// V1.6 G5 spendable-reserve model for ONEchain -> BSC, derived from the EXACT live destination build
// (BSCBridgeV2 @ 6da2fb2, reproduced byte-for-byte) and confirmed on local forks:
// - finalize pays `CROSS.transfer(to, v)` and then `deposited -= v` (checked: v > deposited reverts the batch);
// - insufficient physical balance parks the item as pending (pendingAmount += v), deposited unchanged;
// - pending release / privileged manual release later pays and decrements deposited exactly once;
// - fees never stay in the bridge (sent to `dev` in the same call); verifier value thresholds are read live.
// So for a NEW transfer queued behind every earlier one:
//   spendable = min(balanceOf(bridge), deposited) - pendingAmount - sum(in-flight source initiations)
// Anything not enumerable fails closed (verified=false).

export interface PendingRecord {
  index: bigint;
  toToken: string;
  value: bigint;
}
export interface ReserveInput {
  token: string;
  balance: bigint;
  deposited: bigint;
  pendingAmount: bigint;
  pending: PendingRecord[];
  pendingComplete: boolean;
  // Source initiations (toChainID=56) not yet finalized on BSC, enumerated by index.
  inFlight: { enumerated: boolean; expectedCount: number; values: bigint[] };
  sourceMinted: bigint;
  minimum: bigint;
  driftState: "VERIFIED_READ_ONLY" | "PAUSED" | "REVIEW_REQUIRED";
}
export interface ReserveResult {
  verified: boolean;
  reasons: string[];
  anomalies: string[];
  accountingBound: bigint;
  obligations: bigint;
  spendable: bigint;
  routeMinimum: bigint;
  routeMaximumByReserve: bigint;
  routeMaximumByContract: bigint;
  effectiveMaximum: bigint;
  surplus: bigint;
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

export function deriveSpendableReserve(i: ReserveInput): ReserveResult {
  const reasons: string[] = [];
  const anomalies: string[] = [];
  for (const v of [
    i.balance,
    i.deposited,
    i.pendingAmount,
    i.sourceMinted,
    i.minimum,
  ])
    if (v < 0n) throw new Error("NEGATIVE_INPUT");
  const indices = new Set<string>();
  let pendingSum = 0n;
  for (const p of i.pending) {
    if (p.value < 0n) throw new Error("NEGATIVE_INPUT");
    const key = p.index.toString();
    if (indices.has(key)) reasons.push("DUPLICATE_PENDING_INDEX");
    indices.add(key);
    if (p.toToken.toLowerCase() === i.token.toLowerCase())
      pendingSum += p.value;
  }
  if (!i.pendingComplete) reasons.push("PENDING_SET_INCOMPLETE");
  if (pendingSum !== i.pendingAmount) reasons.push("PENDING_AMOUNT_MISMATCH");
  if (
    !i.inFlight.enumerated ||
    i.inFlight.values.length !== i.inFlight.expectedCount
  )
    reasons.push("IN_FLIGHT_UNENUMERATED");
  if (i.driftState === "REVIEW_REQUIRED") reasons.push("ROUTE_REVIEW_REQUIRED");
  const inFlight = i.inFlight.values.reduce((s, v) => {
    if (v < 0n) throw new Error("NEGATIVE_INPUT");
    return s + v;
  }, 0n);
  const accountingBound = min(i.balance, i.deposited);
  const obligations = i.pendingAmount + inFlight;
  const spendable =
    accountingBound > obligations ? accountingBound - obligations : 0n;
  const surplus = i.balance - i.deposited;
  if (surplus < 0n) anomalies.push("BALANCE_BELOW_DEPOSITED");
  if (surplus > 0n)
    anomalies.push("BALANCE_ABOVE_DEPOSITED_UNSPENDABLE_SURPLUS");
  if (spendable < i.minimum) reasons.push("RESERVE_BELOW_ROUTE_MINIMUM");
  const effectiveMaximum = min(spendable, i.sourceMinted);
  return {
    verified: reasons.length === 0,
    reasons,
    anomalies,
    accountingBound,
    obligations,
    spendable,
    routeMinimum: i.minimum,
    routeMaximumByReserve: spendable,
    routeMaximumByContract: i.sourceMinted,
    effectiveMaximum,
    surplus,
  };
}
