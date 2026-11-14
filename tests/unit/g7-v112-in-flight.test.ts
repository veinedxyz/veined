import { expect, it } from "vitest";
import { tokenInFlight } from "../../src/g7/in-flight-reserve";
import type { InFlight } from "../../src/g7/prep";
import { deriveSpendableReserve } from "../../src/g5/reserve";
const cross = "0x" + "c1".repeat(20),
  other = "0x" + "a2".repeat(20);
const inbox = (): InFlight => ({
  enumerated: true,
  bscNextFinalize: "5",
  oneNextInitiate: "7",
  items: [
    { index: "5", found: 1, value: "10", toToken: cross },
    { index: "6", found: 1, value: "20", toToken: other },
  ],
});
it("mixed-token global inbox counts and deducts every CROSS obligation exactly once", () => {
  const i = tokenInFlight(inbox(), cross);
  expect(i).toEqual({ enumerated: true, expectedCount: 1, values: [10n] });
  const result = deriveSpendableReserve({
    token: cross,
    balance: 100n,
    deposited: 100n,
    pendingAmount: 0n,
    pending: [],
    pendingComplete: true,
    inFlight: i,
    sourceMinted: 0n,
    minimum: 1n,
    driftState: "VERIFIED_READ_ONLY",
  });
  expect(result.verified).toBe(true);
  expect(result.spendable).toBe(90n);
});
it("a non-CROSS inbox still needs complete global enumeration", () => {
  const i = inbox();
  i.items[0].toToken = other;
  expect(tokenInFlight(i, cross)).toEqual({
    enumerated: true,
    expectedCount: 0,
    values: [],
  });
  i.enumerated = false;
  expect(tokenInFlight(i, cross).enumerated).toBe(false);
});
it.each([
  "missing index",
  "duplicate index",
  "gap",
  "missing value",
  "negative value",
  "missing token",
  "ambiguous event",
  "reversed range",
])("%s fails closed including non-CROSS entries", (name) => {
  const i = inbox();
  if (name === "missing index") i.items.pop();
  if (name === "duplicate index") i.items[1].index = "5";
  if (name === "gap") i.items[1].index = "8";
  if (name === "missing value") delete i.items[1].value;
  if (name === "negative value") i.items[1].value = "-1";
  if (name === "missing token") delete i.items[1].toToken;
  if (name === "ambiguous event") i.items[1].found = 2;
  if (name === "reversed range") i.oneNextInitiate = "4";
  expect(tokenInFlight(i, cross).enumerated).toBe(false);
});
