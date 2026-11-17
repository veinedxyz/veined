import type { ManualPreparation } from "./protocol";

export interface FastReview {
  reviewId: string;
  ready: boolean;
  step: string | null;
  expiresAt: number;
  guardian: { level: string } | null;
  amountOutMinimum?: string;
  minimumOut?: string | null;
  quoteOut?: string;
  effectiveOutput?: string | null;
}
export interface FastTracking {
  state: string;
  steps?: Record<string, { state?: string }>;
}
export function trackingMessage(state: string) {
  if (state === "SETTLED_VERIFIED")
    return "Completed · settlement verified at policy confirmation depth";
  if (state === "REFUND_PENDING")
    return "Refund pending · reconciliation continues in Scan";
  if (state === "DESTINATION_PENDING")
    return "Source confirmed · destination fill pending";
  if (/FAILED/.test(state))
    return "Transaction failed · see the verified receipt in Scan";
  if (/UNKNOWN|UNCERTAIN|DISCREPANCY|DISAGREE|REORG/.test(state))
    return "Needs reconciliation · no automatic resend";
  return "Pending · tracking receipts in Scan";
}
export interface FastflowPort {
  review(): Promise<FastReview>;
  prepare(review: FastReview): Promise<ManualPreparation>;
  send(preparation: ManualPreparation): Promise<string>;
  track(): Promise<FastTracking>;
  current(): boolean;
  status(message: string): void;
  submitted(hash: string, step: string): void;
  wait(): Promise<void>;
  now(): number;
}
export function assertFastReview(r: FastReview, now: number) {
  if (!r.ready || r.guardian?.level !== "CLEAR") throw Error("GUARDIAN_STOP");
  if (r.expiresAt <= now) throw Error("REVIEW_EXPIRED");
}
/** One explicit application action. Each necessary on-chain transaction still has its own wallet confirmation. */
export async function runFastflow(port: FastflowPort, cached?: FastReview) {
  const check = () => {
    if (!port.current()) throw Error("WALLET_SESSION_STALE");
  };
  check();
  let r =
    cached && cached.expiresAt > port.now() ? cached : await port.review();
  check();
  assertFastReview(r, port.now());
  const minimum = BigInt(r.amountOutMinimum ?? r.minimumOut ?? "0");
  for (let i = 0; i < 2; i++) {
    check();
    assertFastReview(r, port.now());
    port.status("Validating transaction…");
    const p = await port.prepare(r);
    check();
    if (!p.released) {
      port.status("Ready for owner review · execution closed");
      return "LOCAL_READY";
    }
    if (
      p.reviewId !== r.reviewId ||
      p.step !== r.step ||
      p.expiresAt <= port.now()
    )
      throw Error("REVIEW_EXPIRED");
    port.status(
      p.step === "APPROVE"
        ? "Confirm permission in wallet · then confirm the exchange"
        : "Confirm transaction in wallet",
    );
    const hash = await port.send(p);
    check();
    port.submitted(hash, p.step);
    if (p.step !== "APPROVE") {
      port.status("Submitted · tracking in Scan");
      return "SUBMITTED";
    }
    port.status("Permission submitted · waiting for its verified receipt");
    let approved = false;
    for (let poll = 0; poll < 120; poll++) {
      await port.wait();
      check();
      const t = await port.track();
      check();
      const state = t.steps?.APPROVE?.state ?? "UNKNOWN";
      if (state === "FINAL_SUCCESS") {
        approved = true;
        break;
      }
      if (
        /FAILED|REFUSED|DISCREPANCY|UNKNOWN|UNCERTAIN|REORG|DISAGREE/.test(
          state,
        )
      )
        throw Error("APPROVAL_NEEDS_RECONCILIATION");
    }
    if (!approved) {
      port.status("Permission pending · tracking in Scan");
      return "APPROVAL_PENDING";
    }
    port.status("Permission confirmed · checking a fresh execution quote");
    r = await port.review();
    check();
    assertFastReview(r, port.now());
    if (r.step === "APPROVE") throw Error("ALLOWANCE_NOT_SUFFICIENT");
    const output = BigInt(r.quoteOut ?? r.effectiveOutput ?? "0");
    const nextMinimum = BigInt(r.amountOutMinimum ?? r.minimumOut ?? "0");
    if (minimum <= 0n || output < minimum || nextMinimum < minimum)
      throw Error("MINIMUM_OUTPUT_CHANGED");
  }
  throw Error("MANUAL_FLOW_STOPPED");
}
