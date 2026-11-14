import { z } from "zod";
import {
  normalizeAccount,
  unitString,
  verifiedActivitySchema,
  type Category,
  type ReferralBinding,
  type VerifiedActivity,
} from "../points/model";
import {
  LIFETIME_REFERRAL_BPS,
  LIFETIME_STATUSES,
  lifetimePolicySchema,
} from "./policy";
import {
  computeLedger,
  type ExclusionPeriod,
  type LineStatus,
  type Reversal,
} from "./ledger";
// G12 H05: cumulative points from verified volume - the owner's newer preference (2026-11-11): "1 point for every
// 100 USD of verified transaction volume". Engineering reading, to be confirmed by the owner before any activation:
//   * the unit is an account's CUMULATIVE verified, settled, eligible economic volume (Swap, Trade, Bridge), in exact
//     micro-dollars; one whole point per full 100 USD; the remainder below 100 USD is kept and counts toward the next
//     point (40 + 60 USD -> 1 point; 250 USD -> 2 points and 50 USD toward the third);
//   * no fractional activity points, no signup points, no weekly pool, no ranking, no token or monetary value;
//   * a referrer earns 10% of the invited account's ACTIVITY points (one level; a commission is never volume and never
//     a base for another commission), in exact units (1 point = 1,000,000 units, so 10% of a point is 100,000 units).
// Which records count is decided by the accepted lifetime ledger (src/lifetime-points/ledger.ts), reused unchanged as
// the gate: one line per event, an operation counted once whatever its event id or category, conflicting events
// rejected, pending / failed / reverted / future-dated records never counted, exclusions by period, reversals kept in
// the audit trail. This module only replaces "fixed points per activity" by "volume toward 100 USD thresholds".
// Pure: no I/O, no clock. The registered policy is PENDING_OWNER_POLICY and awards nothing; nothing here is wired to
// production activity, and no historical weekly record is read, converted or changed.

export const UNITS_PER_POINT = 1_000_000n;
/** The owner's wording, as micro-dollars per whole point. Another value is a new owner decision (a new literal). */
export const USD_MICROS_PER_POINT = "100000000";
const isoInstant = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/)
  .refine((v) => !Number.isNaN(Date.parse(v)), "INSTANT_INVALID");

export const volumePolicySchema = z
  .object({
    version: z.string().regex(/^vp-[a-z0-9][a-z0-9.-]{0,24}$/),
    status: z.enum(LIFETIME_STATUSES),
    approval: z
      .object({
        approvedBy: z.string().min(1).max(80),
        approvedAt: isoInstant,
        reference: z.string().min(1).max(200),
      })
      .strict()
      .optional(),
    usdMicrosPerPoint: z.literal(USD_MICROS_PER_POINT),
    /** The owner confirmed the engineering reading above (cumulative thresholds, carried remainder). */
    readingConfirmed: z.boolean(),
    eligibility: z
      .object({
        /** Activities below this volume add nothing (dust and spam). null: not decided. */
        minVolumeUsdMicros: unitString.nullable(),
        /** At most this many counted activities per account per UTC day. null: not decided. */
        maxActivitiesPerAccountPerDay: z
          .number()
          .int()
          .min(1)
          .max(10_000)
          .nullable(),
        /** At most this much volume is counted per account per UTC day (review H05 M2: the activity cap alone does
         * not bound volume); the part of an activity above it adds nothing. null: not decided. */
        maxVolumeUsdMicrosPerAccountPerDay: unitString.nullable(),
      })
      .strict(),
    referral: z
      .object({
        commissionBps: z.literal(LIFETIME_REFERRAL_BPS),
        depth: z.literal(1),
        base: z.literal("ACTIVITY"),
      })
      .strict(),
    effectiveFrom: isoInstant.nullable(),
    retroactivity: z.enum([
      "PENDING_OWNER_DECISION",
      "NONE",
      "FROM_EFFECTIVE_DATE",
    ]),
    legacyWeeklyConversion: z.enum(["PENDING_OWNER_DECISION", "NONE"]),
  })
  .strict()
  .superRefine((p, ctx) => {
    const issue = (message: string) =>
      ctx.addIssue({ code: "custom", message });
    const undecided =
      p.eligibility.minVolumeUsdMicros === null ||
      p.eligibility.maxActivitiesPerAccountPerDay === null ||
      p.eligibility.maxVolumeUsdMicrosPerAccountPerDay === null;
    if (p.status === "PENDING_OWNER_POLICY") {
      // Not one decision may be pre-filled without approval.
      if (p.approval) issue("PENDING_WITH_APPROVAL");
      if (
        p.readingConfirmed ||
        p.effectiveFrom !== null ||
        p.retroactivity !== "PENDING_OWNER_DECISION" ||
        p.legacyWeeklyConversion !== "PENDING_OWNER_DECISION" ||
        p.eligibility.minVolumeUsdMicros !== null ||
        p.eligibility.maxActivitiesPerAccountPerDay !== null ||
        p.eligibility.maxVolumeUsdMicrosPerAccountPerDay !== null
      )
        issue("PENDING_WITH_DECISIONS");
    }
    if (p.status === "FIXTURE_ONLY") {
      if (p.approval) issue("FIXTURE_WITH_APPROVAL");
      if (undecided || !p.effectiveFrom) issue("FIXTURE_INCOMPLETE");
    }
    if (p.status === "OWNER_APPROVED") {
      if (!p.approval) issue("APPROVAL_MISSING");
      if (!p.readingConfirmed) issue("READING_NOT_CONFIRMED");
      if (undecided) issue("ELIGIBILITY_MISSING");
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
    }
  });
export type VolumePolicy = z.output<typeof volumePolicySchema>;

/** The registered policy: the owner's stated rule without any confirmed decision. It awards nothing. */
export const REGISTERED_VOLUME_POLICY: VolumePolicy = Object.freeze({
  version: "vp-pending.1",
  status: "PENDING_OWNER_POLICY",
  usdMicrosPerPoint: USD_MICROS_PER_POINT,
  readingConfirmed: false,
  eligibility: Object.freeze({
    minVolumeUsdMicros: null,
    maxActivitiesPerAccountPerDay: null,
    maxVolumeUsdMicrosPerAccountPerDay: null,
  }),
  referral: Object.freeze({
    commissionBps: LIFETIME_REFERRAL_BPS,
    depth: 1,
    base: "ACTIVITY",
  }),
  effectiveFrom: null,
  retroactivity: "PENDING_OWNER_DECISION",
  legacyWeeklyConversion: "PENDING_OWNER_DECISION",
}) as VolumePolicy;

/**
 * What this module does NOT defend and no policy field can decide (review H05 M2). Each is an open owner decision or a
 * contract the future activity verifier must meet; they are listed with every pending or approved policy so the list
 * of open items is never read as complete without them.
 */
export const OPEN_BEYOND_POLICY = Object.freeze([
  // Trading back and forth to inflate volume: only the daily caps bound it; no pattern rule exists.
  "abuse.washTradingRule",
  // One person behind an inviter and an invitee wallet earns the 10% on top: no identity rule exists.
  "abuse.sybilSelfReferralRule",
  // One user action that settles as several operations (a swap, then a bridge) must arrive under ONE operationKey.
  "verifier.multiLegOperationKey",
  // volumeUsdMicros is taken as the verifier reports it: the price source, its timestamp and provenance are not
  // carried by a verified activity yet.
  "verifier.priceProvenance",
  // A later policy version needs version history (as the lifetime ledger has) before it can replace this one.
  "policy.versionHistory",
]);

export type VolumeActivation =
  | { state: "PENDING_OWNER_POLICY"; missing: string[] }
  | { state: "FIXTURE_ONLY" }
  | { state: "APPROVED_NOT_ACTIVATED"; open: string[] };
/** What a policy allows. Approval alone never activates real points: activation is a separate owner gate. */
export function volumeActivation(policy: VolumePolicy): VolumeActivation {
  if (policy.status === "FIXTURE_ONLY") return { state: "FIXTURE_ONLY" };
  if (policy.status === "OWNER_APPROVED")
    return {
      state: "APPROVED_NOT_ACTIVATED",
      open: [
        "productionActivation",
        ...(policy.legacyWeeklyConversion === "PENDING_OWNER_DECISION"
          ? ["legacyWeeklyConversion"]
          : []),
        ...OPEN_BEYOND_POLICY,
      ],
    };
  return {
    state: "PENDING_OWNER_POLICY",
    missing: [
      ...(policy.readingConfirmed ? [] : ["readingConfirmed"]),
      ...(policy.eligibility.minVolumeUsdMicros === null
        ? ["eligibility.minVolume"]
        : []),
      ...(policy.eligibility.maxActivitiesPerAccountPerDay === null
        ? ["eligibility.dailyCap"]
        : []),
      ...(policy.eligibility.maxVolumeUsdMicrosPerAccountPerDay === null
        ? ["eligibility.dailyVolumeCap"]
        : []),
      ...(policy.effectiveFrom ? [] : ["effectiveFrom"]),
      ...(policy.retroactivity === "PENDING_OWNER_DECISION"
        ? ["retroactivity"]
        : []),
      ...(policy.legacyWeeklyConversion === "PENDING_OWNER_DECISION"
        ? ["legacyWeeklyConversion"]
        : []),
      ...OPEN_BEYOND_POLICY,
    ],
  };
}

export interface VolumeInputs {
  policy: VolumePolicy;
  activities: readonly VerifiedActivity[];
  bindings?: readonly ReferralBinding[];
  reversals?: readonly Reversal[];
  exclusions?: readonly ExclusionPeriod[];
  /** The computation's clock; required with an approved policy (as the lifetime ledger). */
  asOf?: string;
  /** The separate owner activation of an APPROVED policy (review H05 m8): without it an approved policy computes
   * nothing. A fixture policy never accepts it. */
  ownerActivation?: {
    activatedBy: string;
    activatedAt: string;
    reference: string;
  };
}
export interface VolumeLine {
  ref: string;
  account: string;
  category?: Category;
  occurredAt: string;
  status: LineStatus;
  reason?: string;
  /** The activity's verified volume as reported by its verifier (micro-dollars); "0" on a conflicting event, whose
   * variants disagree about it. */
  volumeUsdMicros: string;
  /** Counted lines only: the part of the volume that counted (less than the volume when the daily volume cap cut it). */
  countedUsdMicros?: string;
  /** Counted lines only: the account's cumulative counted volume after this activity. */
  cumulativeUsdMicros?: string;
  /** Counted lines only: whole points this activity completed (0 when no 100 USD threshold was crossed). */
  points?: string;
}
export interface VolumeTotals {
  /** Verified, settled, eligible volume counted so far. */
  countedUsdMicros: string;
  /** Whole points from volume (never fractional). */
  points: string;
  /** Counted volume not yet converted: it stays and counts toward the next point. */
  carryUsdMicros: string;
  toNextPointUsdMicros: string;
  /** Volume of activities that are not final yet: never counted, shown apart. */
  pendingUsdMicros: string;
  /** Volume of reversed activities (reorg, refund, abuse finding): kept in the trail, not counted. */
  reversedUsdMicros: string;
  /** Referral commission in units (1 point = 1,000,000 units): 10% of invited accounts' activity points. */
  referralUnits: string;
  /** points x 1,000,000 + referralUnits. */
  totalUnits: string;
}
export type VolumeResult =
  | { state: "PENDING_OWNER_POLICY"; version: string; missing: string[] }
  | { state: "APPROVED_NOT_ACTIVATED"; version: string; open: string[] }
  | {
      state: "COMPUTED";
      version: string;
      fixture: boolean;
      usdMicrosPerPoint: string;
      lines: VolumeLine[];
      accounts: Record<string, VolumeTotals>;
    };

const BPS = 10_000n;
const zero = (): VolumeTotals => ({
  countedUsdMicros: "0",
  points: "0",
  carryUsdMicros: "0",
  toNextPointUsdMicros: USD_MICROS_PER_POINT,
  pendingUsdMicros: "0",
  reversedUsdMicros: "0",
  referralUnits: "0",
  totalUnits: "0",
});

export function computeVolumeLedger(input: VolumeInputs): VolumeResult {
  const policy = volumePolicySchema.parse(input.policy);
  const act = volumeActivation(policy);
  if (act.state === "PENDING_OWNER_POLICY")
    return {
      state: "PENDING_OWNER_POLICY",
      version: policy.version,
      missing: act.missing,
    };
  if (policy.status === "FIXTURE_ONLY" && input.ownerActivation)
    throw Error("VOLUME_FIXTURE_WITH_ACTIVATION");
  if (act.state === "APPROVED_NOT_ACTIVATED") {
    // Approval is not activation: a real computation needs the owner's separate activation record, dated at or after
    // the approval.
    const a = input.ownerActivation;
    if (
      !a ||
      Object.keys(a).sort().join() !== "activatedAt,activatedBy,reference" ||
      typeof a.activatedBy !== "string" ||
      a.activatedBy.length < 1 ||
      a.activatedBy.length > 80 ||
      typeof a.reference !== "string" ||
      a.reference.length < 1 ||
      a.reference.length > 200 ||
      !isoInstant.safeParse(a.activatedAt).success ||
      Date.parse(a.activatedAt) < Date.parse(policy.approval!.approvedAt) ||
      // An activation dated after the computation's own clock has not happened yet.
      input.asOf === undefined ||
      Number.isNaN(Date.parse(input.asOf)) ||
      Date.parse(a.activatedAt) > Date.parse(input.asOf)
    )
      return {
        state: "APPROVED_NOT_ACTIVATED",
        version: policy.version,
        open: act.open,
      };
  }
  // Every input is validated here (review H05 m6): an activity is the store's exact record shape (canonical account,
  // decimal volume), a binding names two canonical accounts and an exact instant. Anything else is refused, never
  // repaired.
  const activities = input.activities.map((e) => {
    const parsed = verifiedActivitySchema.parse(e);
    if (parsed.account !== e.account)
      throw Error("VOLUME_ACCOUNT_NOT_CANONICAL");
    return parsed;
  });
  const bindings = (input.bindings ?? []).map((b) => {
    if (
      normalizeAccount(b.child) !== b.child ||
      normalizeAccount(b.parent) !== b.parent ||
      !isoInstant.safeParse(b.effectiveAt).success
    )
      throw Error("VOLUME_BINDING_INVALID");
    return b;
  });
  const perPoint = BigInt(policy.usdMicrosPerPoint);
  const dayCap =
    policy.eligibility.maxVolumeUsdMicrosPerAccountPerDay === null
      ? null
      : BigInt(policy.eligibility.maxVolumeUsdMicrosPerAccountPerDay);
  // The accepted lifetime ledger decides which records count. It is run with a marker rate of one unit per activity
  // and without bindings (commissions are derived from points below), so its eligibility, duplicate, conflict,
  // finality, exclusion, daily-cap, minimum-volume and reversal rules apply here exactly as accepted.
  const gate = computeLedger({
    policy: lifetimePolicySchema.parse({
      version: "lt-volume-gate",
      status: policy.status,
      ...(policy.approval ? { approval: policy.approval } : {}),
      rates: { SWAP: "1", TRADE: "1", BRIDGE: "1" },
      tasks: [],
      signupUnits: "0",
      eligibility: {
        minVolumeUsdMicros: policy.eligibility.minVolumeUsdMicros,
        maxActivitiesPerAccountPerDay:
          policy.eligibility.maxActivitiesPerAccountPerDay,
      },
      referral: policy.referral,
      effectiveFrom: policy.effectiveFrom,
      retroactivity: policy.retroactivity,
      legacyWeeklyConversion: policy.legacyWeeklyConversion,
    }),
    activities,
    reversals: input.reversals,
    exclusions: input.exclusions,
    asOf: input.asOf,
  });
  if (gate.state !== "COMPUTED") throw Error("VOLUME_GATE_NOT_COMPUTED");
  // An event id names one volume: conflicting variants were rejected by the gate, and the confirmation count is the
  // only field identical events may differ in.
  const volumeOf = new Map<string, bigint>();
  for (const e of activities)
    if (!volumeOf.has(e.eventId))
      volumeOf.set(e.eventId, BigInt(e.volumeUsdMicros));

  // No prototype: an account string is only ever a key.
  const accounts: Record<string, VolumeTotals> = Object.create(null);
  const totals = (account: string) => (accounts[account] ??= zero());
  const bump = (
    account: string,
    field: "pendingUsdMicros" | "reversedUsdMicros",
    v: bigint,
  ) => {
    const t = totals(account);
    t[field] = (BigInt(t[field]) + v).toString();
  };
  const lines: VolumeLine[] = [];
  const cumulative = new Map<string, bigint>();
  const perDayVolume = new Map<string, bigint>();
  // Whole points each counted activity completed, for the referral commission.
  const awarded: { account: string; occurredAt: string; points: bigint }[] = [];
  // The gate's activity lines are already in deterministic order (time, then event id).
  for (const l of gate.lines) {
    if (l.kind !== "ACTIVITY") continue;
    // The variants of a conflicting event disagree about the volume: none is reported.
    const volume =
      l.reason === "EVENT_CONFLICT" ? 0n : (volumeOf.get(l.ref) ?? 0n);
    const line: VolumeLine = {
      ref: l.ref,
      account: l.account,
      category: l.category,
      occurredAt: l.occurredAt,
      status: l.status,
      ...(l.reason ? { reason: l.reason } : {}),
      volumeUsdMicros: volume.toString(),
    };
    if (l.status === "EARNED") {
      // The daily volume cap: only what still fits into the account's UTC day counts.
      const dayKey = `${l.account}\u0000${l.occurredAt.slice(0, 10)}`;
      const used = perDayVolume.get(dayKey) ?? 0n;
      const counted =
        dayCap === null || volume <= dayCap - used
          ? volume
          : dayCap > used
            ? dayCap - used
            : 0n;
      perDayVolume.set(dayKey, used + counted);
      line.countedUsdMicros = counted.toString();
      const before = cumulative.get(l.account) ?? 0n;
      const after = before + counted;
      cumulative.set(l.account, after);
      const points = after / perPoint - before / perPoint;
      line.cumulativeUsdMicros = after.toString();
      line.points = points.toString();
      awarded.push({ account: l.account, occurredAt: l.occurredAt, points });
      totals(l.account);
    } else if (l.status === "PENDING")
      bump(l.account, "pendingUsdMicros", volume);
    else if (l.status === "REVERSED")
      bump(l.account, "reversedUsdMicros", volume);
    lines.push(line);
  }
  for (const [account, counted] of cumulative) {
    const t = totals(account);
    const carry = counted % perPoint;
    t.countedUsdMicros = counted.toString();
    t.points = (counted / perPoint).toString();
    t.carryUsdMicros = carry.toString();
    t.toNextPointUsdMicros = (perPoint - carry).toString();
  }

  // Referral: one binding per invited account (the earliest), never to itself and never back to its own invitee, as
  // in the lifetime ledger. The commission is 10% of the whole points the invited account's activities completed from
  // the binding's effective time on, while the referrer was not excluded. Commission is never volume, so it can never
  // become a base for another commission.
  // The same order as the lifetime ledger: effective time, then the invited account, then canonical content (keys
  // sorted), so one input gives one binding whichever way it is passed. A point is "completed" by the activity that
  // crosses its 100 USD threshold: when that activity is at or after the binding, the whole point is shared, even if
  // most of its volume came earlier (bounded to one point per binding; stated in the admin inspector).
  const content = (b: ReferralBinding) =>
    JSON.stringify(
      Object.keys(b)
        .sort()
        .map((k) => [k, (b as unknown as Record<string, unknown>)[k]]),
    );
  const parentOf = new Map<string, ReferralBinding>();
  for (const b of [...bindings].sort(
    (x, y) =>
      Date.parse(x.effectiveAt) - Date.parse(y.effectiveAt) ||
      (x.child < y.child ? -1 : x.child > y.child ? 1 : 0) ||
      (content(x) < content(y) ? -1 : content(x) > content(y) ? 1 : 0),
  ))
    if (
      !parentOf.has(b.child) &&
      b.child !== b.parent &&
      parentOf.get(b.parent)?.parent !== b.child
    )
      parentOf.set(b.child, b);
  const periods = (input.exclusions ?? []).map((x) => ({
    account: normalizeAccount(x.account),
    from: Date.parse(x.from),
    until:
      x.until === undefined || x.until === null
        ? Infinity
        : Date.parse(x.until),
  }));
  const excludedAt = (account: string, iso: string) => {
    const t = Date.parse(iso);
    return periods.some(
      (x) => x.account === account && x.from <= t && t < x.until,
    );
  };
  for (const a of awarded) {
    const b = parentOf.get(a.account);
    if (
      !b ||
      a.points === 0n ||
      Date.parse(a.occurredAt) < Date.parse(b.effectiveAt) ||
      excludedAt(b.parent, a.occurredAt)
    )
      continue;
    const t = totals(b.parent);
    t.referralUnits = (
      BigInt(t.referralUnits) +
      (a.points * UNITS_PER_POINT * BigInt(LIFETIME_REFERRAL_BPS)) / BPS
    ).toString();
  }
  for (const t of Object.values(accounts))
    t.totalUnits = (
      BigInt(t.points) * UNITS_PER_POINT +
      BigInt(t.referralUnits)
    ).toString();
  return {
    state: "COMPUTED",
    version: policy.version,
    fixture: policy.status === "FIXTURE_ONLY",
    usdMicrosPerPoint: policy.usdMicrosPerPoint,
    lines,
    accounts,
  };
}

/** Only the requesting account's own totals and activity lines: no other account, no rank, no global sum; the referral
 * commission appears only as one sum (the invited account's activity and its timing stay private); a reversal shows
 * a code, never the internal review note. */
export function ownVolumeView(result: VolumeResult, requested: string) {
  if (result.state !== "COMPUTED")
    return { state: result.state, version: result.version } as const;
  const account = /^0x[0-9a-fA-F]{40}$/.test(requested)
    ? requested.toLowerCase()
    : requested;
  return {
    state: result.state,
    version: result.version,
    fixture: result.fixture,
    usdMicrosPerPoint: result.usdMicrosPerPoint,
    totals: Object.hasOwn(result.accounts, account)
      ? result.accounts[account]
      : zero(),
    lines: result.lines
      .filter((l) => l.account === account)
      .map((l) => (l.status === "REVERSED" ? { ...l, reason: "REVERSED" } : l)),
  } as const;
}
