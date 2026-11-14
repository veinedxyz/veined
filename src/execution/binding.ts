// G13: what an owner authorization is bound to. Browser-safe and deterministic (execution canonical JSON + sha256).
//   planDigest   (v3) every field a signature would commit to and the owner is shown: route, tool, quote id + quote
//                time + expiry, account, both chains, both assets (chain + address + symbol + decimals), amounts,
//                recipient, refund address, slippage, VEINED fee, every fee line (amount, asset, inclusion), the token
//                spender, the exact approval and the exact canonical transaction (chain, from, to, value, calldata,
//                gas, fee caps). Any change -> another digest.
//   reviewDigest planDigest + the server Guardian verdict digest + the preflight report digest: the review the owner saw.
// An OwnerAuthorization names one action for one reviewDigest, one RECORD, one account, a single-use nonce and a short
// expiry. It authorizes nothing by itself (the execution gate is CLOSED), and it is not proof of a human: `isTrusted`
// only keeps scripted clicks from creating one in the page. The owner's real, per-signature consent is the wallet's own
// prompt, which only the owner can approve (the protected adapter never signs).
import { digest } from "./canonical";
import { EXECUTION_POLICY, type ExecutionPlan } from "./model";

const evm = (a: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(a) ? a.toLowerCase() : a;

export function planDigest(p: ExecutionPlan): string {
  return digest([
    "veined.execution.plan.v3",
    p.version,
    p.kind,
    p.provider,
    p.tool,
    p.quoteId,
    p.quotedAt,
    p.expiresAt,
    evm(p.account),
    p.sourceChainId,
    p.destinationChainId,
    [
      p.pay.chainId,
      evm(p.pay.address),
      p.pay.symbol,
      p.pay.decimals,
      p.pay.native,
    ],
    [
      p.receive.chainId,
      evm(p.receive.address),
      p.receive.symbol,
      p.receive.decimals,
      p.receive.native,
    ],
    p.amountIn,
    p.expectedOut,
    p.minimumOut,
    // The fee lines the owner is shown are part of what was reviewed (review N11).
    p.fees.map((f) => [
      f.name,
      f.amount,
      f.usd,
      f.included,
      f.kind,
      f.asset.chainId,
      evm(f.asset.address),
      f.asset.symbol,
      f.asset.decimals,
      f.asset.native,
    ]),
    evm(p.recipient),
    p.refundTo === null ? null : evm(p.refundTo),
    p.slippageBps,
    p.platformFeeBps,
    p.spender === null ? null : evm(p.spender),
    p.approval === null
      ? null
      : [evm(p.approval.token), evm(p.approval.spender), p.approval.amount],
    p.transaction === null
      ? null
      : [
          p.transaction.chainId,
          evm(p.transaction.from),
          evm(p.transaction.to),
          p.transaction.value,
          p.transaction.data.toLowerCase(),
          p.transaction.gas ?? null,
          p.transaction.maxFeePerGas ?? null,
          p.transaction.maxPriorityFeePerGas ?? null,
        ],
  ]);
}
export function reviewDigest(
  plan: string,
  guardianDigest: string,
  preflightDigest: string,
): string {
  return digest([
    "veined.execution.review.v1",
    plan,
    guardianDigest,
    preflightDigest,
  ]);
}

export type AuthorizedAction = "APPROVE" | "SEND" | "NEAR_DEPOSIT_ADDRESS";
export interface OwnerAuthorization {
  action: AuthorizedAction;
  review: string;
  /** The execution record this authorization belongs to (it is refused in any other record). */
  record: string;
  account: string;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
}
export type AuthorizationRefusal =
  | "UNTRUSTED_GESTURE"
  | "INVALID_NONCE"
  | "QUOTE_EXPIRED"
  | "QUOTE_TOO_CLOSE_TO_EXPIRY"
  | "AUTHORIZATION_EXPIRED"
  | "AUTHORIZATION_NOT_YET_VALID"
  | "WRONG_ACTION"
  | "WRONG_REVIEW"
  | "WRONG_RECORD"
  | "WRONG_ACCOUNT"
  | "NONCE_REUSED";
export class AuthorizationError extends Error {
  constructor(public code: AuthorizationRefusal) {
    super(code);
    this.name = "AuthorizationError";
  }
}
const NONCE = /^[0-9a-f]{32}$/;
/**
 * Issued only inside a real click / key handler (`trustedGesture` = the browser's `event.isTrusted`), for one record,
 * when at least EXECUTION_POLICY.minRemainingMs of the quote is left. Valid until the earlier of the policy TTL and the
 * quote's own expiry.
 */
export function issueAuthorization(i: {
  action: AuthorizedAction;
  review: string;
  record: string;
  account: string;
  now: number;
  quoteExpiresAt: number;
  nonce: string;
  trustedGesture: boolean;
}): OwnerAuthorization {
  if (i.trustedGesture !== true)
    throw new AuthorizationError("UNTRUSTED_GESTURE");
  if (!NONCE.test(i.nonce)) throw new AuthorizationError("INVALID_NONCE");
  if (!(i.quoteExpiresAt > i.now))
    throw new AuthorizationError("QUOTE_EXPIRED");
  if (i.quoteExpiresAt - i.now < EXECUTION_POLICY.minRemainingMs)
    throw new AuthorizationError("QUOTE_TOO_CLOSE_TO_EXPIRY");
  return Object.freeze({
    action: i.action,
    review: i.review,
    record: i.record,
    account: i.account,
    issuedAt: i.now,
    expiresAt: Math.min(
      i.now + EXECUTION_POLICY.authorizationTtlMs,
      i.quoteExpiresAt,
    ),
    nonce: i.nonce,
  });
}
/** Null when `auth` authorizes exactly this action on exactly this review, in this record, for this account, now, once. */
export function authorizationProblem(
  auth: OwnerAuthorization,
  expected: {
    action: AuthorizedAction;
    review: string;
    record: string;
    account: string;
    now: number;
    used: ReadonlySet<string>;
  },
): AuthorizationRefusal | null {
  if (!NONCE.test(auth.nonce)) return "INVALID_NONCE";
  // A hand-made object without real timestamps never "never expires" (review N4).
  if (
    !Number.isSafeInteger(auth.issuedAt) ||
    !Number.isSafeInteger(auth.expiresAt)
  )
    return "AUTHORIZATION_EXPIRED";
  if (expected.used.has(auth.nonce)) return "NONCE_REUSED";
  if (auth.action !== expected.action) return "WRONG_ACTION";
  if (auth.review !== expected.review) return "WRONG_REVIEW";
  if (auth.record !== expected.record) return "WRONG_RECORD";
  if (evm(auth.account) !== evm(expected.account)) return "WRONG_ACCOUNT";
  if (expected.now < auth.issuedAt) return "AUTHORIZATION_NOT_YET_VALID";
  if (
    expected.now >= auth.expiresAt ||
    auth.expiresAt - auth.issuedAt > EXECUTION_POLICY.authorizationTtlMs
  )
    return "AUTHORIZATION_EXPIRED";
  return null;
}
