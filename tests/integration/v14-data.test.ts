import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest } from "next/server";
import { MemoryStore } from "../../src/data/store/memory";
import { DataPlane } from "../../src/data/plane";
import {
  buildRegistry,
  defaultTierConfig,
  type ChainRecord,
} from "../../src/data/registry/chains";
import { indexOnce, resolveMetadata } from "../../src/data/indexer/worker";
import { RpcPool } from "../../src/data/rpc/pool";
import { readNative } from "../../src/data/balances/evm";
import { admit } from "../../src/data/rpc/admission";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import { SelfHostedPortfolioProvider } from "../../src/data/portfolio/provider";
import { scanPortfolio } from "../../src/portfolio/service";
import { mergePortfolio, portfolioSchema } from "../../src/portfolio/model";
import { createDataApi } from "../../src/data/api/router";
import { generateKey, randomId } from "../../src/data/api/keys";
import { MemoryRateLimiter } from "../../src/server/rate-limit";
import { openApiDocument } from "../../src/data/api/openapi";
import { docsPage } from "../../src/data/api/docs-page";
import { setDataPlaneForTests } from "../../src/data/plane";
import { setAppLimiterForTests } from "../../src/server/api-guard";
import { POST as portfolioPost } from "../../src/app/api/portfolio/route";
import { routingCore } from "../../src/adapters/routing-core";
import { NativePortfolioProvider } from "../../src/portfolio/providers";
import { fakeNetwork, approved, FakeChain } from "../fixtures/fake-chain";
import { fixtureCatalog } from "../fixtures/routing";
import type { Catalog } from "../../src/routing/model";
const wallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const other = "0x2222222222222222222222222222222222222222";
const tokenA = "0xaaaa000000000000000000000000000000000001";
const tokenB = "0xbbbb000000000000000000000000000000000002";
const owner = "test-owner-1";
function chainRecord(
  id: string,
  tier: ChainRecord["configuredTier"] = "ON_DEMAND_FUNGIBLE",
): ChainRecord {
  return {
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
    tvlUsd: 1000 - Number(id) / 1e6,
    routable: false,
    sources: ["tvl-catalog"],
  };
}
async function setupIndexed(blocks = 300) {
  const net = fakeNetwork();
  const chain = new FakeChain("900001");
  chain.mine(blocks, (n) =>
    n % 10n === 0n
      ? [
          { token: tokenA, from: other, to: wallet, value: 5n },
          { token: tokenB, from: wallet, to: other, value: 1n },
        ]
      : [{ token: tokenA, from: other, to: other, value: 1n }],
  );
  chain.metadata.set(tokenA, { symbol: "AAA", name: "Token A", decimals: 6 });
  chain.metadata.set(tokenB, { symbol: "BBB", name: "Token B", decimals: 18 });
  chain.balances.set(`${tokenA}|${wallet}`, 123456n);
  net.chains.set("900001", chain);
  const store = new MemoryStore();
  await store.upsertChains([chainRecord("900001", "FULL_INDEXED")]);
  await store.upsertEndpoint(approved("900001", "rpc-a.synthetic.test"), 10);
  await store.upsertEndpoint(approved("900001", "rpc-b.synthetic.test"), 20);
  await store.setMulticall("900001", {
    address: MULTICALL3,
    codeHash: null,
    verified: true,
    observedAt: 1,
  });
  const plane = new DataPlane(store, net.transport, 0);
  const state = await plane.state();
  return {
    net,
    chain,
    store,
    plane,
    state,
    pool: plane.pool(state, "900001")!,
    record: state.chains[0],
  };
}
describe("V14 indexer against RPC fixtures", () => {
  it("healthy node: bounded windows, checkpoint, discovery and consistent verification", async () => {
    const { store, pool, record } = await setupIndexed();
    const r = await indexOnce(store, pool, record, owner, {
      initialRange: 25,
      confirmations: 3,
    });
    expect(r.status).toBe("CURRENT");
    expect(r.throughBlock).toBe("297");
    expect(r.fromBlock).toBe("98");
    const v = await store.verifyIndex("900001");
    expect(v).toMatchObject({
      missingRanges: [],
      duplicateLogKeys: 0,
      orphanRecords: 0,
      checkpointMismatch: false,
    });
    const found = (await store.discoveredTokens("900001", wallet))
      .map((d) => d.token)
      .sort();
    expect(found).toEqual([tokenA, tokenB]);
    const again = await indexOnce(store, pool, record, owner, {
      confirmations: 3,
    });
    expect(again.windows).toBe(0);
    expect(again.inserted).toBe(0);
    expect(
      (await resolveMetadata(store, pool, (await store.listChains())[0]))
        .resolved,
    ).toBe(2);
    expect((await store.getTokens("900001", [tokenA]))[0]).toMatchObject({
      symbol: "AAA",
      decimals: 6,
      metadataStatus: "OK",
    });
  });
  it("log range too big: adaptive shrink completes without an infinite loop", async () => {
    const { store, pool, record, net } = await setupIndexed();
    for (const host of ["rpc-a.synthetic.test", "rpc-b.synthetic.test"])
      net.behaviors.set(`https://${host}`, { maxRange: 7 });
    const r = await indexOnce(store, pool, record, owner, {
      initialRange: 100,
      confirmations: 3,
      maxWindows: 500,
    });
    expect(r.status).toBe("CURRENT");
    expect(r.range).toBeLessThanOrEqual(7);
    expect((await store.verifyIndex("900001")).missingRanges).toEqual([]);
  });
  it("reorg: unfinalized rows are rewound and discovery rebuilt; finalized history kept", async () => {
    const { store, pool, record, chain } = await setupIndexed();
    await indexOnce(store, pool, record, owner, {
      initialRange: 10,
      confirmations: 3,
    });
    const before = (await store.verifyIndex("900001")).transfers;
    chain.reorg(290n, "fork", (n) =>
      n === 292n ? [{ token: tokenB, from: other, to: wallet, value: 9n }] : [],
    );
    const r = await indexOnce(store, pool, record, owner, {
      initialRange: 10,
      confirmations: 3,
    });
    expect(r.reorgs).toBe(1);
    expect(r.rewoundRows).toBeGreaterThan(0);
    const v = await store.verifyIndex("900001");
    expect(v).toMatchObject({
      missingRanges: [],
      orphanRecords: 0,
      checkpointMismatch: false,
    });
    expect(v.transfers).toBeLessThan(before + 5);
    const cp = (await store.getCheckpoint("900001"))!;
    expect(cp.throughBlockHash).toBe(
      chain.blocks[Number(cp.indexedThroughBlock)].hash,
    );
    expect(
      (await store.listWindows("900001", 100)).some((w) => w.finalized),
    ).toBe(true);
  });
  it("deep reorg into finalized windows is refused (FINALIZED_CONFLICT), nothing deleted", async () => {
    const { store, pool, record, chain } = await setupIndexed();
    await indexOnce(store, pool, record, owner, {
      initialRange: 10,
      confirmations: 3,
    });
    const before = (await store.verifyIndex("900001")).transfers;
    chain.reorg(100n, "deep");
    const r = await indexOnce(store, pool, record, owner, {
      initialRange: 10,
      confirmations: 3,
    });
    expect(r.status).toBe("FINALIZED_CONFLICT");
    expect((await store.verifyIndex("900001")).transfers).toBe(before);
    expect((await store.getCheckpoint("900001"))!.lastError).toMatch(
      /FINALIZED_CONFLICT/,
    );
  });
  it("malformed logs (RPC poisoning) abort the window without committing", async () => {
    const { store, pool, record, net } = await setupIndexed();
    for (const host of ["rpc-a.synthetic.test", "rpc-b.synthetic.test"])
      net.behaviors.set(`https://${host}`, { malformedLogs: true });
    const r = await indexOnce(store, pool, record, owner, {
      initialRange: 10,
      confirmations: 3,
    });
    expect(r.status).toBe("ERROR");
    expect(r.windows).toBe(0);
    expect((await store.verifyIndex("900001")).transfers).toBe(0);
  });
  it("endpoint lying about the canonical hash is detected by two-endpoint consensus", async () => {
    const { store, record, net } = await setupIndexed();
    const liar = new FakeChain("900001", "liar");
    liar.mine(300);
    const lying = new DataPlane(
      store,
      async (endpoint, body, options) =>
        endpoint.url.includes("rpc-b")
          ? fakeHandle(liar, body)
          : net.transport(endpoint, body, options),
      0,
    );
    const state = await lying.state();
    const r = await indexOnce(
      store,
      lying.pool(state, "900001")!,
      record,
      owner,
      { initialRange: 10, confirmations: 3 },
    );
    expect(r.status).toBe("ERROR");
    expect(r.error).toMatch(/RPC_INCONSISTENT/);
    expect((await store.verifyIndex("900001")).transfers).toBe(0);
  });
  it("concurrent workers: one lease wins, expired leases are reclaimable, stale owners cannot commit", async () => {
    const { store, pool, record } = await setupIndexed();
    const [a, b] = await Promise.all([
      indexOnce(store, pool, record, "owner-aaaaaaaa", {
        initialRange: 10,
        confirmations: 3,
      }),
      indexOnce(store, pool, record, "owner-bbbbbbbb", {
        initialRange: 10,
        confirmations: 3,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual(["CURRENT", "LEASE_HELD"]);
    let now = Date.now();
    const timed = new MemoryStore(() => now);
    await timed.upsertChains([record]);
    expect(
      await timed.acquireLease("900001", "owner-xxxxxxxx", 1000, 0n, 1n),
    ).toBe(true);
    expect(
      await timed.acquireLease("900001", "owner-yyyyyyyy", 1000, 0n, 1n),
    ).toBe(false);
    now += 2000;
    expect(
      await timed.acquireLease("900001", "owner-yyyyyyyy", 1000, 0n, 1n),
    ).toBe(true);
    await expect(
      timed.initCheckpoint(
        "900001",
        "owner-xxxxxxxx",
        1n,
        "0x" + "1".repeat(64),
      ),
    ).rejects.toThrow("LEASE_LOST");
  });
  it("duplicate log keys are idempotent and replayed windows are refused", async () => {
    const store = new MemoryStore();
    await store.upsertChains([chainRecord("900002", "FULL_INDEXED")]);
    await store.acquireLease("900002", owner, 60000, 1n, 2n);
    await store.initCheckpoint("900002", owner, 1n, "0x" + "a".repeat(64));
    const row = {
      chainId: "900002",
      blockNumber: 1n,
      blockHash: "0x" + "b".repeat(64),
      txHash: "0x" + "c".repeat(64),
      logIndex: 0,
      token: tokenA,
      from: other,
      to: wallet,
      value: 1n,
    };
    const r = await store.commitWindow({
      chainId: "900002",
      owner,
      window: {
        fromBlock: 1n,
        toBlock: 1n,
        toBlockHash: "0x" + "b".repeat(64),
        logCount: 2,
        finalized: false,
      },
      rows: [row, row],
      headBlock: 2n,
      safeBlock: 1n,
    });
    expect(r).toEqual({ inserted: 1, duplicates: 1 });
    expect(
      (await store.discoveredTokens("900002", wallet))[0].transferCount,
    ).toBe(1);
    await expect(
      store.commitWindow({
        chainId: "900002",
        owner,
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
      }),
    ).rejects.toThrow("CHECKPOINT_RACE");
  });
});
function fakeHandle(chain: FakeChain, body: unknown) {
  const one = (req: { id: number; method: string; params: unknown[] }) => {
    try {
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: chain.handle(req.method, req.params, {}),
      };
    } catch (error) {
      return { jsonrpc: "2.0", id: req.id, error };
    }
  };
  return Promise.resolve(
    Array.isArray(body)
      ? body.map(one)
      : one(body as { id: number; method: string; params: unknown[] }),
  );
}
describe("V14 RPC failure semantics", () => {
  it("wrong chain ID endpoint is quarantined; healthy fallback serves the read", async () => {
    const net = fakeNetwork();
    const chain = new FakeChain("900003");
    chain.mine(5);
    chain.native.set(wallet, 77n);
    net.chains.set("900003", chain);
    net.behaviors.set("https://liar.synthetic.test", { wrongChainId: true });
    const store = new MemoryStore();
    await store.upsertChains([chainRecord("900003")]);
    await store.upsertEndpoint(approved("900003", "liar.synthetic.test"), 1);
    await store.upsertEndpoint(approved("900003", "good.synthetic.test"), 50);
    const plane = new DataPlane(store, net.transport, 0);
    const state = await plane.state();
    const pool = plane.pool(state, "900003")!;
    // The batched read detects the lying endpoint, quarantines it and falls back within the same read.
    const n = await readNative(pool, wallet);
    expect(n.balance).toBe(77n);
    expect(pool.ranked().map((e) => e.id)).toEqual([
      "900003:good.synthetic.test",
    ]);
    expect(
      plane.health.get("900003:liar.synthetic.test")?.quarantineReason,
    ).toBe("CHAIN_MISMATCH");
  });
  it("rate-limited and timing-out nodes fail over within bounded attempts", async () => {
    const net = fakeNetwork();
    const chain = new FakeChain("900004");
    chain.mine(3);
    net.chains.set("900004", chain);
    net.behaviors.set("https://limited.synthetic.test", { rateLimited: true });
    net.behaviors.set("https://slow.synthetic.test", { timeout: true });
    const pool = new RpcPool(
      "900004",
      { ecosystem: "EVM" },
      ["limited", "slow", "good"].map((h, i) => ({
        id: h,
        chainId: "900004",
        url: `https://${h}.synthetic.test`,
        priority: i,
        supportsLogs: true,
        maxLogRange: 100,
        supportsBatch: false,
        supportsFinalized: true,
        supportsSafe: true,
        archive: false,
      })),
      net.transport,
    );
    const r = await pool.call(
      { method: "eth_blockNumber", params: [] },
      { timeoutMs: 50 },
    );
    expect(r.endpoint.id).toBe("good");
    expect(pool.ranked().map((e) => e.id)).toEqual(["good", "slow"]);
  });
  it("admission records pruned history and wrong chain without trusting the endpoint", async () => {
    const net = fakeNetwork();
    const chain = new FakeChain("900005");
    chain.mine(6000, (n) =>
      n % 2n ? [{ token: tokenA, from: other, to: wallet, value: 1n }] : [],
    );
    net.chains.set("900005", chain);
    net.behaviors.set("https://pruned.synthetic-chain.net", { pruned: true });
    net.behaviors.set("https://wrong.synthetic-chain.net", {
      wrongChainId: true,
    });
    const ok = await admit(
      {
        chainId: "900005",
        ecosystem: "EVM",
        url: "https://pruned.synthetic-chain.net",
        provenance: "curated",
      },
      net.transport,
    );
    expect(ok).toMatchObject({
      status: "APPROVED",
      archive: false,
      supportsLogs: true,
      maxLogRange: 5000,
    });
    const bad = await admit(
      {
        chainId: "900005",
        ecosystem: "EVM",
        url: "https://wrong.synthetic-chain.net",
        provenance: "curated",
      },
      net.transport,
    );
    expect(bad).toMatchObject({ status: "REJECTED", reason: "CHAIN_MISMATCH" });
    const ssrf = await admit(
      {
        chainId: "900005",
        ecosystem: "EVM",
        url: "https://169.254.169.254/latest",
        provenance: "public-registry",
      },
      net.transport,
    );
    expect(ssrf).toMatchObject({ status: "REJECTED", reason: "IP_LITERAL" });
  });
});
async function portfolioPlane(
  chains: number,
  opts: { slow?: Set<string>; catalogOnly?: string[] } = {},
) {
  const net = fakeNetwork();
  const store = new MemoryStore();
  const records: ChainRecord[] = [];
  for (let i = 1; i <= chains; i++) {
    const id = String(910000 + i);
    const c = new FakeChain(id, `c${i}`);
    c.mine(30);
    if (i === chains - 1) c.native.set(wallet, 5n * 10n ** 18n);
    if (i === 1) {
      c.metadata.set(tokenA, { symbol: "AAA", name: "Token A", decimals: 6 });
      c.balances.set(`${tokenA}|${wallet}`, 42000000n);
    }
    net.chains.set(id, c);
    records.push(
      chainRecord(id, i === 1 ? "FULL_INDEXED" : "ON_DEMAND_FUNGIBLE"),
    );
    await store.upsertEndpoint(
      approved(id, `rpc-${i}.synthetic.test`, { supportsBatch: i % 2 === 0 }),
      10,
    );
    if (opts.slow?.has(id))
      net.behaviors.set(`https://rpc-${i}.synthetic.test`, { timeout: true });
  }
  for (const id of opts.catalogOnly ?? []) records.push(chainRecord(id));
  await store.upsertChains(records);
  await store.setMulticall("910001", {
    address: MULTICALL3,
    codeHash: null,
    verified: true,
    observedAt: 1,
  });
  // Seed an index for the Tier A chain so the token is discovered by Otherbridge's own index.
  await store.acquireLease("910001", owner, 60000, 1n, 30n);
  await store.initCheckpoint("910001", owner, 1n, "0x" + "0".repeat(64));
  await store.commitWindow({
    chainId: "910001",
    owner,
    window: {
      fromBlock: 1n,
      toBlock: 29n,
      toBlockHash: net.chains.get("910001")!.blocks[29].hash,
      logCount: 1,
      finalized: true,
    },
    rows: [
      {
        chainId: "910001",
        blockNumber: 5n,
        blockHash: net.chains.get("910001")!.blocks[5].hash,
        txHash: "0x" + "d".repeat(64),
        logIndex: 0,
        token: tokenA,
        from: other,
        to: wallet,
        value: 42000000n,
      },
    ],
    headBlock: 30n,
    safeBlock: 29n,
  });
  await store.upsertTokens([
    {
      chainId: "910001",
      address: tokenA,
      symbol: "AAA",
      name: "Token A",
      decimals: 6,
      metadataStatus: "OK",
      sources: ["indexed"],
    },
  ]);
  const plane = new DataPlane(store, net.transport, 0);
  const catalog: Catalog = { ...fixtureCatalog(), stale: false };
  return { net, store, plane, catalog };
}
describe("V14 self-hosted portfolio aggregation", () => {
  it("checks more than 40 discovered chains, pins the forgotten-chain asset and reports coverage", async () => {
    const { plane, catalog } = await portfolioPlane(45, {
      catalogOnly: ["990001"],
    });
    const result = await scanPortfolio(
      { evm: wallet },
      catalog,
      undefined,
      [new SelfHostedPortfolioProvider(plane, catalog)],
      { concurrency: 8, deadlineMs: 20000 },
    );
    portfolioSchema.parse(result);
    expect(result.coverageSummary.checked).toBe(45);
    expect(result.coverageSummary.pending).toBe(0);
    expect(result.coverage.find((c) => c.chainId === "990001")).toMatchObject({
      state: "CATALOG_ONLY",
      reason: "NO_VETTED_RPC",
    });
    const forgotten = result.holdings.find(
      (h) => h.chainId === "910044" && h.native,
    );
    expect(forgotten?.balance).toBe((5n * 10n ** 18n).toString());
    const indexed = result.holdings.find((h) => h.address === tokenA);
    expect(indexed).toMatchObject({
      discovery: "indexed",
      balance: "42000000",
      decimals: 6,
      symbol: "AAA",
    });
    const tierA = result.coverage.find((c) => c.chainId === "910001")!;
    expect(tierA).toMatchObject({
      tier: "FULL_INDEXED",
      tokens: "INDEXED",
      state: "PARTIAL",
      historicalComplete: false,
    });
    expect(result.coverage.find((c) => c.chainId === "910010")).toMatchObject({
      state: "NATIVE_ONLY",
      tokens: "NOT_CHECKED",
    });
    expect(result.state).toBe("PARTIAL");
    expect(result.continuation).toBeNull();
    expect(JSON.stringify(result)).not.toMatch(/CREDENTIAL/);
  });
  it("deadline leaves slow chains PENDING with a continuation; continuing finishes them", async () => {
    const slow = new Set(["910003", "910004"]);
    const { plane, catalog, net } = await portfolioPlane(12, { slow });
    const provider = () => new SelfHostedPortfolioProvider(plane, catalog);
    const first = await scanPortfolio(
      { evm: wallet },
      catalog,
      undefined,
      [provider()],
      { concurrency: 4, deadlineMs: 1500, perChainMs: 60000 },
    );
    expect(
      first.coverage
        .filter((c) => c.state === "PENDING")
        .map((c) => c.chainId)
        .sort(),
    ).toEqual([...slow].sort());
    expect(first.coverageSummary.coverageComplete).toBe(false);
    expect(first.holdings.some((h) => slow.has(h.chainId))).toBe(false);
    expect(first.continuation).toBeTruthy();
    for (const id of ["3", "4"])
      net.behaviors.set(`https://rpc-${id}.synthetic.test`, {});
    const second = await scanPortfolio(
      { evm: wallet },
      catalog,
      undefined,
      [provider()],
      { continuation: first.continuation, concurrency: 4, deadlineMs: 5000 },
    );
    expect(second.coverage.map((c) => c.chainId).sort()).toEqual(
      [...slow].sort(),
    );
    const merged = mergePortfolio(first, second);
    expect(merged.coverageSummary.pending).toBe(0);
    expect(merged.coverageSummary.checked).toBe(12);
    await expect(
      scanPortfolio({ evm: other }, catalog, undefined, [provider()], {
        continuation: first.continuation,
      }),
    ).rejects.toThrow("CONTINUATION_SCOPE_MISMATCH");
  });
  it("data plane unavailable never invents zero balances", async () => {
    const store = new MemoryStore();
    const plane = new DataPlane(store, fakeNetwork().transport, 0, () => ({
      chains: buildRegistry(fixtureCatalog().networks, []),
      routing: fixtureCatalog().networks,
      endpoints: [],
      multicall: {},
    }));
    const catalog = fixtureCatalog();
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(plane, catalog),
    ]);
    expect(result.state).toBe("FAILED");
    expect(result.holdings).toEqual([]);
    expect(result.coverage.every((c) => c.state === "CATALOG_ONLY")).toBe(true);
    expect(result.coverage.length).toBeGreaterThan(0);
    void defaultTierConfig;
  });
  // Regressions found by the live read-only sample (sentinel native balance, native ERC20 mirror,
  // price evidence post-dating the balance read, unknown native symbols).
  it("sentinel native balances are excluded and reported, never shown as holdings", async () => {
    const { plane, catalog, net } = await portfolioPlane(3);
    net.chains
      .get("910002")!
      .native.set(
        wallet,
        BigInt(
          "4242424242424242424242424242424242424242424242424242424242424242424242424242",
        ),
      );
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      new SelfHostedPortfolioProvider(plane, catalog),
    ]);
    expect(
      result.holdings.some((h) => h.chainId === "910002" && h.native),
    ).toBe(false);
    expect(result.coverage.find((c) => c.chainId === "910002")).toMatchObject({
      native: "UNSUPPORTED",
      reason: "IMPLAUSIBLE_BALANCE",
      state: "FAILED",
    });
  });
  it("native ERC20 mirrors are not double counted; live derived prices value holdings", async () => {
    const { plane, catalog, net, store } = await portfolioPlane(2);
    const c1 = net.chains.get("910001")!;
    const mirror = "0xdeaddeaddeaddeaddeaddeaddeaddeaddead0000";
    c1.native.set(wallet, 2n * 10n ** 18n);
    c1.metadata.set(mirror, {
      symbol: "SYN",
      name: "Synthetic native mirror",
      decimals: 18,
    });
    c1.balances.set(`${mirror}|${wallet}`, 2n * 10n ** 18n);
    await store.upsertTokens([
      {
        chainId: "910001",
        address: mirror,
        symbol: "SYN",
        name: "mirror",
        decimals: 18,
        metadataStatus: "OK",
        sources: ["routing-catalog"],
      },
    ]);
    const chains = await store.listChains();
    await store.upsertChains(
      chains.map((c) =>
        c.chainId === "910001" ? { ...c, routable: true } : c,
      ),
    );
    let requested = 0;
    const priceRead = async (_path: string, params: Record<string, string>) => {
      requested = Date.now();
      return {
        tokens: {
          [params.chains]: [
            {
              address: "0x0000000000000000000000000000000000000000",
              symbol: "SYN",
              decimals: 18,
              priceUSD: "2.5",
            },
            { address: tokenA, symbol: "AAA", decimals: 6, priceUSD: "1" },
          ],
        },
      };
    };
    const provider = new SelfHostedPortfolioProvider(plane, catalog, priceRead);
    const result = await scanPortfolio({ evm: wallet }, catalog, undefined, [
      provider,
    ]);
    const rows = result.holdings.filter((h) => h.chainId === "910001");
    expect(rows.filter((h) => h.symbol === "SYN")).toHaveLength(1);
    expect(rows.find((h) => h.native)?.usd).toBe(5);
    expect(rows.find((h) => h.address === tokenA)?.usd).toBe(42);
    expect(rows.find((h) => h.native)!.priceAt!).toBeLessThanOrEqual(
      rows.find((h) => h.native)!.observedAt,
    );
    expect(requested).toBeGreaterThan(0);
  });
  it("registry uses bounded TVL-catalog gas symbols for chains outside routing", () => {
    const reg = buildRegistry(
      [],
      [
        { name: "Fantom", chainId: "250", tvlUsd: 1, symbol: "FTM" },
        { name: "Bad", chainId: "251", tvlUsd: 1, symbol: "<script>" },
      ],
    );
    expect(reg.find((c) => c.chainId === "250")?.native.symbol).toBe("FTM");
    expect(reg.find((c) => c.chainId === "251")?.native.symbol).toBe("?");
  });
});
describe("V14 Data API (/v1) auth, scopes, quotas and safety", () => {
  async function api(
    planId = "developer",
    scopes = [
      "chains:read",
      "portfolio:read",
      "balances:read",
      "activity:read",
      "tokens:read",
    ],
  ) {
    const env = await portfolioPlane(3);
    const clientId = randomId("cli");
    await env.store.createClient({
      id: clientId,
      displayName: "test",
      status: "ACTIVE",
      planId,
      scopes,
      createdAt: Date.now(),
    });
    const key = generateKey("test");
    const keyId = randomId("key");
    await env.store.createKey({
      id: keyId,
      clientId,
      prefix: key.prefix,
      verifier: key.verifier,
      status: "ACTIVE",
      createdAt: Date.now(),
      revokedAt: null,
      lastUsedAt: null,
    });
    const handle = createDataApi({
      store: env.store,
      plane: env.plane,
      limiter: new MemoryRateLimiter(),
      routing: async () => env.catalog,
    });
    const get = (
      path: string,
      auth: string | null = key.plaintext,
      method = "GET",
    ) =>
      handle(
        new Request(`http://127.0.0.1:3200${path}`, {
          method,
          headers: auth
            ? {
                authorization: `Bearer ${auth}`,
                origin: "https://evil.example",
              }
            : {},
        }),
      );
    return { ...env, key, keyId, clientId, get };
  }
  it("requires hashed API keys; unknown, malformed, wrong and revoked keys look identical", async () => {
    const { get, key, store, keyId } = await api();
    const bodies = [];
    for (const auth of [
      null,
      "garbage",
      `ob_test_${"z".repeat(12)}_${"A".repeat(43)}`,
      key.plaintext.slice(0, -2) + "zz",
    ]) {
      const r = await get("/v1/chains", auth);
      expect(r.status).toBe(401);
      const b = await r.json();
      expect(b.error.code).toBe("UNAUTHORIZED");
      bodies.push(b.error.message);
    }
    expect(new Set(bodies).size).toBe(1);
    expect((await get("/v1/chains")).status).toBe(200);
    await store.revokeKey(keyId, Date.now());
    expect((await get("/v1/chains")).status).toBe(401);
    expect(
      [...store.keys.values()].every(
        (k) => !JSON.stringify(k).includes(key.plaintext),
      ),
    ).toBe(true);
  });
  it("scopes, plan rate limits and cost units are enforced; billing is off; no CORS", async () => {
    const { get } = await api("developer", ["chains:read"]);
    const ok = await get("/v1/chains");
    expect(ok.headers.get("access-control-allow-origin")).toBeNull();
    expect(ok.headers.get("x-cost-units")).toBe("1");
    expect(ok.headers.get("x-request-id")).toMatch(/^req_[a-z0-9]{32}$/);
    expect((await get(`/v1/address/${wallet}/portfolio`)).status).toBe(403);
    let limited = 0;
    for (let i = 0; i < 35; i++)
      if ((await get("/v1/chains")).status === 429) limited++;
    expect(limited).toBeGreaterThan(0);
    const health = await (await get("/v1/health", null)).json();
    expect(health.data.billingEnabled).toBe(false);
    expect((await get("/v1/chains", null, "OPTIONS")).status).toBe(405);
    expect((await get("/v1/chains", null, "POST")).status).toBe(405);
  });
  it("portfolio is pre-charged by chains and returns explicit coverage", async () => {
    const { get, store, clientId } = await api("internal");
    const r = await get(`/v1/address/${wallet}/portfolio?maxChains=2`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-cost-units")).toBe("4");
    const body = await r.json();
    expect(body.data.coverageSummary.pending).toBe(1);
    expect(body.data.continuation).toBeTruthy();
    const usage = await store.usageSummary(clientId, "2000-01-01");
    expect(usage.find((u) => u.endpointGroup === "portfolio")?.costUnits).toBe(
      4,
    );
    expect(JSON.stringify(store.usage)).not.toContain(wallet.slice(2));
  });
  it("hostile inputs fail with the fixed envelope and never reach SQL/RPC as text", async () => {
    const { get } = await api("internal");
    for (const path of [
      "/v1/chains/1%27%20OR%201=1--",
      "/v1/chains/../../etc/passwd",
      `/v1/address/${encodeURIComponent("0x' UNION SELECT *")}/activity`,
      "/v1/910001/address/not-an-address/native-balance",
      "/v1/chains?cursor=%%%",
      "/v1/chains?limit=999999",
      "/v1/910001/token/%E0%A4%A",
      `/v1/address/${wallet}/activity?cursor=eyJ2IjoxLCJrIjpbIngiXX0`,
    ]) {
      const r = await get(path);
      expect([400, 404, 422], path).toContain(r.status);
      const text = await r.text();
      expect(text).not.toMatch(/stack|at Object|postgres|SELECT|Error:/i);
      expect(JSON.parse(text).error.requestId).toMatch(/^req_/);
    }
  });
  it("activity, balances and token endpoints are bounded, paginated and sanitized", async () => {
    const { get } = await api("internal");
    const activity = await (
      await get(`/v1/address/${wallet}/activity?limit=1`)
    ).json();
    expect(activity.data.items).toHaveLength(1);
    expect(activity.data.note).toMatch(/indexed block windows/);
    const balances = await (
      await get(`/v1/910001/address/${wallet}/token-balances`)
    ).json();
    expect(balances.data.tokens).toEqual([
      {
        token: tokenA,
        balance: "42000000",
        decimals: 6,
        symbol: "AAA",
        discovery: "indexed",
      },
    ]);
    expect(balances.data.coverage.tokens).toBe("INDEXED");
    const native = await (
      await get(`/v1/910002/address/${wallet}/native-balance`)
    ).json();
    expect(native.data).toMatchObject({
      chainId: "910002",
      balance: "5000000000000000000",
      decimals: 18,
    });
    const token = await (await get(`/v1/910001/token/${tokenA}`)).json();
    expect(token.data).toMatchObject({ symbol: "AAA", decimals: 6 });
    const page = await (await get("/v1/chains?limit=2")).json();
    expect(page.data.chains).toHaveLength(2);
    const next = await (
      await get(`/v1/chains?limit=2&cursor=${page.data.nextCursor}`)
    ).json();
    expect(next.data.chains[0].chainId > page.data.chains[1].chainId).toBe(
      true,
    );
  });
  it("OpenAPI 3.1 document is structurally valid and every $ref resolves; docs page escapes", () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    const refs =
      JSON.stringify(doc).match(/#\/components\/schemas\/\w+/g) ?? [];
    for (const r of refs)
      expect(doc.components.schemas, r).toHaveProperty(r.split("/").pop()!);
    for (const [path, item] of Object.entries(doc.paths)) {
      expect(path.startsWith("/v1/")).toBe(true);
      const op = (
        item as {
          get: {
            responses: Record<string, unknown>;
            parameters: { name: string; in: string }[];
          };
        }
      ).get;
      expect(Object.keys(op.responses)).toEqual(
        expect.arrayContaining(["200", "401", "429", "500"]),
      );
      for (const name of path.match(/\{(\w+)\}/g) ?? [])
        expect(
          op.parameters.some((p) => `{${p.name}}` === name && p.in === "path"),
        ).toBe(true);
    }
    expect(
      Object.keys(doc.paths).every(
        (p) =>
          !/post|put|delete/i.test(
            JSON.stringify((doc.paths as Record<string, object>)[p]),
          ),
      ),
    ).toBe(true);
    const html = docsPage({
      ...doc,
      info: { ...doc.info, description: '<script>alert("x")</script>' },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
describe("V14 app portfolio route uses the own data plane", () => {
  beforeEach(() => setAppLimiterForTests(new MemoryRateLimiter()));
  afterEach(() => {
    setDataPlaneForTests(undefined);
    setAppLimiterForTests(undefined);
    vi.unstubAllEnvs();
  });
  const post = (
    body: unknown,
    origin = "http://127.0.0.1:3100",
    host = "127.0.0.1:3100",
  ) =>
    portfolioPost(
      new NextRequest(`http://${host}/api/portfolio`, {
        method: "POST",
        headers: { origin, host, "content-type": "application/json" },
        body: JSON.stringify(body),
      }) as unknown as Request,
    );
  it("rejects wildcard production origin configuration and non-matching hosts", async () => {
    vi.stubEnv("OTHERBRIDGE_APP_ORIGINS", "*");
    expect(
      (await post({ identity: { evm: wallet }, consent: true })).status,
    ).toBe(503);
    vi.stubEnv("OTHERBRIDGE_APP_ORIGINS", "https://otherbridge.io");
    expect(
      (await post({ identity: { evm: wallet }, consent: true })).status,
    ).toBe(403);
  });
  it("rejects tampered continuation and invalid identities", async () => {
    const env = await portfolioPlane(2);
    setDataPlaneForTests(env.plane);
    vi.spyOn(routingCore, "listNetworks").mockResolvedValue(env.catalog);
    vi.spyOn(
      NativePortfolioProvider.prototype,
      "discoverActivity",
    ).mockResolvedValue([]);
    const r = await post({
      identity: { evm: wallet },
      consent: true,
      continuation: "!!",
    });
    expect(r.status).toBe(422);
    expect((await r.json()).error).toMatch(/INVALID/);
    expect(
      (await post({ identity: { evm: "0x123" }, consent: true })).status,
    ).toBe(422);
    const ok = await post({ identity: { evm: wallet }, consent: true });
    expect(ok.status).toBe(200);
    const body = portfolioSchema.parse(await ok.json());
    expect(body.source).toBe("otherbridge-data-plane");
    expect(body.coverageSummary.checked).toBe(2);
    expect(ok.headers.get("cache-control")).toBe("private, no-store");
    vi.restoreAllMocks();
  });
});
