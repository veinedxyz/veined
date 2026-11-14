import { describe, expect, it } from "vitest";
import { allocate, type WeightLine } from "../../src/points/allocation";
import {
  activityWeight,
  POLICIES,
  policyHash,
  resolvePolicy,
  weightPolicySchema,
} from "../../src/points/policy";
import { simulatedEvent } from "../../src/points/fixtures";
import {
  isqrt,
  UNITS_PER_POINT,
  WEEKLY_POOL_UNITS,
} from "../../src/points/units";
import { displayPoints, exactPoints } from "../../src/points/format";
import { prng } from "../fixtures/prng";
// Weekly allocation: exact budget, proportionality, exact 10% referral commission, determinism. SYNTHETIC_TEST_ONLY.

const line = (
  id: string,
  account: string,
  weight: bigint,
  parent: string | null = null,
): WeightLine => ({
  lineId: `a:${id}`,
  account,
  kind: "ACTIVITY",
  sourceRef: id,
  weight,
  referralParent: parent,
});
const sum = (xs: bigint[]) => xs.reduce((a, b) => a + b, 0n);

describe("points allocation", () => {
  it("the weekly pool is exactly 200,000 points in 6-decimal units", () => {
    expect(WEEKLY_POOL_UNITS).toBe(200_000n * 10n ** 6n);
    expect(UNITS_PER_POINT).toBe(1_000_000n);
  });

  it("owner example: a referred user's activity earning 500 points gives the referrer exactly 50 more", () => {
    // D = 10·11,000 + 3,989·10,000 = 40,000,000 → child = P·10·10,000 / D = 500 points.
    const result = allocate(WEEKLY_POOL_UNITS, [
      line("child", "c", 10n, "p"),
      line("filler", "f", 3989n),
    ]);
    const child = result.lines.find((l) => l.lineId === "a:child")!;
    const commission = result.lines.find(
      (l) => l.kind === "REFERRAL_COMMISSION",
    )!;
    expect(child.amount).toBe(500n * UNITS_PER_POINT);
    expect(commission.amount).toBe(50n * UNITS_PER_POINT);
    expect(commission.account).toBe("p");
    expect(commission.sourceAccount).toBe("c");
    // The referred user keeps everything: the commission is reserved in the denominator, not deducted.
    expect(result.allocatedUnits).toBe(WEEKLY_POOL_UNITS);
    expect(result.residualUnits).toBe(0n);
  });

  it("is proportional to weight and independent of input order", () => {
    const lines = [line("x", "a", 1n), line("y", "b", 3n), line("z", "c", 6n)];
    const one = allocate(WEEKLY_POOL_UNITS, lines);
    const two = allocate(WEEKLY_POOL_UNITS, [...lines].reverse());
    expect(two).toEqual(one);
    const amount = (id: string) =>
      one.lines.find((l) => l.lineId === id)!.amount;
    expect(amount("a:x")).toBe(20_000n * UNITS_PER_POINT);
    expect(amount("a:y")).toBe(60_000n * UNITS_PER_POINT);
    expect(amount("a:z")).toBe(120_000n * UNITS_PER_POINT);
    expect(one.allocatedUnits).toBe(WEEKLY_POOL_UNITS);
  });

  it("fuzz: never exceeds the pool, commission is exactly ⌊10%⌋ of the final line reward, residual is tiny", () => {
    const r = prng(0x9e3779b9);
    for (let round = 0; round < 400; round++) {
      const accounts = Array.from(
        { length: 1 + r.int(40) },
        (_, i) => `acct-${i}`,
      );
      const lines: WeightLine[] = [];
      const count = 1 + r.int(120);
      for (let i = 0; i < count; i++) {
        const account = r.pick(accounts);
        const others = accounts.filter((a) => a !== account);
        const parent = others.length && r.next() < 0.4 ? r.pick(others) : null;
        const weight = BigInt(1 + r.int(r.next() < 0.1 ? 10_000_000 : 5000));
        lines.push(line(`${round}-${i}`, account, weight, parent));
      }
      const result = allocate(WEEKLY_POOL_UNITS, r.shuffle(lines));
      const rewards = result.lines.filter(
        (l) => l.kind !== "REFERRAL_COMMISSION",
      );
      const commissions = result.lines.filter(
        (l) => l.kind === "REFERRAL_COMMISSION",
      );
      expect(sum(result.lines.map((l) => l.amount))).toBe(
        result.allocatedUnits,
      );
      expect(result.allocatedUnits + result.residualUnits).toBe(
        WEEKLY_POOL_UNITS,
      );
      expect(result.allocatedUnits <= WEEKLY_POOL_UNITS).toBe(true);
      // Floor rounding loses < 1 unit per reward line and < 1.1 units per commission line (floor of a floor).
      expect(
        result.residualUnits * 10n <
          BigInt(rewards.length * 10 + commissions.length * 11),
      ).toBe(true);
      for (const c of commissions) {
        const source = rewards.find((l) => l.lineId === c.sourceRef)!;
        expect(c.amount).toBe((source.amount * 1000n) / 10_000n);
        expect(c.account).not.toBe(source.account);
        // Never recursive: a commission is never itself a source of commission.
        expect(commissions.some((x) => x.sourceRef === c.lineId)).toBe(false);
      }
    }
  });

  it("no qualified activity: nothing is fabricated, the whole pool is undistributed", () => {
    const result = allocate(WEEKLY_POOL_UNITS, []);
    expect(result.lines).toEqual([]);
    expect(result.allocatedUnits).toBe(0n);
    expect(result.residualUnits).toBe(WEEKLY_POOL_UNITS);
  });

  it("rejects malformed lines instead of guessing", () => {
    expect(() => allocate(WEEKLY_POOL_UNITS, [line("a", "x", 0n)])).toThrow(
      "LINE_WEIGHT_INVALID",
    );
    expect(() =>
      allocate(WEEKLY_POOL_UNITS, [line("a", "x", 1n), line("a", "y", 1n)]),
    ).toThrow("LINE_DUPLICATE");
    expect(() =>
      allocate(WEEKLY_POOL_UNITS, [line("a", "x", 1n, "x")]),
    ).toThrow("SELF_REFERRAL");
  });
});

describe("points weight policy", () => {
  const { policy } = resolvePolicy("draft-1");
  const event = (usd: number, category: "SWAP" | "TRADE" | "BRIDGE" = "SWAP") =>
    simulatedEvent({
      id: `w-${usd}`,
      account: `0x${"1".repeat(40)}`,
      category,
      occurredAt: "2026-11-10T00:00:00.000Z",
      usd,
    });

  it("the registered draft is a placeholder, is pinned by hash and validates", () => {
    expect(policy.status).toBe("DRAFT_PLACEHOLDER");
    expect(policy.referral.commissionBps).toBe(1000);
    expect(policy.referral.includeTasks).toBe(false);
    expect(weightPolicySchema.parse(policy)).toEqual(policy);
    expect(Object.keys(POLICIES)).toEqual(["draft-1"]);
    expect(() => resolvePolicy("draft-1", "0".repeat(64))).toThrow(
      "POLICY_DRIFT",
    );
    expect(resolvePolicy("draft-1", policyHash(policy)).hash).toBe(
      policyHash(policy),
    );
  });

  it("an owner-approved policy needs an approval record and the commission is fixed at 10%", () => {
    expect(() =>
      weightPolicySchema.parse({ ...policy, status: "OWNER_APPROVED" }),
    ).toThrow();
    expect(() =>
      weightPolicySchema.parse({
        ...policy,
        referral: { ...policy.referral, commissionBps: 1500 },
      }),
    ).toThrow();
  });

  it("bounded volume weighting: a huge transaction is capped and concave", () => {
    const small = activityWeight(policy, event(1_000)).weight;
    const capped = activityWeight(policy, event(100_000)).weight;
    const whale = activityWeight(policy, event(500_000_000));
    expect(whale.weight).toBe(capped);
    expect(whale.boundedVolumeUsdMicros).toBe(100_000_000_000n);
    // 100,000x the volume of a $1,000 swap earns less than 10x its weight.
    expect(whale.weight < small * 10n).toBe(true);
  });

  it("integer sqrt is exact", () => {
    for (const v of [
      0n,
      1n,
      2n,
      3n,
      4n,
      15n,
      16n,
      17n,
      10n ** 30n,
      10n ** 30n - 1n,
    ])
      expect(
        isqrt(v) * isqrt(v) <= v && (isqrt(v) + 1n) * (isqrt(v) + 1n) > v,
      ).toBe(true);
  });
});

describe("points display", () => {
  it("formats exact units without floating point", () => {
    expect(exactPoints("500000000")).toBe("500");
    expect(exactPoints("1234567")).toBe("1.234567");
    expect(exactPoints("-50000000")).toBe("-50");
    expect(displayPoints("200000000000", "en")).toBe("200,000");
    expect(displayPoints("1234567", "en")).toBe("1.23");
    expect(displayPoints("1999999", "en")).toBe("1.99");
    expect(displayPoints("1234560000", "tr")).toBe("1.234,56");
  });
});
