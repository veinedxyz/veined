import { expect, it } from "vitest";
import { bridgeDisplayCost } from "../../src/manual-wallet/display";
const quote = {
  amountIn: "5000000",
  effectiveOutput: "4980501",
  feeTotal: "12500",
  costBps: 38,
  gas: { limits: { EXECUTE: "240000" }, worstCaseTotalWei: "4000000000000" },
};
it("includes provider and relayer deductions without double counting the provider fee", () => {
  expect(bridgeDisplayCost(quote)).toEqual({
    tokenCost: "19499",
    rateBps: 39,
    networkFeeWei: "4000000000000",
  });
});
it("keeps network gas unavailable when an underfunded simulation supplied only an L1 component", () => {
  expect(
    bridgeDisplayCost({
      ...quote,
      gas: { limits: {}, worstCaseTotalWei: "13436885562" },
    }),
  ).toMatchObject({ tokenCost: "19499", networkFeeWei: undefined });
});
it("does not invent a zero cost or rate for an absent or invalid output", () => {
  expect(bridgeDisplayCost()).toEqual({
    tokenCost: undefined,
    rateBps: undefined,
    networkFeeWei: undefined,
  });
  expect(
    bridgeDisplayCost({ ...quote, effectiveOutput: null }).tokenCost,
  ).toBeUndefined();
  expect(
    bridgeDisplayCost({ ...quote, effectiveOutput: "5000001" }).rateBps,
  ).toBeUndefined();
  expect(
    bridgeDisplayCost({ ...quote, amountIn: "0", effectiveOutput: "0" })
      .rateBps,
  ).toBeUndefined();
});
