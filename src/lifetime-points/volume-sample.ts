import type { ReferralBinding, VerifiedActivity } from "../points/model";
import {
  USD_MICROS_PER_POINT,
  volumePolicySchema,
  type VolumeInputs,
} from "./volume";
// G12 H05: SAMPLE data for the labelled preview on the Points page (opened only with ?lifetimePreview=sample), the
// admin inspector and tests. Every number here is invented for illustration: it is not an owner decision, not an
// account and not a real point. The policy is FIXTURE_ONLY, so the ledger marks every result as fixture data.

export const VOLUME_SAMPLE_ACCOUNT =
  "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const INVITED = "0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b";
export const VOLUME_SAMPLE_POLICY = volumePolicySchema.parse({
  version: "vp-sample.1",
  status: "FIXTURE_ONLY",
  usdMicrosPerPoint: USD_MICROS_PER_POINT,
  readingConfirmed: false,
  eligibility: {
    minVolumeUsdMicros: "1000000",
    maxActivitiesPerAccountPerDay: 50,
    maxVolumeUsdMicrosPerAccountPerDay: "1000000000000",
  },
  referral: { commissionBps: 1000, depth: 1, base: "ACTIVITY" },
  effectiveFrom: "2027-01-01T00:00:00Z",
  retroactivity: "NONE",
  legacyWeeklyConversion: "NONE",
});
const event = (
  n: number,
  account: string,
  category: VerifiedActivity["category"],
  dollars: number,
  finalized = true,
): VerifiedActivity => ({
  eventId: `vsample-${n}`,
  verifier: "sample-verifier",
  category,
  operationKey: `evm:1:0xvsample${String(n).padStart(8, "0")}`,
  account,
  outcome: category === "BRIDGE" ? "COMPLETED" : "SETTLED",
  occurredAt: `2027-01-0${n}T12:00:00Z`,
  chainId: "1",
  volumeUsdMicros: String(dollars * 1_000_000),
  finality: {
    blockNumber: String(100 + n),
    blockHash: `vsamplehash${n}`.padEnd(16, "0"),
    confirmations: finalized ? 64 : 1,
    finalized,
  },
  ...(category === "BRIDGE"
    ? {
        bridge: {
          destinationChainId: "8453",
          destinationTx: `vsampledest${n}`.padEnd(16, "0"),
          destinationVerified: finalized,
        },
      }
    : {}),
});
const binding: ReferralBinding = {
  child: INVITED,
  parent: VOLUME_SAMPLE_ACCOUNT,
  code: "SAMPLE01",
  bindingEventId: "vsample-5",
  effectiveAt: "2027-01-01T00:00:00Z",
  createdAt: "2027-01-01T00:00:00Z",
};
// The sample account: 40 + 60 USD swaps and a 230 USD bridge = 330 USD -> 3 points, 70 USD left to the fourth; a
// 120 USD swap that is not final yet is shown apart; its invitee's 1,000 USD -> 10 points -> 1 point of commission.
export const VOLUME_SAMPLE_INPUT: VolumeInputs = {
  policy: VOLUME_SAMPLE_POLICY,
  activities: [
    event(1, VOLUME_SAMPLE_ACCOUNT, "SWAP", 40),
    event(2, VOLUME_SAMPLE_ACCOUNT, "SWAP", 60),
    event(3, VOLUME_SAMPLE_ACCOUNT, "BRIDGE", 230),
    event(4, VOLUME_SAMPLE_ACCOUNT, "SWAP", 120, false),
    event(5, INVITED, "TRADE", 1000),
  ],
  bindings: [binding],
};
