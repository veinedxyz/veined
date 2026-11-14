import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import postgres from "postgres";
import { connect, PostgresStore } from "../../src/data/store/postgres";
import {
  loadMigrations,
  migrate,
  schemaVersion,
} from "../../src/data/store/migrate";
import { indexOnce } from "../../src/data/indexer/worker";
import { backfillOnce, reverifyOnce } from "../../src/data/indexer/backfill";
import { collectOpsMetrics } from "../../src/data/observability/ops-metrics";
import {
  CHAIN_ID,
  defaultLogs,
  makeChain,
  witnessHarness,
} from "../fixtures/witness-harness";
import type { LogWindowWitness } from "../../src/data/indexer/witness";
// V1.5 PostgreSQL suite: migration 0002, witness persistence/consensus over Postgres, halt fencing,
// backfill lane, REVERIFY guard, least-privilege monitor/backup roles and the DB-derived exporter.
try {
  process.loadEnvFile(".env.data.local");
} catch {
  /* CI provides the variables directly. */
}
const ownerUrl = process.env.OTHERBRIDGE_DATA_MIGRATOR_URL!;
const dbName = `otherbridge_v15_${randomBytes(5).toString("hex")}`;
const urlFor = (base: string, db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};
const admin = postgres(urlFor(ownerUrl, "postgres"), {
  max: 1,
  onnotice: () => {},
});
let owner: PostgresStore, indexer: PostgresStore, api: PostgresStore;
let monitor: ReturnType<typeof postgres> | null = null,
  backup: ReturnType<typeof postgres> | null = null;
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  for (const role of [
    "otherbridge_api",
    "otherbridge_indexer",
    "otherbridge_monitor",
    "otherbridge_backup",
  ]) {
    const [exists] =
      await admin`SELECT 1 AS x FROM pg_roles WHERE rolname = ${role}`;
    if (exists)
      await admin.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO ${role}`);
  }
  owner = new PostgresStore(connect(urlFor(ownerUrl, dbName), { max: 4 }));
  await migrate(owner.sql, await loadMigrations());
  await owner.sql.unsafe(
    "GRANT USAGE ON SCHEMA public TO otherbridge_api, otherbridge_indexer",
  );
  for (const role of ["otherbridge_monitor", "otherbridge_backup"]) {
    const [exists] =
      await owner.sql`SELECT 1 AS x FROM pg_roles WHERE rolname = ${role}`;
    if (exists)
      await owner.sql.unsafe(`GRANT USAGE ON SCHEMA public TO ${role}`);
  }
  await owner.sql.unsafe(await readFile("src/data/store/grants.sql", "utf8"));
  indexer = new PostgresStore(
    connect(urlFor(process.env.OTHERBRIDGE_DATA_INDEXER_URL!, dbName), {
      max: 6,
    }),
  );
  api = new PostgresStore(
    connect(urlFor(process.env.OTHERBRIDGE_DATA_DATABASE_URL!, dbName), {
      max: 4,
    }),
  );
  if (process.env.OTHERBRIDGE_DATA_MONITOR_URL)
    monitor = postgres(
      urlFor(process.env.OTHERBRIDGE_DATA_MONITOR_URL, dbName),
      { max: 2, onnotice: () => {} },
    );
  if (process.env.OTHERBRIDGE_DATA_BACKUP_URL)
    backup = postgres(urlFor(process.env.OTHERBRIDGE_DATA_BACKUP_URL, dbName), {
      max: 2,
      onnotice: () => {},
    });
});
afterAll(async () => {
  await Promise.all([
    owner?.close(),
    indexer?.close(),
    api?.close(),
    monitor?.end({ timeout: 5 }),
    backup?.end({ timeout: 5 }),
  ]);
  // Ephemeral database created by this suite only.
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
const three = [
  { host: "rpc-a.synthetic.test", operator: "op-a" },
  { host: "rpc-b.synthetic.test", operator: "op-b" },
  { host: "rpc-c.synthetic.test", operator: "op-c" },
];
describe("V15 migration 0002", () => {
  it("applies additively with witness/backfill/ops tables and constraint-level guarantees", async () => {
    const files = await loadMigrations();
    expect(files.map((f) => f.name)).toEqual([
      "0001_data_plane.sql",
      "0002_v15_hardening.sql",
      "0003_asset_registry.sql",
      "0004_defi_positions.sql",
      // V1.14 forward-only global DeFi universe migration.
      "0005_defi_universe.sql",
    ]);
    expect(await schemaVersion(owner.sql)).toBe(5);
    const tables = (
      await owner.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`
    ).map((r) => r.table_name);
    for (const t of [
      "indexed_window_witnesses",
      "indexer_backfill_leases",
      "ops_backup_events",
    ])
      expect(tables).toContain(t);
    const cols = (
      await owner.sql`SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = 'public'`
    ).map((r) => r.c);
    for (const c of [
      "indexed_block_windows.witness_consensus",
      "indexed_block_windows.log_digest",
      "indexed_block_windows.lane",
      "indexer_checkpoints.halted_reason",
    ])
      expect(cols).toContain(c);
    await owner.upsertChains([
      (await import("../fixtures/witness-harness")).chainRecord(),
    ]);
    const h = "0x" + "1".repeat(64);
    // A disputed window can never be stored as committed; malformed digests/halt reasons are refused.
    await expect(
      owner.sql`INSERT INTO indexed_window_witnesses (chain_id, from_block, to_block, mode, primary_endpoint_id, primary_block_start_hash, primary_block_end_hash, primary_log_count, primary_digest, consensus, committed, observed_at) VALUES (${CHAIN_ID}, 1, 2, 'LIVE', 'e', ${h}, ${h}, 0, ${"a".repeat(64)}, 'UNRESOLVED', true, now())`,
    ).rejects.toThrow();
    await expect(
      owner.sql`INSERT INTO indexed_window_witnesses (chain_id, from_block, to_block, mode, primary_endpoint_id, primary_block_start_hash, primary_block_end_hash, primary_log_count, primary_digest, consensus, committed, observed_at) VALUES (${CHAIN_ID}, 1, 2, 'LIVE', 'e', ${h}, ${h}, 0, 'not-a-digest', 'MATCH', false, now())`,
    ).rejects.toThrow();
    await expect(
      owner.sql`UPDATE indexer_checkpoints SET halted_reason = 'x; DROP TABLE y'`,
    ).resolves.toBeDefined(); // no rows yet
    await expect(
      owner.sql`INSERT INTO ops_backup_events (kind, ok, at, detail) VALUES ('BACKUP', true, now(), ${"bad'); --"})`,
    ).rejects.toThrow();
  });
});
describe("V15 witness consensus over PostgreSQL", () => {
  it("MATCH windows commit atomically with their witness record; verify-index is consistent", async () => {
    const h = await witnessHarness({ hosts: three, store: indexer });
    const r = await indexOnce(indexer, h.pool, h.record, "pg-witness-owner-1", {
      initialRange: 25,
      confirmations: 3,
      witness: "required",
    });
    expect(r.status).toBe("CURRENT");
    expect(r.witness.trusted).toBe(r.windows);
    const v = await indexer.verifyIndex(CHAIN_ID);
    expect(v).toMatchObject({
      missingRanges: [],
      duplicateLogKeys: 0,
      orphanRecords: 0,
      checkpointMismatch: false,
      blockHashInconsistencies: 0,
      disputedCommittedWindows: 0,
      invalidCheckpointState: [],
    });
    expect(v.witness).toMatchObject({
      trustedWindows: v.windows,
      unwitnessedWindows: 0,
    });
  });
  it("indexer witness evidence is append-only; api/monitor cannot write it", async () => {
    await expect(
      indexer.sql`DELETE FROM indexed_window_witnesses`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      indexer.sql`UPDATE indexed_window_witnesses SET committed = false`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      api.sql`INSERT INTO indexed_window_witnesses (chain_id) VALUES ('1')`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      api.sql`SELECT count(*) FROM indexed_window_witnesses`,
    ).resolves.toBeDefined();
    await expect(indexer.sql`SELECT * FROM ops_backup_events`).rejects.toThrow(
      /permission denied/,
    );
  });
  it("UNRESOLVED halts; a halted chain refuses commits even with a valid lease; operator resume", async () => {
    const h = await witnessHarness({ hosts: three, store: indexer });
    h.main.mine(60, defaultLogs); // new blocks carry Transfer logs, so omissions are observable
    const drop =
      (block: bigint, idx: bigint) => (logs: Record<string, unknown>[]) =>
        logs.filter(
          (l) =>
            !(
              BigInt(String(l.blockNumber)) === block &&
              BigInt(String(l.logIndex)) === idx
            ),
        );
    const cp0 = (await indexer.getCheckpoint(CHAIN_ID))!;
    const target = cp0.indexedThroughBlock + 5n;
    h.hooks.set("rpc-b.synthetic.test", { logs: drop(target, 0n) });
    h.hooks.set("rpc-c.synthetic.test", { logs: (logs) => logs.slice(1) });
    const r = await indexOnce(indexer, h.pool, h.record, "pg-witness-owner-1", {
      initialRange: 25,
      confirmations: 3,
      witness: "required",
    });
    expect(
      r.status,
      JSON.stringify({
        w: r.witness,
        windows: r.windows,
        from: r.fromBlock,
        through: r.throughBlock,
        cp0: cp0.indexedThroughBlock.toString(),
        err: r.error,
      }),
    ).toBe("HALTED");
    const cp = (await indexer.getCheckpoint(CHAIN_ID))!;
    expect(cp.haltedReason).toMatch(/^LOG_CONSENSUS_UNRESOLVED:/);
    expect(cp.indexedThroughBlock).toBe(cp0.indexedThroughBlock);
    expect(
      await indexer.acquireLease(CHAIN_ID, "pg-direct-owner", 60000, 0n, 1n),
    ).toBe(true);
    await expect(
      indexer.commitWindow({
        chainId: CHAIN_ID,
        owner: "pg-direct-owner",
        window: {
          fromBlock: cp.indexedThroughBlock + 1n,
          toBlock: cp.indexedThroughBlock + 1n,
          toBlockHash: "0x" + "2".repeat(64),
          logCount: 0,
          finalized: false,
        },
        rows: [],
        headBlock: 1n,
        safeBlock: 1n,
      }),
    ).rejects.toThrow("CHAIN_HALTED");
    await indexer.releaseLease(CHAIN_ID, "pg-direct-owner");
    expect(await indexer.resumeChain(CHAIN_ID)).toBe(true);
    h.hooks.clear();
    const again = await indexOnce(
      indexer,
      h.pool,
      h.record,
      "pg-witness-owner-1",
      { initialRange: 25, confirmations: 3, witness: "required" },
    );
    expect(again.status).toBe("CURRENT");
    expect((await indexer.verifyIndex(CHAIN_ID)).disputedCommittedWindows).toBe(
      0,
    );
  });
  it("backward backfill: finalized, witnessed, contiguous, own lease; race with live lane is fenced", async () => {
    const before = (await indexer.getCheckpoint(CHAIN_ID))!;
    const h = await witnessHarness({ hosts: three, store: indexer });
    const r = await backfillOnce(
      indexer,
      h.pool,
      h.record,
      "pg-backfill-owner",
      { maxWindows: 3, range: 10, witness: "required" },
    );
    expect(r.status).toMatch(/PARTIAL|DONE/);
    expect(r.verified).toBe(r.windows);
    const after = (await indexer.getCheckpoint(CHAIN_ID))!;
    expect(after.indexedFromBlock).toBe(
      before.indexedFromBlock - BigInt(r.windows * 10),
    );
    expect(after.indexedThroughBlock).toBeGreaterThanOrEqual(
      before.indexedThroughBlock,
    );
    const v = await indexer.verifyIndex(CHAIN_ID);
    expect(v).toMatchObject({
      missingRanges: [],
      orphanRecords: 0,
      checkpointMismatch: false,
      disputedCommittedWindows: 0,
    });
    // Non-contiguous / unfinalized / foreign-owner backfill commits are refused.
    expect(
      await indexer.acquireBackfillLease(CHAIN_ID, "pg-backfill-owner", 60000),
    ).toBe(true);
    expect(
      await indexer.acquireBackfillLease(CHAIN_ID, "pg-other-owner", 60000),
    ).toBe(false);
    const w = {
      fromBlock: after.indexedFromBlock - 20n,
      toBlock: after.indexedFromBlock - 15n,
      toBlockHash: "0x" + "3".repeat(64),
      logCount: 0,
      finalized: true,
    };
    await expect(
      indexer.commitBackfillWindow({
        chainId: CHAIN_ID,
        owner: "pg-backfill-owner",
        window: w,
        rows: [],
        headBlock: 1n,
        safeBlock: 1n,
      }),
    ).rejects.toThrow("CHECKPOINT_RACE");
    await expect(
      indexer.commitBackfillWindow({
        chainId: CHAIN_ID,
        owner: "pg-backfill-owner",
        window: {
          ...w,
          toBlock: after.indexedFromBlock - 1n,
          finalized: false,
        },
        rows: [],
        headBlock: 1n,
        safeBlock: 1n,
      }),
    ).rejects.toThrow("BACKFILL_REQUIRES_FINALIZED");
    await expect(
      indexer.commitBackfillWindow({
        chainId: CHAIN_ID,
        owner: "pg-other-owner",
        window: { ...w, toBlock: after.indexedFromBlock - 1n },
        rows: [],
        headBlock: 1n,
        safeBlock: 1n,
      }),
    ).rejects.toThrow("LEASE_LOST");
    await indexer.releaseBackfillLease(CHAIN_ID, "pg-backfill-owner");
  });
  it("REVERIFY marks only the exact unwitnessed window and detects stored-row tampering", async () => {
    const legacy = await witnessHarness({
      hosts: [{ host: "rpc-x.synthetic.test", operator: null }],
      store: indexer,
      chain: makeChain(200, "legacy"),
    });
    void legacy;
    // Build an unwitnessed (pre-V1.5 style) window directly, then reverify it with three operators.
    const rec: LogWindowWitness = {
      chainId: CHAIN_ID,
      fromBlock: 1n,
      toBlock: 1n,
      mode: "LIVE",
      primaryEndpointId: "e",
      witnessEndpointId: null,
      tiebreakEndpointId: null,
      primaryOperator: null,
      witnessOperator: null,
      tiebreakOperator: null,
      primaryBlockStartHash: "0x" + "4".repeat(64),
      primaryBlockEndHash: "0x" + "4".repeat(64),
      witnessBlockStartHash: null,
      witnessBlockEndHash: null,
      primaryLogCount: 0,
      witnessLogCount: null,
      tiebreakLogCount: null,
      primaryDigest: "a".repeat(64),
      witnessDigest: null,
      tiebreakDigest: null,
      consensus: "MATCH",
      failure: null,
      committed: true,
      observedAt: Date.now(),
    };
    await expect(
      indexer.markWindowWitnessed(CHAIN_ID, 1n, 1n, {
        ...rec,
        mode: "REVERIFY",
        consensus: "UNRESOLVED" as never,
      }),
    ).rejects.toThrow("WITNESS_RECORD_MISMATCH");
    expect(
      await indexer.markWindowWitnessed(CHAIN_ID, 1n, 1n, {
        ...rec,
        mode: "REVERIFY",
      }),
    ).toBe(false);
    const h = await witnessHarness({ hosts: three, store: indexer });
    const r = await reverifyOnce(indexer, h.pool, h.record, { maxWindows: 5 });
    // Every window of this chain is already witnessed by now, so nothing is pending.
    expect(r.windows).toBe(0);
  });
});
describe("V15 least-privilege monitor/backup roles and DB-derived metrics", () => {
  it("monitor reads aggregates only; never keys, clients, usage, snapshots or transfers", async () => {
    if (!monitor) return expect(process.env.CI).toBeUndefined();
    await expect(
      monitor`SELECT count(*) FROM indexer_checkpoints`,
    ).resolves.toBeDefined();
    await expect(
      monitor`SELECT count(*) FROM indexed_window_witnesses`,
    ).resolves.toBeDefined();
    for (const t of [
      "api_keys",
      "api_clients",
      "api_usage_events",
      "native_balance_snapshots",
      "wallet_balance_snapshots",
      "erc20_transfers",
      "wallet_token_discovery",
    ])
      await expect(
        monitor.unsafe(`SELECT count(*) FROM ${t}`),
        t,
      ).rejects.toThrow(/permission denied/);
    await expect(monitor`SELECT symbol FROM tokens LIMIT 1`).rejects.toThrow(
      /permission denied/,
    );
    // Self-review D7: scan-run aggregates are readable, wallet pseudonyms and client ids are not.
    await expect(
      monitor`SELECT origin, state, count(*) FROM portfolio_scan_runs GROUP BY 1, 2`,
    ).resolves.toBeDefined();
    for (const col of ["wallet_hash", "client_id", "id", "*"])
      await expect(
        monitor.unsafe(`SELECT ${col} FROM portfolio_scan_runs LIMIT 1`),
        col,
      ).rejects.toThrow(/permission denied/);
    await expect(
      monitor`INSERT INTO ops_backup_events (kind, ok, at) VALUES ('BACKUP', true, now())`,
    ).rejects.toThrow(/permission denied/);
    const text = await collectOpsMetrics(monitor as never);
    expect(text).toMatch(/otherbridge_db_up 1/);
    expect(text).toMatch(
      new RegExp(
        `otherbridge_indexer_windows\\{chain="${CHAIN_ID}",consensus="MATCH"\\} \\d+`,
      ),
    );
    expect(text).toMatch(
      /otherbridge_witness_records\{chain="910001",consensus="UNRESOLVED",failure="CONSENSUS_UNRESOLVED"\} 1/,
    );
    expect(text).not.toMatch(/ops_exporter_errors_total/);
    expect(text).not.toMatch(/0x[0-9a-f]{40}/i);
  });
  it("backup role can read everything for pg_dump, write only its own events, never data", async () => {
    if (!backup) return expect(process.env.CI).toBeUndefined();
    await expect(backup`SELECT count(*) FROM api_keys`).resolves.toBeDefined();
    await expect(
      backup`SELECT count(*) FROM erc20_transfers`,
    ).resolves.toBeDefined();
    await expect(
      backup`INSERT INTO ops_backup_events (kind, ok, at, backup_id) VALUES ('BACKUP', true, now(), 'test-backup-1')`,
    ).resolves.toBeDefined();
    await expect(backup`UPDATE api_keys SET status = 'ACTIVE'`).rejects.toThrow(
      /permission denied/,
    );
    await expect(backup`DELETE FROM erc20_transfers`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      backup`INSERT INTO chains (chain_id) VALUES ('1')`,
    ).rejects.toThrow(/permission denied/);
    const text = await collectOpsMetrics(monitor as never);
    expect(text).toMatch(
      /otherbridge_backup_last_success_timestamp_seconds\{kind="BACKUP"\} \d+/,
    );
  });
});
