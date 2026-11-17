interface BridgeCostReview {
  amountIn: string;
  effectiveOutput: string | null;
  costBps: number | null;
  gas: { limits: Record<string, string>; worstCaseTotalWei: string };
}
/** The effective output already includes provider and relayer deductions. */
export function bridgeDisplayCost(review?: BridgeCostReview) {
  let tokenCost: string | undefined;
  let rateBps: number | undefined;
  let networkFeeWei: string | undefined;
  if (
    review &&
    /^\d+$/.test(review.amountIn) &&
    typeof review.effectiveOutput === "string" &&
    /^\d+$/.test(review.effectiveOutput) &&
    BigInt(review.amountIn) > 0n &&
    BigInt(review.amountIn) >= BigInt(review.effectiveOutput)
  ) {
    tokenCost = (
      BigInt(review.amountIn) - BigInt(review.effectiveOutput)
    ).toString();
    // Round the exact deduction up for display; the server's integer costBps may be truncated.
    rateBps = Number(
      (BigInt(tokenCost) * 10000n + BigInt(review.amountIn) - 1n) /
        BigInt(review.amountIn),
    );
  }
  if (
    review &&
    Object.values(review.gas?.limits ?? {}).some(
      (n) => /^\d+$/.test(n) && BigInt(n) > 0n,
    ) &&
    /^\d+$/.test(review.gas?.worstCaseTotalWei ?? "")
  )
    networkFeeWei = review.gas.worstCaseTotalWei;
  return { tokenCost, rateBps, networkFeeWei };
}
