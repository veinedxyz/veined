import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import postgres from "postgres";
import { connect, PostgresStore } from "../../src/data/store/postgres";
import {
  loadMigrations,
  migrate,
  schemaVersion,
} from "../../src/data/store/migrate";
import {
  StoreRateLimiter,
  RateLimitUnavailable,
} from "../../src/server/rate-limit";
import { createDataApi } from "../../src/data/api/router";
import { generateKey, randomId } from "../../src/data/api/keys";
import { DataPlane } from "../../src/data/plane";
import { indexOnce } from "../../src/data/indexer/worker";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import type { ChainRecord } from "../../src/data/registry/chains";
import { fakeNetwork, approved, FakeChain } from "../fixtures/fake-chain";
import { fixtureCatalog } from "../fixtures/routing";
// Loads local git-ignored credentials when the test runner did not inherit them.
try {
  process.loadEnvFile(".env.data.local");
} catch {
  /* CI provides the variables directly. */
}
const ownerUrl = process.env.OTHERBRIDGE_DATA_MIGRATOR_URL;
if (!ownerUrl)
  throw Error(
    "DB suite requires OTHERBRIDGE_DATA_MIGRATOR_URL (pnpm data:db:init && pnpm data:db:up)",
  );
const dbName = `otherbridge_test_${randomBytes(5).toString("hex")}`;
const urlFor = (base: string, db: string) => {
  const u = new URL(base);
  u.pathname = `/${db}`;
  return u.toString();
};
const admin = postgres(urlFor(ownerUrl, "postgres"), {
  max: 1,
  onnotice: () => {},
});
let ownerStore: PostgresStore,
  apiStore: PostgresStore,
  indexerStore: PostgresStore;
const wallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const other = "0x2222222222222222222222222222222222222222";
const tokenA = "0xaaaa000000000000000000000000000000000001";
const chain = (
  id: string,
  tier: ChainRecord["configuredTier"] = "FULL_INDEXED",
): ChainRecord => ({
  chainId: id,
  canonicalId: `eip155:${id}`,
  eip155: id,
  ecosystem: "EVM",
  name: `Synthetic ${id}`,
  mainnet: true,
  native: { symbol: "SYN", name: "Synthetic", decimals: 18 },
  finality: { kind: "finalized-tag", depth: 20 },
  configuredTier: tier,
  indexStartBlocks: 200,
  tokenEventModel: "erc20-transfer",
  enabled: true,
  tvlUsd: 1,
  routable: false,
  sources: ["tvl-catalog"],
});
beforeAll(async () => {
  await admin.unsafe(`CREATE DATABASE ${dbName}`);
  for (const [role, env] of [
    ["otherbridge_api", "OTHERBRIDGE_PG_API_PASSWORD"],
    ["otherbridge_indexer", "OTHERBRIDGE_PG_INDEXER_PASSWORD"],
  ]) {
    await admin.unsafe(`GRANT CONNECT ON DATABASE ${dbName} TO ${role}`);
    void env;
  }
  ownerStore = new PostgresStore(connect(urlFor(ownerUrl, dbName), { max: 4 }));
  const files = await loadMigrations();
  await migrate(ownerStore.sql, files);
  await ownerStore.sql.unsafe(
    "GRANT USAGE ON SCHEMA public TO otherbridge_api, otherbridge_indexer",
  );
  await ownerStore.sql.unsafe(
    await readFile("src/data/store/grants.sql", "utf8"),
  );
  apiStore = new PostgresStore(
    connect(urlFor(process.env.OTHERBRIDGE_DATA_DATABASE_URL!, dbName), {
      max: 12,
    }),
  );
  indexerStore = new PostgresStore(
    connect(urlFor(process.env.OTHERBRIDGE_DATA_INDEXER_URL!, dbName), {
      max: 6,
    }),
  );
});
afterAll(async () => {
  await Promise.all([
    ownerStore?.close(),
    apiStore?.close(),
    indexerStore?.close(),
  ]);
  // Ephemeral database created by this suite only; no pre-existing data is touched.
  await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});
describe("V14 PostgreSQL migrations", () => {
  it("fresh apply, repeat run safe, checksum tamper detected", async () => {
    const files = await loadMigrations();
    expect(await schemaVersion(ownerStore.sql)).toBe(files.length);
    const again = await migrate(ownerStore.sql, files);
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(files.map((f) => f.name));
    await expect(
      migrate(ownerStore.sql, [{ ...files[0], checksum: "0".repeat(64) }]),
    ).rejects.toThrow("MIGRATION_CHECKSUM_MISMATCH");
    await expect(migrate(ownerStore.sql, [])).rejects.toThrow(
      "SCHEMA_AHEAD_OF_CODE",
    );
    const indexes = (
      await ownerStore.sql`SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`
    ).map((r) => r.indexname);
    for (const name of [
      "erc20_transfers_chain_block",
      "erc20_transfers_from",
      "erc20_transfers_to",
      "wallet_token_discovery_wallet",
      "api_keys_prefix_key",
      "api_usage_events_client_at",
      "rate_limit_buckets_pkey",
      "indexer_checkpoints_pkey",
    ])
      expect(indexes).toContain(name);
  });
  it("constraints reject corrupt rows and least-privilege roles are enforced", async () => {
    await indexerStore.upsertChains([chain("920001")]);
    await expect(
      ownerStore.sql`INSERT INTO erc20_transfers VALUES ('920001', 1, 'not-a-hash', ${"0x" + "1".repeat(64)}, 0, ${tokenA}, ${other}, ${wallet}, 1)`,
    ).rejects.toThrow();
    await expect(
      ownerStore.sql`INSERT INTO api_keys (id, client_id, prefix, verifier, status) VALUES ('key_x', 'cli_x', 'short', 'plaintext', 'ACTIVE')`,
    ).rejects.toThrow();
    await expect(apiStore.sql`DELETE FROM erc20_transfers`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      apiStore.sql`UPDATE api_keys SET status = 'ACTIVE'`,
    ).rejects.toThrow(/permission denied/);
    await expect(apiStore.sql`DROP TABLE tokens`).rejects.toThrow();
    // Audit B12: the indexer never reads API key verifiers or usage; the api role cannot write health.
    await expect(indexerStore.sql`SELECT * FROM api_keys`).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      indexerStore.sql`SELECT * FROM api_usage_events`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      apiStore.sql`INSERT INTO rpc_health (endpoint_id, checked_at, error_rate) VALUES ('x', now(), 0)`,
    ).rejects.toThrow(/permission denied/);
    await expect(
      indexerStore.sql`SELECT count(*) FROM erc20_transfers`,
    ).resolves.toBeDefined();
    await expect(
      indexerStore.sql`INSERT INTO api_clients (id, display_name, status, plan_id, scopes) VALUES ('cli_aaaaaaaaaaaaaaaa', 'x', 'ACTIVE', 'pro', '{}')`,
    ).rejects.toThrow(/permission denied/);
  });
});
describe("V14 PostgreSQL store semantics", () => {
  it("indexer over Postgres: commit, reorg rewind, discovery rebuild, verification", async () => {
    const net = fakeNetwork();
    const c = new FakeChain("920002");
    c.mine(300, (n) =>
      n % 10n === 0n
        ? [{ token: tokenA, from: other, to: wallet, value: 5n }]
        : [{ token: tokenA, from: other, to: other, value: 1n }],
    );
    net.chains.set("920002", c);
    await indexerStore.upsertChains([chain("920002")]);
    await indexerStore.upsertEndpoint(
      approved("920002", "rpc-a.synthetic.test"),
      10,
    );
    await indexerStore.upsertEndpoint(
      approved("920002", "rpc-b.synthetic.test"),
      20,
    );
    const plane = new DataPlane(indexerStore, net.transport, 0);
    const state = await plane.state();
    const record = state.chains.find((x) => x.chainId === "920002")!;
    const pool = plane.pool(state, "920002")!;
    const r = await indexOnce(indexerStore, pool, record, "pg-owner-aaaa", {
      initialRange: 20,
      confirmations: 3,
    });
    expect(r.status).toBe("CURRENT");
    expect(await indexerStore.verifyIndex("920002")).toMatchObject({
      missingRanges: [],
      duplicateLogKeys: 0,
      orphanRecords: 0,
      checkpointMismatch: false,
    });
    expect(
      (await indexerStore.discoveredTokens("920002", wallet))[0],
    ).toMatchObject({ token: tokenA, transferCount: 20 });
    c.reorg(290n, "pgfork");
    const r2 = await indexOnce(indexerStore, pool, record, "pg-owner-aaaa", {
      initialRange: 20,
      confirmations: 3,
    });
    expect(r2.reorgs).toBe(1);
    expect(
      (await indexerStore.discoveredTokens("920002", wallet))[0].transferCount,
    ).toBe(19);
    expect(await indexerStore.verifyIndex("920002")).toMatchObject({
      missingRanges: [],
      orphanRecords: 0,
      checkpointMismatch: false,
    });
    const [{ n }] =
      await indexerStore.sql`SELECT count(*)::int AS n FROM indexed_block_windows WHERE chain_id = '920002' AND finalized`;
    expect(n).toBeGreaterThan(0);
  });
  it("concurrent indexers race for one lease; stale owners cannot commit", async () => {
    await indexerStore.upsertChains([chain("920003")]);
    const owners = Array.from({ length: 8 }, (_, i) => `racer-${i}-aaaaaaa`);
    const wins = await Promise.all(
      owners.map((o) => indexerStore.acquireLease("920003", o, 60000, 0n, 10n)),
    );
    expect(wins.filter(Boolean)).toHaveLength(1);
    const winner = owners[wins.indexOf(true)];
    await indexerStore.initCheckpoint(
      "920003",
      winner,
      1n,
      "0x" + "a".repeat(64),
    );
    await indexerStore.sql`UPDATE indexer_leases SET expires_at = now() - interval '1 second' WHERE chain_id = '920003'`;
    const thief = "racer-thief-aaaaaa";
    expect(
      await indexerStore.acquireLease("920003", thief, 60000, 0n, 10n),
    ).toBe(true);
    const row = {
      chainId: "920003",
      blockNumber: 1n,
      blockHash: "0x" + "b".repeat(64),
      txHash: "0x" + "c".repeat(64),
      logIndex: 0,
      token: tokenA,
      from: other,
      to: wallet,
      value: 1n,
    };
    const commit = (o: string) =>
      indexerStore.commitWindow({
        chainId: "920003",
        owner: o,
        window: {
          fromBlock: 1n,
          toBlock: 1n,
          toBlockHash: "0x" + "b".repeat(64),
          logCount: 1,
          finalized: false,
        },
        rows: [row],
        headBlock: 2n,
        safeBlock: 1n,
      });
    await expect(commit(winner)).rejects.toThrow("LEASE_LOST");
    await expect(commit(thief)).resolves.toEqual({
      inserted: 1,
      duplicates: 0,
    });
    await expect(commit(thief)).rejects.toThrow("CHECKPOINT_RACE");
  });
  it("100k transfer records: bulk insert and wallet lookups stay fast (measured)", async () => {
    await indexerStore.upsertChains([chain("920004")]);
    const owner = "bulk-owner-aaaaaaa";
    await indexerStore.acquireLease("920004", owner, 600000, 0n, 1000n);
    await indexerStore.initCheckpoint(
      "920004",
      owner,
      1n,
      "0x" + "0".repeat(64),
    );
    const wallets = Array.from(
      { length: 2000 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`,
    );
    const tokens = Array.from(
      { length: 300 },
      (_, i) => `0x${"e".repeat(20)}${(i + 1).toString(16).padStart(20, "0")}`,
    );
    const started = Date.now();
    let block = 1n;
    for (let w = 0; w < 50; w++) {
      const rows = Array.from({ length: 2000 }, (_, i) => {
        const k = w * 2000 + i;
        return {
          chainId: "920004",
          blockNumber: block + BigInt(Math.floor(i / 100)),
          blockHash: `0x${(Number(block) + Math.floor(i / 100)).toString(16).padStart(64, "0")}`,
          txHash: `0x${k.toString(16).padStart(64, "f")}`,
          logIndex: i % 100,
          token: tokens[k % tokens.length],
          from: wallets[k % wallets.length],
          to: wallets[(k * 7 + 3) % wallets.length],
          value: BigInt(k),
        };
      });
      const to = block + 19n;
      await indexerStore.commitWindow({
        chainId: "920004",
        owner,
        window: {
          fromBlock: block,
          toBlock: to,
          toBlockHash: `0x${Number(to).toString(16).padStart(64, "0")}`,
          logCount: rows.length,
          finalized: true,
        },
        rows,
        headBlock: to + 5n,
        safeBlock: to,
      });
      block = to + 1n;
    }
    const insertMs = Date.now() - started;
    const lookups: number[] = [];
    for (let i = 0; i < 50; i++) {
      const t = performance.now();
      await apiStore.discoveredTokens(
        "920004",
        wallets[(i * 37) % wallets.length],
      );
      await apiStore.walletActivity(
        wallets[(i * 37) % wallets.length],
        null,
        50,
      );
      lookups.push(performance.now() - t);
    }
    lookups.sort((a, b) => a - b);
    const v = await indexerStore.verifyIndex("920004");
    expect(v.transfers).toBe(100000);
    expect(v).toMatchObject({
      missingRanges: [],
      duplicateLogKeys: 0,
      orphanRecords: 0,
      checkpointMismatch: false,
    });
    const p95 = lookups[Math.floor(lookups.length * 0.95)];
    const perf = {
      at: new Date().toISOString(),
      bulkTransfers: 100000,
      windows: 50,
      insertMs,
      lookups: lookups.length,
      lookupP50Ms: Math.round(lookups[25]),
      lookupP95Ms: Math.round(p95),
      note: "Local Docker PostgreSQL 17; synthetic rows; not an SLA",
    };
    if (process.env.OTHERBRIDGE_EVIDENCE_ROOT) {
      await mkdir(`${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/performance`, {
        recursive: true,
      });
      await writeFile(
        `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/performance/db-100k.json`,
        JSON.stringify(perf, null, 2),
      );
    }
    expect(p95).toBeLessThan(500);
  });
  it("verify-index detects injected gaps and orphan records", async () => {
    await indexerStore.upsertChains([chain("920005")]);
    const owner = "verify-owner-aaaaa";
    await indexerStore.acquireLease("920005", owner, 60000, 0n, 10n);
    await indexerStore.initCheckpoint(
      "920005",
      owner,
      1n,
      "0x" + "0".repeat(64),
    );
    await indexerStore.commitWindow({
      chainId: "920005",
      owner,
      window: {
        fromBlock: 1n,
        toBlock: 5n,
        toBlockHash: "0x" + "5".repeat(64),
        logCount: 0,
        finalized: true,
      },
      rows: [],
      headBlock: 10n,
      safeBlock: 5n,
    });
    await ownerStore.sql`INSERT INTO indexed_block_windows VALUES ('920005', 8, 9, ${"0x" + "9".repeat(64)}, 0, true, now())`;
    await ownerStore.sql`INSERT INTO erc20_transfers VALUES ('920005', 50, ${"0x" + "1".repeat(64)}, ${"0x" + "2".repeat(64)}, 0, ${tokenA}, ${other}, ${wallet}, 1)`;
    const v = await indexerStore.verifyIndex("920005");
    expect(v.missingRanges).toEqual([{ from: "6", to: "7" }]);
    expect(v.orphanRecords).toBeGreaterThan(0);
    expect(v.checkpointMismatch).toBe(true);
  });
});
describe("V14 durable rate limiting and API auth on PostgreSQL", () => {
  it("multi-instance limiter: concurrent consumes across two pools allow exactly the limit", async () => {
    const now = Date.now();
    const a = new StoreRateLimiter(apiStore, () => now),
      second = new PostgresStore(
        connect(urlFor(process.env.OTHERBRIDGE_DATA_DATABASE_URL!, dbName), {
          max: 12,
        }),
      ),
      b = new StoreRateLimiter(second, () => now);
    try {
      // Establish every connection before measuring concurrent atomic updates.
      // Holding reservations proves 24 distinct live backends across both pools;
      // cold TLS/authentication setup is not part of this concurrency contract.
      const held = [],
        backendPids: number[] = [];
      const readinessStarted = performance.now();
      try {
        for (const pool of [apiStore, second])
          for (let i = 0; i < 12; i++) {
            const reserved = await pool.sql.reserve();
            held.push(reserved);
            backendPids.push(
              (await reserved`SELECT pg_backend_pid() AS pid`)[0].pid,
            );
          }
        expect(new Set(backendPids).size).toBe(24);
      } finally {
        for (const reserved of held) reserved.release();
      }
      const readinessMs = performance.now() - readinessStarted;
      // Drain every submitted request before cleanup, even when one rejects.
      // A rejected request still fails the test; it never becomes an allowance.
      async function drain<T>(requests: Promise<T>[]): Promise<T[]> {
        const settled = await Promise.allSettled(requests);
        expect(
          settled.filter((result) => result.status === "rejected"),
        ).toEqual([]);
        return settled.map((result) => {
          if (result.status !== "fulfilled") throw result.reason;
          return result.value;
        });
      }
      const key = `multi:${randomBytes(4).toString("hex")}`;
      const results = await drain(
        Array.from({ length: 200 }, (_, i) =>
          (i % 2 ? a : b).consume(key, { limit: 50, windowSeconds: 3600 }),
        ),
      );
      expect(results.filter((r) => r.allowed)).toHaveLength(50);
      expect(new Set(results.map((r) => r.count)).size).toBe(200);
      const cost = await drain(
        Array.from({ length: 20 }, () =>
          a.consume(`${key}:cu`, { limit: 100, windowSeconds: 3600, cost: 10 }),
        ),
      );
      expect(cost.filter((r) => r.allowed)).toHaveLength(10);
      const slots = await drain(
        Array.from({ length: 10 }, (_, i) =>
          (i % 2 ? apiStore : second).acquireSlot(
            "cli_slots",
            `req_slot_${i}`,
            3,
            30000,
          ),
        ),
      );
      expect(slots.filter(Boolean)).toHaveLength(3);
      if (process.env.OTHERBRIDGE_EVIDENCE_ROOT) {
        await mkdir(`${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/security`, {
          recursive: true,
        });
        await writeFile(
          `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/security/rate-limit-concurrency.json`,
          JSON.stringify(
            {
              at: new Date().toISOString(),
              instances: 2,
              backendPids,
              distinctReadyBackends: new Set(backendPids).size,
              readinessMs,
              rejectedRequests: 0,
              fixedWindowClock: now,
              concurrentConsumes: 200,
              limit: 50,
              allowed: results.filter((r) => r.allowed).length,
              distinctCounts: new Set(results.map((r) => r.count)).size,
              costUnitLimit: 100,
              costPerRequest: 10,
              costAllowed: cost.filter((r) => r.allowed).length,
              concurrencyCap: 3,
              slotAttempts: 10,
              slotsGranted: slots.filter(Boolean).length,
              backend: "postgres atomic upsert",
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await second.close();
    }
  });
  it("unavailable PostgreSQL refuses durable rate-limit requests without granting an allowance", async () => {
    // Reserve an OS-assigned loopback port, then close our listener. A real
    // connection-refused error must remain a durable-limiter refusal.
    const refuser = createServer();
    await new Promise<void>((resolve, reject) => {
      refuser.once("error", reject);
      refuser.listen(0, "127.0.0.1", resolve);
    });
    const address = refuser.address();
    if (!address || typeof address === "string")
      throw Error("OWNED_TCP_PORT_REQUIRED");
    await new Promise<void>((resolve, reject) =>
      refuser.close((error) => (error ? reject(error) : resolve())),
    );
    const url = new URL(process.env.OTHERBRIDGE_DATA_DATABASE_URL!);
    url.hostname = "127.0.0.1";
    url.port = String(address.port);
    const unavailable = new PostgresStore(connect(url.toString(), { max: 1 }));
    try {
      const limiter = new StoreRateLimiter(unavailable);
      expect(limiter.backend).toBe("postgres");
      await expect(unavailable.sql`SELECT 1`).rejects.toMatchObject({
        code: "ECONNREFUSED",
      });
      await expect(
        limiter.consume("unavailable:refusal", {
          limit: 50,
          windowSeconds: 3600,
        }),
      ).rejects.toBeInstanceOf(RateLimitUnavailable);
      if (process.env.OTHERBRIDGE_EVIDENCE_ROOT) {
        const directory = `${process.env.OTHERBRIDGE_EVIDENCE_ROOT}/security`;
        await mkdir(directory, { recursive: true });
        await writeFile(
          `${directory}/rate-limit-unavailable.json`,
          JSON.stringify(
            {
              at: new Date().toISOString(),
              fixture:
                "closed current test-owned loopback port; real ECONNREFUSED verified",
              pid: process.pid,
              port: address.port,
              error: "RateLimitUnavailable",
              allowed: 0,
              fallback: false,
            },
            null,
            2,
          ),
        );
      }
    } finally {
      await unavailable.sql.end({ timeout: 0 });
    }
  });
  it("API keys are verified against stored hashes only and revocation is immediate", async () => {
    await indexerStore.upsertChains([chain("920006", "ON_DEMAND_FUNGIBLE")]);
    const clientId = randomId("cli");
    await ownerStore.createClient({
      id: clientId,
      displayName: "db test",
      status: "ACTIVE",
      planId: "developer",
      scopes: ["chains:read"],
      createdAt: Date.now(),
    });
    const key = generateKey("test");
    const keyId = randomId("key");
    await ownerStore.createKey({
      id: keyId,
      clientId,
      prefix: key.prefix,
      verifier: key.verifier,
      status: "ACTIVE",
      createdAt: Date.now(),
      revokedAt: null,
      lastUsedAt: null,
    });
    const stored =
      await ownerStore.sql`SELECT * FROM api_keys WHERE id = ${keyId}`;
    expect(JSON.stringify(stored)).not.toContain(key.plaintext.slice(-43));
    const handle = createDataApi({
      store: apiStore,
      plane: new DataPlane(apiStore, fakeNetwork().transport, 0),
      limiter: new StoreRateLimiter(apiStore),
      routing: async () => fixtureCatalog(),
    });
    const get = () =>
      handle(
        new Request("http://127.0.0.1:3200/v1/chains/920006", {
          headers: { authorization: `Bearer ${key.plaintext}` },
        }),
      );
    expect((await get()).status).toBe(200);
    await ownerStore.revokeKey(key.prefix, Date.now());
    expect((await get()).status).toBe(401);
    // Revoked-key requests are unauthenticated and therefore never metered to the client.
    await expect
      .poll(
        async () => (await ownerStore.usageSummary(clientId, "2000-01-01"))[0],
      )
      .toMatchObject({
        endpointGroup: "chains",
        requests: 1,
        errors: 0,
        costUnits: 1,
      });
    const events =
      await ownerStore.sql`SELECT * FROM api_usage_events WHERE client_id = ${clientId}`;
    expect(JSON.stringify(events)).not.toMatch(/0x[0-9a-f]{40}/);
    void MULTICALL3;
  });
});
