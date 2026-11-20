// VEINED-MC1 (review MINOR-4): receipt acceptance shared by the swap and the bridge lane engines, exactly as strict as
// signer v5 receiptVerdict (D:/vnd/hk1/mc1/signer/policy-v5.mjs): a lane never counts a step as final that the signer
// cannot decide (which would make the next step ready and certainly refused). Pure; no I/O.
// Lanes review R2 NEW-5: the signer's own quantity rule (QTY: 0x, no leading zeros, at most 64 digits) for every
// quantity it checks, both heads included; the operator-fee fields compared raw across the operators (an absent field
// and null differ, as with the signer's `!==`; the engines' pick keeps them raw) and the block hash compared raw.
const lower = (a: string) => a.toLowerCase();
/** signer v5 policy-v5.mjs QTY: a 0x quantity without leading zeros. */
export const SIGNER_QUANTITY = /^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/;
export const isQuantity = (v: unknown): v is string =>
  typeof v === "string" && SIGNER_QUANTITY.test(v);
/**
 * VEINED-MC1 review MINOR-4: the receipt fields signer v5 receiptVerdict requires before it counts a signature as
 * decided (the operators already agreed on all of them): the dispatched hash, well-formed quantities and status (and,
 * when given, well-formed heads of both operators), and on OP-stack chains a zero or absent Isthmus operator fee.
 * null = acceptable.
 */
export function strictReceiptProblem(
  x: {
    transactionHash?: unknown;
    status?: unknown;
    blockNumber?: unknown;
    gasUsed?: unknown;
    effectiveGasPrice?: unknown;
    l1Fee?: unknown;
    operatorFeeScalar?: unknown;
    operatorFeeConstant?: unknown;
  },
  hash: string,
  opStack: boolean,
  heads?: readonly unknown[],
): string | null {
  if (
    typeof x.transactionHash !== "string" ||
    lower(x.transactionHash) !== lower(hash)
  )
    return "RECEIPT_TX_HASH_MISMATCH";
  if (
    !isQuantity(x.blockNumber) ||
    !isQuantity(x.gasUsed) ||
    !isQuantity(x.effectiveGasPrice) ||
    (heads !== undefined &&
      (heads.length !== 2 || !heads.every((h) => isQuantity(h)))) ||
    typeof x.status !== "string" ||
    !/^0x[01]$/.test(x.status)
  )
    return "RECEIPT_MALFORMED";
  if (opStack)
    for (const f of [x.operatorFeeScalar, x.operatorFeeConstant])
      if (f !== undefined && f !== null && (!isQuantity(f) || BigInt(f) !== 0n))
        return "RECEIPT_OPERATOR_FEE_UNPROVEN";
  return null;
}
