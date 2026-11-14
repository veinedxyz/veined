import type { VerifiedActivity } from "../points/model";
import type { LedgerInputs } from "./ledger";
import { lifetimePolicySchema } from "./policy";
// gf1 G06: SAMPLE data for the labelled preview on the Points page (opened only with ?lifetimePreview=sample) and for
// tests. Every number here is invented for illustration: it is not an owner rate, not an account and not a real point.
// The policy is FIXTURE_ONLY, so the ledger marks every result as fixture data.

export const SAMPLE_ACCOUNT = "0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a";
const INVITED = "0x6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b6b";
export const SAMPLE_POLICY = lifetimePolicySchema.parse({
  version: "lt-sample.1",
  status: "FIXTURE_ONLY",
  rates: { SWAP: "10000000", TRADE: "10000000", BRIDGE: "15000000" },
  tasks: [{ taskId: "sample-task", units: "5000000", maxPerAccount: 1 }],
  signupUnits: "0",
  eligibility: {
    minVolumeUsdMicros: "1000000",
    maxActivitiesPerAccountPerDay: 50,
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
  outcome: VerifiedActivity["outcome"],
  finalized = true,
): VerifiedActivity => ({
  eventId: `sample-${n}`,
  verifier: "sample-verifier",
  category,
  operationKey: `evm:1:0xsample${String(n).padStart(8, "0")}`,
  account,
  outcome,
  occurredAt: `2027-01-0${n}T12:00:00Z`,
  chainId: "1",
  volumeUsdMicros: "100000000",
  finality: {
    blockNumber: String(100 + n),
    blockHash: `samplehash${n}`.padEnd(16, "0"),
    confirmations: finalized ? 64 : 1,
    finalized,
  },
  ...(category === "BRIDGE"
    ? {
        bridge: {
          destinationChainId: "8453",
          destinationTx: `sampledest${n}`.padEnd(16, "0"),
          destinationVerified: finalized,
        },
      }
    : {}),
});
export const SAMPLE_INPUT: LedgerInputs = {
  policy: SAMPLE_POLICY,
  activities: [
    event(1, SAMPLE_ACCOUNT, "SWAP", "SETTLED"),
    event(2, SAMPLE_ACCOUNT, "BRIDGE", "COMPLETED"),
    event(3, SAMPLE_ACCOUNT, "SWAP", "PENDING", false),
    event(4, SAMPLE_ACCOUNT, "TRADE", "FAILED"),
    event(5, INVITED, "SWAP", "SETTLED"),
  ],
  taskAwards: [
    {
      awardId: "sample-award-1",
      taskId: "sample-task",
      account: SAMPLE_ACCOUNT,
      occurredAt: "2027-01-06T12:00:00Z",
      approved: true,
    },
  ],
  bindings: [
    {
      child: INVITED,
      parent: SAMPLE_ACCOUNT,
      code: "SAMPLE01",
      bindingEventId: "sample-5",
      effectiveAt: "2027-01-01T00:00:00Z",
      createdAt: "2027-01-01T00:00:00Z",
    },
  ],
};
