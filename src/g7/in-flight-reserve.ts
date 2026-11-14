import type { InFlight } from "./prep";
// Bridge indices are global across token pairs. All indices must be enumerated; only
// obligations denominated in this reserve's exact token enter its count and sum.
export function tokenInFlight(input: InFlight, token: string) {
  const decimal = /^\d{1,78}$/;
  let complete =
    input.enumerated &&
    decimal.test(input.bscNextFinalize) &&
    decimal.test(input.oneNextInitiate);
  const from = complete ? BigInt(input.bscNextFinalize) : 0n;
  const to = complete ? BigInt(input.oneNextInitiate) : 0n;
  complete =
    complete &&
    to >= from &&
    to - from === BigInt(input.items.length) &&
    input.items.every(
      (item, i) =>
        item.index === (from + BigInt(i)).toString() &&
        item.found === 1 &&
        decimal.test(item.value ?? "") &&
        /^0x[0-9a-f]{40}$/i.test(item.toToken ?? ""),
    );
  const relevant = input.items.filter(
    (item) => item.toToken?.toLowerCase() === token.toLowerCase(),
  );
  return {
    enumerated: complete,
    expectedCount: relevant.length,
    values: complete ? relevant.map((item) => BigInt(item.value!)) : [],
  };
}
