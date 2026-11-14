import { describe, expect, it } from "vitest";
import { acct, at, DAY, harness, WEEK } from "../helpers/points";
import type { TaskInput } from "../../src/points/model";
// Trusted activity verification, deduplication, finality/reorg, referral binding and task verification.
// SYNTHETIC_TEST_ONLY: simulated verifier events, isolated in-memory store.

const status = async (h: ReturnType<typeof harness>, eventId: string) =>
  (await h.engine.store.getActivity(eventId))?.status;

describe("points activity verification", () => {
  it("only settled swaps/trades and destination-verified bridges are eligible", async () => {
    const h = harness();
    const a = acct("v1");
    const cases = [
      ["ok-swap", { category: "SWAP" }, "ELIGIBLE"],
      ["ok-trade", { category: "TRADE" }, "ELIGIBLE"],
      ["ok-bridge", { category: "BRIDGE" }, "ELIGIBLE"],
      ["failed", { outcome: "FAILED" }, "REJECTED"],
      ["reverted", { outcome: "REVERTED" }, "REJECTED"],
      ["quote", { outcome: "QUOTE" }, "REJECTED"],
      ["intent", { outcome: "UNSIGNED_INTENT" }, "REJECTED"],
      ["pending", { outcome: "PENDING" }, "REJECTED"],
      ["cancelled", { category: "TRADE", outcome: "CANCELLED" }, "REJECTED"],
      [
        "bridge-settled-only",
        { category: "BRIDGE", outcome: "SETTLED" },
        "REJECTED",
      ],
      ["dust", { usd: 5 }, "REJECTED"],
    ] as const;
    for (const [id, extra, expected] of cases) {
      await h.ingest(h.event({ id, account: a, offset: 3600_000, ...extra }));
      expect([id, await status(h, id)]).toEqual([id, expected]);
    }
    const unverified = h.event({
      id: "bridge-unverified",
      account: a,
      offset: 3600_000,
      category: "BRIDGE",
    });
    await h.ingest({
      ...unverified,
      bridge: { ...unverified.bridge!, destinationVerified: false },
    });
    expect(
      (await h.engine.store.getActivity("bridge-unverified"))?.reason,
    ).toBe("BRIDGE_DESTINATION_UNVERIFIED");
  });

  it("rejects untrusted verifiers, malformed events, future timestamps and pre-program activity", async () => {
    const h = harness();
    const a = acct("v2");
    await expect(
      h.engine.ingest(
        h.event({ account: a, offset: 1, verifier: "browser" }),
        "browser",
      ),
    ).rejects.toThrow("VERIFIER_NOT_TRUSTED");
    await expect(
      h.engine.ingest(h.event({ account: a, offset: 1 }), "fixture"),
    ).rejects.toThrow("VERIFIER_MISMATCH");
    await expect(
      h.engine.ingest({ eventId: "x" }, "simulated-verifier"),
    ).rejects.toThrow("EVENT_INVALID");
    await h.ingest(
      h.event({ id: "future", account: a, offset: DAY + 3600_000 }),
    );
    expect((await h.engine.store.getActivity("future"))?.reason).toBe(
      "FUTURE_TIMESTAMP",
    );
    await h.ingest(h.event({ id: "early", account: a, offset: -60_000 }));
    expect((await h.engine.store.getActivity("early"))?.reason).toBe(
      "OUTSIDE_PROGRAM",
    );
  });

  it("replays are no-ops, conflicting replays are refused, one operation counts once across categories", async () => {
    const h = harness();
    const a = acct("v3");
    const e = h.event({ id: "once", account: a, offset: 1000 });
    expect((await h.ingest(e)).result).toBe("ELIGIBLE");
    expect((await h.ingest(e)).result).toBe("DUPLICATE_REPLAY");
    expect(
      (await h.ingest({ ...e, volumeUsdMicros: "999000000" })).result,
    ).toBe("CONFLICT");
    expect(
      (await h.engine.store.getActivity("once"))?.event.volumeUsdMicros,
    ).toBe(e.volumeUsdMicros);
    const swap = h.event({
      id: "op-swap",
      account: a,
      offset: 2000,
      operation: "shared",
    });
    const trade = h.event({
      id: "op-trade",
      account: a,
      offset: 2000,
      category: "TRADE",
      operation: "shared",
    });
    expect(swap.operationKey).toBe(trade.operationKey);
    await h.ingest(swap);
    const second = await h.ingest(trade);
    expect(second.result).toBe("REJECTED");
    expect(second.record?.reason).toBe("DUPLICATE_OPERATION");
    const eligible = (
      await h.engine.store.listActivities({ account: a })
    ).filter((r) => r.status === "ELIGIBLE");
    expect(eligible.map((r) => r.event.eventId).sort()).toEqual([
      "once",
      "op-swap",
    ]);
  });

  it("waits for finality, promotes on confirmation and reverses on a reorganisation", async () => {
    const h = harness();
    const a = acct("v4");
    const e = h.event({
      id: "slow",
      account: a,
      offset: 1000,
      confirmations: 3,
      finalized: false,
    });
    expect((await h.ingest(e)).result).toBe("PENDING_FINALITY");
    // A replay carrying more confirmations is a finality update.
    expect(
      (await h.ingest({ ...e, finality: { ...e.finality, confirmations: 20 } }))
        .result,
    ).toBe("ELIGIBLE");
    const r = h.event({ id: "reorg", account: a, offset: 2000 });
    await h.ingest(r);
    await h.engine.updateFinality(
      "reorg",
      { ...r.finality, blockHash: `0x${"f".repeat(64)}` },
      r.verifier,
    );
    const reversed = await h.engine.store.getActivity("reorg");
    expect(reversed?.status).toBe("REVERSED");
    expect(reversed?.reason).toBe("REORG_BLOCK_CHANGED");
    // The same transaction re-included in a new block may be reported again under a new event id.
    expect((await h.ingest({ ...r, eventId: "reorg-reincluded" })).result).toBe(
      "ELIGIBLE",
    );
    await expect(
      h.engine.updateFinality("reorg", r.finality, "fixture"),
    ).rejects.toThrow("VERIFIER_MISMATCH");
  });
});

describe("points referrals", () => {
  it("binds on the first verified activity carrying a code; one parent; no self, prior-activity or cycles", async () => {
    const h = harness();
    const [p, c, d, e] = ["rp", "rc", "rd", "re"].map(acct);
    await expect(h.engine.referralCode(p, true)).rejects.toThrow(
      "REFERRAL_CODE_NOT_ELIGIBLE",
    );
    await h.ingest(h.event({ id: "p1", account: p, offset: 1000 }));
    const code = (await h.engine.referralCode(p, true))!.code;
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect((await h.engine.referralCode(p, true))!.code).toBe(code);
    await h.ingest(
      h.event({
        id: "c1",
        account: c,
        offset: 2000,
        referralCode: code.toLowerCase(),
      }),
    );
    expect((await h.engine.store.getBinding(c))?.parent).toBe(p);
    expect((await h.engine.store.getActivity("c1"))?.attributionResult).toBe(
      "BOUND",
    );
    // Self-referral: the owner's own later activity with its own code.
    await h.ingest(
      h.event({ id: "p2", account: p, offset: 3000, referralCode: code }),
    );
    expect((await h.engine.store.getActivity("p2"))?.attributionResult).toBe(
      "SELF_REFERRAL",
    );
    expect(await h.engine.store.getBinding(p)).toBeNull();
    // An existing user cannot be captured later.
    await h.ingest(h.event({ id: "d1", account: d, offset: 4000 }));
    await h.ingest(
      h.event({ id: "d2", account: d, offset: 5000, referralCode: code }),
    );
    expect((await h.engine.store.getActivity("d2"))?.attributionResult).toBe(
      "PRIOR_ACTIVITY",
    );
    // One parent forever: a second code does not rebind.
    await h.ingest(h.event({ id: "e1", account: e, offset: 6000 }));
    const other = (await h.engine.referralCode(e, true))!.code;
    await h.ingest(
      h.event({ id: "c2", account: c, offset: 7000, referralCode: other }),
    );
    expect((await h.engine.store.getActivity("c2"))?.attributionResult).toBe(
      "ALREADY_BOUND",
    );
    expect((await h.engine.store.getBinding(c))?.parent).toBe(p);
    // Cycle: c (child of p) holds a code; p already has activity, so it can never be bound to c.
    const childCode = (await h.engine.referralCode(c, true))!.code;
    await h.ingest(
      h.event({ id: "p3", account: p, offset: 8000, referralCode: childCode }),
    );
    expect(await h.engine.store.getBinding(p)).toBeNull();
    // Unknown code.
    await h.ingest(
      h.event({
        id: "x1",
        account: acct("rx"),
        offset: 9000,
        referralCode: "ZZZZZZZZ",
      }),
    );
    expect((await h.engine.store.getActivity("x1"))?.attributionResult).toBe(
      "INVALID_CODE",
    );
  });

  it("an excluded referrer cannot gain new referrals or codes", async () => {
    const h = harness();
    const [p, c] = ["xp", "xc"].map(acct);
    await h.ingest(h.event({ id: "xp1", account: p, offset: 1000 }));
    const code = (await h.engine.referralCode(p, true))!.code;
    await h.engine.setFlag("ops-a", p, "EXCLUDED", true, "abuse review");
    await h.ingest(
      h.event({ id: "xc1", account: c, offset: 2000, referralCode: code }),
    );
    expect((await h.engine.store.getActivity("xc1"))?.attributionResult).toBe(
      "REFERRER_EXCLUDED",
    );
    expect(await h.engine.codeEligible(p)).toBe(false);
  });
});

describe("points periodic tasks", () => {
  const task = (over: Partial<TaskInput> = {}): TaskInput => ({
    id: "bridge-week",
    title: "Bridge twice",
    description: "Complete two verified bridges this week.",
    criteria: { category: "BRIDGE", minCount: 2 },
    weight: "500",
    perUserLimit: 1,
    globalLimit: 2,
    startsAt: at(DAY + 3600_000),
    endsAt: at(WEEK - 1),
    requiresReview: false,
    ...over,
  });

  it("requires four-eyes owner approval, refuses retroactive windows and login-style criteria", async () => {
    const h = harness();
    await expect(
      h.engine.createTask("ops-a", {
        ...task(),
        criteria: { kind: "LOGIN", minCount: 1 },
      }),
    ).rejects.toThrow("TASK_INVALID");
    await expect(
      h.engine.createTask("ops-a", { ...task(), weight: "0" }),
    ).rejects.toThrow("TASK_WEIGHT_INVALID");
    await h.engine.createTask("ops-a", task());
    await expect(h.engine.approveTask("ops-a", "bridge-week")).rejects.toThrow(
      "FOUR_EYES_REQUIRED",
    );
    await h.engine.createTask(
      "ops-a",
      task({ id: "late-task", startsAt: at(0) }),
    );
    await expect(h.engine.approveTask("owner-b", "late-task")).rejects.toThrow(
      "TASK_RETROACTIVE",
    );
    expect((await h.engine.approveTask("owner-b", "bridge-week")).status).toBe(
      "APPROVED",
    );
  });

  it("completes server-side from verified activity only, each event once, within per-user and global limits", async () => {
    const h = harness();
    await h.engine.createTask("ops-a", task());
    await h.engine.approveTask("owner-b", "bridge-week");
    h.advance(2 * DAY);
    const [a, b, c] = ["ta", "tb", "tc"].map(acct);
    const bridge = (id: string, account: string, offset: number, extra = {}) =>
      h.event({ id, account, offset, category: "BRIDGE", ...extra });
    // Before the window, failed, and swap activity do not count.
    await h.ingest(bridge("a0", a, 1000));
    await h.ingest(
      bridge("a-failed", a, DAY + 2 * 3600_000, { outcome: "FAILED" }),
    );
    await h.ingest(
      h.event({ id: "a-swap", account: a, offset: DAY + 2 * 3600_000 }),
    );
    await h.ingest(bridge("a1", a, DAY + 3 * 3600_000));
    expect(
      await h.engine.store.listCompletions({ taskId: "bridge-week" }),
    ).toEqual([]);
    const a2 = bridge("a2", a, DAY + 4 * 3600_000);
    await h.ingest(a2);
    await h.ingest(a2); // replay
    await h.ingest(bridge("a3", a, DAY + 5 * 3600_000));
    await h.ingest(bridge("a4", a, DAY + 6 * 3600_000));
    const mine = await h.engine.store.listCompletions({
      taskId: "bridge-week",
      account: a,
    });
    expect(mine.map((x) => [x.status, x.eventIds])).toEqual([
      ["APPROVED", ["a1", "a2"]],
    ]);
    for (const [i, who] of [b, c].entries()) {
      await h.ingest(bridge(`${i}-1`, who, DAY + 7 * 3600_000));
      await h.ingest(bridge(`${i}-2`, who, DAY + 8 * 3600_000));
    }
    const all = await h.engine.store.listCompletions({ taskId: "bridge-week" });
    expect(all.length).toBe(2); // global limit
    // A forged completion that reuses an event is refused by the store itself.
    expect(
      await h.engine.store.insertCompletion(
        { ...mine[0], id: "forged", ordinal: 9, account: c },
        { perUser: 5, global: 5 },
      ),
    ).toBe("EVENT_USED");
  });

  it("a reversal during review voids the completion, so the redone calculation never pays it", async () => {
    const h = harness();
    await h.engine.createTask(
      "ops-a",
      task({ id: "one-swap", criteria: { minCount: 1 } }),
    );
    await h.engine.approveTask("owner-b", "one-swap");
    h.advance(2 * DAY);
    const a = acct("tv");
    await h.ingest(
      h.event({ id: "v1", account: a, offset: DAY + 2 * 3600_000 }),
    );
    await h.ingest(
      h.event({ id: "v2", account: acct("tw"), offset: DAY + 3 * 3600_000 }),
    );
    h.setNow(WEEK + 21_600_000 + 1000);
    const first = await h.settlement.calculate(1, "ops-a");
    expect(
      first.calculation.entries.some(
        (e) => e.kind === "TASK" && e.account === a,
      ),
    ).toBe(true);
    await h.engine.reverse("v1", "REORG_BLOCK_CHANGED", "simulated-verifier");
    expect(
      (
        await h.engine.store.listCompletions({ taskId: "one-swap", account: a })
      )[0].status,
    ).toBe("VOIDED");
    await expect(
      h.settlement.finalize(1, "owner-b", first.calculation.id),
    ).rejects.toThrow("CALCULATION_STALE");
    await h.settlement.reject(1, "owner-b", "reorg during review");
    const second = await h.settlement.calculate(1, "ops-a");
    expect(second.calculation.entries.some((e) => e.account === a)).toBe(false);
  });

  it("review, cancellation and reversal void unpaid completions", async () => {
    const h = harness();
    await h.engine.createTask(
      "ops-a",
      task({ id: "reviewed", requiresReview: true, criteria: { minCount: 1 } }),
    );
    await h.engine.approveTask("owner-b", "reviewed");
    h.advance(2 * DAY);
    const a = acct("tr");
    await h.ingest(
      h.event({ id: "r1", account: a, offset: DAY + 2 * 3600_000 }),
    );
    const [pending] = await h.engine.store.listCompletions({
      taskId: "reviewed",
    });
    expect(pending.status).toBe("PENDING_REVIEW");
    expect(
      (await h.engine.reviewCompletion("owner-b", pending.id, true, "ok"))
        .status,
    ).toBe("APPROVED");
    await h.engine.reverse("r1", "REFUNDED", "simulated-verifier");
    expect(
      (await h.engine.store.listCompletions({ taskId: "reviewed" }))[0].status,
    ).toBe("VOIDED");
    await h.engine.cancelTask("ops-a", "reviewed", "campaign withdrawn");
    expect((await h.engine.store.getTask("reviewed"))?.status).toBe(
      "CANCELLED",
    );
  });
});
