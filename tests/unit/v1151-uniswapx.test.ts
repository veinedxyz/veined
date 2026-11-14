import { describe, it, expect } from "vitest";
import {
  CosignedV2DutchOrder,
  CosignedV3DutchOrder,
  CosignedPriorityOrder,
  UNISWAPX_REACTORS,
  UniswapXOrderType,
} from "../../swap-providers/uniswapx-runtime";
import { decodeUniswapX } from "../../src/swap/server/providers/uniswapx";
import { swapIntent } from "../fixtures/swap";
const fixture = (type: "DUTCH_V2" | "DUTCH_V3" | "PRIORITY") => {
  const i = swapIntent({ chain: type === "PRIORITY" ? "8453" : "1" });
  i.tokenIn = {
    ...i.tokenIn,
    chain: i.chain,
    native: false,
    address: "0x1111111111111111111111111111111111111111",
  };
  i.tokenOut = { ...i.tokenOut, chain: i.chain };
  const now = Math.floor(Date.now() / 1000),
    reactor =
      UNISWAPX_REACTORS[Number(i.chain)][
        type === "DUTCH_V2"
          ? UniswapXOrderType.Dutch_V2
          : type === "DUTCH_V3"
            ? UniswapXOrderType.Dutch_V3
            : UniswapXOrderType.Priority
      ]!;
  const base = {
    reactor,
    swapper: i.taker,
    nonce: "1",
    deadline: now + 90,
    additionalValidationContract: "0x0000000000000000000000000000000000000000",
    additionalValidationData: "0x",
    cosigner: "0x2222222222222222222222222222222222222222",
    cosignature: "0x",
  };
  const c = {
    exclusiveFiller: "0x0000000000000000000000000000000000000000",
    exclusivityOverrideBps: 0,
    inputOverride: "0",
    outputOverrides: ["0"],
  };
  const order =
    type === "DUTCH_V2"
      ? CosignedV2DutchOrder.fromJSON(
          {
            ...base,
            input: {
              token: i.tokenIn.address,
              startAmount: String(i.amount),
              endAmount: String(i.amount),
            },
            outputs: [
              {
                token: i.tokenOut.address,
                recipient: i.recipient,
                startAmount: "1000000",
                endAmount: "995000",
              },
            ],
            cosignerData: { ...c, decayStartTime: now, decayEndTime: now + 80 },
          },
          Number(i.chain),
        )
      : type === "DUTCH_V3"
        ? CosignedV3DutchOrder.fromJSON(
            {
              ...base,
              startingBaseFee: "0",
              input: {
                token: i.tokenIn.address,
                startAmount: String(i.amount),
                maxAmount: String(i.amount),
                curve: { relativeBlocks: [], relativeAmounts: [] },
                adjustmentPerGweiBaseFee: "0",
              },
              outputs: [
                {
                  token: i.tokenOut.address,
                  recipient: i.recipient,
                  startAmount: "1000000",
                  minAmount: "995000",
                  curve: { relativeBlocks: [10], relativeAmounts: ["5000"] },
                  adjustmentPerGweiBaseFee: "0",
                },
              ],
              cosignerData: { ...c, decayStartBlock: 100 },
            },
            Number(i.chain),
          )
        : CosignedPriorityOrder.fromJSON(
            {
              ...base,
              auctionStartBlock: "100",
              baselinePriorityFeeWei: "0",
              input: {
                token: i.tokenIn.address,
                amount: String(i.amount),
                mpsPerPriorityFeeWei: "0",
              },
              outputs: [
                {
                  token: i.tokenOut.address,
                  recipient: i.recipient,
                  amount: "1000000",
                  mpsPerPriorityFeeWei: "1",
                },
              ],
              cosignerData: { auctionTargetBlock: "100" },
            },
            Number(i.chain),
          );
  return { i, order };
};
describe("current UniswapX API semantic formats", () => {
  it.each(["DUTCH_V2", "DUTCH_V3", "PRIORITY"] as const)(
    "parses %s using its pinned reactor and domain",
    (type) => {
      const { i, order } = fixture(type),
        d = decodeUniswapX(order.serialize(), type, i);
      expect(d.amountIn).toBe(i.amount);
      expect(d.minAmountOut).toBeGreaterThanOrEqual(995000n);
      expect(d.nonce).toBe(1n);
      expect(d.permit.domain.chainId).toBe(Number(i.chain));
      expect(d.signable).toBe(false);
    },
  );
  it.each(["recipient", "amount", "chain", "unknown", "trailing-bytes"])(
    "rejects %s",
    (mutation) => {
      const { i, order } = fixture("DUTCH_V2");
      if (mutation === "recipient")
        i.recipient = "0x4444444444444444444444444444444444444444";
      if (mutation === "amount") i.amount++;
      if (mutation === "chain") i.chain = "56";
      expect(() =>
        decodeUniswapX(
          order.serialize() + (mutation === "trailing-bytes" ? "00" : ""),
          mutation === "unknown" ? "NEW_ORDER" : "DUTCH_V2",
          i,
        ),
      ).toThrow();
    },
  );
});
