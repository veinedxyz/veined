import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  loadMigrations,
  migrate,
  schemaVersion,
} from "../../src/data/store/migrate";
import { PostgresDefiStore } from "../../src/defi/store";
import { defiFixture, defiWallet, loan } from "../fixtures/defi";
import { deployments } from "../../src/defi/registry";
import { commitDefiWindow, rollbackDefi } from "../../src/defi/indexer";
import { encodeEventTopics, encodeAbiParameters } from "viem";
import { eventAbi } from "../../src/defi/abi";
try {
  process.loadEnvFile(".env.data.local");
} catch {}
const base = process.env.OTHERBRIDGE_DATA_MIGRATOR_URL;
if (!base) throw Error("DB_REQUIRED");
const name = "otherbridge_v113_" + randomBytes(5).toString("hex"),
  url = (db: string) => {
    const u = new URL(base);
    u.pathname = "/" + db;
    return u.toString();
  };
const admin = postgres(url("postgres"), { max: 1, onnotice: () => {} });
let sql: ReturnType<typeof postgres>, store: PostgresDefiStore;
beforeAll(async () => {
  await admin.unsafe("CREATE DATABASE " + name);
  sql = postgres(url(name), { max: 1, onnotice: () => {} });
  const files = await loadMigrations();
  await migrate(sql, files.slice(0, 3));
  expect(await schemaVersion(sql)).toBe(3);
  await migrate(sql, files);
  store = new PostgresDefiStore(sql);
  await store.syncRegistry();
  await sql.unsafe(await readFile("src/data/store/grants.sql", "utf8"));
});
afterAll(async () => {
  await sql?.end();
  await admin.unsafe("DROP DATABASE " + name + " WITH (FORCE)");
  await admin.end();
});
it("accepted schema upgrades additively (V1.13 = 4, V1.14 adds forward-only 5) and repeats checksum-safe", async () => {
  expect(await schemaVersion(sql)).toBe((await loadMigrations()).length);
  expect(await schemaVersion(sql)).toBeGreaterThanOrEqual(4);
  const r = await migrate(sql, await loadMigrations());
  expect(r.applied).toEqual([]);
});
it("registry deployment/adapter uniqueness persists exact chain identity", async () => {
  const rows = await sql`SELECT count(*) AS n FROM defi_protocol_deployments`;
  expect(Number(rows[0].n)).toBe(deployments.length);
  await expect(
    sql`INSERT INTO defi_protocols VALUES('aave-v3','Fake','https://evil.test')`,
  ).rejects.toThrow();
});
it("snapshots disabled by default", async () => {
  await store.record(await defiFixture(), "client-a", 0);
  expect(
    Number((await sql`SELECT count(*) AS n FROM defi_scan_runs`)[0].n),
  ).toBe(0);
});
it("snapshot versioning retains assets, risk and rewards under scoped scan", async () => {
  const a = await defiFixture();
  a.scanId = "version-a";
  await store.record(a, "client-a", 1000);
  expect(
    Number((await sql`SELECT count(*) AS n FROM defi_position_assets`)[0].n),
  ).toBeGreaterThan(0);
  expect(
    Number((await sql`SELECT count(*) AS n FROM defi_position_risk`)[0].n),
  ).toBe(a.positions.length);
  const [row] =
    await sql`SELECT client_scope,wallet_hash FROM defi_scan_runs WHERE id='version-a'`;
  expect(row.wallet_hash).not.toContain(defiWallet);
  expect(row.client_scope).not.toBe("client-a");
});
it("an opt-in scan with unchecked or pending coverage is recorded as PARTIAL", async () => {
  const scan = await defiFixture();
  scan.scanId = "partial-coverage-status";
  scan.coverage[0].state = "NOT_CHECKED";
  scan.coverage[0].result = "UNKNOWN";
  scan.continuation = [scan.coverage[0].deploymentId];
  await store.record(scan, "client-partial", 60000);
  const [row] =
    await sql`SELECT state FROM defi_scan_runs WHERE id=${scan.scanId}`;
  expect(row.state).toBe("PARTIAL");
});
it("retention expiration cascades financial records", async () => {
  await sql`UPDATE defi_scan_runs SET expires_at=now()-interval '1 second'`;
  await store.purge();
  expect(
    Number((await sql`SELECT count(*) AS n FROM defi_position_assets`)[0].n),
  ).toBe(0);
});
it("raw negative debt rejected by DB constraint", async () => {
  const a = await defiFixture();
  a.scanId = "constraint-test";
  await store.record(a, "A", 60000);
  await expect(
    sql`INSERT INTO defi_position_assets VALUES('constraint-test',${a.positions[0].id},999,'borrowed','bad',-1,'{}')`,
  ).rejects.toThrow();
});
it("monitor has no wallet payload visibility", async () => {
  await sql`SET ROLE otherbridge_monitor`;
  try {
    await expect(sql`SELECT wallet_hash FROM defi_scan_runs`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      sql`SELECT payload FROM defi_position_snapshots`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      sql`SELECT state,rpc_calls FROM defi_scan_runs`,
    ).resolves.toBeDefined();
  } finally {
    await sql`RESET ROLE`;
  }
});
it("indexer cannot read private scan snapshots", async () => {
  await sql`SET ROLE otherbridge_indexer`;
  try {
    await expect(sql`SELECT * FROM defi_position_snapshots`).rejects.toThrow(
      /permission denied/,
    );
  } finally {
    await sql`RESET ROLE`;
  }
});
it("API cannot modify discovery/deployment registry", async () => {
  await sql`SET ROLE otherbridge_api`;
  try {
    await expect(
      sql`UPDATE defi_protocol_deployments SET status='fake'`,
    ).rejects.toThrow(/permission denied/);
  } finally {
    await sql`RESET ROLE`;
  }
});
it("ERC721 canonical window rollback rebuilds owner then replay restores fresh ownership", async () => {
  const d = deployments.find((d) => d.id === "uniswap-v3-1")!,
    hash = "0x" + "aa".repeat(32),
    tx = "0x" + "bb".repeat(32);
  const make = (from: string, to: string, block: number) => ({
    address: d.contracts.manager,
    topics: encodeEventTopics({
      abi: eventAbi,
      eventName: "Transfer",
      args: {
        from: from as `0x${string}`,
        to: to as `0x${string}`,
        tokenId: 42n,
      },
    }),
    data: encodeAbiParameters([], []),
    blockNumber: "0x" + block.toString(16),
    blockHash: hash,
    transactionHash: tx.slice(0, -2) + block.toString(16).padStart(2, "0"),
    logIndex: "0x0",
    removed: false,
  });
  await commitDefiWindow(sql, d, 1n, 10n, hash, [make(loan, defiWallet, 5)]);
  await commitDefiWindow(sql, d, 11n, 20n, hash, [make(defiWallet, loan, 15)]);
  expect(
    (
      await sql`SELECT owner_address FROM wallet_nft_positions WHERE token_id=42`
    )[0].owner_address,
  ).toBe(loan);
  await rollbackDefi(sql, d.id, 10n, hash);
  expect(
    (
      await sql`SELECT owner_address FROM wallet_nft_positions WHERE token_id=42`
    )[0].owner_address,
  ).toBe(defiWallet);
  await commitDefiWindow(sql, d, 11n, 20n, hash, [make(defiWallet, loan, 16)]);
  expect(
    (
      await sql`SELECT owner_address FROM wallet_nft_positions WHERE token_id=42`
    )[0].owner_address,
  ).toBe(loan);
});
it("event index gaps fail atomically", async () => {
  const d = deployments.find((d) => d.id === "uniswap-v3-1")!;
  await expect(
    commitDefiWindow(sql, d, 25n, 30n, "0x" + "ab".repeat(32), []),
  ).rejects.toThrow("INDEX_WINDOW_GAP");
});
