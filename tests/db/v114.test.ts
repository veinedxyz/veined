import { beforeAll, afterAll, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import postgres from "postgres";
import {
  encodeAbiParameters,
  keccak256,
  toEventSelector,
  type Hex,
} from "viem";
import {
  loadMigrations,
  migrate,
  schemaVersion,
} from "../../src/data/store/migrate";
import { PostgresDefiStore } from "../../src/defi/store";
import {
  normalizeUniverse,
  parseChainlistText,
  type RawSources,
} from "../../src/defi/universe/normalize";
import { buildIndex } from "../../src/defi/universe/store";
import { buildQueue } from "../../src/defi/universe/queue";
import { loadUniverseIntoDb } from "../../src/defi/universe/db";
import type { Universe } from "../../src/defi/universe/model";
import { buildReverseIndex } from "../../src/defi/reverse-index";
import { deployments } from "../../src/defi/registry";
import { indexLaneOnce, LANES, type LogSource } from "../../src/defi/lanes";
import { defiFixture } from "../fixtures/defi";
// V1.14 real PostgreSQL suite (isolated throwaway database). Synthetic catalog fixtures and a synthetic log source.
try {
  process.loadEnvFile(".env.data.local");
} catch {}
const base = process.env.OTHERBRIDGE_DATA_MIGRATOR_URL;
if (!base) throw Error("DB_REQUIRED");
const name = "otherbridge_v114_" + randomBytes(5).toString("hex"),
  url = (db: string) => {
    const u = new URL(base);
    u.pathname = "/" + db;
    return u.toString();
  };
const admin = postgres(url("postgres"), { max: 1, onnotice: () => {} });
let sql: ReturnType<typeof postgres>;
const dir = "tests/fixtures/defi-universe/";
const raw = (): RawSources & { protocols: Record<string, unknown>[] } => ({
  protocols: JSON.parse(readFileSync(dir + "protocols.json", "utf8")),
  chains: JSON.parse(readFileSync(dir + "chains.json", "utf8")),
  config: JSON.parse(readFileSync(dir + "config.json", "utf8")),
});
const normalize = (r: RawSources, syncId: string, previous?: Universe) =>
  normalizeUniverse(r, {
    syncId,
    generatedAt: "2026-10-11T00:00:00.000Z",
    sources: [],
    previous,
    identities: [
      {
        id: "1",
        chainId: "1",
        caip2: "eip155:1",
        name: "Ethereum",
        ecosystem: "EVM",
      },
    ],
    chainlist: parseChainlistText(readFileSync(dir + "chainIds.js", "utf8")),
  }).universe;
const load = (u: Universe) => {
  const index = buildIndex(
    u,
    keccak256(Buffer.from(u.syncId) as unknown as Hex).slice(2),
  );
  return loadUniverseIntoDb(
    sql,
    index,
    { syncId: u.syncId, fixture: true },
    buildQueue(index),
    buildReverseIndex(deployments),
    [
      {
        id: "fixture-protocols",
        url: "https://fixture.invalid/protocols.json",
        revision: null,
        sha256: null,
        bytes: null,
        license: "LEGAL_REVIEW_REQUIRED",
        use: "catalog metadata",
      },
    ],
  );
};
beforeAll(async () => {
  await admin.unsafe("CREATE DATABASE " + name);
  sql = postgres(url(name), { max: 1, onnotice: () => {} });
  const files = await loadMigrations();
  await migrate(sql, files.slice(0, 4));
  expect(await schemaVersion(sql)).toBe(4);
  await migrate(sql, files);
  await new PostgresDefiStore(sql).syncRegistry();
  await sql.unsafe(await readFile("src/data/store/grants.sql", "utf8"));
});
afterAll(async () => {
  await sql?.end();
  await admin.unsafe("DROP DATABASE " + name + " WITH (FORCE)");
  await admin.end();
});
it("the accepted V1.13 schema upgrades forward-only to version 5 and repeats checksum-safe", async () => {
  expect(await schemaVersion(sql)).toBe(5);
  expect((await migrate(sql, await loadMigrations())).applied).toEqual([]);
  const tables = (
    await sql`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'defi_%'`
  ).map((r) => r.tablename);
  for (const t of [
    "defi_universe_syncs",
    "defi_catalog_chains",
    "defi_catalog_protocols",
    "defi_catalog_protocol_chains",
    "defi_coverage",
    "defi_adapter_queue",
    "defi_contract_index",
    "defi_index_lanes",
    "defi_index_lane_windows",
    "defi_registry_entries",
    "defi_scan_receipts",
    "defi_deployment_candidates",
    "defi_source_revisions",
  ])
    expect(tables).toContain(t);
});
it("an accepted catalog loads transactionally and idempotently with coverage, queue and reverse index", async () => {
  const u = normalize(raw(), "fixture-db-1");
  expect((await load(u)).state).not.toBe("ALREADY_LOADED");
  expect((await load(u)).state).toBe("ALREADY_LOADED");
  const count = async (t: string) =>
    Number((await sql.unsafe(`SELECT count(*) AS n FROM ${t}`))[0].n);
  expect(await count("defi_catalog_protocols")).toBe(u.protocols.length);
  expect(await count("defi_catalog_protocol_chains")).toBe(u.rows.length);
  expect(await count("defi_coverage")).toBeGreaterThanOrEqual(
    u.protocols.length,
  );
  expect(await count("defi_contract_index")).toBe(
    new Set(
      buildReverseIndex(deployments).map((e) =>
        [e.chainId, e.contract, e.deploymentId, e.role].join("|"),
      ),
    ).size,
  );
  const [aave] =
    await sql`SELECT status FROM defi_coverage WHERE sync_id='fixture-db-1' AND protocol_id='llama:1599' AND status='FULL_POSITION'`;
  expect(aave).toBeDefined();
});
it("a later sync never deletes identity: removed protocols stay as REMOVED_UPSTREAM", async () => {
  const first = normalize(raw(), "fixture-db-1");
  const r = raw();
  r.protocols = r.protocols.filter((p) => p.id !== "2198");
  const second = normalize(r, "fixture-db-2", first);
  await load(second);
  const [row] =
    await sql`SELECT status, first_seen FROM defi_catalog_protocols WHERE protocol_id='llama:2198'`;
  expect(row.status).toBe("REMOVED_UPSTREAM");
  expect(row.first_seen).toBe(
    first.protocols.find((p) => p.llamaId === "2198")!.firstSeen,
  );
  expect(
    Number((await sql`SELECT count(*) AS n FROM defi_universe_syncs`)[0].n),
  ).toBe(2);
});
it("catalog constraints reject malformed identities and roles", async () => {
  await expect(
    sql`INSERT INTO defi_catalog_chains VALUES('Ethereum; DROP','x','EVM',NULL,'ACTIVE','MAPPED',NULL,'a','a','{}')`,
  ).rejects.toThrow();
  await expect(
    sql`INSERT INTO defi_contract_index VALUES('1','0x' || repeat('a',40),'d','p','x',NULL,'signer','s')`,
  ).rejects.toThrow();
  await expect(
    sql`INSERT INTO defi_contract_index VALUES('1','0xABC','d','p','x',NULL,'pool','s')`,
  ).rejects.toThrow();
});
// Synthetic canonical chain for one Morpho registry lane: deterministic hashes per (block, fork).
const d = deployments.find((x) => x.id === "morpho-blue-1")!;
const spec = LANES["morpho-blue"]![0];
const start = BigInt(d.startBlock!);
const marketLog = (block: bigint, fork: number, salt: number) => {
  const params = [
    "0x" + (0xa0 + salt).toString(16).padStart(40, "0"),
    "0x" + "b".repeat(40),
    "0x" + "c".repeat(40),
    d.contracts.irm,
    86n * 10n ** 16n,
  ] as unknown as readonly [Hex, Hex, Hex, Hex, bigint];
  const id = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      params,
    ),
  );
  return {
    address: d.contracts.blue,
    topics: [toEventSelector(spec.signature), id],
    data: encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: "address" },
            { type: "uint256" },
          ],
        },
      ],
      [params],
    ),
    blockNumber: "0x" + block.toString(16),
    blockHash: hashAt(block, fork),
    transactionHash: keccak256(
      ("0x" +
        block.toString(16).padStart(2, "0") +
        salt.toString(16).padStart(2, "0")) as Hex,
    ),
    logIndex: "0x0",
  };
};
const hashAt = (block: bigint, fork: number) =>
  keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [block, BigInt(fork)],
    ),
  );
function source(state: {
  fork: (b: bigint) => number;
  head: bigint;
  corrupt?: boolean;
}): LogSource {
  return {
    id: "synthetic-log-source",
    async head() {
      return state.head;
    },
    async blockHash(b) {
      return hashAt(b, state.fork(b));
    },
    async logs(_address, _topic, from, to) {
      return [10n, 1500n, 2900n]
        .map((o) => start + o)
        .filter((b) => b >= from && b <= to)
        .map((b, i) => {
          const l = marketLog(b, state.fork(b), Number(b - start) % 251);
          return state.corrupt && i === 0
            ? { ...l, blockHash: hashAt(b, 99) }
            : l;
        });
    },
  };
}
const entries = async () =>
  (
    await sql`SELECT entry_key, source_block FROM defi_registry_entries WHERE deployment_id=${d.id} AND lane=${spec.lane} ORDER BY source_block`
  ).map((r) => String(r.source_block));
it("a registry lane backfills without gaps to the finalized head and records canonical windows", async () => {
  const s = source({ fork: () => 0, head: start + 3000n });
  let r = await indexLaneOnce(sql, s, d, spec, {
    range: 1000n,
    finality: 64n,
    maxWindows: 2,
  });
  expect(r.state).toBe("PARTIAL");
  r = await indexLaneOnce(sql, s, d, spec, { range: 1000n, finality: 64n });
  expect(r).toMatchObject({
    state: "CURRENT",
    historicalComplete: true,
    indexedThrough: (start + 2936n).toString(),
  });
  expect(await entries()).toEqual(
    [start + 10n, start + 1500n, start + 2900n].map(String),
  );
  const windows =
    await sql`SELECT from_block, to_block FROM defi_index_lane_windows WHERE deployment_id=${d.id} AND lane=${spec.lane} ORDER BY to_block`;
  for (let i = 1; i < windows.length; i++)
    expect(BigInt(windows[i].from_block)).toBe(
      BigInt(windows[i - 1].to_block) + 1n,
    );
  expect(BigInt(windows[0].from_block)).toBe(start);
});
it("a reorg rolls the lane back to the newest canonical window and replays the new branch", async () => {
  const reorgAt = start + 2500n;
  const s = source({
    fork: (b) => (b >= reorgAt ? 1 : 0),
    head: start + 3000n,
  });
  const back = await indexLaneOnce(sql, s, d, spec, {
    range: 1000n,
    finality: 64n,
  });
  expect(back.state).toBe("ROLLED_BACK");
  expect(BigInt((back as { ancestor: string }).ancestor)).toBeLessThan(reorgAt);
  expect(await entries()).toEqual([start + 10n, start + 1500n].map(String));
  const [cp] =
    await sql`SELECT historical_complete FROM defi_index_lanes WHERE deployment_id=${d.id} AND lane=${spec.lane}`;
  expect(cp.historical_complete).toBe(false);
  const again = await indexLaneOnce(sql, s, d, spec, {
    range: 1000n,
    finality: 64n,
  });
  expect(again).toMatchObject({ state: "CURRENT", historicalComplete: true });
  const [replayed] =
    await sql`SELECT source_hash FROM defi_registry_entries WHERE deployment_id=${d.id} AND lane=${spec.lane} AND source_block=${(start + 2900n).toString()}`;
  expect(replayed.source_hash).toBe(hashAt(start + 2900n, 1));
});
it("a non-canonical log aborts the window atomically", async () => {
  await sql`DELETE FROM defi_registry_entries WHERE deployment_id=${d.id}`;
  await sql`DELETE FROM defi_index_lane_windows WHERE deployment_id=${d.id}`;
  await sql`DELETE FROM defi_index_lanes WHERE deployment_id=${d.id}`;
  const s = source({ fork: () => 0, head: start + 3000n, corrupt: true });
  await expect(
    indexLaneOnce(sql, s, d, spec, { range: 1000n, finality: 64n }),
  ).rejects.toThrow("NONCANONICAL_LOG");
  expect(await entries()).toEqual([]);
  expect(
    (
      await sql`SELECT count(*) AS n FROM defi_index_lanes WHERE deployment_id=${d.id}`
    )[0].n,
  ).toBe("0");
});
it("registry-complete discovery reads the lane only when it is historically complete", async () => {
  const store = new PostgresDefiStore(sql);
  const s = source({ fork: () => 0, head: start + 3000n });
  await indexLaneOnce(sql, s, d, spec, {
    range: 1000n,
    finality: 64n,
    maxWindows: 1,
  });
  expect(
    (await store.refs(d.id, "0x28136a77ec8ba3d918114712a588b4095ba12a6b", 4096))
      .complete,
  ).toBe(false);
  await indexLaneOnce(sql, s, d, spec, { range: 1000n, finality: 64n });
  const done = await store.refs(
    d.id,
    "0x28136a77ec8ba3d918114712a588b4095ba12a6b",
    4096,
  );
  expect(done.complete).toBe(true);
  expect(done.refs.map((r) => r.marketId).sort()).toEqual(
    (
      await sql`SELECT entry_key FROM defi_registry_entries WHERE deployment_id=${d.id}`
    )
      .map((r) => r.entry_key)
      .sort(),
  );
});
it("an opt-in scan stores its receipt with the run (pseudonymous, cascades on expiry)", async () => {
  const scan = await defiFixture();
  scan.scanId = "receipt-run";
  scan.receipt = {
    catalogVersion: "fixture-db-2",
    chainsConsidered: 1,
    chainsChecked: 1,
    funnel: {
      universeRows: 10,
      chainRelevantRows: 5,
      candidateDeployments: 3,
      adaptersRun: 2,
    },
    signals: { RECEIPT_TOKEN: 1 },
    candidateProtocols: ["aave-v3"],
    skipped: [{ deploymentId: "curve-1", reason: "NO_RECEIPT_CANDIDATE" }],
    failed: 0,
    checkedZero: 1,
    nonzero: 1,
    positions: scan.positions.length,
    unpriced: 0,
    unpricedDebt: 0,
    durationMs: 10,
    rpcCalls: 20,
    slowest: null,
  };
  await new PostgresDefiStore(sql).record(scan, "client-a", 5000);
  const [row] =
    await sql`SELECT catalog_version, payload FROM defi_scan_receipts WHERE scan_id='receipt-run'`;
  expect(row.catalog_version).toBe("fixture-db-2");
  expect(JSON.stringify(row.payload)).not.toContain(scan.wallet);
  await sql`UPDATE defi_scan_runs SET expires_at = now() - interval '1 second' WHERE id='receipt-run'`;
  await new PostgresDefiStore(sql).purge();
  expect((await sql`SELECT count(*) AS n FROM defi_scan_receipts`)[0].n).toBe(
    "0",
  );
});
it("roles: the indexer cannot read scan receipts, the API cannot write the catalog, the monitor sees no payloads", async () => {
  await sql`SET ROLE otherbridge_indexer`;
  try {
    await expect(sql`SELECT * FROM defi_scan_receipts`).rejects.toThrow();
  } finally {
    await sql`RESET ROLE`;
  }
  await sql`SET ROLE otherbridge_api`;
  try {
    expect(
      (await sql`SELECT count(*) AS n FROM defi_catalog_protocols`)[0].n,
    ).not.toBe("0");
    await expect(
      sql`UPDATE defi_catalog_protocols SET name='x'`,
    ).rejects.toThrow();
    await expect(sql`DELETE FROM defi_registry_entries`).rejects.toThrow();
  } finally {
    await sql`RESET ROLE`;
  }
  await sql`SET ROLE otherbridge_monitor`;
  try {
    await expect(
      sql`SELECT receipt FROM defi_universe_syncs`,
    ).rejects.toThrow();
    expect((await sql`SELECT sync_id FROM defi_universe_syncs`).length).toBe(2);
  } finally {
    await sql`RESET ROLE`;
  }
});
