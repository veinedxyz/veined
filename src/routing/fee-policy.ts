import { RoutingError } from "./model";
export type PlatformFeePolicy = {
  enabled: boolean;
  bps: number;
  maxBps: number;
  recipientMode: "disabled" | "provider-native";
};
export const targetFeeBps = 5;
export const platformFeePolicy: Readonly<PlatformFeePolicy> = Object.freeze({
  enabled: false,
  bps: 0,
  maxBps: 10,
  recipientMode: "disabled",
});
export function platformFee(
  amount: string,
  policy: PlatformFeePolicy = platformFeePolicy,
): string {
  if (
    !/^(0|[1-9]\d{0,77})$/.test(amount) ||
    !Number.isInteger(policy.bps) ||
    policy.bps < 0 ||
    policy.bps > 10 ||
    policy.maxBps !== 10 ||
    policy.bps > policy.maxBps ||
    (!policy.enabled && policy.bps !== 0) ||
    (policy.enabled && policy.recipientMode !== "provider-native")
  )
    throw new RoutingError("INVALID_FEE_POLICY");
  return ((BigInt(amount) * BigInt(policy.bps)) / 10000n).toString();
}
