// gf1 G06 lifetime personal points (isolated engineering only): the registered policy awards nothing until the owner
// decides; with SAMPLE (fixture-only) numbers the ledger is idempotent, order-independent, exact (bigint, floor), pays
// 10% of the invited user's activity points one level deep, honours finality, reversals, exclusions (from the time they
// were set), the effective start, the version in effect when an activity happened, minimum volume and daily cap, never
// pays signup points, and shows a user only their own points. SYNTHETIC_TEST_ONLY data.
import { describe, expect, it } from "vitest";
import type { ReferralBinding, VerifiedActivity } from "../../src/points/model";
import {
  LIFETIME_REFERRAL_BPS,
  REGISTERED_LIFETIME_POLICY,
  activation,
  lifetimePolicySchema,
  type LifetimePolicy,
} from "../../src/lifetime-points/policy";
import {
  computeLedger,
  ownView,
  type ExclusionPeriod,
  type LedgerResult,
  type TaskAward,
} from "../../src/lifetime-points/ledger";
import { SAMPLE_ACCOUNT, SAMPLE_INPUT } from "../../src/lifetime-points/sample";

const A = "0x" + "a".repeat(40),
  B = "0x" + "b".repeat(40),
  C = "0x" + "c".repeat(40),
  D = "0x" + "d".repeat(40);
const POINT = 1_000_000n;
/** SAMPLE numbers for tests only: they are not the owner's rates. */
const FIXTURE: LifetimePolicy = lifetimePolicySchema.parse({
  version: "lt-fixture.1",
  status: "FIXTURE_ONLY",
  rates: { SWAP: "5000000", TRADE: "5000005", BRIDGE: "8000000" },
  tasks: [{ taskId: "task-first-bridge", units: "3000000", maxPerAccount: 1 }],
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
let n = 0;
function activity(
  account: string,
  over: Partial<VerifiedActivity> = {},
): VerifiedActivity {
  n++;
  const category = over.category ?? "SWAP";
  return {
    eventId: `ev-${n}`,
    verifier: "fixture-verifier",
    category,
    operationKey: `evm:1:0x${n.toString(16).padStart(64, "0")}`,
    account,
    outcome: category === "BRIDGE" ? "COMPLETED" : "SETTLED",
    occurredAt: `2027-01-0${1 + (n % 8)}T10:00:00Z`,
    chainId: "1",
    volumeUsdMicros: "1000000",
    finality: {
      blockNumber: String(1000 + n),
      blockHash: `hash${n}`.padEnd(16, "0"),
      confirmations: 64,
      finalized: true,
    },
    ...(category === "BRIDGE"
      ? {
          bridge: {
            destinationChainId: "8453",
            destinationTx: `dest${n}`.padEnd(16, "0"),
            destinationVerified: true,
          },
        }
      : {}),
    ...over,
  } as VerifiedActivity;
}
const bind = (
  child: string,
  parent: string,
  at = "2027-01-01T00:00:00Z",
): ReferralBinding => ({
  child,
  parent,
  code: "ABCDEFGH",
  bindingEventId: "bind-" + child.slice(2, 6),
  effectiveAt: at,
  createdAt: at,
});
const exclude = (
  account: string,
  from = "2027-01-01T00:00:00Z",
  until: string | null = null,
): ExclusionPeriod => ({ account, from, until });
const computed = (r: LedgerResult) => {
  if (r.state !== "COMPUTED") throw Error("not computed");
  return r;
};
const total = (r: LedgerResult, account: string) =>
  BigInt(computed(r).accounts[account]?.totalUnits ?? "0");
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    Object.values(v).forEach(deepFreeze);
    Object.freeze(v);
  }
  return v;
};

describe("gf1 G06 policy: nothing is invented", () => {
  it("the registered policy is the owner's structure without numbers and awards nothing", () => {
    expect(lifetimePolicySchema.parse(REGISTERED_LIFETIME_POLICY)).toEqual(
      REGISTERED_LIFETIME_POLICY,
    );
    expect(REGISTERED_LIFETIME_POLICY.status).toBe("PENDING_OWNER_POLICY");
    expect(REGISTERED_LIFETIME_POLICY.signupUnits).toBe("0");
    expect(REGISTERED_LIFETIME_POLICY.referral).toEqual({
      commissionBps: LIFETIME_REFERRAL_BPS,
      depth: 1,
      base: "ACTIVITY",
    });
    expect(LIFETIME_REFERRAL_BPS).toBe(1000);
    const r = computeLedger({
      policy: REGISTERED_LIFETIME_POLICY,
      activities: [activity(A), activity(B, { category: "BRIDGE" })],
      bindings: [bind(B, A)],
    });
    expect(r).toEqual({
      state: "PENDING_OWNER_POLICY",
      version: "lt-pending.1",
      missing: [
        "rate.SWAP",
        "rate.TRADE",
        "rate.BRIDGE",
        "eligibility.minVolume",
        "eligibility.dailyCap",
        "effectiveFrom",
        "retroactivity",
        "legacyWeeklyConversion",
      ],
    });
    expect(ownView(r, A)).toEqual({
      state: "PENDING_OWNER_POLICY",
      version: "lt-pending.1",
    });
  });
  it("refuses a policy that would silently change the owner's rules or pretend to be decided", () => {
    const base = { ...FIXTURE } as Record<string, unknown>;
    const bad: [string, Record<string, unknown>][] = [
      ["signup points", { ...base, signupUnits: "1000000" }],
      [
        "another referral rate",
        {
          ...base,
          referral: { commissionBps: 1500, depth: 1, base: "ACTIVITY" },
        },
      ],
      [
        "commission on commission",
        {
          ...base,
          referral: { commissionBps: 1000, depth: 2, base: "ACTIVITY" },
        },
      ],
      [
        "commission on tasks",
        { ...base, referral: { commissionBps: 1000, depth: 1, base: "ALL" } },
      ],
      [
        "pending with numbers",
        {
          ...REGISTERED_LIFETIME_POLICY,
          rates: { SWAP: "1", TRADE: null, BRIDGE: null },
        },
      ],
      ["approved without approval", { ...base, status: "OWNER_APPROVED" }],
      [
        "approved without eligibility",
        {
          ...base,
          status: "OWNER_APPROVED",
          eligibility: {
            minVolumeUsdMicros: null,
            maxActivitiesPerAccountPerDay: 50,
          },
          approval: {
            approvedBy: "owner",
            approvedAt: "2027-01-01T00:00:00Z",
            reference: "x",
          },
        },
      ],
      [
        "pending with an eligibility number",
        {
          ...REGISTERED_LIFETIME_POLICY,
          eligibility: {
            minVolumeUsdMicros: "1",
            maxActivitiesPerAccountPerDay: null,
          },
        },
      ],
      [
        "eligibility missing",
        Object.fromEntries(
          Object.entries(base).filter(([k]) => k !== "eligibility"),
        ),
      ],
      [
        "approved without retroactivity",
        {
          ...base,
          status: "OWNER_APPROVED",
          retroactivity: "PENDING_OWNER_DECISION",
          approval: {
            approvedBy: "owner",
            approvedAt: "2027-01-01T00:00:00Z",
            reference: "x",
          },
        },
      ],
      [
        "fractional units",
        { ...base, rates: { SWAP: "1.5", TRADE: "1", BRIDGE: "1" } },
      ],
      [
        "negative units",
        { ...base, rates: { SWAP: "-1", TRADE: "1", BRIDGE: "1" } },
      ],
      ["unknown member", { ...base, airdrop: true }],
      [
        "legacy conversion invented",
        { ...base, legacyWeeklyConversion: "ONE_TO_ONE" },
      ],
    ];
    for (const [name, p] of bad)
      expect(lifetimePolicySchema.safeParse(p).success, name).toBe(false);
  });
  it("each refusal says what is missing (review m13, m2)", () => {
    const approval = {
      approvedBy: "owner",
      approvedAt: "2027-01-01T00:00:00Z",
      reference: "x",
    };
    const ok = { ...FIXTURE, status: "OWNER_APPROVED", approval };
    const cases: [string, Record<string, unknown>][] = [
      ["RATE_MISSING", { ...ok, rates: { ...FIXTURE.rates, TRADE: null } }],
      ["EFFECTIVE_FROM_MISSING", { ...ok, effectiveFrom: null }],
      // A pending policy cannot pre-fill a decision without approval (review-2 mn1).
      [
        "PENDING_WITH_DECISIONS",
        {
          ...REGISTERED_LIFETIME_POLICY,
          effectiveFrom: "2020-01-01T00:00:00Z",
          retroactivity: "FROM_EFFECTIVE_DATE",
          legacyWeeklyConversion: "NONE",
        },
      ],
      [
        "PENDING_WITH_DECISIONS",
        { ...REGISTERED_LIFETIME_POLICY, legacyWeeklyConversion: "NONE" },
      ],
      ["FIXTURE_WITH_APPROVAL", { ...FIXTURE, approval }],
      ["PENDING_WITH_APPROVAL", { ...REGISTERED_LIFETIME_POLICY, approval }],
      [
        "TASK_DUPLICATE",
        { ...FIXTURE, tasks: [FIXTURE.tasks[0], FIXTURE.tasks[0]] },
      ],
      [
        "ELIGIBILITY_MISSING",
        {
          ...ok,
          eligibility: {
            minVolumeUsdMicros: "1",
            maxActivitiesPerAccountPerDay: null,
          },
        },
      ],
      // NONE means nothing before the approval counts: an earlier start needs the explicit FROM_EFFECTIVE_DATE.
      [
        "RETROACTIVE_START_WITHOUT_DECISION",
        {
          ...ok,
          approval: { ...approval, approvedAt: "2027-02-01T00:00:00Z" },
        },
      ],
    ];
    for (const [code, p] of cases) {
      const r = lifetimePolicySchema.safeParse(p);
      expect(r.success, code).toBe(false);
      expect(
        r.error?.issues.map((i) => i.message),
        code,
      ).toContain(code);
    }
    expect(
      lifetimePolicySchema.safeParse({
        ...ok,
        retroactivity: "FROM_EFFECTIVE_DATE",
        approval: { ...approval, approvedAt: "2027-02-01T00:00:00Z" },
      }).success,
    ).toBe(true);
  });
  it("an approved policy still is not an activation", () => {
    const approved = lifetimePolicySchema.parse({
      ...FIXTURE,
      status: "OWNER_APPROVED",
      approval: {
        approvedBy: "owner",
        approvedAt: "2027-01-01T00:00:00Z",
        reference: "ref",
      },
    });
    expect(activation(approved)).toEqual({
      state: "APPROVED_NOT_ACTIVATED",
      open: [],
    });
    expect(activation(FIXTURE)).toEqual({ state: "FIXTURE_ONLY" });
    // Approving the rates does not force a decision on earlier weekly points: it stays open (review-2 m2).
    const open = lifetimePolicySchema.parse({
      ...approved,
      legacyWeeklyConversion: "PENDING_OWNER_DECISION",
    });
    expect(activation(open)).toEqual({
      state: "APPROVED_NOT_ACTIVATED",
      open: ["legacyWeeklyConversion"],
    });
  });
});

describe("gf1 G06 ledger with SAMPLE numbers (fixture only)", () => {
  it("fixed points per eligible verified activity, by category; results say they are fixture data", () => {
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [
          activity(A),
          activity(A, { category: "TRADE" }),
          activity(A, { category: "BRIDGE" }),
        ],
      }),
    );
    expect(r.fixture).toBe(true);
    expect(r.accounts[A]).toEqual({
      activityUnits: (5_000_000n + 5_000_005n + 8_000_000n).toString(),
      taskUnits: "0",
      referralUnits: "0",
      totalUnits: (5_000_000n + 5_000_005n + 8_000_000n).toString(),
      pendingUnits: "0",
      reversedUnits: "0",
    });
  });
  it("no signup or welcome points: an account with only a referral binding has nothing", () => {
    const r = computeLedger({
      policy: FIXTURE,
      activities: [],
      bindings: [bind(B, A)],
    });
    expect(computed(r).accounts).toEqual({});
    expect(ownView(r, B)).toMatchObject({
      totals: { totalUnits: "0" },
      lines: [],
    });
  });
  it("idempotent: a repeated event counts once; a conflicting event earns nothing; one operation counts once", () => {
    const e = activity(A);
    const twice = computeLedger({ policy: FIXTURE, activities: [e, { ...e }] });
    expect(total(twice, A)).toBe(5n * POINT);
    const conflict = computeLedger({
      policy: FIXTURE,
      activities: [e, { ...e, volumeUsdMicros: "999" }],
    });
    expect(total(conflict, A)).toBe(0n);
    expect(computed(conflict).lines).toContainEqual(
      expect.objectContaining({
        ref: e.eventId,
        status: "REJECTED",
        reason: "EVENT_CONFLICT",
      }),
    );
    // The same settlement reported again as a TRADE under another eventId is the same operation.
    const again = activity(A, {
      category: "TRADE",
      operationKey: e.operationKey,
      occurredAt: "2027-01-09T10:00:00Z",
    });
    const dup = computeLedger({ policy: FIXTURE, activities: [e, again] });
    expect(total(dup, A)).toBe(5n * POINT);
    expect(
      computed(dup).lines.find((l) => l.ref === again.eventId)?.reason,
    ).toBe("OPERATION_DUPLICATE");
  });
  it("order-independent: any input order gives the same lines and totals", () => {
    const events = [
      activity(A),
      activity(B, { category: "BRIDGE" }),
      activity(B),
      activity(C, { category: "TRADE" }),
      activity(A, { outcome: "PENDING" }),
    ];
    const bindings = [bind(B, A), bind(C, B)];
    const reversals = [
      {
        reversalId: "rv-1",
        ref: events[2].eventId,
        at: "2027-01-20T00:00:00Z",
        reason: "REORG",
      },
    ];
    // Time ties, a conflicting record, a duplicate operation and task awards in the same run.
    const tie = "2027-01-04T10:00:00Z";
    events.push(
      activity(D, { occurredAt: tie }),
      activity(D, { occurredAt: tie, category: "TRADE" }),
      { ...events[0], volumeUsdMicros: "2000000" },
      activity(C, { operationKey: events[3].operationKey }),
    );
    const taskAwards: TaskAward[] = [
      {
        awardId: "aw-x",
        taskId: "task-first-bridge",
        account: D,
        occurredAt: tie,
        approved: true,
      },
      {
        awardId: "aw-y",
        taskId: "task-first-bridge",
        account: D,
        occurredAt: tie,
        approved: true,
      },
    ];
    const one = computeLedger({
      policy: FIXTURE,
      activities: events,
      bindings,
      reversals,
      taskAwards,
    });
    const two = computeLedger({
      policy: FIXTURE,
      activities: [...events].reverse(),
      bindings: [...bindings].reverse(),
      reversals: [...reversals].reverse(),
      taskAwards: [...taskAwards].reverse(),
    });
    expect(two).toEqual(one);
    expect(computed(one).lines.map((l) => l.reason)).toContain(
      "EVENT_CONFLICT",
    );
  });
  it("referral: exactly floor(10%) of the invited user's activity points, one level, never on tasks", () => {
    // C invited by B, B invited by A. C trades (5.000005 points): B earns floor(10%) = 0.5 point (500000 units, the
    // 0.5 unit is dropped); A earns nothing from B's commission (no commission on commission).
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [activity(C, { category: "TRADE" }), activity(B)],
        taskAwards: [
          {
            awardId: "aw-1",
            taskId: "task-first-bridge",
            account: C,
            occurredAt: "2027-01-03T00:00:00Z",
            approved: true,
          },
        ],
        bindings: [bind(C, B), bind(B, A)],
      }),
    );
    expect(r.accounts[B].referralUnits).toBe("500000");
    expect(r.accounts[C].taskUnits).toBe("3000000");
    // A: 10% of B's own SWAP only (5 points → 0.5 point), nothing of B's commission or C's task.
    expect(r.accounts[A].referralUnits).toBe("500000");
    expect(r.accounts[A].totalUnits).toBe("500000");
    for (const [k, v] of Object.entries(r.accounts))
      expect(BigInt(v.totalUnits), k).toBe(
        BigInt(v.activityUnits) + BigInt(v.taskUnits) + BigInt(v.referralUnits),
      );
  });
  it("referral abuse: self-referral, a second binding and activity before the binding earn no commission", () => {
    const early = activity(B, { occurredAt: "2027-01-01T05:00:00Z" });
    const later = activity(B, { occurredAt: "2027-01-05T05:00:00Z" });
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [early, later, activity(D)],
        bindings: [
          bind(B, A, "2027-01-02T00:00:00Z"),
          bind(B, C, "2027-01-03T00:00:00Z"),
          bind(D, D),
        ],
      }),
    );
    expect(r.accounts[A].referralUnits).toBe("500000"); // only `later`
    expect(r.accounts[C]).toBeUndefined();
    expect(r.accounts[D].referralUnits).toBe("0");
  });
  it("finality: pending, failed, reverted, quotes and unverified bridges never count as earned", () => {
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [
          activity(A, { outcome: "PENDING" }),
          activity(A, {
            finality: {
              blockNumber: "1",
              blockHash: "h".repeat(16),
              confirmations: 1,
              finalized: false,
            },
          }),
          activity(A, { outcome: "FAILED" }),
          activity(A, { outcome: "REVERTED" }),
          activity(A, { outcome: "QUOTE" }),
          activity(A, { outcome: "UNSIGNED_INTENT" }),
          { ...activity(A, { category: "BRIDGE" }), bridge: undefined },
          // Not final yet and no destination record: still missing, never pending (review-2 n6).
          {
            ...activity(A, {
              category: "BRIDGE",
              finality: {
                blockNumber: "2",
                blockHash: "i".repeat(16),
                confirmations: 1,
                finalized: false,
              },
            }),
            bridge: undefined,
          },
          activity(A, {
            category: "BRIDGE",
            bridge: {
              destinationChainId: "8453",
              destinationTx: "x".repeat(16),
              destinationVerified: false,
            },
          }),
        ],
      }),
    );
    expect(r.accounts[A].totalUnits).toBe("0");
    expect(r.accounts[A].pendingUnits).toBe(
      (5n * POINT * 2n + 8n * POINT).toString(),
    );
    expect(
      r.lines
        .filter((l) => l.status === "REJECTED")
        .map((l) => l.reason)
        .sort(),
    ).toEqual([
      "BRIDGE_DESTINATION_MISSING",
      "BRIDGE_DESTINATION_MISSING",
      "OUTCOME_FAILED",
      "OUTCOME_QUOTE",
      "OUTCOME_REVERTED",
      "OUTCOME_UNSIGNED_INTENT",
    ]);
  });
  it("reversal removes the activity and its commission, keeps both lines for the audit, and repeats harmlessly", () => {
    const e = activity(B);
    const reversals = [
      {
        reversalId: "rv-1",
        ref: e.eventId,
        at: "2027-01-20T00:00:00Z",
        reason: "REORG",
      },
      {
        reversalId: "rv-2",
        ref: e.eventId,
        at: "2027-01-21T00:00:00Z",
        reason: "REORG",
      },
      {
        reversalId: "rv-3",
        ref: "ev-unknown",
        at: "2027-01-21T00:00:00Z",
        reason: "TYPO",
      },
    ];
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [e],
        bindings: [bind(B, A)],
        reversals,
      }),
    );
    expect(r.accounts[B]).toMatchObject({
      totalUnits: "0",
      reversedUnits: "5000000",
    });
    expect(r.accounts[A]).toMatchObject({
      totalUnits: "0",
      reversedUnits: "500000",
    });
    expect(r.lines.filter((l) => l.status === "REVERSED")).toHaveLength(2);
    expect(r.lines).toContainEqual(
      expect.objectContaining({ ref: "rv-3", reason: "REVERSAL_UNKNOWN_REF" }),
    );
  });
  it("excluded accounts earn nothing and pay no commission; their referrer gets nothing from them", () => {
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [activity(B), activity(C)],
        bindings: [bind(B, A), bind(C, D)],
        exclusions: [exclude(B), exclude(D)],
      }),
    );
    expect(r.accounts[B]).toBeUndefined();
    expect(r.accounts[A]).toBeUndefined();
    expect(r.accounts[C].totalUnits).toBe("5000000");
    expect(r.accounts[D]).toBeUndefined();
  });
  it("the effective start: earlier activity and tasks earn nothing (no silent retroactivity)", () => {
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [activity(A, { occurredAt: "2026-12-31T23:59:59Z" })],
        taskAwards: [
          {
            awardId: "aw-0",
            taskId: "task-first-bridge",
            account: A,
            occurredAt: "2026-12-31T00:00:00Z",
            approved: true,
          },
        ],
      }),
    );
    expect(r.accounts).toEqual({});
    expect(r.lines.map((l) => l.reason)).toEqual([
      "BEFORE_EFFECTIVE_FROM",
      "BEFORE_EFFECTIVE_FROM",
    ]);
  });
  it("tasks: owner-defined only, approved only, within the per-account limit, idempotent by award", () => {
    const aw = (awardId: string, over: Partial<TaskAward> = {}): TaskAward => ({
      awardId,
      taskId: "task-first-bridge",
      account: A,
      occurredAt: "2027-01-02T00:00:00Z",
      approved: true,
      ...over,
    });
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [],
        taskAwards: [
          aw("a1"),
          aw("a1"),
          aw("a2"),
          aw("a3", { approved: false }),
          aw("a4", { taskId: "task-unknown" }),
        ],
      }),
    );
    expect(r.accounts[A].taskUnits).toBe("3000000");
    expect(r.lines.map((l) => l.reason ?? l.status)).toEqual([
      "EARNED",
      "TASK_LIMIT",
      "TASK_NOT_APPROVED",
      "TASK_UNKNOWN",
    ]);
  });
  it("a rate change is a new version: earlier activity keeps the rate in effect when it happened (review M1)", () => {
    const v2 = lifetimePolicySchema.parse({
      ...FIXTURE,
      version: "lt-fixture.2",
      rates: { SWAP: "7000000", TRADE: "5000005", BRIDGE: "8000000" },
      effectiveFrom: "2027-01-05T00:00:00Z",
    });
    const before = activity(A, { occurredAt: "2027-01-03T00:00:00Z" });
    const after = activity(A, { occurredAt: "2027-01-06T00:00:00Z" });
    const r = computed(
      computeLedger({
        policy: v2,
        history: [FIXTURE],
        activities: [before, after],
      }),
    );
    // Each priced line names the version that priced it.
    expect(r.lines.map((l) => [l.ref, l.units, l.version])).toEqual([
      [before.eventId, "5000000", "lt-fixture.1"],
      [after.eventId, "7000000", "lt-fixture.2"],
    ]);
    // Without its history, the new version does not reach back (no silent retroactivity).
    const alone = computed(
      computeLedger({ policy: v2, activities: [before, after] }),
    );
    expect(alone.lines.map((l) => l.reason ?? l.units)).toEqual([
      "BEFORE_EFFECTIVE_FROM",
      "7000000",
    ]);
    // Sample numbers never mix with approved ones, and two versions cannot start at the same instant.
    const approved = lifetimePolicySchema.parse({
      ...v2,
      status: "OWNER_APPROVED",
      approval: {
        approvedBy: "owner",
        approvedAt: "2027-01-01T00:00:00Z",
        reference: "r",
      },
    });
    expect(() =>
      computeLedger({
        policy: approved,
        history: [FIXTURE],
        activities: [],
        asOf: "2027-02-01T00:00:00Z",
      }),
    ).toThrow("LIFETIME_HISTORY_STATUS_MISMATCH");
    expect(() =>
      computeLedger({
        policy: v2,
        history: [{ ...FIXTURE, effectiveFrom: v2.effectiveFrom }],
        activities: [],
      }),
    ).toThrow("LIFETIME_HISTORY_AMBIGUOUS");
    // The same instant written two ways is the same start (review-2 mn3).
    expect(() =>
      computeLedger({
        policy: v2,
        history: [{ ...FIXTURE, effectiveFrom: "2027-01-05T00:00:00.000Z" }],
        activities: [],
      }),
    ).toThrow("LIFETIME_HISTORY_AMBIGUOUS");
    // The current policy is the latest version: passing them the other way round is refused, not silently re-priced.
    expect(() =>
      computeLedger({ policy: FIXTURE, history: [v2], activities: [before] }),
    ).toThrow("LIFETIME_HISTORY_NOT_LATEST");
  });
  it("an exclusion applies only within its decided period: earlier and later earned points stay (no silent clawback)", () => {
    const early = activity(B, { occurredAt: "2027-01-03T00:00:00Z" });
    const during = activity(B, { occurredAt: "2027-01-06T00:00:00Z" });
    const after = activity(B, { occurredAt: "2027-01-09T00:00:00Z" });
    const period = exclude(B, "2027-01-05T00:00:00Z", "2027-01-08T00:00:00Z");
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [early, during, after],
        bindings: [bind(B, A)],
        exclusions: [period],
      }),
    );
    expect(r.accounts[B].totalUnits).toBe("10000000");
    expect(r.accounts[A].referralUnits).toBe("1000000");
    expect(r.lines.map((l) => l.reason ?? l.status).slice(0, 3)).toEqual([
      "EARNED",
      "ACCOUNT_EXCLUDED",
      "EARNED",
    ]);
    // The period is the decided one (review-2 MJ1): recording the same decision again, for example with a new note,
    // is the same period and moves nothing; lifting it only ends the window from that time on.
    expect(
      computeLedger({
        policy: FIXTURE,
        activities: [early, during, after],
        bindings: [bind(B, A)],
        exclusions: [period, { ...period }],
      }),
    ).toEqual(r);
    const lifted = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [early, during, after],
        exclusions: [exclude(B, "2027-01-05T00:00:00Z")],
      }),
    );
    expect(lifted.accounts[B].totalUnits).toBe("5000000");
    // The same operation re-attributed to another account after the excluded record still counts once (review-2 n5).
    const moved = activity(C, {
      operationKey: during.operationKey,
      occurredAt: "2027-01-07T00:00:00Z",
    });
    const re = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [during, moved],
        exclusions: [period],
      }),
    );
    expect(re.accounts[C]).toBeUndefined();
    expect(re.lines.find((l) => l.ref === moved.eventId)?.reason).toBe(
      "OPERATION_DUPLICATE",
    );
  });
  it("operation ownership: the first record owns its operation; a reversal's text never changes that (review-3)", () => {
    // MN2: a reversal whose free text reads like a reason code changes nothing about who owns the operation.
    const x = activity(A, { occurredAt: "2027-01-03T00:00:00Z" });
    const y = activity(B, {
      operationKey: x.operationKey,
      occurredAt: "2027-01-04T00:00:00Z",
    });
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [x, y],
        reversals: [
          {
            reversalId: "rv-text",
            ref: x.eventId,
            at: "2027-01-05T00:00:00Z",
            reason: "OPERATION_DUPLICATE",
          },
        ],
      }),
    );
    expect(r.accounts[B]).toBeUndefined();
    expect(r.lines.find((l) => l.ref === y.eventId)?.reason).toBe(
      "OPERATION_DUPLICATE",
    );
    // NT1: an earned record wins over a pending one only for the same account; across accounts the first record owns.
    const first = activity(A, {
      occurredAt: "2027-01-03T00:00:00Z",
      finality: {
        blockNumber: "9",
        blockHash: "j".repeat(16),
        confirmations: 1,
        finalized: false,
      },
    });
    const other = activity(B, {
      operationKey: first.operationKey,
      occurredAt: "2027-01-04T00:00:00Z",
    });
    const own = computed(
      computeLedger({ policy: FIXTURE, activities: [other, first] }),
    );
    expect(own.lines.map((l) => [l.account, l.reason ?? l.status])).toEqual([
      [A, "PENDING"],
      [B, "OPERATION_DUPLICATE"],
    ]);
  });
  it("exclusion periods and the clock are validated: exact instants, ordered periods, canonical accounts (review-3 MN3)", () => {
    const bad: ExclusionPeriod[] = [
      exclude(B, "2027-01-05T00:00:00"),
      exclude(B, "2027-01-05T00:00:00Z", ""),
      exclude(B, "2027-01-05T00:00:00Z", "2027-01-04T00:00:00Z"),
      exclude("not-an-account"),
    ];
    for (const period of bad)
      expect(() =>
        computeLedger({
          policy: FIXTURE,
          activities: [],
          exclusions: [period],
        }),
      ).toThrow("LEDGER_EXCLUSION_INVALID");
    expect(() =>
      computeLedger({
        policy: FIXTURE,
        activities: [],
        asOf: "2027-01-05T00:00:00",
      }),
    ).toThrow("LEDGER_AS_OF_INVALID");
    // A mixed-case address is the same account.
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [activity(B)],
        exclusions: [exclude(B.toUpperCase().replace("0X", "0x"))],
      }),
    );
    expect(r.accounts[B]).toBeUndefined();
  });
  it("future timestamps earn nothing; an approved policy needs the clock (review-2 mn8)", () => {
    const now = "2027-01-04T12:00:00Z";
    const soon = activity(A, { occurredAt: "2027-01-04T12:04:00Z" });
    const later = activity(A, { occurredAt: "2027-01-04T12:06:00Z" });
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [soon, later],
        taskAwards: [
          {
            awardId: "aw-future",
            taskId: "task-first-bridge",
            account: A,
            occurredAt: "2027-01-05T00:00:00Z",
            approved: true,
          },
        ],
        asOf: now,
      }),
    );
    expect(r.lines.map((l) => l.reason ?? l.status)).toEqual([
      "EARNED",
      "FUTURE_TIMESTAMP",
      "FUTURE_TIMESTAMP",
    ]);
    const approved = lifetimePolicySchema.parse({
      ...FIXTURE,
      status: "OWNER_APPROVED",
      approval: {
        approvedBy: "owner",
        approvedAt: "2027-01-01T00:00:00Z",
        reference: "r",
      },
    });
    expect(() => computeLedger({ policy: approved, activities: [] })).toThrow(
      "LEDGER_AS_OF_REQUIRED",
    );
    expect(() =>
      computeLedger({ policy: FIXTURE, activities: [], asOf: "not a time" }),
    ).toThrow("LEDGER_AS_OF_INVALID");
  });
  it("eligibility (review M2): below the minimum volume earns nothing; the daily cap counts in time order", () => {
    const capped = lifetimePolicySchema.parse({
      ...FIXTURE,
      eligibility: {
        minVolumeUsdMicros: "1000000",
        maxActivitiesPerAccountPerDay: 2,
      },
    });
    const day = (h: number, over: Partial<VerifiedActivity> = {}) =>
      activity(A, {
        occurredAt: `2027-01-04T${String(h).padStart(2, "0")}:00:00Z`,
        ...over,
      });
    const small = day(1, { volumeUsdMicros: "999999" });
    const failed = day(2, { outcome: "FAILED" });
    const first = day(3);
    const pending = day(4, { outcome: "PENDING" });
    const third = day(5);
    const nextDay = activity(A, { occurredAt: "2027-01-05T00:00:00Z" });
    const r = computed(
      computeLedger({
        policy: capped,
        activities: [third, nextDay, pending, first, failed, small],
      }),
    );
    expect(r.lines.map((l) => l.reason ?? l.status)).toEqual([
      "BELOW_MIN_VOLUME",
      "OUTCOME_FAILED",
      "EARNED",
      "PENDING",
      "DAILY_CAP",
      "EARNED",
    ]);
    // A reversed activity holds no place (it never happened on chain): the next one earns (review-2 mn4).
    const e1 = day(6);
    const e2 = day(7);
    const e3 = day(8);
    const rev = computed(
      computeLedger({
        policy: capped,
        activities: [e1, e2, e3],
        reversals: [
          {
            reversalId: "rv-cap",
            ref: e1.eventId,
            at: "2027-01-04T09:00:00Z",
            reason: "REORG",
          },
        ],
      }),
    );
    expect(rev.lines.map((l) => l.reason ?? l.status)).toEqual([
      "REORG",
      "EARNED",
      "EARNED",
    ]);
  });
  it("a failed or reverted operation is never pending, whatever its finality flag (review M3)", () => {
    const unfinal = {
      blockNumber: "1",
      blockHash: "h".repeat(16),
      confirmations: 0,
      finalized: false,
    };
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [
          activity(A, { outcome: "FAILED", finality: unfinal }),
          activity(A, { outcome: "REVERTED", finality: unfinal }),
        ],
      }),
    );
    expect(r.accounts).toEqual({});
    expect(r.lines.map((l) => l.reason).sort()).toEqual([
      "OUTCOME_FAILED",
      "OUTCOME_REVERTED",
    ]);
  });
  it("deterministic tie-breaks: equal times and ids resolve the same way in any input order", () => {
    const same = "2027-01-01T00:00:00Z";
    const bindings = [bind(C, A, same), bind(C, B, same)];
    const events = [activity(C)];
    const one = computeLedger({
      policy: FIXTURE,
      activities: events,
      bindings,
    });
    const two = computeLedger({
      policy: FIXTURE,
      activities: events,
      bindings: [...bindings].reverse(),
    });
    expect(two).toEqual(one);
    const awards: TaskAward[] = [
      {
        awardId: "dup",
        taskId: "task-first-bridge",
        account: A,
        occurredAt: same,
        approved: false,
      },
      {
        awardId: "dup",
        taskId: "task-first-bridge",
        account: B,
        occurredAt: same,
        approved: false,
      },
    ];
    const forward = computeLedger({
      policy: FIXTURE,
      activities: [],
      taskAwards: awards,
    });
    expect(forward).toEqual(
      computeLedger({
        policy: FIXTURE,
        activities: [],
        taskAwards: [...awards].reverse(),
      }),
    );
    // Two different records under one awardId are a reported conflict that earns nothing (review-2 mn2); a repeated
    // identical award is one award.
    expect(computed(forward).lines).toEqual([
      expect.objectContaining({
        ref: "dup",
        status: "REJECTED",
        reason: "AWARD_CONFLICT",
      }),
    ]);
    const approved = { ...awards[0], approved: true };
    expect(
      computed(
        computeLedger({
          policy: FIXTURE,
          activities: [],
          taskAwards: [approved, { ...approved }],
        }),
      ).accounts[A].taskUnits,
    ).toBe("3000000");
    // Approval is one-way (review-3 NT4): a later approved record of the same award is the same award, in any order.
    for (const order of [
      [awards[0], approved],
      [approved, awards[0]],
    ])
      expect(
        computed(
          computeLedger({ policy: FIXTURE, activities: [], taskAwards: order }),
        ).accounts[A].taskUnits,
      ).toBe("3000000");
  });
  it("an unchecked policy object is refused (no other referral rate or signup points through the ledger)", () => {
    expect(() =>
      computeLedger({
        policy: { ...FIXTURE, signupUnits: "1" } as unknown as LifetimePolicy,
        activities: [],
      }),
    ).toThrow();
    expect(() =>
      computeLedger({
        policy: {
          ...FIXTURE,
          referral: { commissionBps: 2000, depth: 1, base: "ACTIVITY" },
        } as unknown as LifetimePolicy,
        activities: [],
      }),
    ).toThrow();
  });
  it("a later confirmation of the same event is the same event; an earned record of an operation wins (review m5)", () => {
    const pending = activity(A, {
      finality: {
        blockNumber: "7",
        blockHash: "b".repeat(16),
        confirmations: 2,
        finalized: false,
      },
    });
    const final = {
      ...pending,
      finality: { ...pending.finality, confirmations: 64, finalized: true },
    };
    for (const order of [
      [pending, final],
      [final, pending],
    ]) {
      const r = computed(computeLedger({ policy: FIXTURE, activities: order }));
      expect(r.lines).toEqual([
        expect.objectContaining({ ref: pending.eventId, status: "EARNED" }),
      ]);
    }
    // The same operation reported pending under one eventId earlier and earned under another later: it earns once.
    const early = activity(A, {
      outcome: "PENDING",
      occurredAt: "2027-01-02T00:00:00Z",
    });
    const late = activity(A, {
      operationKey: early.operationKey,
      occurredAt: "2027-01-03T00:00:00Z",
    });
    const r = computed(
      computeLedger({ policy: FIXTURE, activities: [early, late] }),
    );
    expect(r.accounts[A]).toMatchObject({
      totalUnits: "5000000",
      pendingUnits: "0",
    });
  });
  it("reversals that cannot apply are reported, never applied elsewhere (review m3)", () => {
    const e = activity(B);
    const p = activity(B, { outcome: "PENDING" });
    const shared = activity(A, { eventId: "shared-id" });
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [e, p, shared],
        taskAwards: [
          {
            awardId: "shared-id",
            taskId: "task-first-bridge",
            account: A,
            occurredAt: "2027-01-03T00:00:00Z",
            approved: true,
          },
        ],
        bindings: [bind(B, A)],
        reversals: [
          {
            reversalId: "rv-c",
            ref: `commission/${e.eventId}`,
            at: "2027-01-20T00:00:00Z",
            reason: "X",
          },
          {
            reversalId: "rv-p",
            ref: p.eventId,
            at: "2027-01-20T00:00:00Z",
            reason: "X",
          },
          {
            reversalId: "rv-s",
            ref: "shared-id",
            at: "2027-01-20T00:00:00Z",
            reason: "X",
          },
        ],
      }),
    );
    const report = Object.fromEntries(
      r.lines
        .filter((l) => l.kind === "REVERSAL")
        .map((l) => [l.ref, l.reason]),
    );
    expect(report).toEqual({
      "rv-c": "REVERSAL_NOT_APPLICABLE",
      "rv-p": "REVERSAL_NOT_APPLICABLE",
      "rv-s": "REVERSAL_AMBIGUOUS_REF",
    });
    // Nothing was reversed: B's activity and A's commission, A's activity and task all stand.
    expect(r.accounts[B]).toMatchObject({
      totalUnits: "5000000",
      reversedUnits: "0",
    });
    expect(r.accounts[A]).toMatchObject({
      activityUnits: "5000000",
      taskUnits: "3000000",
      referralUnits: "500000",
      reversedUnits: "0",
    });
  });
  it("a two-way referral pair is refused: the later binding back to one's own invitee earns nothing (review m4)", () => {
    const r = computed(
      computeLedger({
        policy: FIXTURE,
        activities: [activity(A), activity(B)],
        bindings: [
          bind(B, A, "2027-01-01T00:00:00Z"),
          bind(A, B, "2027-01-01T01:00:00Z"),
        ],
      }),
    );
    expect(r.accounts[A].referralUnits).toBe("500000");
    expect(r.accounts[B].referralUnits).toBe("0");
  });
  it("own view takes the canonical account (an EVM address in any case)", () => {
    const r = computeLedger({ policy: FIXTURE, activities: [activity(A)] });
    expect(ownView(r, A.toUpperCase().replace("0X", "0x"))).toEqual(
      ownView(r, A),
    );
  });
  it("never mutates its inputs (earlier records stay exactly as they are)", () => {
    const input = deepFreeze({
      policy: FIXTURE,
      activities: [activity(A), activity(B)],
      bindings: [bind(B, A)],
      reversals: [],
      exclusions: [],
    });
    const before = JSON.stringify(input);
    expect(() => computeLedger(input)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("gf1 G06 privacy: a user sees only their own points", () => {
  it("the labelled sample preview shows the documented sample totals (fixture data only)", () => {
    expect(ownView(computeLedger(SAMPLE_INPUT), SAMPLE_ACCOUNT)).toMatchObject({
      state: "COMPUTED",
      fixture: true,
      totals: {
        activityUnits: "25000000",
        taskUnits: "5000000",
        referralUnits: "1000000",
        totalUnits: "31000000",
        pendingUnits: "10000000",
        reversedUnits: "0",
      },
    });
  });
  it("own view: own totals and lines only, no other account, no rank, no global sum, no invitee identity", () => {
    const c = activity(C, { occurredAt: "2027-01-07T13:14:15Z" });
    const r = computeLedger({
      policy: FIXTURE,
      activities: [
        activity(A, { occurredAt: "2027-01-02T10:00:00Z" }),
        activity(B),
        c,
      ],
      bindings: [bind(C, A)],
    });
    const view = ownView(r, A);
    const json = JSON.stringify(view);
    for (const other of [B, C]) expect(json).not.toContain(other);
    expect(json).not.toContain(c.eventId);
    // Neither the invited user's event nor its timing: the commission is only part of the totals (review M4).
    expect(json).not.toContain(c.occurredAt);
    expect(json).not.toMatch(
      /rank|participants|pool|allocated|leader|commission/i,
    );
    expect(view).toMatchObject({
      state: "COMPUTED",
      fixture: true,
      totals: { totalUnits: "5500000", referralUnits: "500000" },
    });
    if (view.state === "COMPUTED")
      expect(view.lines.map((l) => l.kind)).toEqual(["ACTIVITY"]);
  });
  it("own view: an invitee's reversal does not show in the referrer's reversed total (review-2 mn5)", () => {
    const c = activity(C);
    const r = computeLedger({
      policy: FIXTURE,
      activities: [c],
      bindings: [bind(C, A)],
      reversals: [
        {
          reversalId: "rv-inv",
          ref: c.eventId,
          at: "2027-01-20T00:00:00Z",
          reason: "abuse finding",
        },
      ],
    });
    expect(computed(r).accounts[A].reversedUnits).toBe("500000");
    expect(ownView(r, A)).toMatchObject({
      totals: { referralUnits: "0", reversedUnits: "0", totalUnits: "0" },
      lines: [],
    });
  });
  it("own view: a reversal shows a code, never the internal review note", () => {
    const e = activity(A);
    const r = computeLedger({
      policy: FIXTURE,
      activities: [e],
      reversals: [
        {
          reversalId: "rv-9",
          ref: e.eventId,
          at: "2027-01-20T00:00:00Z",
          reason: "abuse finding: linked wallets (case 41)",
        },
      ],
    });
    const view = ownView(r, A);
    expect(JSON.stringify(view)).not.toMatch(/abuse|case 41|linked/);
    if (view.state === "COMPUTED")
      expect(view.lines).toEqual([
        expect.objectContaining({
          ref: e.eventId,
          status: "REVERSED",
          reason: "REVERSED",
        }),
      ]);
  });
});
