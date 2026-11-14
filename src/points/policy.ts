import { z } from "zod";
import { digest } from "./hash";
import {
  CATEGORIES,
  unitString,
  type Category,
  type VerifiedActivity,
} from "./model";
import { BPS, isqrt, minBig, parseUnits } from "./units";
// Versioned weight policies. A version is immutable once any season froze it (seasons store its hash and refuse
// drift). Every numeric value below is owner-configurable; the registered draft is a PLACEHOLDER for playtest and
// is refused in production until the owner registers an OWNER_APPROVED version.

const category = z
  .object({
    enabled: z.boolean(),
    baseWeight: unitString,
    volumeWeight: unitString,
    multiplierBps: z.number().int().min(0).max(100_000),
  })
  .strict();
export const weightPolicySchema = z
  .object({
    version: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,31}$/),
    status: z.enum(["DRAFT_PLACEHOLDER", "OWNER_APPROVED"]),
    approval: z
      .object({
        approvedBy: z.string().min(1).max(80),
        approvedAt: z.string().min(1).max(40),
        reference: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    categories: z
      .object({ SWAP: category, TRADE: category, BRIDGE: category })
      .strict(),
    volume: z
      .object({
        // Bounded volume weighting: volume is capped per activity and (sqrt mode) concave, so one very large
        // transaction cannot dominate the weekly pool.
        mode: z.enum(["linear-capped", "sqrt-capped"]),
        minEligibleUsdMicros: unitString,
        perActivityCapUsdMicros: unitString,
      })
      .strict(),
    limits: z
      .object({
        maxActivitiesPerAccountPerSeason: z.number().int().min(1).max(100_000),
        accountSeasonActivityWeightCap: unitString,
        accountSeasonTaskWeightCap: unitString,
      })
      .strict(),
    finality: z
      .object({
        defaultMinConfirmations: z.number().int().min(1).max(10_000),
        minConfirmations: z.record(
          z.string().regex(/^[A-Za-z0-9-]{1,24}$/),
          z.number().int().min(1).max(10_000),
        ),
        // Activity that settles inside a season but finalizes after close + grace is excluded from that season.
        graceSeconds: z
          .number()
          .int()
          .min(0)
          .max(7 * 24 * 3600),
      })
      .strict(),
    referral: z
      .object({
        commissionBps: z.literal(1000),
        // Task rewards carry commission only when the owner separately approves it.
        includeTasks: z.boolean(),
        codeRequiresVerifiedActivity: z.boolean(),
        bindOnlyWithoutPriorActivity: z.literal(true),
      })
      .strict(),
    display: z
      .object({
        // Week-1 style privacy: when false, the live season shows no participation hint at all.
        showParticipationStatus: z.boolean(),
        leaderboardSize: z.number().int().min(10).max(500),
        maskAccounts: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .refine(
    (p) => p.status !== "OWNER_APPROVED" || !!p.approval,
    "APPROVAL_RECORD_REQUIRED",
  );
export type WeightPolicy = z.output<typeof weightPolicySchema>;

const DRAFT: WeightPolicy = weightPolicySchema.parse({
  version: "draft-1",
  status: "DRAFT_PLACEHOLDER",
  categories: {
    SWAP: {
      enabled: true,
      baseWeight: "100",
      volumeWeight: "10",
      multiplierBps: 10_000,
    },
    TRADE: {
      enabled: true,
      baseWeight: "100",
      volumeWeight: "10",
      multiplierBps: 10_000,
    },
    BRIDGE: {
      enabled: true,
      baseWeight: "100",
      volumeWeight: "10",
      multiplierBps: 10_000,
    },
  },
  volume: {
    mode: "sqrt-capped",
    minEligibleUsdMicros: "10000000",
    perActivityCapUsdMicros: "100000000000",
  },
  limits: {
    maxActivitiesPerAccountPerSeason: 200,
    accountSeasonActivityWeightCap: "100000",
    accountSeasonTaskWeightCap: "50000",
  },
  finality: {
    defaultMinConfirmations: 12,
    minConfirmations: {},
    graceSeconds: 21_600,
  },
  referral: {
    commissionBps: 1000,
    includeTasks: false,
    codeRequiresVerifiedActivity: true,
    bindOnlyWithoutPriorActivity: true,
  },
  display: {
    showParticipationStatus: false,
    leaderboardSize: 100,
    maskAccounts: true,
  },
});

// Append-only registry. Never edit a registered version; add a new one.
export const POLICIES: Readonly<Record<string, WeightPolicy>> = Object.freeze({
  [DRAFT.version]: Object.freeze(DRAFT),
});
export const policyHash = (policy: WeightPolicy) => digest(policy);

export function resolvePolicy(version: string, expectedHash?: string) {
  const policy = POLICIES[version];
  if (!policy) throw Error("POLICY_UNKNOWN");
  const hash = policyHash(policy);
  if (expectedHash && hash !== expectedHash) throw Error("POLICY_DRIFT");
  return { policy, hash };
}

export function minConfirmations(policy: WeightPolicy, chainId: string) {
  return (
    policy.finality.minConfirmations[chainId] ??
    policy.finality.defaultMinConfirmations
  );
}

/** Raw (pre-cap) weight of one verified activity under the policy, plus the bounded volume actually used. */
export function activityWeight(policy: WeightPolicy, event: VerifiedActivity) {
  const rule = policy.categories[event.category as Category];
  const volume = parseUnits(event.volumeUsdMicros);
  const bounded = minBig(
    volume,
    parseUnits(policy.volume.perActivityCapUsdMicros),
  );
  const coefficient = parseUnits(rule.volumeWeight);
  const volumePart =
    policy.volume.mode === "linear-capped"
      ? (coefficient * bounded) / 1_000_000n
      : (coefficient * isqrt(bounded)) / 1_000n;
  const weight =
    ((parseUnits(rule.baseWeight) + volumePart) * BigInt(rule.multiplierBps)) /
    BPS;
  return { weight, boundedVolumeUsdMicros: bounded, volumePart };
}

export function categoryEnabled(policy: WeightPolicy, c: Category) {
  return CATEGORIES.includes(c) && policy.categories[c].enabled;
}
