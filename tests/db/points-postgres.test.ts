import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { loadPointsMigrations, migratePoints } from "../../src/points/migrate";
import { PostgresPointsStore } from "../../src/points/postgres-store";
import { WEEKLY_POOL_UNITS } from "../../src/points/units";
import { acct, harness, WEEK } from "../helpers/points";
// Points migration proposal and durable store against a real, THROWAWAY PostgreSQL (isolated container started
// for this run only; never a shared, staging or production database). Fails closed without one.
const base = process.env.VEINED_POINTS_TEST_DATABASE_URL;
if (!base)
  throw Error(
    "Points DB suite requires VEINED_POINTS_TEST_DATABASE_URL (throwaway PostgreSQL only)",
  );
const db = `veined_points_test_${randomBytes(5).toString("hex")}`;
const url = (name: string) => {
  const u = new URL(base);
  u.pathname = `/${name}`;
  return u.toString();
};
let admin: Sql;
let sql: Sql;
const stores: PostgresPointsStore[] = [];
const GRACE = 21_600_000;

beforeAll(async () => {
  admin = postgres(base, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${db}`);
  sql = postgres(url(db), { max: 4, onnotice: () => {} });
});
afterAll(async () => {
  for (const s of stores) await s.close();
  await sql?.end({ timeout: 5 });
  await admin?.unsafe(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  await admin?.end({ timeout: 5 });
});
const store = async () => {
  const s = await PostgresPointsStore.connect(url(db), { max: 4 });
  stores.push(s);
  return s;
};

describe("points schema proposal (PostgreSQL)", () => {
  it("refuses an unmigrated database, then migrates once, up-only and checksum-pinned", async () => {
    await expect(PostgresPointsStore.connect(url(db))).rejects.toThrow(
      "POINTS_SCHEMA_NOT_MIGRATED",
    );
    const files = await loadPointsMigrations();
    expect(files.map((f) => f.name)).toEqual(["0001_weekly_points.sql"]);
    expect(await migratePoints(sql)).toEqual({
      applied: ["0001_weekly_points.sql"],
      schemaVersion: 1,
    });
    expect(await migratePoints(sql)).toEqual({ applied: [], schemaVersion: 1 });
    const tables = await sql<
      { t: string }[]
    >`SELECT table_name AS t FROM information_schema.tables
      WHERE table_schema = 'veined_points' ORDER BY table_name`;
    expect(tables.map((r) => r.t)).toEqual([
      "account_flag",
      "activity",
      "audit_log",
      "correction",
      "lease_lock",
      "ledger_entry",
      "referral_binding",
      "referral_code",
      "season",
      "task",
      "task_completion",
    ]);
  });

  it("runs the full engine on Postgres: dedupe, referral, settlement, budget, immutability", async () => {
    const h = harness({ store: await store() });
    const [p, c, w] = ["pp", "pc", "pw"].map(acct);
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
      h.event({ id: "w1", account: w, offset: 3000, usd: 50_000_000 }),
    );
    const dupSwap = h.event({
      id: "d1",
      account: w,
      offset: 4000,
      operation: "same-op",
    });
    const dupTrade = h.event({
      id: "d2",
      account: w,
      offset: 4000,
      operation: "same-op",
      category: "TRADE",
    });
    expect((await h.ingest(dupSwap)).result).toBe("ELIGIBLE");
    expect((await h.ingest(dupTrade)).record?.reason).toBe(
      "DUPLICATE_OPERATION",
    );
    expect((await h.ingest(dupSwap)).result).toBe("DUPLICATE_REPLAY");
    expect((await h.engine.store.getBinding(c))?.parent).toBe(p);

    h.setNow(WEEK + GRACE + 1000);
    // Two independent pools against one database stand in for two application processes.
    const other = harness({ store: await store() });
    other.setNow(WEEK + GRACE + 1000);
    const calcs = await Promise.allSettled([
      ...Array.from({ length: 4 }, () => h.settlement.calculate(1, "ops-a")),
      ...Array.from({ length: 4 }, () =>
        other.settlement.calculate(1, "ops-a"),
      ),
    ]);
    const fulfilled = calcs.filter(
      (r) => r.status === "fulfilled",
    ) as PromiseFulfilledResult<{
      calculation: { id: string };
      idempotent: boolean;
    }>[];
    expect(fulfilled.filter((r) => !r.value.idempotent).length).toBe(1);
    for (const r of calcs.filter((x) => x.status === "rejected"))
      expect(String((r as PromiseRejectedResult).reason)).toMatch(
        /SETTLEMENT_LOCKED|SETTLEMENT_CONFLICT/,
      );
    const id = fulfilled[0].value.calculation.id;
    await Promise.allSettled([
      ...Array.from({ length: 4 }, () =>
        h.settlement.finalize(1, "owner-b", id),
      ),
      ...Array.from({ length: 4 }, () =>
        other.settlement.finalize(1, "owner-b", id),
      ),
    ]);
    const season = (await h.engine.store.getSeason(1))!;
    expect(season.state).toBe("FINALIZED");
    const ledger = await h.engine.store.listLedger({ season: 1 });
    expect(ledger.length).toBe(season.calculation!.entries.length);
    const [{ total }] = await sql<
      { total: string }[]
    >`SELECT SUM(amount_units)::text AS total FROM veined_points.ledger_entry WHERE season = 1`;
    expect(total).toBe(season.calculation!.summary.allocatedUnits);
    expect(BigInt(total) <= WEEKLY_POOL_UNITS).toBe(true);
    expect(
      ledger
        .filter((e) => e.kind === "REFERRAL_COMMISSION")
        .every((e) => e.account === p),
    ).toBe(true);

    // The schema itself refuses rewriting history and breaking the weekly budget.
    await expect(
      sql`UPDATE veined_points.ledger_entry SET amount_units = 1 WHERE season = 1`,
    ).rejects.toThrow(/IMMUTABLE/);
    await expect(
      sql`DELETE FROM veined_points.ledger_entry WHERE season = 1`,
    ).rejects.toThrow(/IMMUTABLE/);
    await expect(
      sql`UPDATE veined_points.audit_log SET actor = 'x'`,
    ).rejects.toThrow(/IMMUTABLE/);
    await expect(
      sql`INSERT INTO veined_points.ledger_entry (id, season, account, kind, amount_units, source_ref, record, created_at)
          VALUES ('s1:forged', 1, 'x', 'ACTIVITY', ${WEEKLY_POOL_UNITS.toString()}, 'x', '{}'::jsonb, now())`,
    ).rejects.toThrow(/BUDGET_EXCEEDED/);
    await expect(
      sql`INSERT INTO veined_points.ledger_entry (id, season, account, kind, amount_units, source_ref, record, created_at)
          VALUES ('s1:negative', 1, 'x', 'ACTIVITY', -5, 'x', '{}'::jsonb, now())`,
    ).rejects.toThrow();
    await expect(
      sql`INSERT INTO veined_points.referral_binding (child, parent, record) VALUES ('a', 'a', '{}'::jsonb)`,
    ).rejects.toThrow();

    // Publication and a post-publication clawback keep the ledger within budget.
    await h.settlement.publish(1, "owner-b");
    await h.engine.reverse("c1", "REORG_BLOCK_CHANGED", "simulated-verifier");
    const correction = await h.settlement.proposeCorrection(1, "c1", "ops-a");
    await h.settlement.decideCorrection(correction.id, "owner-b", true);
    const after = await h.engine.store.listLedger({ season: 1 });
    expect(after.length).toBe(ledger.length + correction.entries.length);
    expect(
      after.reduce((s, e) => s + BigInt(e.amountUnits), 0n) < BigInt(total),
    ).toBe(true);
    expect((await h.views.leaderboard(1))?.amended).toBe(true);

    // Audit chain: consecutive sequence, each record committing to its predecessor.
    const audit = await h.engine.store.listAudit(1000);
    for (let i = 1; i < audit.length; i++) {
      expect(audit[i].seq).toBe(audit[i - 1].seq + 1);
      expect(audit[i].prevHash).toBe(audit[i - 1].hash);
    }
  });

  it("lease locks are exclusive across processes and fenced", async () => {
    const a = await store();
    const b = await store();
    const now = new Date();
    const t1 = await a.acquireLock("test:lock", "owner-1", 60_000, now);
    expect(t1).not.toBeNull();
    expect(await b.acquireLock("test:lock", "owner-2", 60_000, now)).toBeNull();
    const later = new Date(now.getTime() + 61_000);
    const t2 = await b.acquireLock("test:lock", "owner-2", 60_000, later);
    expect(t2! > t1!).toBe(true);
    expect(await a.checkLock("test:lock", t1!, later)).toBe(false);
    expect(await b.checkLock("test:lock", t2!, later)).toBe(true);
    await a.releaseLock("test:lock", t1!); // stale token: no effect
    expect(await b.checkLock("test:lock", t2!, later)).toBe(true);
  });

  it("task completions respect limits and single event use under concurrency", async () => {
    const s = await store();
    const task = {
      id: "pg-task",
      title: "PG task",
      description: "",
      criteria: { minCount: 1 },
      weight: "10",
      perUserLimit: 1,
      globalLimit: 3,
      startsAt: "2026-11-09T00:00:00.000Z",
      endsAt: "2026-11-15T00:00:00.000Z",
      requiresReview: false,
      status: "APPROVED" as const,
      version: 1,
      createdBy: "ops-a",
      createdAt: "2026-11-09T00:00:00.000Z",
    };
    expect(await s.insertTask(task)).toBe("INSERTED");
    const completion = (n: number, account: string, event: string) => ({
      id: `pg-task:${account}:${n}`,
      taskId: "pg-task",
      account,
      ordinal: n,
      season: 1,
      completedAt: "2026-11-10T00:00:00.000Z",
      eventIds: [event],
      weight: "10",
      status: "APPROVED" as const,
      revision: 1,
    });
    const results = await Promise.all([
      ...Array.from({ length: 6 }, (_, i) =>
        s.insertCompletion(completion(1, `acct-${i}`, `ev-${i}`), {
          perUser: 1,
          global: 3,
        }),
      ),
      s.insertCompletion(completion(2, "acct-0", "ev-x"), {
        perUser: 1,
        global: 3,
      }),
      s.insertCompletion(completion(1, "acct-9", "ev-0"), {
        perUser: 1,
        global: 3,
      }),
    ]);
    expect(results.filter((r) => r === "INSERTED").length).toBe(3);
    expect(
      results.every((r) =>
        ["INSERTED", "GLOBAL_LIMIT", "USER_LIMIT", "EVENT_USED"].includes(r),
      ),
    ).toBe(true);
  });
});
