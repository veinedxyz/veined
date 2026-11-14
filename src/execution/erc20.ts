// G13: exact ERC-20 approvals only. Pure (viem ABI codec, bigint). An approval is built HERE from the plan's own
// fields — never taken from a provider payload — and must name the exact token sent, the reviewed spender of the same
// provider, and exactly the amount sent: never unlimited, never more, never "just in case".
import {
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
  type Hex,
} from "viem";
import type {
  ApprovalRequest,
  ExecutionPlan,
  WalletTransaction,
} from "./model";

export const APPROVE_SELECTOR = "0x095ea7b3";
export const MAX_UINT256 = 2n ** 256n - 1n;
/** Values at or above 2^255 are treated as "unlimited" by wallets and by Guardian (APPROVAL_UNLIMITED). */
export const UNLIMITED_FLOOR = 2n ** 255n;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const lower = (a: string) => a.toLowerCase();

export function encodeExactApproval(spender: string, amount: bigint): string {
  if (!ADDRESS.test(spender) || /^0x0{40}$/i.test(spender))
    throw new RangeError("SPENDER");
  if (amount <= 0n || amount >= UNLIMITED_FLOOR) throw new RangeError("AMOUNT");
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "approve",
    args: [spender as Hex, amount],
  });
}
/** `approve(address,uint256)` with exactly two words of arguments, or null (anything else is not an approval). */
export function decodeApproval(
  data: string,
): { spender: string; amount: bigint } | null {
  if (
    !/^0x[0-9a-fA-F]*$/.test(data) ||
    data.length !== 2 + 8 + 128 ||
    lower(data.slice(0, 10)) !== APPROVE_SELECTOR
  )
    return null;
  try {
    const d = decodeFunctionData({ abi: erc20Abi, data: data as Hex });
    if (d.functionName !== "approve") return null;
    const [spender, amount] = d.args as readonly [string, bigint];
    return { spender, amount };
  } catch {
    return null;
  }
}
export type ApprovalProblem =
  | "APPROVAL_ON_NATIVE"
  | "ALLOWANCE_UNKNOWN"
  | "APPROVAL_MISSING"
  | "APPROVAL_NOT_NEEDED"
  | "APPROVAL_WRONG_TOKEN"
  | "UNEXPECTED_SPENDER"
  | "UNLIMITED_APPROVAL"
  | "APPROVAL_EXCEEDS_AMOUNT"
  | "APPROVAL_BELOW_AMOUNT"
  | "NONZERO_ALLOWANCE_FIRST"
  | "AMOUNT_INVALID"
  | "ALLOWANCE_ABOVE_AMOUNT"
  | "PLAN_INVALID";
/**
 * Whether the plan's approval is exactly what this transfer needs, given the allowance READ on chain for
 * (owner, spender). `spenderReviewed` must say whether the address is the reviewed spender of the plan's provider.
 */
export function approvalProblem(
  plan: Pick<ExecutionPlan, "pay" | "amountIn" | "approval">,
  existingAllowance: bigint | null,
  spenderReviewed: (address: string) => boolean,
): ApprovalProblem | null {
  // Structurally malformed input is refused with a code, never thrown on (round 4, S4).
  if (
    !plan ||
    typeof plan.pay !== "object" ||
    plan.pay === null ||
    typeof plan.pay.native !== "boolean" ||
    typeof plan.pay.address !== "string" ||
    typeof plan.amountIn !== "string" ||
    (plan.approval !== null &&
      (typeof plan.approval !== "object" ||
        typeof plan.approval.token !== "string" ||
        typeof plan.approval.spender !== "string" ||
        typeof plan.approval.amount !== "string"))
  )
    return "PLAN_INVALID";
  const a: ApprovalRequest | null = plan.approval;
  if (plan.pay.native) return a ? "APPROVAL_ON_NATIVE" : null;
  if (existingAllowance === null) return "ALLOWANCE_UNKNOWN";
  // Canonical decimal digits only (round-2 review F09: "5e6" is refused, never thrown on).
  if (!/^(0|[1-9]\d{0,77})$/.test(plan.amountIn)) return "AMOUNT_INVALID";
  const amount = BigInt(plan.amountIn);
  // No approval in the plan: the allowance read on chain must cover exactly this transfer. More would remain with
  // the spender afterwards (review round 3, R1: a pre-existing large or unlimited allowance is never "fine").
  if (!a)
    return existingAllowance < amount
      ? "APPROVAL_MISSING"
      : existingAllowance > amount
        ? "ALLOWANCE_ABOVE_AMOUNT"
        : null;
  if (lower(a.token) !== lower(plan.pay.address)) return "APPROVAL_WRONG_TOKEN";
  if (!spenderReviewed(a.spender)) return "UNEXPECTED_SPENDER";
  if (!/^\d{1,78}$/.test(a.amount)) return "UNLIMITED_APPROVAL";
  const v = BigInt(a.amount);
  if (v >= UNLIMITED_FLOOR) return "UNLIMITED_APPROVAL";
  if (v > amount) return "APPROVAL_EXCEEDS_AMOUNT";
  if (v < amount) return "APPROVAL_BELOW_AMOUNT";
  // An allowance that already covers the transfer needs no new approval (no extra signature is ever requested).
  if (existingAllowance >= amount) return "APPROVAL_NOT_NEEDED";
  // Some tokens (USDT-style) revert when an allowance is changed from non-zero to non-zero; a partial allowance must
  // first be reset by the owner — refused here rather than guessed (review F15).
  if (existingAllowance > 0n) return "NONZERO_ALLOWANCE_FIRST";
  return null;
}
/** The canonical approval transaction for the plan (to = the token, value 0, exact calldata), or null. */
export function approvalTransaction(
  plan: Pick<
    ExecutionPlan,
    "approval" | "account" | "sourceChainId" | "amountIn" | "pay"
  >,
): WalletTransaction | null {
  if (!plan || typeof plan !== "object")
    throw new RangeError("APPROVAL_NOT_EXACT");
  if (!plan.approval) return null;
  // The builder itself refuses anything but the exact amount of the exact token sent (review F15); malformed input
  // is refused the same way (round 4, S4).
  if (
    typeof plan.approval !== "object" ||
    typeof plan.approval.token !== "string" ||
    typeof plan.approval.spender !== "string" ||
    typeof plan.approval.amount !== "string" ||
    typeof plan.pay?.address !== "string" ||
    typeof plan.amountIn !== "string"
  )
    throw new RangeError("APPROVAL_NOT_EXACT");
  if (
    plan.approval.amount !== plan.amountIn ||
    !/^(0|[1-9]\d{0,77})$/.test(plan.approval.amount) ||
    lower(plan.approval.token) !== lower(plan.pay.address)
  )
    throw new RangeError("APPROVAL_NOT_EXACT");
  return {
    chainId: plan.sourceChainId,
    from: plan.account,
    to: plan.approval.token,
    value: "0",
    data: encodeExactApproval(
      plan.approval.spender,
      BigInt(plan.approval.amount),
    ),
  };
}
