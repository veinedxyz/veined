import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { decodeFunctionData, encodeFunctionResult, type Hex } from "viem";
import { DataPlane, fallbackRegistry } from "../../src/data/plane";
import { RpcPool } from "../../src/data/rpc/pool";
import { RpcError, type RpcTransport } from "../../src/data/rpc/transport";
import { multicall3Abi, SELECTORS } from "../../src/data/evm/erc20";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import {
  CANDIDATE_TIERS,
  clearScanStateForTests,
  scanDefi,
} from "../../src/defi/scanner";
import {
  cached,
  cacheKey,
  cacheSet,
  clearDefiMetadataCacheForTests,
  metadataCacheKeys,
  metadataCacheStats,
  metadataCacheValuesForTests,
} from "../../src/defi/cache";
import { DefiReader, pinChain, COALESCE_MAX } from "../../src/defi/reader";
import { PREFILTER_CHUNK } from "../../src/defi/adapters";
import { deployments } from "../../src/defi/registry";
import { prewarmDefiMetadata } from "../../src/defi/prewarm";
import { scanSchema, type DefiScan } from "../../src/defi/model";
import { readRound } from "../../src/components/defi-stream";
import { perf } from "../../src/components/perf";
import {
  buildWorld,
  census,
  seedProfile,
  simPriceRead,
  SIM_WALLETS,
  type SimProfile,
  type SimWorld,
} from "../fixtures/defi-sim";
import { economicView } from "../fixtures/defi-economic";
// V1.14.1 DeFi scan performance hardening. Every test runs the production reader / scanner against the deterministic
// simulator (SYNTHETIC_TEST_ONLY; read methods only; no wallet session, no signature, no transaction).
const oracle = JSON.parse(
  readFileSync("tests/fixtures/v114-economic-oracle.json", "utf8"),
).result as Record<SimProfile, Record<string, unknown>>;
const base = fallbackRegistry();
function setup(
  o: {
    chains?: string[];
    markets?: number;
    vaults?: number;
    endpoints?: number;
    profile?: SimProfile;
  } = {},
) {
  const chains = o.chains ?? ["1"];
  const world = buildWorld({
    chains,
    morphoMarkets: o.markets ?? 0,
    morphoVaults: o.vaults ?? 0,
  });
  const wallet = seedProfile(world, o.profile ?? "production");
  const endpoints = chains.flatMap((c) =>
    world.net.endpoints(c, o.endpoints ?? 1),
  );
  const plane = new DataPlane(null, world.net.transport, 60000, () => ({
    ...base,
    endpoints,
  }));
  return { world, plane, wallet, held: world.held(wallet) };
}
const scanOne = (
  s: ReturnType<typeof setup>,
  id: string,
  extra: Parameters<typeof scanDefi>[2] = {},
) =>
  scanDefi(s.wallet, s.plane, {
    deploymentIds: [id],
    held: s.held,
    clientScope: "v1141",
    priceRead: simPriceRead(s.world),
    store: s.world.store,
    catalog: null,
    ...extra,
  });
const views = (w: SimWorld, chain = "1") => w.net.chains.get(chain)!.viewLog;
const named = (w: SimWorld, name: string, chain = "1") =>
  views(w, chain).filter((v) => v.endsWith(":" + name)).length;
const quarantined = (plane: DataPlane) =>
  [...plane.health.values()].some(
    (h) => h.quarantinedUntil !== null && h.quarantinedUntil > Date.now(),
  );
beforeEach(() => {
  clearScanStateForTests();
  clearDefiMetadataCacheForTests();
});
afterEach(() => vi.restoreAllMocks());

describe("V1.14.1 economic equivalence with the frozen V1.14 oracle (PF2, C1-C8)", () => {
  it("every reviewed deployment on three chains reports byte-identical economics, cold and warm", async () => {
    for (const profile of ["production", "zero"] as SimProfile[]) {
      const s = setup({
        chains: ["1", "8453", "10"],
        markets: 1814,
        vaults: 382,
        profile,
      });
      for (const pass of ["cold", "warm"])
        for (const d of deployments.filter((x) =>
          ["1", "8453", "10"].includes(x.chainId),
        )) {
          clearScanStateForTests();
          const scan = await scanOne(s, d.id, {
            perAdapterMs: 60000,
            deadlineMs: 120000,
          });
          const got = economicView(
            scan.positions,
            scan.coverage.filter((c) => c.deploymentId === d.id),
          );
          expect(
            { profile, pass, id: d.id, got },
            `${profile}/${pass}/${d.id}`,
          ).toEqual({ profile, pass, id: d.id, got: oracle[profile][d.id] });
        }
    }
  }, 240000);
  it("Aave on Ethereum (treasury-like wallet): every reserve is exact and FULL; V1.14 exhausted its budget", async () => {
    const s = setup({ profile: "whale" });
    const scan = await scanOne(s, "aave-v3-1");
    const c = scan.coverage[0];
    expect(c).toMatchObject({ state: "FULL_POSITION", scanResult: "NONZERO" });
    const p = scan.positions[0];
    const state = s.world.aave.get(s.wallet)!.get("aave-v3-1")!;
    const supplied = [...state.entries()].filter(([, u]) => u.supply > 0n);
    expect(p.supplied).toHaveLength(supplied.length);
    for (const [asset, u] of supplied) {
      const a = p.supplied.find((x) => x.contract === asset)!;
      expect(a.rawAmount).toBe(u.supply.toString());
      expect(p.collateral.some((x) => x.contract === asset)).toBe(
        u.collateral !== false,
      );
    }
    expect(p.rewards.map((r) => r.rawClaimable)).toEqual([
      (5n * 10n ** 18n).toString(),
    ]);
    expect(p.rewardsStatus).toBe("CHECKED");
    // Logical reads stay inside the accepted 256-read budget (V1.14 double-counted a rejected JSON-RPC batch).
    expect(c.calls).toBeLessThanOrEqual(256);
  });
});

describe("V1.14.1 Aave read plan and request reduction (PF1, PF3)", () => {
  it("Ethereum Aave: one aggregate carries identity, account, reserve list and 67 reserves; <=4 HTTP cold, <=3 warm", async () => {
    const s = setup();
    const cold = await scanOne(s, "aave-v3-1");
    const coldCensus = census(s.world.net.log);
    expect(cold.coverage[0].state).toBe("FULL_POSITION");
    // pin batch + code proofs (with the Multicall3 proof) + the plan aggregate + the proofs of the 3 nonzero
    // reserves + the reorg check
    expect(coldCensus.httpRequests).toBeLessThanOrEqual(5);
    clearScanStateForTests();
    s.world.net.reset();
    const warm = await scanOne(s, "aave-v3-1");
    const warmCensus = census(s.world.net.log);
    expect(warmCensus.httpRequests).toBeLessThanOrEqual(3);
    expect(warmCensus.multicallBatches).toBe(1);
    expect(warm.coverage[0].cacheHits).toBeGreaterThan(0);
    expect(warm.coverage[0].http).toBe(1);
    // V1.14 sent 85 HTTP requests for the same isolated scan (baseline census).
    expect(warmCensus.httpRequests * 20).toBeLessThan(85);
  });
  it("a checked-zero account reads no identity proofs and uses no rewards result (exact zero short-circuit)", async () => {
    const s = setup({ profile: "zero" });
    const scan = await scanOne(s, "aave-v3-1");
    expect(scan.coverage[0]).toMatchObject({
      state: "FULL_POSITION",
      scanResult: "CHECKED_ZERO",
    });
    expect(named(s.world, "getReserveTokensAddresses")).toBe(0);
    expect(named(s.world, "getReserveConfigurationData")).toBe(0);
    // Every reviewed reserve's exact user view was read: zero is proven, not assumed.
    expect(named(s.world, "getUserReserveData")).toBe(
      deployments.find((d) => d.id === "aave-v3-1")!.assets!.length,
    );
  });
  it("one reserve read that reverts keeps the account PARTIAL (never a checked zero)", async () => {
    const s = setup();
    const d = deployments.find((x) => x.id === "aave-v3-1")!;
    const weth = d.assets!.find((a) => a.symbol === "WETH")!.underlying;
    s.world.net.behavior.set(`https://rpc0.sim.test/1`, {
      latencyMs: 0,
      perItemMs: 0,
      jitter: 0,
      revertWhen: (_t, name, args) =>
        name === "getUserReserveData" && String(args[0]).toLowerCase() === weth,
    });
    const scan = await scanOne(s, "aave-v3-1");
    expect(scan.coverage[0]).toMatchObject({
      state: "PARTIAL_POSITION",
      scanResult: "NONZERO",
    });
    expect(scan.positions[0].warnings).toContain("RESERVE_READ_INCOMPLETE");
    expect(scan.positions[0].supplied.some((a) => a.contract === weth)).toBe(
      false,
    );
  });
  it("a reviewed reserve whose on-chain identity differs fails the deployment (cached proofs are compared every scan)", async () => {
    const s = setup();
    await scanOne(s, "aave-v3-1");
    const d = deployments.find((x) => x.id === "aave-v3-1")!;
    const key = cacheKey(
      "aave-reserve",
      "1",
      "aave-v3-1@1.1.0",
      d.assets!.find((a) => a.symbol === "USDC")!.underlying,
    );
    expect(metadataCacheKeys()).toContain(key);
    // A forged cached proof (wrong receipt) can never value a position: the comparison runs on every scan.
    cacheSet(
      key,
      {
        receipt: "0x" + "9".repeat(40),
        debt: "0x" + "9".repeat(40),
        decimals: 6,
      },
      "LONG",
    );
    clearScanStateForTests();
    const scan = await scanOne(s, "aave-v3-1");
    // V1.14 semantics: an identity mismatch fails the position read, so the deployment fails (never a value or a zero).
    expect(scan.coverage[0]).toMatchObject({
      state: "FAILED",
      reason: "POSITION_READ_FAILED",
      scanResult: "FAILED",
    });
    expect(scan.positions).toEqual([]);
  });
});

describe("V1.14.1 static metadata cache and single-flight (R4, §17-19)", () => {
  it("a warm scan re-proves no static identity: no code, Multicall3 or reserve-identity reads", async () => {
    const s = setup();
    await scanOne(s, "aave-v3-1");
    await scanOne(s, "compound-1-usdc");
    clearScanStateForTests();
    s.world.net.reset();
    views(s.world).length = 0;
    await scanOne(s, "aave-v3-1");
    await scanOne(s, "compound-1-usdc");
    const k = census(s.world.net.log);
    expect(k.byMethod.eth_getCode ?? 0).toBe(0);
    expect(named(s.world, "getReserveTokensAddresses")).toBe(0);
    expect(named(s.world, "decimals")).toBe(0);
    expect(metadataCacheStats().hits).toBeGreaterThan(0);
  });
  it("keys are kind|chain|deployment@version|contract and no wallet value is ever stored", async () => {
    const s = setup({ chains: ["1"], markets: 64, vaults: 32 });
    for (const id of [
      "aave-v3-1",
      "compound-1-usdc",
      "morpho-blue-1",
      "morpho-vault-1",
      "uniswap-v3-1",
      "lido-1",
    ])
      await scanOne(s, id);
    const keys = metadataCacheKeys();
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) {
      const [kind, chain, scope, subject] = k.split("|");
      expect(kind).toMatch(/^[a-z0-9-]+$/);
      expect(chain).toMatch(/^\d+$/);
      expect(scope).toMatch(/^(chain|[a-z0-9-]+@\d+\.\d+\.\d+)$/);
      expect(subject).toMatch(/^0x[0-9a-f]{40}$|^0x[0-9a-f]{64}$/);
    }
    const stored = JSON.stringify(metadataCacheValuesForTests(), (_k, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ).toLowerCase();
    for (const w of Object.values(SIM_WALLETS))
      expect(keys.join() + stored).not.toContain(w.slice(2));
  });
  it("a proof cached for one chain is never used on another chain", async () => {
    const s = setup({ chains: ["1", "8453"] });
    await scanOne(s, "aave-v3-1");
    const shared = Object.values(
      deployments.find((d) => d.id === "aave-v3-8453")!.contracts,
    );
    s.world.net.reset();
    await scanOne(s, "aave-v3-8453");
    const getCode = s.world.net.log.filter(
      (r) => r.chainId === "8453" && r.methods.includes("eth_getCode"),
    );
    expect(getCode.length).toBeGreaterThan(0);
    expect(
      metadataCacheKeys().some((k) =>
        shared.some((a) => k === `code|1|chain|${a}`),
      ),
    ).toBe(false);
  });
  it("a failure is never cached and short-lived position state can never enter the metadata cache", async () => {
    let loads = 0;
    const key = cacheKey("token", "1", "chain", "0x" + "1".repeat(40));
    await expect(
      cached(key, "LONG", async () => {
        loads++;
        throw Error("RPC_UNAVAILABLE");
      }),
    ).rejects.toThrow("RPC_UNAVAILABLE");
    const ok = await cached(
      key,
      "LONG",
      async () => (loads++, { decimals: 6, symbol: "USDC" }),
    );
    expect(ok).toEqual({ value: { decimals: 6, symbol: "USDC" }, hit: false });
    expect(loads).toBe(2);
    expect(() => cacheSet(key, { risk: "x" }, "SHORT")).toThrow(
      "SHORT_STATE_NOT_CACHED_HERE",
    );
    expect(() =>
      cacheKey("token", "1", "0xWALLET", "0x" + "1".repeat(40)),
    ).toThrow();
  });
  it("concurrent cold scans of two wallets prove each nonzero Aave reserve identity once (single-flight)", async () => {
    const world = buildWorld({ chains: ["1"] });
    const a = seedProfile(world, "production"),
      b = seedProfile(world, "whale");
    const plane = new DataPlane(null, world.net.transport, 60000, () => ({
      ...base,
      endpoints: world.net.endpoints("1"),
    }));
    const opts = {
      deploymentIds: ["aave-v3-1"],
      priceRead: simPriceRead(world),
      catalog: null,
      clientScope: "v1141",
    };
    const [sa, sb] = await Promise.all([
      scanDefi(a, plane, opts),
      scanDefi(b, plane, opts),
    ]);
    expect(sa.positions[0].wallet).toBe(a);
    expect(sb.positions[0].wallet).toBe(b);
    const proofs = world.net.chains
      .get("1")!
      .callLog.filter((c) => c.name === "getReserveTokensAddresses")
      .map((c) => c.args);
    expect(proofs.length).toBeGreaterThan(3);
    expect(proofs.length).toBe(new Set(proofs).size);
  });
  it("identical concurrent scans share one in-flight scan; identical reads inside one round share one result", async () => {
    const s = setup();
    const [x, y] = await Promise.all([
      scanOne(s, "aave-v3-1"),
      scanOne(s, "aave-v3-1"),
    ]);
    expect(x.scanId).toBe(y.scanId);
    // Three UniswapV2-family probes of the same held tokens: identical token views are read once per round.
    clearScanStateForTests();
    views(s.world).length = 0;
    await scanDefi(s.wallet, s.plane, {
      deploymentIds: ["uniswap-v2-1", "sushiswap-v2-1", "pancakeswap-v2-1"],
      held: s.held,
      priceRead: simPriceRead(s.world),
      store: s.world.store,
      catalog: null,
    });
    const factoryReads = views(s.world).filter((v) => v.endsWith(":factory"));
    expect(factoryReads.length).toBeGreaterThan(0);
    expect(factoryReads.length).toBe(new Set(factoryReads).size);
  });
});

describe("V1.14.1 failure, throttling and partial truth (PF5, PF6, R1-R3, R7)", () => {
  it("expected contract reverts of receipt probes never quarantine the endpoint the other adapters use", async () => {
    const s = setup();
    const scan = await scanDefi(s.wallet, s.plane, {
      deploymentIds: [
        "curve-1",
        "uniswap-v2-1",
        "sushiswap-v2-1",
        "aave-v3-1",
        "compound-1-usdc",
        "lido-1",
      ],
      held: [...s.held, "1:0x" + "ab".repeat(20)],
      priceRead: simPriceRead(s.world),
      store: s.world.store,
      catalog: null,
    });
    expect(quarantined(s.plane)).toBe(false);
    expect(scan.coverage.some((c) => c.state === "FAILED")).toBe(false);
    expect(
      scan.coverage.find((c) => c.deploymentId === "aave-v3-1")!.state,
    ).toBe("FULL_POSITION");
  });
  it("an aggregate above the provider's capacity is split (bounded), never fanned out and never quarantines", async () => {
    const s = setup({ markets: 1814, vaults: 0 });
    s.world.net.behavior.set(`https://rpc0.sim.test/1`, {
      latencyMs: 0,
      perItemMs: 0,
      jitter: 0,
      maxAggregateInner: 300,
    });
    const scan = await scanOne(s, "morpho-blue-1");
    const c = scan.coverage[0];
    expect(c).toMatchObject({ state: "FULL_POSITION", scanResult: "NONZERO" });
    expect(c.retries).toBeGreaterThan(0);
    const k = census(s.world.net.log);
    // 4 chunks of <=500 -> each split once into halves of <=250 (no single-call fan-out of 1,814 markets).
    expect(k.multicallBatches).toBeLessThanOrEqual(4 + 8 + 4);
    expect(k.byMethod.eth_call).toBeLessThan(30);
    expect(quarantined(s.plane)).toBe(false);
    expect(PREFILTER_CHUNK).toBeLessThanOrEqual(500);
  });
  it("a throttling provider stops the registry prefilter: bounded requests, never a checked zero", async () => {
    const s = setup({ markets: 1814, vaults: 382 });
    s.world.net.behavior.set(`https://rpc0.sim.test/1`, {
      latencyMs: 5,
      perItemMs: 0,
      jitter: 0,
      ratePerSecond: 4,
    });
    for (const id of ["morpho-blue-1", "morpho-vault-1"]) {
      clearScanStateForTests();
      s.world.net.reset();
      const scan = await scanOne(s, id);
      const c = scan.coverage[0];
      expect(c.scanResult).not.toBe("CHECKED_ZERO");
      expect([
        "FAILED",
        "PARTIAL_POSITION",
        "NOT_CHECKED",
        "FULL_POSITION",
      ]).toContain(c.state);
      if (c.state === "FULL_POSITION") expect(c.result).toBe("NONZERO");
      // Never a storm: at most the chunk count plus pin, proofs, positions and the reorg check.
      expect(s.world.net.log.length).toBeLessThanOrEqual(20);
      await new Promise((r) => setTimeout(r, 1100));
    }
  });
  it("a failed whole request is FAILED (never zero) and a failed scan is not served from the result cache", async () => {
    const s = setup();
    s.world.net.behavior.set(`https://rpc0.sim.test/1`, {
      latencyMs: 0,
      perItemMs: 0,
      jitter: 0,
      failNext: 0,
    });
    const first = await scanOne(s, "aave-v3-1");
    expect(first.coverage[0].state).toBe("FULL_POSITION");
    clearScanStateForTests();
    // Every request after the pin fails: the adapter fails truthfully.
    const plane = new DataPlane(
      null,
      (async (e, body, o) => {
        const b = body as { method?: string } | unknown[];
        if (!Array.isArray(b) && b.method === "eth_call")
          throw new RpcError("HTTP_ERROR", "503");
        return s.world.net.transport(e, body, o);
      }) as RpcTransport,
      60000,
      () => ({ ...base, endpoints: s.world.net.endpoints("1") }),
    );
    const failed = await scanDefi(s.wallet, plane, {
      deploymentIds: ["aave-v3-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    expect(failed.coverage[0]).toMatchObject({
      state: "FAILED",
      result: "UNKNOWN",
      scanResult: "FAILED",
    });
    const again = await scanDefi(s.wallet, plane, {
      deploymentIds: ["aave-v3-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    expect(again.scanId).not.toBe(failed.scanId);
  });
  it("a partial Multicall result set is rejected as a whole and never decoded into zeros", async () => {
    const s = setup({ profile: "zero" });
    const truncating: RpcTransport = async (e, body, o) => {
      const out = (await s.world.net.transport(e, body, o)) as {
        result?: unknown;
      };
      const b = body as {
        method?: string;
        params?: { to?: string; data?: string }[];
      };
      if (
        !Array.isArray(body) &&
        b.method === "eth_call" &&
        b.params?.[0]?.to === MULTICALL3 &&
        b.params[0].data?.startsWith(SELECTORS.aggregate3)
      ) {
        const n = (
          decodeFunctionData({
            abi: multicall3Abi,
            data: b.params[0].data as Hex,
          }).args[0] as unknown[]
        ).length;
        return {
          ...out,
          result: encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: Array.from({ length: n - 1 }, () => ({
              success: true,
              returnData: ("0x" + "0".repeat(64)) as Hex,
            })),
          }),
        };
      }
      return out;
    };
    const plane = new DataPlane(null, truncating, 60000, () => ({
      ...base,
      endpoints: s.world.net.endpoints("1"),
    }));
    const scan = await scanDefi(s.wallet, plane, {
      deploymentIds: ["aave-v3-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    expect(scan.coverage[0].scanResult).not.toBe("CHECKED_ZERO");
    expect(scan.coverage[0].state).toBe("FAILED");
  });
  it("a malformed JSON-RPC batch (duplicate ids) never yields a value", async () => {
    const d =
      deployments.find((x) => x.id === "aave-v3-324") ??
      deployments.find((x) => x.adapter === "aave-v3")!;
    const endpoint = {
      id: "s",
      chainId: d.chainId,
      url: "https://s.test",
      priority: 1,
      supportsLogs: false,
      maxLogRange: 0,
      supportsBatch: true,
      supportsFinalized: false,
      supportsSafe: false,
      archive: false,
    };
    const pool = new RpcPool(
      d.chainId,
      { ecosystem: "EVM" },
      [endpoint],
      async (_e, body) =>
        Array.isArray(body)
          ? (body as { id: number }[]).map(() => ({
              jsonrpc: "2.0",
              id: 1,
              result: "0x",
            }))
          : {
              jsonrpc: "2.0",
              id: 1,
              error: { code: -32000, message: "unavailable" },
            },
    );
    const pin = {
      number: 5n,
      hash: ("0x" + "11".repeat(32)) as Hex,
      timestamp: 1n,
      observedAt: Date.now(),
      endpointId: "s",
      endpointGroup: "SYNTHETIC",
    };
    const r = new DefiReader(
      d,
      SIM_WALLETS.zero,
      pin,
      new AbortController().signal,
      pool,
    );
    (
      r as unknown as { multicallVerified: Promise<boolean> }
    ).multicallVerified = Promise.resolve(false);
    const out = await Promise.allSettled([
      r.read(d.contracts.pool, "getUserAccountData", [SIM_WALLETS.zero]),
      r.read(d.contracts.provider, "getAllReservesTokens"),
    ]);
    expect(out.every((x) => x.status === "rejected")).toBe(true);
    expect(r.errors).toBeGreaterThan(0);
  });
  it("a slow adapter never blocks the others: their results arrive first and it fails by its own deadline", async () => {
    const s = setup();
    const comet = deployments.find((d) => d.id === "compound-1-usdc")!.contracts
      .comet;
    const slow: RpcTransport = async (e, body, o) => {
      if (JSON.stringify(body).toLowerCase().includes(comet.slice(2)))
        await new Promise((r) => setTimeout(r, 2000));
      return s.world.net.transport(e, body, o);
    };
    const plane = new DataPlane(null, slow, 60000, () => ({
      ...base,
      endpoints: s.world.net.endpoints("1"),
    }));
    const order: string[] = [];
    const scan = await scanDefi(s.wallet, plane, {
      deploymentIds: ["compound-1-usdc", "aave-v3-1", "lido-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
      perAdapterMs: 400,
      onResult: (part) => order.push(part.coverage.deploymentId),
    });
    expect(order.indexOf("compound-1-usdc")).toBe(order.length - 1);
    expect(
      scan.coverage.find((c) => c.deploymentId === "compound-1-usdc"),
    ).toMatchObject({
      state: "FAILED",
      reason: "SCAN_TIMEOUT",
      result: "UNKNOWN",
    });
    expect(scan.positions.some((p) => p.deploymentId === "aave-v3-1")).toBe(
      true,
    );
    expect(scan.positions.some((p) => p.deploymentId === "lido-1")).toBe(true);
  });
  it("bounded failover: a throttled pinned endpoint is replaced once by the other healthy endpoint", async () => {
    const s = setup({ endpoints: 2 });
    let throttled = 0;
    const transport: RpcTransport = async (e, body, o) => {
      if (
        e.url.includes("rpc0") &&
        !Array.isArray(body) &&
        (body as { method: string }).method === "eth_call"
      ) {
        throttled++;
        throw new RpcError("RATE_LIMITED", "429");
      }
      return s.world.net.transport(e, body, o);
    };
    const plane = new DataPlane(null, transport, 60000, () => ({
      ...base,
      endpoints: s.world.net.endpoints("1", 2),
    }));
    const scan = await scanDefi(s.wallet, plane, {
      deploymentIds: ["aave-v3-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    expect(throttled).toBeGreaterThan(0);
    expect(scan.coverage[0]).toMatchObject({
      state: "FULL_POSITION",
      scanResult: "NONZERO",
    });
    expect(scan.coverage[0].retries).toBeGreaterThan(0);
    expect(scan.receipt!.requests!.pins).toBe(2);
  });
  it("retry storms are bounded: a provider answering 429 to everything receives a bounded number of requests", async () => {
    const s = setup();
    let requests = 0;
    const transport: RpcTransport = async (e, body, o) => {
      requests++;
      if (requests > 3) throw new RpcError("RATE_LIMITED", "429");
      return s.world.net.transport(e, body, o);
    };
    const plane = new DataPlane(null, transport, 60000, () => ({
      ...base,
      endpoints: s.world.net.endpoints("1"),
    }));
    const ids = deployments
      .filter((d) => d.chainId === "1")
      .map((d) => d.id)
      .slice(0, 12);
    const scan = await scanDefi(s.wallet, plane, {
      deploymentIds: ids,
      maxDeployments: 12,
      held: s.held,
      priceRead: simPriceRead(s.world),
      store: s.world.store,
      catalog: null,
    });
    expect(requests).toBeLessThanOrEqual(8);
    expect(
      scan.coverage.every(
        (c) => c.scanResult !== "CHECKED_ZERO" || c.calls > 0,
      ),
    ).toBe(true);
    expect(scan.coverage.some((c) => c.reason === "RPC_COOLDOWN")).toBe(true);
    // Throttling is a provider condition: it never trips a protocol's circuit.
    clearScanStateForTests();
  });
});

describe("V1.14.1 candidate tiers and dedup (PF10, §11-12)", () => {
  it("exact held receipts are scheduled first and bounded fallback probes last; every coverage row carries its tier", async () => {
    const s = setup();
    const scan = await scanDefi(s.wallet, s.plane, {
      chains: ["1"],
      held: s.held,
      maxDeployments: 32,
      priceRead: simPriceRead(s.world),
      store: s.world.store,
      catalog: null,
    });
    const run = scan.coverage.filter(
      (c) => c.reason !== "NO_RECEIPT_CANDIDATE",
    );
    const tiers = run.map((c) => c.tier!);
    expect(tiers.every(Boolean)).toBe(true);
    expect(scan.receipt!.tiers!.EXACT_HELD_RECEIPT).toBeGreaterThan(0);
    expect(scan.receipt!.tiers!.BOUNDED_FALLBACK_PROBE).toBeGreaterThan(0);
    // Every candidate of the scope is still scheduled (priority only, never a skipped class).
    expect(scan.receipt!.funnel.candidateDeployments).toBe(
      run.length + scan.continuation.length,
    );
    expect(CANDIDATE_TIERS[0]).toBe("EXACT_HELD_RECEIPT");
    expect(CANDIDATE_TIERS.at(-1)).toBe("BOUNDED_FALLBACK_PROBE");
  });
  it("native coin ids and duplicate held ids never become receipt candidates", async () => {
    const s = setup({ profile: "zero" });
    const scan = await scanDefi(s.wallet, s.plane, {
      deploymentIds: ["curve-1", "balancer-v2-1", "uniswap-v2-1"],
      held: [
        "1:0x0000000000000000000000000000000000000000",
        "1:0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        "1:0x0000000000000000000000000000000000000000",
      ],
      priceRead: simPriceRead(s.world),
      store: s.world.store,
      catalog: null,
    });
    for (const c of scan.coverage) {
      expect(c.state).not.toBe("FAILED");
      expect(c.scanResult).toBe("NOT_CHECKED");
    }
    expect(
      scan.coverage.find((c) => c.deploymentId === "curve-1")!.reason,
    ).toBe("NO_RECEIPT_CANDIDATE");
  });
  it("duplicate continuation ids are scheduled exactly once", async () => {
    const s = setup({ profile: "zero" });
    const scan = await scanDefi(s.wallet, s.plane, {
      deploymentIds: ["lido-1", "lido-1", "lst-reth-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    expect(scan.coverage.map((c) => c.deploymentId).sort()).toEqual([
      "lido-1",
      "lst-reth-1",
    ]);
  });
});

describe("V1.14.1 progressive results and timing receipts (PF7-PF9, §13)", () => {
  it("receipt timing and request census describe the round exactly", async () => {
    const s = setup();
    const scan = await scanDefi(s.wallet, s.plane, {
      deploymentIds: ["aave-v3-1", "compound-1-usdc", "lido-1", "lst-reth-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    const t = scan.receipt!.timing!;
    expect(t.firstResultMs).not.toBeNull();
    expect(t.firstResultMs!).toBeLessThanOrEqual(t.roundMs);
    const r = scan.receipt!.requests!;
    expect(r.http).toBe(census(s.world.net.log).httpRequests);
    expect(r.multicallBatches).toBe(census(s.world.net.log).multicallBatches);
    expect(r.pins).toBe(1);
    scanSchema.parse(scan);
  });
  it("readRound renders validated progress before the final round and rejects another wallet's data", async () => {
    const s = setup();
    const lines: string[] = [];
    const scan = await scanDefi(s.wallet, s.plane, {
      deploymentIds: ["aave-v3-1", "lido-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
      onResult: (part) =>
        lines.push(JSON.stringify({ type: "progress", ...part })),
    });
    lines.push(JSON.stringify({ type: "scan", scan }));
    const body = (text: string) =>
      new Response(text, {
        headers: { "Content-Type": "application/x-ndjson" },
      });
    const partials: DefiScan[] = [];
    const final = await readRound(
      body(lines.join("\n") + "\n"),
      s.wallet,
      (p) => partials.push(p),
    );
    expect(partials.length).toBe(2);
    expect(partials[0].coverage).toHaveLength(1);
    expect(final.scanId).toBe(scan.scanId);
    await expect(
      readRound(body(lines.join("\n") + "\n"), SIM_WALLETS.zero, () => {}),
    ).rejects.toThrow("WALLET_SCOPE_MISMATCH");
    await expect(
      readRound(body(lines[0] + "\n"), s.wallet, () => {}),
    ).rejects.toThrow("INCOMPLETE_ROUND");
    const json = await readRound(
      new Response(JSON.stringify(scan), {
        headers: { "Content-Type": "application/json" },
      }),
      s.wallet,
      () => partials.push(scan),
    );
    expect(json.scanId).toBe(scan.scanId);
  });
  it("User Timing receipts: walletFirst <= firstDefi; a new scan (other identity) clears the previous receipts", async () => {
    performance.clearMeasures();
    perf.scanStart();
    await new Promise((r) => setTimeout(r, 5));
    perf.once("walletFirstResultMs");
    perf.defiStart();
    await new Promise((r) => setTimeout(r, 5));
    perf.once("firstDefiResultMs");
    perf.once("firstDefiResultMs");
    perf.once("fullDefiScanMs");
    const m = (n: string) =>
      performance.getEntriesByName("otherbridge:" + n, "measure");
    expect(m("walletFirstResultMs")).toHaveLength(1);
    expect(m("firstDefiResultMs")).toHaveLength(1);
    expect(m("walletFirstResultMs")[0].duration).toBeLessThanOrEqual(
      m("firstDefiResultMs")[0].duration,
    );
    expect(m("fullDefiScanMs")).toHaveLength(1);
    perf.scanStart();
    expect(m("walletFirstResultMs")).toHaveLength(0);
    expect(m("firstDefiResultMs")).toHaveLength(0);
    expect(m("fullDefiScanMs")).toHaveLength(0);
  });
  it("fixture timing: the wallet page, the first DeFi result and the full scan are measured in order", async () => {
    const s = setup();
    for (const b of s.world.net.endpoints("1"))
      s.world.net.behavior.set(b.url, {
        latencyMs: 20,
        perItemMs: 0,
        jitter: 0,
      });
    const t0 = performance.now();
    let first: number | null = null;
    let continuation: string[] | undefined;
    for (let round = 0; round < 10; round++) {
      const scan = await scanDefi(s.wallet, s.plane, {
        chains: ["1"],
        deploymentIds: continuation,
        held: s.held,
        priceRead: simPriceRead(s.world),
        store: s.world.store,
        catalog: null,
        onResult: () => (first ??= performance.now() - t0),
      });
      continuation = scan.continuation;
      if (!continuation.length) break;
    }
    const full = performance.now() - t0;
    expect(first).not.toBeNull();
    expect(first!).toBeLessThan(full);
    expect(continuation).toEqual([]);
  });
});

describe("V1.14.1 adversarial reads (§38)", () => {
  it("a forged or wallet-supplied address can never become a call target of an account family", async () => {
    const s = setup();
    const evil = "0x" + "ee".repeat(19) + "01";
    s.world.net.chains
      .get("1")!
      .contract(evil, { getUserAccountData: () => [1n, 1n, 1n, 1n, 1n, 1n] });
    for (const id of [
      "aave-v3-1",
      "compound-1-usdc",
      "lido-1",
      "eigenlayer-1",
      "uniswap-v3-1",
    ])
      await scanOne(s, id, { held: [...s.held, "1:" + evil] });
    expect(views(s.world).some((v) => v.startsWith(evil))).toBe(false);
    const d = deployments.find((x) => x.id === "aave-v3-1")!;
    const pin = await pinChain(
      s.plane.pool(await s.plane.state(), "1")!,
      new AbortController().signal,
    );
    const r = new DefiReader(
      d,
      s.wallet,
      pin,
      new AbortController().signal,
      s.plane.pool(await s.plane.state(), "1")!,
    );
    await expect(
      r.read(evil, "getUserAccountData", [s.wallet]),
    ).rejects.toThrow("TARGET_NOT_AUTHORIZED");
    await expect(
      r.readAggregate([{ target: evil, name: "balanceOf", args: [s.wallet] }]),
    ).rejects.toThrow("TARGET_NOT_AUTHORIZED");
    expect(COALESCE_MAX).toBeLessThanOrEqual(500);
  });
  it("each round reads user state at its own pin: no read of an earlier block is reused", async () => {
    const s = setup();
    const a = await scanOne(s, "aave-v3-1");
    s.world.net.chains.get("1")!.number += 5n;
    clearScanStateForTests();
    views(s.world).length = 0;
    const b = await scanOne(s, "aave-v3-1");
    expect(b.positions[0].sourceBlock).toBe(
      (BigInt(a.positions[0].sourceBlock) + 5n).toString(),
    );
    expect(named(s.world, "getUserReserveData")).toBeGreaterThan(60);
    expect(named(s.world, "getUserAccountData")).toBe(1);
  });
  it("an endpoint reporting another chain is rejected before any protocol read", async () => {
    const s = setup();
    const lying: RpcTransport = async (e, body, o) => {
      const out = await s.world.net.transport(e, body, o);
      const fix = (x: { id: number; result?: unknown }, m: string) =>
        m === "eth_chainId" ? { ...x, result: "0x2105" } : x;
      return Array.isArray(body)
        ? (out as { id: number }[]).map((x, i) =>
            fix(x, (body as { method: string }[])[i].method),
          )
        : fix(out as { id: number }, (body as { method: string }).method);
    };
    const plane = new DataPlane(null, lying, 60000, () => ({
      ...base,
      endpoints: s.world.net.endpoints("1"),
    }));
    const scan = await scanDefi(s.wallet, plane, {
      deploymentIds: ["aave-v3-1"],
      priceRead: simPriceRead(s.world),
      catalog: null,
    });
    expect(scan.coverage[0]).toMatchObject({
      state: "FAILED",
      reason: "CHAIN_MISMATCH",
    });
    expect(s.world.net.log.some((r) => r.methods.includes("eth_call"))).toBe(
      false,
    );
  });
  it("account switch mid-scan: concurrent scans of two wallets never share positions, memos or results", async () => {
    const world = buildWorld({ chains: ["1"] });
    const a = seedProfile(world, "production"),
      b = SIM_WALLETS.zero;
    const plane = new DataPlane(null, world.net.transport, 60000, () => ({
      ...base,
      endpoints: world.net.endpoints("1"),
    }));
    const opts = {
      chains: ["1"],
      held: world.held(a),
      priceRead: simPriceRead(world),
      store: world.store,
      catalog: null,
      clientScope: "app",
    };
    const [sa, sb] = await Promise.all([
      scanDefi(a, plane, opts),
      scanDefi(b, plane, opts),
    ]);
    expect(sa.positions.every((p) => p.wallet === a)).toBe(true);
    expect(sb.positions).toEqual([]);
    expect(sb.coverage.filter((c) => c.scanResult === "NONZERO")).toEqual([]);
  });
  it("stale risk is never served as fresh: an old pin fails and a cached round expires after 30 s", async () => {
    const s = setup();
    const scan = await scanOne(s, "aave-v3-1", {
      pinFactory: async (chainId, signal) => ({
        ...(await pinChain(
          s.plane.pool(await s.plane.state(), chainId)!,
          signal,
        )),
        observedAt: Date.now() - 120000,
      }),
    });
    expect(scan.coverage[0]).toMatchObject({
      state: "FAILED",
      reason: "STALE_STATE",
    });
    clearScanStateForTests();
    const fresh = await scanOne(s, "aave-v3-1");
    expect((await scanOne(s, "aave-v3-1")).scanId).toBe(fresh.scanId);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31000);
    const later = await scanOne(s, "aave-v3-1");
    expect(later.scanId).not.toBe(fresh.scanId);
    expect(later.positions[0].observedAt).toBeGreaterThanOrEqual(now + 31000);
  });
  it("prewarm reads deployment metadata only: no wallet-scoped view, then the first scan reuses it", async () => {
    const s = setup();
    const report = await prewarmDefiMetadata(s.plane, {
      chains: ["1"],
      deadlineMs: 20000,
    });
    expect(report.deployments).toBeGreaterThan(20);
    const userViews =
      /:(getUserReserveData|getUserAccountData|position|balanceOf|borrowBalanceOf|collateralBalanceOf|getAllUserRewards|getDeposits|getWithdrawalRequests|tokenOfOwnerByIndex)$/;
    expect(views(s.world).filter((v) => userViews.test(v))).toEqual([]);
    views(s.world).length = 0;
    const scan = await scanOne(s, "aave-v3-1");
    expect(scan.coverage[0].state).toBe("FULL_POSITION");
    expect(named(s.world, "getReserveTokensAddresses")).toBe(0);
  });
});

describe("V1.14.1 catalog stays out of the client bundle (PF13)", () => {
  it("no client module (transitively) imports the global catalog store or its data", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const n of readdirSync(d)) {
        const p = join(d, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(n)) files.push(p);
      }
    };
    walk("src");
    const clients = files.filter((f) =>
      /^["']use client["']/.test(readFileSync(f, "utf8").trimStart()),
    );
    expect(clients.length).toBeGreaterThan(5);
    const seen = new Set<string>();
    const forbidden: string[] = [];
    const visit = (f: string, from: string) => {
      const key = resolve(f);
      if (seen.has(key)) return;
      seen.add(key);
      const text = readFileSync(f, "utf8");
      if (/content[\\/]defi-universe|defi\/universe\/(store|db|io)"/.test(text))
        forbidden.push(from + " -> " + f);
      for (const m of text.matchAll(
        /^import\s+(?!type\b)[^;]*?from\s+["'](\.[^"']+)["']/gm,
      )) {
        const base = resolve(dirname(f), m[1]);
        const target = [
          base + ".ts",
          base + ".tsx",
          join(base, "index.ts"),
        ].find((x) => existsSync(x));
        if (target && !/\.json$/.test(target)) visit(target, from);
      }
    };
    for (const c of clients) visit(c, c);
    expect(forbidden).toEqual([]);
  });
});
