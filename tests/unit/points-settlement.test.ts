import { describe, expect, it } from "vitest";
import { acct, DAY, harness, WEEK } from "../helpers/points";
import { WEEKLY_POOL_UNITS } from "../../src/points/units";
// Settlement state machine, concurrency safety, corrections and the Week 1 / Week 2 / Week 3 visibility rules.
// SYNTHETIC_TEST_ONLY.

const GRACE = 21_600_000; // draft policy finality grace (6 h)
const sumUnits = (xs: { amountUnits: string }[]) =>
  xs.reduce((s, e) => s + BigInt(e.amountUnits), 0n);

async function seeded() {
  const h = harness();
  const [p, c, w, q] = ["sp", "sc", "sw", "sq"].map(acct);
  await h.ingest(h.event({ id: "p1", account: p, offset: 1000, usd: 2000 }));
  const code = (await h.engine.referralCode(p, true))!.code;
  await h.ingest(
    h.event({
      id: "c1",
      account: c,
      offset: 2000,
      usd: 900,
      referralCode: code,
    }),
  );
  await h.ingest(
    h.event({
      id: "c2",
      account: c,
      offset: 3000,
      usd: 4000,
      category: "TRADE",
    }),
  );
  await h.ingest(
    h.event({ id: "w1", account: w, offset: 4000, usd: 90_000_000 }),
  );
  await h.ingest(
    h.event({
      id: "q1",
      account: q,
      offset: 5000,
      usd: 640,
      category: "BRIDGE",
    }),
  );
  return { h, p, c, w, q, code };
}
const closeSeason = (h: ReturnType<typeof harness>, season = 1) =>
  h.setNow(season * WEEK + GRACE + 1000);

describe("points settlement", () => {
  it("cannot calculate before the season closes plus the finality grace", async () => {
    const { h } = await seeded();
    await expect(h.settlement.calculate(1, "ops-a")).rejects.toThrow(
      "SEASON_NOT_CLOSED",
    );
    h.setNow(WEEK + 1000);
    await expect(h.settlement.calculate(1, "ops-a")).rejects.toThrow(
      "SEASON_NOT_CLOSED",
    );
  });

  it("preview awards nothing; calculate → review → finalize (four-eyes) → publish; exact budget", async () => {
    const { h, p, c } = await seeded();
    const preview = await h.settlement.preview(1);
    expect(await h.engine.store.listLedger({})).toEqual([]);
    closeSeason(h);
    const { calculation } = await h.settlement.calculate(1, "ops-a");
    expect((await h.engine.store.getSeason(1))?.state).toBe("REVIEW_PENDING");
    expect(calculation.resultHash).toBe(preview.resultHash);
    expect(await h.engine.store.listLedger({})).toEqual([]);
    await expect(
      h.settlement.finalize(1, "ops-a", calculation.id),
    ).rejects.toThrow("FOUR_EYES_REQUIRED");
    await expect(h.settlement.publish(1, "owner-b")).rejects.toThrow(
      "SEASON_STATE_INVALID",
    );
    await h.settlement.finalize(1, "owner-b", calculation.id);
    const ledger = await h.engine.store.listLedger({ season: 1 });
    expect(sumUnits(ledger)).toBe(BigInt(calculation.summary.allocatedUnits));
    expect(
      sumUnits(ledger) + BigInt(calculation.summary.undistributedUnits),
    ).toBe(WEEKLY_POOL_UNITS);
    expect(sumUnits(ledger) <= WEEKLY_POOL_UNITS).toBe(true);
    // Referral: exactly ⌊10%⌋ of the child's referral-eligible activity lines, inside the same 200,000.
    const childLines = ledger.filter(
      (e) => e.account === c && e.kind === "ACTIVITY",
    );
    const commissions = ledger.filter((e) => e.kind === "REFERRAL_COMMISSION");
    expect(
      commissions.every((e) => e.account === p && e.sourceAccount === c),
    ).toBe(true);
    for (const line of childLines)
      expect(
        commissions.find((e) => e.sourceRef === line.id.slice(3))?.amountUnits,
      ).toBe(((BigInt(line.amountUnits) * 1000n) / 10_000n).toString());
    // Bounded volume: the $90M swap holds > 99.9% of the volume but its weight is the capped, concave one,
    // so its share stays bounded (here < 70% among five participants) instead of taking the whole pool.
    const whale = ledger.filter((e) => e.account === acct("sw"));
    expect(calculation.entries.length).toBeGreaterThan(0);
    expect(
      (await h.views.adminExplain(acct("sw"), 1)).lines[0].notes,
    ).toContain("VOLUME_CAPPED");
    expect(sumUnits(whale) * 10n < WEEKLY_POOL_UNITS * 7n).toBe(true);
    await h.settlement.publish(1, "owner-b");
    expect((await h.engine.store.getSeason(1))?.state).toBe("PUBLISHED");
  });

  it("is idempotent and safe under concurrent calculation and finalization", async () => {
    const { h } = await seeded();
    closeSeason(h);
    const calcs = await Promise.allSettled(
      Array.from({ length: 12 }, () => h.settlement.calculate(1, "ops-a")),
    );
    const ok = calcs
      .filter((r) => r.status === "fulfilled")
      .map(
        (r) =>
          (
            r as PromiseFulfilledResult<{
              calculation: { id: string };
              idempotent: boolean;
            }>
          ).value,
      );
    expect(ok.filter((r) => !r.idempotent).length).toBe(1);
    expect(new Set(ok.map((r) => r.calculation.id)).size).toBe(1);
    for (const r of calcs.filter((x) => x.status === "rejected"))
      expect(String((r as PromiseRejectedResult).reason)).toMatch(
        /SETTLEMENT_LOCKED|SETTLEMENT_CONFLICT/,
      );
    const id = ok[0].calculation.id;
    const fins = await Promise.allSettled(
      Array.from({ length: 12 }, () => h.settlement.finalize(1, "owner-b", id)),
    );
    expect(fins.some((r) => r.status === "fulfilled")).toBe(true);
    const ledger = await h.engine.store.listLedger({ season: 1 });
    const calc = (await h.engine.store.getSeason(1))!.calculation!;
    expect(ledger.length).toBe(calc.entries.length);
    expect(new Set(ledger.map((e) => e.id)).size).toBe(ledger.length);
    expect(sumUnits(ledger)).toBe(BigInt(calc.summary.allocatedUnits));
    // Repeating every step afterwards changes nothing.
    expect((await h.settlement.calculate(1, "ops-a")).idempotent).toBe(true);
    expect((await h.settlement.finalize(1, "owner-b", id)).idempotent).toBe(
      true,
    );
    expect((await h.engine.store.listLedger({ season: 1 })).length).toBe(
      ledger.length,
    );
  });

  it("the store refuses any ledger commit that would exceed 200,000 points", async () => {
    const { h } = await seeded();
    closeSeason(h);
    const { calculation } = await h.settlement.calculate(1, "ops-a");
    const record = (await h.engine.store.getSeason(1))!;
    const inflated = [
      ...calculation.entries,
      {
        ...calculation.entries[0],
        id: "s1:a:extra",
        amountUnits: WEEKLY_POOL_UNITS.toString(),
      },
    ];
    expect(
      await h.engine.store.commitFinalization(
        1,
        record.version,
        { ...record, state: "FINALIZED", version: record.version + 1 },
        inflated,
        WEEKLY_POOL_UNITS,
      ),
    ).toBe("BUDGET_EXCEEDED");
    expect(await h.engine.store.listLedger({})).toEqual([]);
  });

  it("a calculation made stale by a reversal must be rejected and redone; a lost lease cannot commit", async () => {
    const { h } = await seeded();
    closeSeason(h);
    const first = await h.settlement.calculate(1, "ops-a");
    await h.engine.reverse("q1", "REORG_BLOCK_CHANGED", "simulated-verifier");
    await expect(
      h.settlement.finalize(1, "owner-b", first.calculation.id),
    ).rejects.toThrow("CALCULATION_STALE");
    await expect(h.settlement.calculate(1, "ops-a")).rejects.toThrow(
      "CALCULATION_STALE",
    );
    await h.settlement.reject(1, "owner-b", "reorg after calculation");
    const second = await h.settlement.calculate(1, "ops-a");
    expect(second.calculation.id).not.toBe(first.calculation.id);
    expect(second.calculation.entries.some((e) => e.sourceRef === "q1")).toBe(
      false,
    );
    expect((await h.engine.store.getSeason(1))?.rejectedCalculations).toEqual([
      first.calculation.id,
    ]);
  });

  it("an abandoned CALCULATING state is recovered only after its lease expires", async () => {
    const { h } = await seeded();
    closeSeason(h);
    const record = (await h.engine.store.getSeason(1))!;
    await h.engine.store.updateSeason(1, record.version, {
      ...record,
      state: "CALCULATING",
      version: record.version + 1,
      fence: -1,
      calculationStartedAt: new Date(h.now()).toISOString(),
    });
    await expect(h.settlement.calculate(1, "ops-a")).rejects.toThrow(
      "SETTLEMENT_LOCKED",
    );
    h.advance(121_000);
    expect((await h.settlement.calculate(1, "ops-a")).idempotent).toBe(false);
  });

  it("a reversal after publication becomes an approved clawback; the published result is never recalculated", async () => {
    const { h, p, c } = await seeded();
    closeSeason(h);
    const { calculation } = await h.settlement.calculate(1, "ops-a");
    await h.settlement.finalize(1, "owner-b", calculation.id);
    await h.settlement.publish(1, "owner-b");
    const before = await h.views.leaderboard(1);
    await h.engine.reverse("c1", "REORG_BLOCK_CHANGED", "simulated-verifier");
    expect((await h.engine.store.getActivity("c1"))?.afterFinalization).toBe(
      true,
    );
    expect((await h.engine.store.getSeason(1))?.calculation?.id).toBe(
      calculation.id,
    );
    const proposal = await h.settlement.proposeCorrection(1, "c1", "ops-a");
    const child = calculation.entries.find((e) => e.id === "s1:a:c1")!;
    const commission = calculation.entries.find((e) => e.id === "s1:c:a:c1")!;
    expect(
      proposal.entries.map((e) => [e.account, e.amountUnits]).sort(),
    ).toEqual(
      [
        [c, `-${child.amountUnits}`],
        [p, `-${commission.amountUnits}`],
      ].sort(),
    );
    await expect(
      h.settlement.decideCorrection(proposal.id, "ops-a", true),
    ).rejects.toThrow("FOUR_EYES_REQUIRED");
    await h.settlement.decideCorrection(proposal.id, "owner-b", true);
    expect(
      (await h.settlement.decideCorrection(proposal.id, "owner-b", true))
        .status,
    ).toBe("APPLIED");
    const ledger = await h.engine.store.listLedger({ season: 1 });
    expect(sumUnits(ledger)).toBe(
      BigInt(calculation.summary.allocatedUnits) -
        BigInt(child.amountUnits) -
        BigInt(commission.amountUnits),
    );
    const season = (await h.engine.store.getSeason(1))!;
    expect(BigInt(season.undistributed!.units)).toBe(
      BigInt(calculation.summary.undistributedUnits) +
        BigInt(child.amountUnits) +
        BigInt(commission.amountUnits),
    );
    const after = await h.views.leaderboard(1);
    expect(after!.amended).toBe(true);
    // The admin view of a settled season is the ledger: original allocation plus the explicit clawback.
    const dashboard = await h.views.adminDashboard(1);
    expect(dashboard.basis).toBe("SETTLED");
    const childRow = dashboard.accounts.find((a) => a.account === c)!;
    expect(childRow.correctionUnits).toBe(`-${child.amountUnits}`);
    expect(BigInt(childRow.totalUnits)).toBe(
      calculation.entries
        .filter((e) => e.account === c)
        .reduce((s, e) => s + BigInt(e.amountUnits), 0n),
    );
    expect(after!.rows.map((r) => [r.rank, r.totalUnits])).toEqual(
      before!.rows.map((r) => [r.rank, r.totalUnits]),
    );
    await expect(
      h.settlement.proposeCorrection(1, "c2", "ops-a"),
    ).rejects.toThrow("CORRECTION_NOT_APPLICABLE");
  });

  it("a week without qualified activity awards nothing and records the undistributed pool for the owner", async () => {
    const h = harness();
    await h.ingest(
      h.event({
        id: "f1",
        account: acct("nf"),
        offset: 1000,
        outcome: "FAILED",
      }),
    );
    closeSeason(h);
    const { calculation } = await h.settlement.calculate(1, "ops-a");
    expect(calculation.entries).toEqual([]);
    expect(calculation.summary.undistributedUnits).toBe(
      WEEKLY_POOL_UNITS.toString(),
    );
    await h.settlement.finalize(1, "owner-b", calculation.id);
    expect((await h.engine.store.getSeason(1))?.undistributed?.decision).toBe(
      "PENDING_OWNER_DECISION",
    );
    const decided = await h.settlement.retainUndistributed(
      1,
      "owner-b",
      "no activity in week 1",
    );
    expect(decided.undistributed?.decision).toBe("RETAINED_UNALLOCATED");
    // Week 2 still has exactly the fixed pool.
    expect((await h.settlement.preview(2)).summary.poolUnits).toBe(
      WEEKLY_POOL_UNITS.toString(),
    );
  });

  it("future seasons get no record and no frozen policy until they start", async () => {
    const h = harness();
    await expect(h.settlement.preview(2)).rejects.toThrow("SEASON_NOT_STARTED");
    await expect(h.views.adminDashboard(5)).rejects.toThrow(
      "SEASON_NOT_STARTED",
    );
    expect(await h.engine.store.listSeasons()).toEqual([]);
    h.setNow(WEEK + DAY);
    expect((await h.settlement.preview(2)).season).toBe(2);
  });

  it("late activity for a season under settlement is refused, never silently added", async () => {
    const { h } = await seeded();
    closeSeason(h);
    await h.settlement.calculate(1, "ops-a");
    const late = await h.ingest(
      h.event({ id: "late", account: acct("late"), offset: WEEK - 5000 }),
    );
    expect(late.record?.reason).toBe("SEASON_CLOSED");
  });
});

describe("points visibility by week", () => {
  const numeric = /\b(units|weight|rank|amount|total|points|score|share)\b/i;
  const keysOf = (value: unknown): string[] =>
    value && typeof value === "object"
      ? Object.entries(value as Record<string, unknown>).flatMap(([k, v]) => [
          k,
          ...keysOf(v),
        ])
      : [];

  it("week 1: no leaderboard, no balances, no positions, only the countdown", async () => {
    const { h, p, c } = await seeded();
    const preview = await h.settlement.preview(1);
    for (const account of [undefined, p, c]) {
      const overview = await h.views.overview(account);
      expect(overview.current).toMatchObject({
        season: 1,
        resultsHidden: true,
      });
      const text = JSON.stringify(overview);
      expect(keysOf(overview).filter((k) => numeric.test(k))).toEqual([]);
      for (const e of preview.entries)
        expect(text).not.toContain(e.amountUnits);
      for (const l of preview.explain)
        expect(text).not.toContain(`"${l.effectiveWeight}"`);
    }
    expect(await h.views.leaderboard(1)).toBeNull();
    expect(await h.views.history(c)).toEqual([]);
    // Even a finalized but unpublished season stays hidden.
    closeSeason(h);
    const { calculation } = await h.settlement.calculate(1, "ops-a");
    await h.settlement.finalize(1, "owner-b", calculation.id);
    expect(await h.views.leaderboard(1)).toBeNull();
    expect(await h.views.history(c)).toEqual([]);
  });

  it("week 2 shows the finalized week 1 only; week 3 archives it and shows week 2; live weeks stay hidden", async () => {
    const { h, c } = await seeded();
    closeSeason(h, 1);
    const one = await h.settlement.calculate(1, "ops-a");
    await h.settlement.finalize(1, "owner-b", one.calculation.id);
    await h.settlement.publish(1, "owner-b");
    await h.ingest(
      h.event({ id: "c-w2", account: c, offset: WEEK + DAY, usd: 777 }),
    );
    const week2 = await h.views.overview(c);
    expect(week2.current?.season).toBe(2);
    expect(week2.latestPublished).toBe(1);
    expect((await h.views.leaderboard(1))?.rows.length).toBeGreaterThan(0);
    expect((await h.views.leaderboard(1, c))?.you?.totalUnits).toBeDefined();
    expect(await h.views.leaderboard(2)).toBeNull();
    const w2preview = await h.settlement.preview(2);
    const text = JSON.stringify(week2);
    for (const e of w2preview.entries)
      expect(text).not.toContain(e.amountUnits);
    expect((await h.views.history(c)).map((r) => r.season)).toEqual([1]);
    closeSeason(h, 2);
    const two = await h.settlement.calculate(2, "ops-a");
    await h.settlement.finalize(2, "owner-b", two.calculation.id);
    await h.settlement.publish(2, "owner-b");
    h.setNow(2 * WEEK + 2 * DAY);
    const week3 = await h.views.overview();
    expect(week3.current?.season).toBe(3);
    expect(week3.archive?.map((s) => s.season)).toEqual([1, 2]);
    expect(week3.latestPublished).toBe(2);
    expect(await h.views.leaderboard(3)).toBeNull();
  });
});
