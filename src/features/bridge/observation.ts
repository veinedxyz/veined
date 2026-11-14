import { z } from "zod";
import {
  BridgeError,
  recordSchema,
  sameAddress,
  type TransferRecord,
} from "../../core/model";
import {
  verifySettlement,
  type SourceEvidence,
  type DestinationEvidence,
  type SettlementPolicy,
} from "../../core/flow";
import { READ_ONLY_DEPLOYMENT } from "../../adapters/deployment";
const common = {
  record: recordSchema,
  observedAt: z.number().int().positive(),
};
export const observationSchema = z.discriminatedUnion("kind", [
  z.object({ ...common, kind: z.literal("synthetic") }).strict(),
  z
    .object({
      ...common,
      kind: z.literal("chain"),
      evidence: z
        .object({
          source: z.unknown().optional(),
          destination: z.unknown().optional(),
          policy: z
            .object({
              sourceContract: z.string(),
              destinationContract: z.string(),
              sourceConfirmations: z.number(),
              destinationConfirmations: z.number(),
              finality: z.literal("node-finalized"),
            })
            .strict(),
        })
        .strict(),
    })
    .strict(),
]);
export type TrackingObservation = z.infer<typeof observationSchema>;
const identityKeys = [
  "id",
  "mode",
  "route",
  "config",
  "sourceChain",
  "destinationChain",
  "account",
  "recipient",
  "sourceAsset",
  "token",
  "amount",
  "expected",
  "sourceHash",
] as const;
function fingerprint(record: TransferRecord) {
  return JSON.stringify(
    identityKeys.map((key) =>
      typeof record[key] === "string"
        ? String(record[key]).toLowerCase()
        : record[key],
    ),
  );
}
export function validateObservation(
  claim: TransferRecord,
  raw: unknown,
  now = Date.now(),
): TrackingObservation {
  const observation = observationSchema.parse(raw);
  if (
    !Number.isSafeInteger(now) ||
    observation.observedAt > now ||
    now - observation.observedAt > 30000 ||
    fingerprint(claim) !== fingerprint(observation.record) ||
    (claim.index !== undefined && observation.record.index !== claim.index)
  )
    throw new BridgeError("STALE_OR_UNRELATED_OBSERVATION");
  if (observation.kind === "synthetic") {
    if (
      claim.mode !== "local-test" ||
      (claim.error === "IMPORTED_UNVERIFIED" &&
        observation.record.state === "COMPLETED")
    )
      throw new BridgeError("MODE_MISMATCH");
  } else {
    const policy = observation.evidence.policy;
    if (
      !claim.sourceHash &&
      observation.record.state === "SUBMISSION_UNKNOWN" &&
      !observation.evidence.source &&
      !observation.evidence.destination &&
      claim.mode === "mainnet-readonly"
    )
      return observation;
    if (
      claim.mode !== "mainnet-readonly" ||
      policy.sourceConfirmations !== 1 ||
      policy.destinationConfirmations !== 1 ||
      !sameAddress(policy.sourceContract, READ_ONLY_DEPLOYMENT.source) ||
      !sameAddress(
        policy.destinationContract,
        READ_ONLY_DEPLOYMENT.destination,
      ) ||
      observation.record.state !==
        verifySettlement(
          observation.record,
          observation.evidence.source as SourceEvidence | undefined,
          observation.evidence.destination as DestinationEvidence | undefined,
          policy as SettlementPolicy,
        )
    )
      throw new BridgeError("UNVERIFIED_OBSERVATION");
  }
  return observation;
}
// This memory-only view never reads trust or verification timestamps from storage.
export class RuntimeHistoryView {
  private observations = new Map<string, TrackingObservation>();
  accept(claim: TransferRecord, raw: unknown, now = Date.now()) {
    const observation = validateObservation(claim, raw, now);
    this.observations.set(fingerprint(observation.record), observation);
    if (this.observations.size > 100)
      this.observations.delete(this.observations.keys().next().value!);
    return observation.record;
  }
  view(claims: TransferRecord[], now: number) {
    return claims.map((claim) => {
      const observation = this.observations.get(fingerprint(claim));
      if (
        !observation ||
        observation.observedAt > now ||
        now - observation.observedAt > 30000 ||
        (claim.index !== undefined && claim.index !== observation.record.index)
      )
        return claim;
      return observation.record;
    });
  }
}
