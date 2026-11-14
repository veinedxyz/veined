// G13: NEAR Intents (1Click) toward NEAR — dry versus executable. Server-side (it reads the execution gate itself).
// A DRY quote (what VEINED requests today; the request schema in src/guardian/intents.ts fixes `dry: true`) never
// carries a deposit address. An EXECUTABLE quote (`dry: false`) makes 1Click open a real deposit address, so it may only
// be built when ALL hold (hardened after the Phase 3 review, F08):
//   1. the execution gate is open — read here from the protected sources, never passed in (in this build: CLOSED);
//   2. the reviewed request re-parses under the strict request schema (no extra field such as appFees / referral can
//      ride along) and its review digest — computed HERE from that request and the server Guardian digest — is the one
//      the owner authorization names, for this record and the NEAR_DEPOSIT_ADDRESS action;
//   3. the recipient is the owner's own NEAR account, the refund address is the sender on the origin chain, and the
//      deadline is inside the policy window.
// This module never calls the network.
import { digest } from "./canonical";
import { EXECUTION_POLICY } from "./model";
import { authorizationProblem, type OwnerAuthorization } from "./binding";
import { executionGateState } from "./server/gate";
import {
  validRefundAddress,
  type NearRouteChain,
} from "../guardian/near-route";
import {
  intentsQuoteRequestSchema,
  type IntentsQuoteRequest,
} from "../guardian/intents";

export type NearQuoteKind = "DRY" | "EXECUTABLE" | "ANOMALY";
/** A response is executable only when it carries a deposit address; a deposit address on a dry request is an anomaly. */
export function nearQuoteKind(
  requestedDry: boolean,
  response: { quote?: { depositAddress?: string } },
): NearQuoteKind {
  const has = !!response.quote?.depositAddress;
  if (requestedDry) return has ? "ANOMALY" : "DRY";
  return has ? "EXECUTABLE" : "ANOMALY";
}
/** The digest an owner authorization for a NEAR deposit address must name: the exact reviewed request + Guardian. */
export function nearReviewDigest(
  reviewed: IntentsQuoteRequest,
  guardianDigest: string,
): string {
  return digest(["veined.execution.near.v1", reviewed, guardianDigest]);
}
export type NearExecutableProblem =
  | "EXECUTION_CLOSED"
  | "REQUEST_INVALID"
  | "RECIPIENT_NOT_OWNER"
  | "REFUND_INVALID"
  | "REFUND_NOT_SENDER"
  | "DEADLINE_INVALID"
  | "DEADLINE_TOO_SOON"
  | "DEADLINE_TOO_LATE"
  | "AUTHORIZATION_MISSING"
  | NonNullable<ReturnType<typeof authorizationProblem>>;
export interface NearExecutableInput {
  chain: NearRouteChain;
  sender: string;
  ownerNearAccount: string;
  /** The dry request the owner reviewed (re-parsed strictly here). */
  reviewed: unknown;
  guardianDigest: string;
  authorization: OwnerAuthorization | null;
  record: string;
  now: number;
  used: ReadonlySet<string>;
}
/** The request rules on their own (no gate): every reason the executable request would be refused. */
export function nearRequestRuleProblems(
  i: NearExecutableInput,
): NearExecutableProblem[] {
  const parsed = intentsQuoteRequestSchema.safeParse(i.reviewed);
  if (!parsed.success) return ["REQUEST_INVALID"];
  const r = parsed.data;
  const out: NearExecutableProblem[] = [];
  if (r.recipient !== i.ownerNearAccount) out.push("RECIPIENT_NOT_OWNER");
  if (!validRefundAddress(i.chain, r.refundTo)) out.push("REFUND_INVALID");
  const evm = /^0x[0-9a-fA-F]{40}$/.test(i.sender);
  if (
    evm
      ? r.refundTo.toLowerCase() !== i.sender.toLowerCase()
      : r.refundTo !== i.sender
  )
    out.push("REFUND_NOT_SENDER");
  const deadline = Date.parse(r.deadline);
  if (!Number.isFinite(deadline) || !/^\d{4}-\d{2}-\d{2}T/.test(r.deadline))
    out.push("DEADLINE_INVALID");
  else if (deadline - i.now < EXECUTION_POLICY.nearDeadlineMinMs)
    out.push("DEADLINE_TOO_SOON");
  else if (deadline - i.now > EXECUTION_POLICY.nearDeadlineMaxMs)
    out.push("DEADLINE_TOO_LATE");
  if (!i.authorization) out.push("AUTHORIZATION_MISSING");
  else {
    const p = authorizationProblem(i.authorization, {
      action: "NEAR_DEPOSIT_ADDRESS",
      review: nearReviewDigest(r, i.guardianDigest),
      record: i.record,
      account: i.sender,
      now: i.now,
      used: i.used,
    });
    if (p) out.push(p);
  }
  return out;
}
/** Every reason the executable request may not be built (empty = it may). The gate is read and checked first. */
export function nearExecutableProblems(
  i: NearExecutableInput,
): NearExecutableProblem[] {
  if (!executionGateState().open) return ["EXECUTION_CLOSED"];
  return nearRequestRuleProblems(i);
}
export class NearExecutionError extends Error {
  constructor(public problems: NearExecutableProblem[]) {
    super(problems.join(","));
    this.name = "NearExecutionError";
  }
}
/** The same strictly re-parsed reviewed request with `dry: false`, or a refusal. Building it does not send it. */
export function buildNearExecutableRequest(
  i: NearExecutableInput,
): Omit<IntentsQuoteRequest, "dry"> & { dry: false } {
  // Parsed exactly once (review N7): the rules and the built request see the same plain object, never a second read
  // of a caller-supplied value that could answer differently.
  const parsed = intentsQuoteRequestSchema.safeParse(i.reviewed);
  if (!parsed.success) throw new NearExecutionError(["REQUEST_INVALID"]);
  const problems = nearExecutableProblems({ ...i, reviewed: parsed.data });
  if (problems.length) throw new NearExecutionError(problems);
  return { ...parsed.data, dry: false };
}
