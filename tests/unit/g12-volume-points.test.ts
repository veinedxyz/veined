// G12 H05: cumulative points from verified volume (src/lifetime-points/volume.ts): 1 point per full 100 USD of an
// account's verified, settled, eligible volume, remainder carried; 10% one-level referral on activity points. Pure;
// every account, event and number here is SYNTHETIC (fixture policy), nothing is a real point or a real activity.
import { describe, expect, it } from "vitest";
import type { ReferralBinding, VerifiedActivity } from "../../src/points/model";
import {
  OPEN_BEYOND_POLICY,
  REGISTERED_VOLUME_POLICY,
  USD_MICROS_PER_POINT,
  computeVolumeLedger,
  ownVolumeView,
  volumeActivation,
  volumePolicySchema,
  type VolumeInputs,
  type VolumePolicy,
} from "../../src/lifetime-points/volume";
import { REGISTERED_LIFETIME_POLICY } from "../../src/lifetime-points/policy";

const A = "0xa1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1";
const B = "0xb2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2";
const C = "0xc3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3";
const usd = (n: number) => String(Math.round(n * 1_000_000));
const FIXTURE: VolumePolicy = volumePolicySchema.parse({
  version: "vp-fixture.1",
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
let seq = 0;
const ev = (
  account: string,
  dollars: number,
  over: Partial<VerifiedActivity> & { day?: number } = {},
): VerifiedActivity => {
  const n = ++seq;
  const { day = 2, ...rest } = over;
  const category = rest.category ?? "SWAP";
  return {
    eventId: `e-${n}`,
    verifier: "fixture-verifier",
    category,
    operationKey: `evm:1:0xop${String(n).padStart(10, "0")}`,
    account,
    outcome: category === "BRIDGE" ? "COMPLETED" : "SETTLED",
    occurredAt: `2027-01-${String(day).padStart(2, "0")}T12:00:${String(n % 60).padStart(2, "0")}Z`,
    chainId: "1",
    volumeUsdMicros: usd(dollars),
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
    ...rest,
  } as VerifiedActivity;
};
const run = (
  input: Omit<VolumeInputs, "policy"> & { policy?: VolumePolicy },
) => {
  const r = computeVolumeLedger({ policy: FIXTURE, ...input });
  if (r.state !== "COMPUTED") throw new Error(r.state);
  return r;
};
const bind = (
  child: string,
  parent: string,
  at = "2027-01-01T00:00:00Z",
): ReferralBinding => ({
  child,
  parent,
  code: "FIXTURE1",
  bindingEventId: "e-bind",
  effectiveAt: at,
  createdAt: at,
});

describe("G12 H05: the registered policy is not active", () => {
  it("VP1 PENDING_OWNER_POLICY awards nothing and lists every open owner decision; the earlier lifetime policy is untouched", () => {
    expect(volumeActivation(REGISTERED_VOLUME_POLICY)).toEqual({
      state: "PENDING_OWNER_POLICY",
      missing: [
        "readingConfirmed",
        "eligibility.minVolume",
        "eligibility.dailyCap",
        "eligibility.dailyVolumeCap",
        "effectiveFrom",
        "retroactivity",
        "legacyWeeklyConversion",
        // Review H05 M2: what no policy field decides and this build does not defend is always listed.
        "abuse.washTradingRule",
        "abuse.sybilSelfReferralRule",
        "verifier.multiLegOperationKey",
        "verifier.priceProvenance",
        "policy.versionHistory",
      ],
    });
    expect(OPEN_BEYOND_POLICY).toHaveLength(5);
    const r = computeVolumeLedger({
      policy: REGISTERED_VOLUME_POLICY,
      activities: [ev(A, 5000)],
    });
    expect(r).toMatchObject({ state: "PENDING_OWNER_POLICY" });
    expect(JSON.stringify(r)).not.toMatch(/"points"|"lines"|"accounts"/);
    expect(ownVolumeView(r, A)).toEqual({
      state: "PENDING_OWNER_POLICY",
      version: "vp-pending.1",
    });
    expect(REGISTERED_LIFETIME_POLICY.status).toBe("PENDING_OWNER_POLICY");
  });
  it("VP2 a pending policy cannot carry a hidden decision; an approved one needs every decision, the confirmed reading and an approval; approval alone is not activation", () => {
    const pending = { ...REGISTERED_VOLUME_POLICY };
    for (const bad of [
      { readingConfirmed: true },
      { effectiveFrom: "2027-01-01T00:00:00Z" },
      { retroactivity: "NONE" },
      { legacyWeeklyConversion: "NONE" },
      {
        eligibility: {
          minVolumeUsdMicros: "1",
          maxActivitiesPerAccountPerDay: null,
        },
      },
      { usdMicrosPerPoint: "50000000" },
      { referral: { commissionBps: 2000, depth: 1, base: "ACTIVITY" } },
    ])
      expect(volumePolicySchema.safeParse({ ...pending, ...bad }).success).toBe(
        false,
      );
    const approved = {
      ...FIXTURE,
      version: "vp-owner.1",
      status: "OWNER_APPROVED",
      readingConfirmed: true,
      approval: {
        approvedBy: "fixture-owner",
        approvedAt: "2026-12-01T00:00:00Z",
        reference: "fixture reference",
      },
    };
    expect(volumePolicySchema.safeParse(approved).success).toBe(true);
    for (const bad of [
      { readingConfirmed: false },
      { approval: undefined },
      { effectiveFrom: null },
      { retroactivity: "PENDING_OWNER_DECISION" },
      // A start before the approval needs the explicit retroactivity decision.
      { effectiveFrom: "2026-11-01T00:00:00Z" },
    ])
      expect(
        volumePolicySchema.safeParse({ ...approved, ...bad }).success,
      ).toBe(false);
    const policy = volumePolicySchema.parse(approved);
    expect(volumeActivation(policy)).toEqual({
      state: "APPROVED_NOT_ACTIVATED",
      open: ["productionActivation", ...OPEN_BEYOND_POLICY],
    });
    // Review H05 m8: approval is not activation. Without the owner's separate activation record (dated at or after
    // the approval) an approved policy computes nothing at all.
    const activities = [ev(A, 500, { occurredAt: "2027-01-02T12:00:00Z" })];
    for (const ownerActivation of [
      undefined,
      { activatedBy: "", activatedAt: "2027-01-01T00:00:00Z", reference: "x" },
      { activatedBy: "o", activatedAt: "2026-11-30T00:00:00Z", reference: "x" },
      { activatedBy: "o", activatedAt: "not-a-date", reference: "x" },
      // Final audit: dated after the computation's clock, or carrying anything beyond the three fields.
      { activatedBy: "o", activatedAt: "2027-03-01T00:00:00Z", reference: "x" },
      {
        activatedBy: "o",
        activatedAt: "2027-01-01T00:00:00Z",
        reference: "x",
        extra: true,
      } as never,
    ]) {
      const r = computeVolumeLedger({
        policy,
        activities,
        asOf: "2027-02-01T00:00:00Z",
        ownerActivation,
      });
      expect(r.state).toBe("APPROVED_NOT_ACTIVATED");
      expect(JSON.stringify(r)).not.toMatch(/"points"|"lines"|"accounts"/);
    }
    const activation = {
      activatedBy: "fixture-owner",
      activatedAt: "2026-12-15T00:00:00Z",
      reference: "fixture activation",
    };
    // An activated policy always computes against a clock (without one the activation itself cannot be dated), and
    // its result is not fixture data.
    expect(
      computeVolumeLedger({ policy, activities, ownerActivation: activation })
        .state,
    ).toBe("APPROVED_NOT_ACTIVATED");
    expect(
      computeVolumeLedger({
        policy,
        activities,
        asOf: "2027-02-01T00:00:00Z",
        ownerActivation: activation,
      }),
    ).toMatchObject({ state: "COMPUTED", fixture: false });
    // A fixture policy never takes an activation.
    expect(() =>
      computeVolumeLedger({
        policy: FIXTURE,
        activities: [],
        ownerActivation: activation,
      }),
    ).toThrow("VOLUME_FIXTURE_WITH_ACTIVATION");
  });
});

describe("G12 H05: cumulative thresholds", () => {
  it("VP3 the owner's examples: 40 + 60 USD -> 1 point; 250 USD -> 2 points and 50 USD toward the third", () => {
    const r = run({ activities: [ev(A, 40), ev(A, 60), ev(B, 250)] });
    expect(r.accounts[A]).toMatchObject({
      countedUsdMicros: usd(100),
      points: "1",
      carryUsdMicros: "0",
      toNextPointUsdMicros: usd(100),
      totalUnits: "1000000",
    });
    expect(r.accounts[B]).toMatchObject({
      points: "2",
      carryUsdMicros: usd(50),
      toNextPointUsdMicros: usd(50),
      totalUnits: "2000000",
    });
    // The point is completed by the activity that crosses the threshold.
    expect(r.lines.filter((l) => l.account === A).map((l) => l.points)).toEqual(
      ["0", "1"],
    );
    expect(r.fixture).toBe(true);
  });
  it("VP4 exact to the micro-dollar, never rounded up: 99.999999 USD is 0 points; one more micro-dollar completes the point; many small activities add up", () => {
    expect(run({ activities: [ev(A, 99.999999)] }).accounts[A]).toMatchObject({
      points: "0",
      toNextPointUsdMicros: "1",
    });
    expect(
      run({ activities: [ev(A, 99.999999), ev(A, 1.000001)] }).accounts[A],
    ).toMatchObject({ points: "1", carryUsdMicros: usd(1) });
    const many = Array.from({ length: 40 }, () => ev(A, 7.5));
    expect(run({ activities: many }).accounts[A]).toMatchObject({
      countedUsdMicros: usd(300),
      points: "3",
      carryUsdMicros: "0",
    });
  });
  it("VP5 order-independent and idempotent: shuffled or repeated input gives the same result", () => {
    const events = [ev(A, 30), ev(A, 80), ev(B, 120), ev(A, 95), ev(B, 5)];
    const base = run({ activities: events });
    const again = run({
      activities: [...events].reverse().concat(events, [
        {
          ...events[1],
          finality: { ...events[1].finality, confirmations: 900 },
        },
      ]),
    });
    expect(again.accounts).toEqual(base.accounts);
    expect(again.lines).toEqual(base.lines);
    expect(base.accounts[A]).toMatchObject({
      points: "2",
      carryUsdMicros: usd(5),
    });
  });
});

describe("G12 H05: what never counts", () => {
  it("VP6 pending, failed, reverted and quote records, unfinalized settlements, a bridge without its verified destination, dust below the minimum, future-dated and pre-start activity", () => {
    const r = run({
      asOf: "2027-01-10T00:00:00Z",
      activities: [
        ev(A, 500, { outcome: "PENDING" }),
        ev(A, 500, { outcome: "FAILED" }),
        ev(A, 500, { outcome: "REVERTED" }),
        ev(A, 500, { outcome: "QUOTE" }),
        ev(A, 500, {
          finality: {
            blockNumber: "9",
            blockHash: "unfinal0unfinal0",
            confirmations: 1,
            finalized: false,
          },
        }),
        ev(A, 500, {
          category: "BRIDGE",
          bridge: {
            destinationChainId: "8453",
            destinationTx: "destdestdestdest",
            destinationVerified: false,
          },
        }),
        ev(A, 0.5),
        ev(A, 500, { day: 20 }),
        ev(A, 500, { occurredAt: "2026-12-31T23:59:59Z" }),
        ev(A, 150),
      ],
    });
    expect(r.accounts[A]).toMatchObject({
      countedUsdMicros: usd(150),
      points: "1",
      carryUsdMicros: usd(50),
      // Not final yet: shown apart, never counted.
      pendingUsdMicros: usd(1500),
    });
    const reasons = r.lines
      .filter((l) => l.status === "REJECTED")
      .map((l) => l.reason);
    expect(reasons).toEqual(
      expect.arrayContaining([
        "OUTCOME_FAILED",
        "OUTCOME_REVERTED",
        "BELOW_MIN_VOLUME",
        "FUTURE_TIMESTAMP",
        "BEFORE_EFFECTIVE_FROM",
      ]),
    );
  });
  it("VP7 one economic operation counts once: the same settlement reported as a swap and as a trade, under another event id, or by another account", () => {
    const first = ev(A, 100);
    const r = run({
      activities: [
        first,
        { ...first, eventId: "e-dup-category", category: "TRADE" },
        { ...first, eventId: "e-dup-id" },
        { ...first, eventId: "e-dup-account", account: B },
      ],
    });
    expect(r.accounts[A]).toMatchObject({
      countedUsdMicros: usd(100),
      points: "1",
    });
    expect(r.accounts[B]?.points ?? "0").toBe("0");
    expect(
      r.lines.filter((l) => l.reason === "OPERATION_DUPLICATE"),
    ).toHaveLength(3);
  });
  it("VP8 the same event id with different content is a conflict: no variant counts, whatever the order", () => {
    const e = ev(A, 100);
    const forged = { ...e, volumeUsdMicros: usd(100000) };
    for (const activities of [
      [e, forged],
      [forged, e],
    ]) {
      const r = run({ activities });
      expect(r.accounts[A]?.points ?? "0").toBe("0");
      // Review H05 m4: the variants disagree about the volume, so the rejected line reports none (same in any order).
      expect(r.lines).toEqual([
        expect.objectContaining({
          status: "REJECTED",
          reason: "EVENT_CONFLICT",
          volumeUsdMicros: "0",
        }),
      ]);
    }
  });
  it("VP9 a reversal (reorg, refund, abuse finding) removes that volume and recomputes the thresholds; the line stays in the trail; the daily cap and exclusions hold", () => {
    const [x, y, z] = [ev(A, 60), ev(A, 60), ev(A, 90)];
    const before = run({ activities: [x, y, z] });
    expect(before.accounts[A]).toMatchObject({
      points: "2",
      carryUsdMicros: usd(10),
    });
    const after = run({
      activities: [x, y, z],
      reversals: [
        {
          reversalId: "r-1",
          ref: y.eventId,
          at: "2027-01-05T00:00:00Z",
          reason: "internal note",
        },
      ],
    });
    expect(after.accounts[A]).toMatchObject({
      countedUsdMicros: usd(150),
      points: "1",
      carryUsdMicros: usd(50),
      reversedUsdMicros: usd(60),
    });
    expect(after.lines.find((l) => l.ref === y.eventId)).toMatchObject({
      status: "REVERSED",
    });
    expect(
      ownVolumeView(after, A).lines!.find((l) => l.ref === y.eventId)!.reason,
    ).toBe("REVERSED");
    // Daily cap: the 51st counted activity of a UTC day adds nothing.
    const capped = run({
      activities: Array.from({ length: 51 }, () => ev(C, 10)),
    });
    expect(capped.accounts[C]).toMatchObject({
      countedUsdMicros: usd(500),
      points: "5",
    });
    expect(capped.lines.filter((l) => l.reason === "DAILY_CAP")).toHaveLength(
      1,
    );
    // An excluded account's activity inside the period adds nothing.
    expect(
      run({
        activities: [ev(B, 300)],
        exclusions: [{ account: B, from: "2027-01-01T00:00:00Z" }],
      }).accounts[B]?.points ?? "0",
    ).toBe("0");
  });
});

describe("G12 H05: review fixes", () => {
  it("VP9b review M2: the daily volume cap bounds what one account can count in a UTC day, whatever the activity sizes", () => {
    const policy = volumePolicySchema.parse({
      ...FIXTURE,
      eligibility: {
        ...FIXTURE.eligibility,
        maxVolumeUsdMicrosPerAccountPerDay: usd(1000),
      },
    });
    const r = run({
      policy,
      activities: [
        ev(A, 600),
        ev(A, 1_000_000),
        ev(A, 50),
        ev(A, 250, { day: 3 }),
      ],
    });
    // Day 2: 600 + 400 of the million count, the rest and the 50 add nothing; day 3 starts fresh.
    expect(r.lines.map((l) => l.countedUsdMicros)).toEqual([
      usd(600),
      usd(400),
      "0",
      usd(250),
    ]);
    expect(r.accounts[A]).toMatchObject({
      countedUsdMicros: usd(1250),
      points: "12",
      carryUsdMicros: usd(50),
    });
  });
  it("VP9c review m6: inputs are validated, never repaired: a non-decimal volume, a non-canonical account, a malformed binding, a prototype key", () => {
    const e = ev(A, 100);
    for (const bad of [
      { ...e, volumeUsdMicros: "0x5F5E100" },
      { ...e, volumeUsdMicros: "1e8" },
      { ...e, account: `0x${A.slice(2).toUpperCase()}` },
      { ...e, account: "__proto__" },
      { ...e, extra: 1 },
    ])
      expect(() => run({ activities: [bad as never] })).toThrow();
    for (const bad of [
      bind(`0x${A.slice(2).toUpperCase()}`, B),
      bind(A, "constructor"),
      bind(A, B, "yesterday"),
    ])
      expect(() => run({ activities: [e], bindings: [bad] })).toThrow();
    const r = run({ activities: [e] });
    for (const key of ["constructor", "__proto__", "toString"])
      expect(ownVolumeView(r, key).totals).toMatchObject({
        points: "0",
        totalUnits: "0",
      });
  });
  it("VP9d review m5: two bindings of one invited account at the same instant resolve the same way in any order (the lifetime ledger's rule)", () => {
    const x = { ...bind(A, B), code: "AAAA0001" };
    const y = { ...bind(A, C), code: "ZZZZ0001" };
    const one = run({ activities: [ev(A, 300)], bindings: [x, y] });
    const two = run({ activities: [ev(A, 300)], bindings: [y, x] });
    expect(two.accounts[B]?.referralUnits).toBe(one.accounts[B]?.referralUnits);
    expect(two.accounts[C]?.referralUnits).toBe(one.accounts[C]?.referralUnits);
    const paid = [one.accounts[B], one.accounts[C]].filter(
      (t) => t && t.referralUnits !== "0",
    );
    expect(paid).toHaveLength(1);
  });
});

describe("G12 H05: referral", () => {
  it("VP10 10% of the invited account's activity points, in exact units; nothing from the invited account's carry; one level only", () => {
    // C invites B, B invites A. A completes 3 points (350 USD), B completes 1 point (150 USD).
    const r = run({
      activities: [ev(A, 350), ev(B, 150)],
      bindings: [bind(A, B), bind(B, C)],
    });
    expect(r.accounts[A]).toMatchObject({
      points: "3",
      referralUnits: "0",
      totalUnits: "3000000",
    });
    // B: 1 own point + 10% of A's 3 points = 0.3 point.
    expect(r.accounts[B]).toMatchObject({
      points: "1",
      referralUnits: "300000",
      totalUnits: "1300000",
    });
    // C: 10% of B's ACTIVITY point only - B's commission from A is never a base (no commission on commission).
    expect(r.accounts[C]).toMatchObject({
      points: "0",
      referralUnits: "100000",
      totalUnits: "100000",
    });
  });
  it("VP11 self-referral, a two-way pair, a later second binding, activity before the binding and an excluded referrer earn no commission", () => {
    expect(
      run({ activities: [ev(A, 500)], bindings: [bind(A, A)] }).accounts[A],
    ).toMatchObject({ points: "5", referralUnits: "0" });
    const pair = run({
      activities: [ev(A, 200), ev(B, 200)],
      bindings: [
        bind(A, B, "2027-01-01T00:00:00Z"),
        bind(B, A, "2027-01-01T00:00:01Z"),
      ],
    });
    expect(pair.accounts[B].referralUnits).toBe("200000");
    expect(pair.accounts[A].referralUnits).toBe("0");
    const second = run({
      activities: [ev(A, 200)],
      bindings: [
        bind(A, B, "2027-01-01T00:00:00Z"),
        bind(A, C, "2027-01-01T00:00:05Z"),
      ],
    });
    expect(second.accounts[B].referralUnits).toBe("200000");
    expect(second.accounts[C]).toBeUndefined();
    // Points completed before the binding took effect are not shared; the threshold crossed afterwards is.
    const late = run({
      activities: [ev(A, 190, { day: 2 }), ev(A, 20, { day: 6 })],
      bindings: [bind(A, B, "2027-01-04T00:00:00Z")],
    });
    expect(late.accounts[A].points).toBe("2");
    expect(late.accounts[B].referralUnits).toBe("100000");
    expect(
      run({
        activities: [ev(A, 300)],
        bindings: [bind(A, B)],
        exclusions: [{ account: B, from: "2027-01-01T00:00:00Z" }],
      }).accounts[B]?.referralUnits ?? "0",
    ).toBe("0");
  });
  it("VP12 a reversal of the invited account's activity takes the commission with it", () => {
    const e = ev(A, 300);
    const r = run({
      activities: [e],
      bindings: [bind(A, B)],
      reversals: [
        {
          reversalId: "r-2",
          ref: e.eventId,
          at: "2027-01-05T00:00:00Z",
          reason: "refund",
        },
      ],
    });
    expect(r.accounts[A]).toMatchObject({
      points: "0",
      reversedUsdMicros: usd(300),
    });
    expect(r.accounts[B]?.referralUnits ?? "0").toBe("0");
  });
});

describe("G12 H05: privacy", () => {
  it("VP13 an account sees only its own totals and activity lines: no other account, no ranking, no invited account's events", () => {
    const r = run({
      activities: [ev(A, 350), ev(B, 150), ev(C, 990)],
      bindings: [bind(A, B)],
    });
    const view = ownVolumeView(r, B.toUpperCase().replace("0X", "0x"));
    expect(view.totals).toMatchObject({ points: "1", referralUnits: "300000" });
    expect(view.lines!.every((l) => l.account === B)).toBe(true);
    const text = JSON.stringify(view);
    expect(text).not.toContain(A);
    expect(text).not.toContain(C);
    expect(text).not.toMatch(/rank|leaderboard|pool|token|airdrop/i);
    expect(ownVolumeView(r, "0x" + "9".repeat(40)).totals).toMatchObject({
      points: "0",
      totalUnits: "0",
      toNextPointUsdMicros: USD_MICROS_PER_POINT,
    });
  });
});
