import { BPS, REFERRAL_COMMISSION_BPS } from "./units";
// Deterministic weekly allocation. Pure: same lines in, same entries out, independent of input order.
//
// Let w be a line's effective weight and R the set of lines whose account has an eligible referrer. With
// c = commission bps and B = 10,000:
//   D        = Σ w·B + Σ_{l∈R} w·c                      (the reserve for referral commission is in the denominator)
//   amount_l = ⌊P · w·B / D⌋
//   comm_l   = ⌊amount_l · c / B⌋                        (exactly 10% of the referred user's final line reward)
// amount_l ≤ P·w·B/D and comm_l ≤ P·w·c/D, so Σ amount + Σ comm ≤ P·D/D = P. The pool is never exceeded and never
// increased; the smallest-unit residual P − Σ is recorded with the calculation and stays undistributed.

export interface WeightLine {
  lineId: string;
  account: string;
  kind: "ACTIVITY" | "TASK";
  sourceRef: string;
  weight: bigint;
  referralParent: string | null;
}
export interface AllocatedLine {
  lineId: string;
  account: string;
  kind: "ACTIVITY" | "TASK" | "REFERRAL_COMMISSION";
  sourceRef: string;
  sourceAccount?: string;
  weight: bigint;
  amount: bigint;
}
export interface Allocation {
  poolUnits: bigint;
  denominator: bigint;
  lines: AllocatedLine[];
  rewardUnits: bigint;
  commissionUnits: bigint;
  allocatedUnits: bigint;
  residualUnits: bigint;
}

export function allocate(
  poolUnits: bigint,
  input: readonly WeightLine[],
  commissionBps: bigint = REFERRAL_COMMISSION_BPS,
): Allocation {
  if (poolUnits < 0n) throw Error("POOL_NEGATIVE");
  if (commissionBps < 0n || commissionBps > BPS)
    throw Error("COMMISSION_INVALID");
  const lines = [...input].sort((a, b) =>
    a.lineId < b.lineId ? -1 : a.lineId > b.lineId ? 1 : 0,
  );
  const seen = new Set<string>();
  let denominator = 0n;
  for (const line of lines) {
    if (seen.has(line.lineId)) throw Error(`LINE_DUPLICATE:${line.lineId}`);
    seen.add(line.lineId);
    if (line.weight <= 0n) throw Error(`LINE_WEIGHT_INVALID:${line.lineId}`);
    if (line.referralParent === line.account) throw Error("SELF_REFERRAL");
    denominator += line.weight * BPS;
    if (line.referralParent) denominator += line.weight * commissionBps;
  }
  const out: AllocatedLine[] = [];
  let rewardUnits = 0n,
    commissionUnits = 0n;
  if (denominator > 0n)
    for (const line of lines) {
      const amount = (poolUnits * line.weight * BPS) / denominator;
      rewardUnits += amount;
      out.push({
        lineId: line.lineId,
        account: line.account,
        kind: line.kind,
        sourceRef: line.sourceRef,
        weight: line.weight,
        amount,
      });
      if (line.referralParent) {
        const commission = (amount * commissionBps) / BPS;
        commissionUnits += commission;
        out.push({
          lineId: `c:${line.lineId}`,
          account: line.referralParent,
          kind: "REFERRAL_COMMISSION",
          sourceRef: line.lineId,
          sourceAccount: line.account,
          weight: 0n,
          amount: commission,
        });
      }
    }
  const allocatedUnits = rewardUnits + commissionUnits;
  // Defence in depth: the algebra above guarantees this, but a budget breach must never be representable.
  if (allocatedUnits > poolUnits) throw Error("BUDGET_EXCEEDED");
  return {
    poolUnits,
    denominator,
    lines: out,
    rewardUnits,
    commissionUnits,
    allocatedUnits,
    residualUnits: poolUnits - allocatedUnits,
  };
}
