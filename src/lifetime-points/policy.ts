import { z } from "zod";
import { CATEGORIES, unitString, type Category } from "../points/model";
// gf1 G06: lifetime personal points, the owner's new direction (2026-11-09). Users accumulate fixed points per
// eligible verified Swap/Trade/Bridge activity (and owner-defined tasks); no signup points; a referrer earns 10% of the
// invited user's eligible ACTIVITY points, one level only. This module is a versioned policy skeleton: the owner has
// not set the point rates, the effective start, retroactivity or what happens to old weekly points, so the registered
// policy is PENDING_OWNER_POLICY and awards nothing. No token, allocation, airdrop or monetary value exists here.
// Pure: no I/O, no clock, no node built-ins (it also renders in the browser).

/** Owner-confirmed: 10% of the invited user's eligible activity points (basis points of 10,000). */
export const LIFETIME_REFERRAL_BPS = 1000;
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine((v) => !Number.isNaN(Date.parse(v)), "INSTANT_INVALID");
const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._-]{0,63}$/);

export const LIFETIME_STATUSES = [
  // The registered default: no rate, start or conversion decided; nothing is awarded.
  "PENDING_OWNER_POLICY",
  // Sample numbers for isolated tests and the labelled preview only; refused wherever real points would be shown.
  "FIXTURE_ONLY",
  // Exact owner decision with its reference; still requires a separate owner activation before any production use.
  "OWNER_APPROVED",
] as const;
export type LifetimeStatus = (typeof LIFETIME_STATUSES)[number];

export const lifetimePolicySchema = z
  .object({
    version: z.string().regex(/^lt-[a-z0-9][a-z0-9.-]{0,28}$/),
    status: z.enum(LIFETIME_STATUSES),
    approval: z
      .object({
        approvedBy: z.string().min(1).max(80),
        approvedAt: isoInstant,
        reference: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    /** Fixed points per eligible activity, in units (1 point = 1,000,000 units). null: not decided by the owner. */
    rates: z
      .object({
        SWAP: unitString.nullable(),
        TRADE: unitString.nullable(),
        BRIDGE: unitString.nullable(),
      })
      .strict(),
    /** Owner-defined tasks: fixed units per approved completion, at most `maxPerAccount` completions each. */
    tasks: z
      .array(
        z
          .object({
            taskId: id,
            units: unitString,
            maxPerAccount: z.number().int().min(1).max(1000),
          })
          .strict(),
      )
      .max(200),
    /** Owner decision: no one-time signup or welcome points. */
    signupUnits: z.literal("0"),
    referral: z
      .object({
        commissionBps: z.literal(LIFETIME_REFERRAL_BPS),
        /** One level: commission is never paid on commission (a commission-on-commission needs a new owner decision). */
        depth: z.literal(1),
        /** Commission is computed from the invited user's activity points only (not task points). */
        base: z.literal("ACTIVITY"),
      })
      .strict(),
    /** What counts as eligible (review M2): a minimum USD volume per activity (micro-dollars) and a cap of earned
     * activities per account per UTC day. null: not decided by the owner. */
    eligibility: z
      .object({
        minVolumeUsdMicros: unitString.nullable(),
        maxActivitiesPerAccountPerDay: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .nullable(),
      })
      .strict(),
    /** Activities before this instant earn nothing under this policy. A rate change is a NEW version with a later
     * start (earlier activity keeps the rate in effect when it happened; review M1). null: not decided. */
    effectiveFrom: isoInstant.nullable(),
    /** NONE: nothing before the approval counts (effectiveFrom is at or after approval.approvedAt). FROM_EFFECTIVE_DATE:
     * the owner explicitly lets activity count from an earlier effectiveFrom (review m2). */
    retroactivity: z.enum([
      "PENDING_OWNER_DECISION",
      "NONE",
      "FROM_EFFECTIVE_DATE",
    ]),
    /** Earlier weekly points stay exactly as published; any conversion is a separate owner decision (not built) and is
     * independent of approving the rates. */
    legacyWeeklyConversion: z.enum(["PENDING_OWNER_DECISION", "NONE"]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const unset = CATEGORIES.filter((c) => p.rates[c] === null);
    const ids = p.tasks.map((t) => t.taskId);
    if (new Set(ids).size !== ids.length) issue("TASK_DUPLICATE");
    const eligibilityUnset =
      p.eligibility.minVolumeUsdMicros === null ||
      p.eligibility.maxActivitiesPerAccountPerDay === null;
    if (p.status === "PENDING_OWNER_POLICY") {
      if (p.approval) issue("PENDING_WITH_APPROVAL");
      // Not one decision may be pre-filled without approval: a pending policy that carried a start date,
      // retroactivity or a conversion choice would hide an invented decision from the missing list (review-2 mn1).
      if (
        p.effectiveFrom !== null ||
        p.retroactivity !== "PENDING_OWNER_DECISION" ||
        p.legacyWeeklyConversion !== "PENDING_OWNER_DECISION"
      )
        issue("PENDING_WITH_DECISIONS");
      if (
        unset.length !== CATEGORIES.length ||
        p.tasks.length ||
        !(
          p.eligibility.minVolumeUsdMicros === null &&
          p.eligibility.maxActivitiesPerAccountPerDay === null
        )
      )
        issue("PENDING_WITH_NUMBERS");
    }
    if (p.status === "FIXTURE_ONLY" && p.approval)
      issue("FIXTURE_WITH_APPROVAL");
    if (p.status === "OWNER_APPROVED") {
      if (!p.approval) issue("APPROVAL_MISSING");
      if (unset.length) issue("RATE_MISSING");
      if (eligibilityUnset) issue("ELIGIBILITY_MISSING");
      if (!p.effectiveFrom) issue("EFFECTIVE_FROM_MISSING");
      if (p.retroactivity === "PENDING_OWNER_DECISION")
        issue("RETROACTIVITY_MISSING");
      if (
        p.retroactivity === "NONE" &&
        p.approval &&
        p.effectiveFrom &&
        Date.parse(p.effectiveFrom) < Date.parse(p.approval.approvedAt)
      )
        issue("RETROACTIVE_START_WITHOUT_DECISION");
      // The conversion of earlier weekly points is its own owner decision: approving the rates does not force it
      // (review-2 m2); it stays listed as open until decided.
    }
  });
export type LifetimePolicy = z.output<typeof lifetimePolicySchema>;

/** The registered policy: the owner's structure (no signup points, 10% one-level referral) without any number. */
export const REGISTERED_LIFETIME_POLICY: LifetimePolicy = Object.freeze({
  version: "lt-pending.1",
  status: "PENDING_OWNER_POLICY",
  rates: Object.freeze({ SWAP: null, TRADE: null, BRIDGE: null }),
  tasks: Object.freeze([]) as unknown as LifetimePolicy["tasks"],
  signupUnits: "0",
  eligibility: Object.freeze({
    minVolumeUsdMicros: null,
    maxActivitiesPerAccountPerDay: null,
  }),
  referral: Object.freeze({
    commissionBps: LIFETIME_REFERRAL_BPS,
    depth: 1,
    base: "ACTIVITY",
  }),
  effectiveFrom: null,
  retroactivity: "PENDING_OWNER_DECISION",
  legacyWeeklyConversion: "PENDING_OWNER_DECISION",
}) as LifetimePolicy;

export type Activation =
  | { state: "PENDING_OWNER_POLICY"; missing: string[] }
  | { state: "FIXTURE_ONLY" }
  | { state: "APPROVED_NOT_ACTIVATED"; open: string[] };
/** What a policy allows. Approval alone never activates real rewards: activation is a separate owner gate. */
export function activation(policy: LifetimePolicy): Activation {
  if (policy.status === "FIXTURE_ONLY") return { state: "FIXTURE_ONLY" };
  if (policy.status === "OWNER_APPROVED")
    return {
      state: "APPROVED_NOT_ACTIVATED",
      open:
        policy.legacyWeeklyConversion === "PENDING_OWNER_DECISION"
          ? ["legacyWeeklyConversion"]
          : [],
    };
  const missing: string[] = [
    ...CATEGORIES.filter((c) => policy.rates[c] === null).map(
      (c) => `rate.${c}`,
    ),
    ...(policy.eligibility.minVolumeUsdMicros === null
      ? ["eligibility.minVolume"]
      : []),
    ...(policy.eligibility.maxActivitiesPerAccountPerDay === null
      ? ["eligibility.dailyCap"]
      : []),
    ...(policy.effectiveFrom ? [] : ["effectiveFrom"]),
    ...(policy.retroactivity === "PENDING_OWNER_DECISION"
      ? ["retroactivity"]
      : []),
    ...(policy.legacyWeeklyConversion === "PENDING_OWNER_DECISION"
      ? ["legacyWeeklyConversion"]
      : []),
  ];
  return { state: "PENDING_OWNER_POLICY", missing };
}
export const rateOf = (policy: LifetimePolicy, category: Category) =>
  policy.rates[category];
