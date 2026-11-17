// Client/server wire contract. This module has no provider, RPC, signer or server dependency.
export const MANUAL_API = "/api/manual-wallet";
export const MANUAL_ROUTES = Object.freeze({
  SWAP: "base-usdc-weth-univ3-max1",
  BRIDGE: "bridge-8453-42161",
});
export type ManualLane = keyof typeof MANUAL_ROUTES;
export type ManualTx = Readonly<
  Record<
    | "chainId"
    | "from"
    | "to"
    | "value"
    | "data"
    | "gas"
    | "maxFeePerGas"
    | "maxPriorityFeePerGas",
    string
  >
>;
export const TX_FIELDS = Object.freeze([
  "chainId",
  "from",
  "to",
  "value",
  "data",
  "gas",
  "maxFeePerGas",
  "maxPriorityFeePerGas",
] as const);
export interface ManualPreparation {
  id: string;
  lane: ManualLane;
  reviewId: string;
  step: string;
  transaction: ManualTx;
  expiresAt: number;
  serverTime: number;
  released: boolean;
}
export function manualTx(value: unknown): ManualTx {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join() !== [...TX_FIELDS].sort().join()
  )
    throw Error("MANUAL_TX_SHAPE");
  const copy = Object.fromEntries(
    TX_FIELDS.map((k) => [k, (value as Record<string, unknown>)[k]]),
  );
  if (!TX_FIELDS.every((k) => typeof copy[k] === "string"))
    throw Error("MANUAL_TX_SHAPE");
  const t = copy as unknown as ManualTx;
  if (
    t.chainId !== "0x2105" ||
    t.value !== "0x0" ||
    !/^0x[0-9a-f]{40}$/.test(t.from) ||
    !/^0x[0-9a-f]{40}$/.test(t.to) ||
    !/^0x(?:[0-9a-fA-F]{2})+$/.test(t.data) ||
    ![t.gas, t.maxFeePerGas, t.maxPriorityFeePerGas].every((x) =>
      /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(x),
    ) ||
    BigInt(t.gas) < 21000n ||
    BigInt(t.maxFeePerGas) <= 0n ||
    BigInt(t.maxPriorityFeePerGas) > BigInt(t.maxFeePerGas)
  )
    throw Error("MANUAL_TX_INVALID");
  return Object.freeze(t);
}
export function sameManualTx(a: ManualTx, b: ManualTx) {
  return TX_FIELDS.every((k) => a[k] === b[k]);
}
export function manualLane(value: unknown): ManualLane {
  if (value !== "SWAP" && value !== "BRIDGE")
    throw Error("MANUAL_ROUTE_UNSUPPORTED");
  return value;
}
