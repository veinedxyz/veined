import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  encodeAbiParameters,
  encodeFunctionData,
  encodeFunctionResult,
  keccak256,
  toEventSelector,
  type Hex,
} from "viem";
import { deployments } from "../../src/defi/registry";
import { adapterFor, type AdapterContext } from "../../src/defi/adapters";
import {
  isqrt,
  pendingFeeLiquidity,
  uncollectedFees,
} from "../../src/defi/families";
import { abiFor } from "../../src/defi/abi";
import { DefiReader, NATIVE_ASSET } from "../../src/defi/reader";
import { usdValue } from "../../src/data/core/price";
import { WAD } from "../../src/defi/math";
import type { DefiPosition, PositionAsset } from "../../src/defi/model";
import { buildReverseIndex, ReverseIndex } from "../../src/defi/reverse-index";
import { decodeLaneLog, httpLogSource, LANES } from "../../src/defi/lanes";
import { assertAllowed } from "../../src/data/rpc/methods";
import { encodeAggregate3, multicall3Abi } from "../../src/data/evm/erc20";
import { MULTICALL3 } from "../../src/data/evm/multicall";
import { RpcPool } from "../../src/data/rpc/pool";
import {
  exposureGraph,
  leverage,
  portfolioTotals,
} from "../../src/defi/valuation";
// V1.14 reviewed position families. Every value below is a SYNTHETIC FIXTURE: no live chain, no wallet, no signing.
const W = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
const A = (n: number) => "0x" + n.toString(16).padStart(40, "0");
const ZERO = A(0);
const USDC = A(0xc0),
  WETH = A(0xe0),
  DAI = A(0xda);
type Handler = (target: string, args: readonly unknown[]) => unknown;
function mock(
  deploymentId: string,
  reads: Record<string, Handler>,
  meta: Record<string, { symbol: string; decimals: number }> = {},
) {
  const deployment = deployments.find((d) => d.id === deploymentId)!;
  expect(deployment, deploymentId).toBeDefined();
  const log: string[] = [];
  const ctx: AdapterContext = {
    deployment,
    wallet: W,
    pin: {
      number: 100n,
      hash: ("0x" + "cd".repeat(32)) as Hex,
      timestamp: BigInt(Math.floor(Date.now() / 1000)),
      observedAt: Date.now(),
      endpointId: "synthetic",
      endpointGroup: "SYNTHETIC_FIXTURE",
    },
    signal: new AbortController().signal,
    evidence: [],
    calls: 0,
    errors: 0,
    batches: 0,
    fallbacks: 0,
    refs: [],
    discoveryComplete: true,
    trustedOracles: new Set(),
    curatedVaults: new Set(),
    async code() {
      return "0x6000";
    },
    async asset(target, raw, role, metadata) {
      const m = metadata ??
        meta[target] ?? {
          symbol: target === USDC ? "USDC" : "TKN",
          decimals: target === USDC ? 6 : 18,
        };
      return {
        assetId: deployment.chainId + ":" + target,
        chainId: deployment.chainId,
        contract: target,
        symbol: m.symbol,
        decimals: m.decimals,
        rawAmount: raw.toString(),
        role,
        price: {
          priceUsd: "1",
          observedAt: Date.now(),
          method: "synthetic-fixture",
          confidence: "verified",
        },
        valueUsd: usdValue(raw, m.decimals, "1"),
      } as PositionAsset;
    },
    async read(target, name, args = []) {
      ctx.calls++;
      log.push(name);
      const f = reads[name];
      if (!f) throw Error("UNEXPECTED_READ:" + name);
      return f(target, args);
    },
  };
  return { ctx, log, deployment, adapter: adapterFor(deployment) };
}
const READ_ONLY_VIEW =
  /^(get|is|balanceOf|total|token|factory|asset|convert|shares|underlying|pod|lp_token|stable|earned|reward|gauges|staking|position|slot0|fee|tick|ticks|kLast|deployer|owner|find|positions|poolFor|decimals|symbol|exchangeRate|swETH|rsETH|mETH)/;
describe("V1.14 liquid staking: exact protocol conversion, never 1:1", () => {
  it("rETH uses the protocol conversion view (getEthValue) on the exact balance", async () => {
    const { ctx, adapter, deployment } = mock("lst-reth-1", {
      balanceOf: () => 2n * WAD,
      getEthValue: (_t, [raw]) => ((raw as bigint) * 11n) / 10n,
    });
    const [ref] = await adapter.discover(ctx);
    const p = (await adapter.readPosition(ref, ctx))!;
    expect(p.underlying).toHaveLength(1);
    expect(p.underlying[0]).toMatchObject({
      contract: NATIVE_ASSET,
      symbol: "ETH",
      rawAmount: ((2n * WAD * 11n) / 10n).toString(),
    });
    expect(p.details.rateRaw).toBe(((WAD * 11n) / 10n).toString());
    expect(p.warnings).not.toContain("PROTOCOL_REPORTED_RATE");
    expect(p.representations).toEqual(["1:" + deployment.contracts.token]);
    expect(p.adapterVersion).toBe("1.1.0");
  });
  it("swETH uses the protocol-reported rate and says so", async () => {
    const { ctx, adapter } = mock("lst-sweth-1", {
      balanceOf: () => 3n * WAD,
      swETHToETHRate: () => (WAD * 105n) / 100n,
    });
    const p = (await adapter.readPosition(
      { key: "account", discovery: "registry" },
      ctx,
    ))!;
    expect(p.underlying[0].rawAmount).toBe(
      ((3n * WAD * 105n) / 100n).toString(),
    );
    expect(p.warnings).toContain("PROTOCOL_REPORTED_RATE");
    expect(p.details.identity).toBe("ONCHAIN_DERIVED");
  });
  it("a missing rate or a non-18-decimals token fails instead of assuming 1:1", async () => {
    const zero = mock("lst-sweth-1", {
      balanceOf: () => 3n * WAD,
      swETHToETHRate: () => 0n,
    });
    await expect(
      zero.adapter.readPosition(
        { key: "account", discovery: "registry" },
        zero.ctx,
      ),
    ).rejects.toThrow("RATE_UNAVAILABLE");
    const d = deployments.find((x) => x.id === "lst-sweth-1")!;
    const odd = mock(
      "lst-sweth-1",
      { balanceOf: () => 3n * WAD, swETHToETHRate: () => WAD },
      { [d.contracts.token]: { symbol: "swETH", decimals: 6 } },
    );
    await expect(
      odd.adapter.readPosition(
        { key: "account", discovery: "registry" },
        odd.ctx,
      ),
    ).rejects.toThrow("RATE_DECIMALS_UNSUPPORTED");
  });
  it("a zero balance is a checked zero (no position, no conversion read)", async () => {
    const { ctx, adapter, log } = mock("lst-reth-1", {
      balanceOf: () => 0n,
    });
    expect(
      await adapter.readPosition(
        { key: "account", discovery: "registry" },
        ctx,
      ),
    ).toBeNull();
    expect(log).toEqual(["balanceOf"]);
  });
});
describe("V1.14 EigenLayer restaking", () => {
  const d = deployments.find((x) => x.id === "eigenlayer-1")!;
  const steth = d.strategies![0];
  const base = (over: Record<string, Handler> = {}) =>
    mock("eigenlayer-1", {
      getDeposits: () => [
        [steth.strategy, A(0x5eed)],
        [10n * WAD, 5n * WAD],
      ],
      getWithdrawableShares: (_t, [, list]) => {
        expect(list).toEqual([steth.strategy]);
        return [[9n * WAD], [10n * WAD]];
      },
      underlyingToken: () => steth.underlying,
      sharesToUnderlyingView: (_t, [s]) => ((s as bigint) * 105n) / 100n,
      podOwnerDepositShares: () => 0n,
      getQueuedWithdrawalRoots: () => [],
      ...over,
    });
  it("values reviewed strategies from slashing-aware withdrawable shares; unreviewed ones keep it PARTIAL", async () => {
    const { ctx, adapter } = base();
    const p = (await adapter.readPosition(
      { key: "account", discovery: "registry" },
      ctx,
    ))!;
    expect(p.supplied).toHaveLength(1);
    expect(p.supplied[0]).toMatchObject({
      contract: steth.underlying,
      rawAmount: ((9n * WAD * 105n) / 100n).toString(),
    });
    expect(p.coverage).toBe("PARTIAL_POSITION");
    expect(p.warnings).toContain("UNREVIEWED_STRATEGY");
    // stETH is itself a reviewed Lido receipt: shown as the wrapper, never silently decomposed.
    expect(p.warnings).toContain("UNDERLYING_NOT_DECOMPOSED");
    expect(p.details.notDecomposed).toBe("TKN");
  });
  it("a strategy whose underlying token differs from the reviewed one is rejected", async () => {
    const { ctx, adapter } = base({ underlyingToken: () => A(0xbad) });
    await expect(
      adapter.readPosition({ key: "account", discovery: "registry" }, ctx),
    ).rejects.toThrow("STRATEGY_IDENTITY_MISMATCH");
  });
  it("native restaking deficits and queued withdrawals are explicit, never valued", async () => {
    const { ctx, adapter } = base({
      getDeposits: () => [[], []],
      getWithdrawableShares: () => [[], []],
      podOwnerDepositShares: () => -1n,
      getQueuedWithdrawalRoots: () => ["0x" + "11".repeat(32)],
    });
    const p = (await adapter.readPosition(
      { key: "account", discovery: "registry" },
      ctx,
    ))!;
    expect(p.supplied).toEqual([]);
    expect(p.warnings).toEqual(
      expect.arrayContaining([
        "NATIVE_RESTAKING_DEFICIT",
        "QUEUED_WITHDRAWALS_NOT_VALUED",
      ]),
    );
    expect(p.grossAssetsUsd).toBe("0.000000");
  });
});
describe("V1.14 Curve (MetaRegistry identity, proportional share)", () => {
  const CURVE_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const lp = A(0x1a),
    pool = A(0x1b),
    gauge = A(0x1c),
    meta = A(0x2a),
    metaLp = A(0x2b),
    baseLp = A(0x3b),
    basePool = A(0x3c);
  const pad8 = <T>(v: T[], fill: T) => [
    ...v,
    ...Array(8 - v.length).fill(fill),
  ];
  const registry: Record<string, string> = {
    [lp]: pool,
    [metaLp]: meta,
    [baseLp]: basePool,
  };
  const coins: Record<string, string[]> = {
    [pool]: [USDC, CURVE_NATIVE],
    [meta]: [DAI, baseLp],
    [basePool]: [USDC, WETH],
  };
  const balances: Record<string, bigint[]> = {
    [pool]: [1_000_000n * 10n ** 6n, 400n * WAD],
    [meta]: [500n * WAD, 300n * WAD],
    [basePool]: [2_000n * 10n ** 6n, 3n * WAD],
  };
  const supply: Record<string, bigint> = {
    [lp]: 1000n * WAD,
    [metaLp]: 100n * WAD,
    [baseLp]: 600n * WAD,
  };
  const reads = (gaugeOf: string = gauge): Record<string, Handler> => ({
    get_pool_from_lp_token: (_t, [x]) => registry[x as string] ?? ZERO,
    get_n_coins: (_t, [p]) => BigInt(coins[p as string].length),
    get_coins: (_t, [p]) => pad8(coins[p as string], ZERO),
    get_balances: (_t, [p]) => pad8(balances[p as string], 0n),
    totalSupply: (t) => supply[t],
    balanceOf: (t) =>
      t === gauge ? 4n * WAD : t === metaLp ? 10n * WAD : 10n * WAD,
    lp_token: (t) => {
      if (t !== gauge) throw Error("REVERT");
      return lp;
    },
    get_gauge: () => gaugeOf,
    get_address: () => A(0x99),
  });
  it("splits an LP balance into exact pool shares and maps the native sentinel to native ETH", async () => {
    const { ctx, adapter } = mock("curve-1", reads());
    const p = (await adapter.readPosition(
      { key: lp, contract: lp, discovery: "token-triggered" },
      ctx,
    ))!;
    expect(p.underlying.map((a) => [a.contract, a.rawAmount])).toEqual([
      [USDC, ((1_000_000n * 10n ** 6n * 10n * WAD) / (1000n * WAD)).toString()],
      [NATIVE_ASSET, ((400n * WAD * 10n * WAD) / (1000n * WAD)).toString()],
    ]);
    expect(p.rewardsStatus).toBe("NOT_CHECKED");
    expect(p.warnings).toContain("CURVE_REWARDS_NOT_EXACT");
    expect(p.coverage).toBe("PARTIAL_POSITION");
  });
  it("a gauge token counts only when the registry names that exact gauge for the pool", async () => {
    const ok = mock("curve-1", reads());
    const p = (await ok.adapter.readPosition(
      { key: gauge, contract: gauge, discovery: "token-triggered" },
      ok.ctx,
    ))!;
    expect(p.details).toMatchObject({
      gauge,
      lpToken: lp,
      staking: "GAUGE_STAKED_LP",
    });
    const fake = mock("curve-1", reads(A(0xfa4e)));
    expect(
      await fake.adapter.readPosition(
        { key: gauge, contract: gauge, discovery: "token-triggered" },
        fake.ctx,
      ),
    ).toBeNull();
  });
  it("a metapool decomposes its base-pool LP coin exactly once", async () => {
    const { ctx, adapter } = mock("curve-1", reads());
    const p = (await adapter.readPosition(
      { key: metaLp, contract: metaLp, discovery: "token-triggered" },
      ctx,
    ))!;
    const baseShare = (300n * WAD * 10n * WAD) / (100n * WAD);
    expect(p.underlying.map((a) => [a.contract, a.rawAmount])).toEqual([
      [DAI, ((500n * WAD * 10n * WAD) / (100n * WAD)).toString()],
      [USDC, ((2_000n * 10n ** 6n * baseShare) / (600n * WAD)).toString()],
      [WETH, ((3n * WAD * baseShare) / (600n * WAD)).toString()],
    ]);
  });
  it("a token that is neither a registry LP nor a gauge is not a Curve position", async () => {
    const { ctx, adapter } = mock("curve-1", reads());
    expect(
      await adapter.readPosition(
        { key: A(0x777), contract: A(0x777), discovery: "token-triggered" },
        ctx,
      ),
    ).toBeNull();
  });
  it("a derived registry address is re-proven against the official AddressProvider", async () => {
    const { ctx, adapter } = mock("curve-8453", reads());
    await expect(
      adapter.readPosition(
        { key: lp, contract: lp, discovery: "token-triggered" },
        ctx,
      ),
    ).rejects.toThrow("REGISTRY_IDENTITY_MISMATCH");
  });
});
describe("V1.14 Balancer V2 weighted pools", () => {
  const bpt = A(0xb9),
    poolId = ("0x" + bpt.slice(2) + "0002" + "0".repeat(20)) as Hex;
  const reads = (
    over: Record<string, Handler> = {},
  ): Record<string, Handler> => ({
    isPoolFromFactory: () => true,
    balanceOf: () => 3n * WAD,
    getPoolId: () => poolId,
    getVaultPool: () => [bpt, 2],
    getPoolTokens: () => [
      [USDC, WETH],
      [1_000_000n * 10n ** 6n, 500n * WAD],
      1n,
    ],
    getActualSupply: () => 1000n * WAD,
    ...over,
  });
  it("uses the exact exit math (upscale, mulDown by the BPT ratio, downscaleDown) with the actual supply", async () => {
    const { ctx, adapter } = mock("balancer-v2-1", reads());
    const p = (await adapter.readPosition(
      { key: bpt, contract: bpt, discovery: "token-triggered" },
      ctx,
    ))!;
    const ratio = (3n * WAD * WAD) / (1000n * WAD);
    const exit = (balance: bigint, decimals: number) => {
      const scale = 10n ** BigInt(18 - decimals);
      const upscaled = balance * scale;
      const out = (upscaled * ratio) / WAD;
      return out / scale;
    };
    expect(p.underlying.map((a) => a.rawAmount)).toEqual([
      exit(1_000_000n * 10n ** 6n, 6).toString(),
      exit(500n * WAD, 18).toString(),
    ]);
    expect(p.warnings).toContain("STAKED_BPT_NOT_CHECKED");
  });
  it("a BPT outside the reviewed factory is not a position; a vault identity mismatch fails", async () => {
    const outside = mock(
      "balancer-v2-1",
      reads({ isPoolFromFactory: () => false }),
    );
    expect(
      await outside.adapter.readPosition(
        { key: bpt, contract: bpt, discovery: "token-triggered" },
        outside.ctx,
      ),
    ).toBeNull();
    const clone = mock(
      "balancer-v2-1",
      reads({ getVaultPool: () => [A(0xc10e), 2] }),
    );
    await expect(
      clone.adapter.readPosition(
        { key: bpt, contract: bpt, discovery: "token-triggered" },
        clone.ctx,
      ),
    ).rejects.toThrow("POOL_IDENTITY_MISMATCH");
  });
});
describe("V1.14 Aerodrome / Velodrome basic pools", () => {
  const pool = A(0xae),
    gauge = A(0xa9),
    reward = A(0xaa);
  const reads = (
    over: Record<string, Handler> = {},
  ): Record<string, Handler> => ({
    isPool: () => true,
    token0: () => USDC,
    token1: () => WETH,
    balanceOf: (t, [who]) =>
      t === pool
        ? 5n * WAD
        : t === gauge
          ? 5n * WAD
          : who === pool
            ? t === USDC
              ? 1_000n * 10n ** 6n
              : 2n * WAD
            : 0n,
    gauges: () => gauge,
    stakingToken: () => pool,
    totalSupply: () => 100n * WAD,
    rewardToken: () => reward,
    earned: () => 7n * WAD,
    stable: () => false,
    ...over,
  });
  it("adds wallet and gauge-staked LP, splits balances and reports protocol-view emissions separately", async () => {
    const { ctx, adapter } = mock("aerodrome-v2-8453", reads());
    const p = (await adapter.readPosition(
      { key: pool, contract: pool, discovery: "token-triggered" },
      ctx,
    ))!;
    expect(p.underlying.map((a) => a.rawAmount)).toEqual([
      ((10n * WAD * 1_000n * 10n ** 6n) / (100n * WAD)).toString(),
      ((10n * WAD * 2n * WAD) / (100n * WAD)).toString(),
    ]);
    expect(p.rewards).toHaveLength(1);
    expect(p.rewards[0]).toMatchObject({
      rawClaimable: (7n * WAD).toString(),
      confidence: "protocol-view",
    });
    // Rewards are never inside gross/net.
    expect(p.grossAssetsUsd).toBe(
      (
        Number(p.underlying[0].valueUsd) + Number(p.underlying[1].valueUsd)
      ).toFixed(6),
    );
    expect(p.warnings).toContain("UNSTAKED_LP_FEES_NOT_INCLUDED");
  });
  it("a pool unknown to the reviewed factory, or a gauge staking another token, never counts", async () => {
    const fake = mock("aerodrome-v2-8453", reads({ isPool: () => false }));
    expect(
      await fake.adapter.readPosition(
        { key: pool, contract: pool, discovery: "token-triggered" },
        fake.ctx,
      ),
    ).toBeNull();
    const badGauge = mock(
      "aerodrome-v2-8453",
      reads({ stakingToken: () => A(0xbad) }),
    );
    await expect(
      badGauge.adapter.readPosition(
        { key: pool, contract: pool, discovery: "token-triggered" },
        badGauge.ctx,
      ),
    ).rejects.toThrow("GAUGE_IDENTITY_MISMATCH");
  });
});
// Independent integer square root (binary search), not shared with the adapter's Newton iteration.
function sqrtBinary(y: bigint) {
  let lo = 0n,
    hi = y + 1n;
  while (lo + 1n < hi) {
    const mid = (lo + hi) / 2n;
    if (mid * mid <= y) lo = mid;
    else hi = mid;
  }
  return lo;
}
describe("V1.14 exact AMM math", () => {
  it("isqrt equals an independent floor square root, including edge values", () => {
    const values = [
      0n,
      1n,
      2n,
      3n,
      4n,
      15n,
      16n,
      17n,
      10n ** 36n + 7n,
      2n ** 255n,
      2n ** 256n - 1n,
    ];
    let x = 0x9e3779b97f4a7c15n;
    for (let i = 0; i < 200; i++) {
      x = (x * 6364136223846793005n + 1442695040888963407n) % 2n ** 200n;
      values.push(x);
    }
    for (const v of values) expect(isqrt(v), v.toString()).toBe(sqrtBinary(v));
    expect(() => isqrt(-1n)).toThrow("NEGATIVE_SQRT");
  });
  it("protocol-fee liquidity follows UniswapV2Pair._mintFee (×5 Uniswap/Sushi, ×3 Pancake)", () => {
    const r0 = 4_000_000n * 10n ** 6n,
      r1 = 2_000n * WAD,
      kLast = ((r0 * r1) / 100n) * 90n,
      supply = 80_000n * WAD;
    const rootK = sqrtBinary(r0 * r1),
      rootKLast = sqrtBinary(kLast);
    for (const m of [5n, 3n])
      expect(pendingFeeLiquidity(supply, r0, r1, kLast, m)).toBe(
        (supply * (rootK - rootKLast)) / (rootK * m + rootKLast),
      );
    expect(pendingFeeLiquidity(supply, r0, r1, 0n, 5n)).toBe(0n);
    expect(pendingFeeLiquidity(supply, r0, r1, r0 * r1 * 2n, 5n)).toBe(0n);
  });
  const M256 = 2n ** 256n,
    M128 = 2n ** 128n;
  const reference = (i: {
    tick: number;
    lower: number;
    upper: number;
    global: bigint;
    lowerOutside: bigint;
    upperOutside: bigint;
    insideLast: bigint;
    liquidity: bigint;
    owed: bigint;
  }) => {
    const mod = (v: bigint) => ((v % M256) + M256) % M256;
    const below =
      i.tick >= i.lower ? i.lowerOutside : mod(i.global - i.lowerOutside);
    const above =
      i.tick < i.upper ? i.upperOutside : mod(i.global - i.upperOutside);
    const inside = mod(i.global - below - above);
    return (
      (i.owed + (((mod(inside - i.insideLast) * i.liquidity) / M128) % M128)) %
      M128
    );
  };
  it.each([
    ["in range", 0],
    ["below range", -120],
    ["above range", 120],
  ])("uncollected V3 fees use Solidity 0.7 wrapping (%s)", (_n, tick) => {
    const input = {
      tick: tick as number,
      lower: -60,
      upper: 60,
      global: 5n * 2n ** 128n + 77n,
      lowerOutside: 7n * 2n ** 128n, // larger than global: wraps
      upperOutside: 2n ** 120n,
      insideLast: M256 - 3n * 2n ** 128n,
      liquidity: 10n ** 18n,
      owed: M128 - 1n,
    };
    expect(uncollectedFees(input)).toBe(reference(input));
    expect(uncollectedFees(input)).toBeLessThan(M128);
  });
});
describe("V1.14 UniswapV2-family exact burn", () => {
  const pair = A(0x9a);
  const r0 = 4_000_000n * 10n ** 6n,
    r1 = 2_000n * WAD;
  const reads = (
    factory: string,
    over: Record<string, Handler> = {},
  ): Record<string, Handler> => ({
    factory: () => factory,
    token0: () => USDC,
    token1: () => WETH,
    getPair: () => pair,
    balanceOf: (t, [who]) =>
      t === pair
        ? 10n * WAD
        : who === pair
          ? t === USDC
            ? r0 + 5n
            : r1 + 7n
          : 0n,
    totalSupply: () => 80_000n * WAD,
    getReserves: () => [r0, r1, 0],
    feeTo: () => A(0xfee),
    kLast: () => ((r0 * r1) / 100n) * 90n,
    ...over,
  });
  it.each([
    ["sushiswap-v2-1", 5n],
    ["pancakeswap-v2-56", 3n],
  ])(
    "%s mints the protocol fee first, then burns against token balances",
    async (id, m) => {
      const d = deployments.find((x) => x.id === id)!;
      const { ctx, adapter } = mock(id, reads(d.contracts.factory));
      const p = (await adapter.readPosition(
        { key: pair, contract: pair, discovery: "event-index" },
        ctx,
      ))!;
      const supply = 80_000n * WAD;
      const mint = pendingFeeLiquidity(
        supply,
        r0,
        r1,
        ((r0 * r1) / 100n) * 90n,
        m,
      );
      expect(mint).toBeGreaterThan(0n);
      expect(p.details.pendingProtocolFeeLiquidity).toBe(mint.toString());
      expect(p.underlying.map((a) => a.rawAmount)).toEqual([
        ((10n * WAD * (r0 + 5n)) / (supply + mint)).toString(),
        ((10n * WAD * (r1 + 7n)) / (supply + mint)).toString(),
      ]);
    },
  );
  it("a held token that is not a pair of the reviewed factory is not a position (fake clone)", async () => {
    const { ctx, adapter } = mock("sushiswap-v2-1", reads(A(0xc10e)));
    expect(
      await adapter.readPosition(
        { key: pair, contract: pair, discovery: "token-triggered" },
        ctx,
      ),
    ).toBeNull();
    // The same mismatch on an indexed pair is a hard identity failure.
    await expect(
      adapter.readPosition(
        { key: pair, contract: pair, discovery: "event-index" },
        ctx,
      ),
    ).rejects.toThrow("PAIR_IDENTITY_MISMATCH");
  });
});
describe("V1.14 PancakeSwap V3 variant", () => {
  const pool = A(0x93);
  const d = deployments.find((x) => x.id === "pancakeswap-v3-56")!;
  const reads = (
    over: Record<string, Handler> = {},
  ): Record<string, Handler> => ({
    ownerOf: () => W,
    factory: () => d.contracts.factory,
    deployer: () => d.contracts.deployer,
    positions: () => [
      0n,
      ZERO,
      USDC,
      WETH,
      2500,
      -50,
      50,
      10n ** 12n,
      0n,
      0n,
      0n,
      0n,
    ],
    poolFor: () => pool,
    token0: () => USDC,
    token1: () => WETH,
    fee: () => 2500,
    slot0Pancake: () => [2n ** 96n, 0, 0, 0, 0, 0, true],
    tickSpacing: () => 50,
    feeGrowthGlobal0X128: () => (2n ** 128n / 10n ** 12n) * 10n ** 6n,
    feeGrowthGlobal1X128: () => 0n,
    ticks: () => [0n, 0n, 0n, 0n, 0n, 0n, 0, true],
    ...over,
  });
  it("proves the pool deployer, reads the Pancake slot0 layout and keeps MasterChef stakes explicit", async () => {
    const { ctx, adapter, log } = mock("pancakeswap-v3-56", reads());
    const p = (await adapter.readPosition(
      { key: "7", tokenId: "7", discovery: "enumeration" },
      ctx,
    ))!;
    expect(log).toContain("slot0Pancake");
    expect(log).not.toContain("slot0");
    expect(p.coverage).toBe("PARTIAL_POSITION");
    expect(p.warnings).toContain("STAKED_POSITIONS_NOT_CHECKED");
    expect(p.fees?.[0]).toMatchObject({ contract: USDC, role: "fee" });
    expect(adapter.getCoverage(ctx)).toEqual({
      state: "PARTIAL_POSITION",
      reason: "STAKED_POSITIONS_NOT_CHECKED",
    });
  });
  it("a position manager reporting another deployer is rejected", async () => {
    const { ctx, adapter } = mock(
      "pancakeswap-v3-56",
      reads({ deployer: () => A(0xbad) }),
    );
    await expect(
      adapter.readPosition(
        { key: "7", tokenId: "7", discovery: "enumeration" },
        ctx,
      ),
    ).rejects.toThrow("DEPLOYMENT_IDENTITY_MISMATCH");
  });
});
describe("V1.14 Lido withdrawal queue (read-only)", () => {
  const status = (
    amount: bigint,
    owner: string,
    isFinalized: boolean,
    isClaimed: boolean,
  ) => ({
    amountOfStETH: amount,
    amountOfShares: amount,
    owner,
    timestamp: 1n,
    isFinalized,
    isClaimed,
  });
  const reads = (owner = W): Record<string, Handler> => ({
    getWithdrawalRequests: () => [9n, 3n, 5n],
    getWithdrawalStatus: (_t, [ids]) => {
      expect(ids).toEqual([3n, 5n, 9n]);
      return [
        status(WAD, owner, true, false),
        status(WAD, owner, true, true),
        status(2n * WAD, owner, false, false),
      ];
    },
    getLastCheckpointIndex: () => 10n,
    findCheckpointHints: (_t, [ids, first, last]) => {
      expect([ids, first, last]).toEqual([[3n], 1n, 10n]);
      return [4n];
    },
    getClaimableEther: (_t, [ids, hints]) => {
      expect([ids, hints]).toEqual([[3n], [4n]]);
      return [(WAD * 99n) / 100n];
    },
  });
  it("finalized requests are exact claimable ETH; pending stETH is listed but never valued; no claim path", async () => {
    const { ctx, adapter, log } = mock("lido-1", reads());
    const refs = await adapter.discover(ctx);
    expect(refs.map((r) => r.key)).toContain("withdrawals");
    const p = (await adapter.readPosition(
      { key: "withdrawals", discovery: "registry" },
      ctx,
    ))!;
    expect(p.underlying[0]).toMatchObject({
      contract: NATIVE_ASSET,
      rawAmount: ((WAD * 99n) / 100n).toString(),
    });
    expect(p.underlying[1]).toMatchObject({
      symbol: "stETH",
      rawAmount: (2n * WAD).toString(),
      valueUsd: null,
    });
    expect(p.warnings).toContain("WITHDRAWAL_PENDING_FINALIZATION");
    expect(p.details).toMatchObject({
      finalizedUnclaimed: "1",
      pending: "1",
      claimAction: "NONE_READ_ONLY",
    });
    expect(log.every((n) => READ_ONLY_VIEW.test(n))).toBe(true);
    expect(
      log.some((n) => /^(claim|request|transfer|approve|permit)/i.test(n)),
    ).toBe(false);
  });
  it("a request owned by another address is rejected", async () => {
    const { ctx, adapter } = mock("lido-1", reads(A(0x0dd)));
    await expect(
      adapter.readPosition({ key: "withdrawals", discovery: "registry" }, ctx),
    ).rejects.toThrow("WITHDRAWAL_OWNER_MISMATCH");
  });
});
describe("V1.14 registry-complete Morpho discovery", () => {
  const d = deployments.find((x) => x.id === "morpho-blue-1")!;
  const refs = Array.from({ length: 40 }, (_, i) => {
    const marketId = keccak256(
      encodeAbiParameters([{ type: "uint256" }], [BigInt(i)]),
    );
    return { key: marketId, marketId, discovery: "event-index" as const };
  });
  it("reduces a complete market registry to nonzero entries with one aggregate per chunk", async () => {
    const { ctx, adapter } = mock("morpho-blue-1", {});
    ctx.refs = refs;
    const seen: number[] = [];
    ctx.readAggregate = async (calls) => {
      seen.push(calls.length);
      expect(
        calls.every(
          (c) => c.target === d.contracts.blue && c.name === "position",
        ),
      ).toBe(true);
      return calls.map((c, i) => ({
        status: "fulfilled" as const,
        value: i === 3 || i === 17 ? [1n, 0n, 0n] : [0n, 0n, 0n],
      }));
    };
    const found = await adapter.discover(ctx);
    expect(seen).toEqual([40]);
    expect(found.map((r) => r.key)).toEqual([refs[3].key, refs[17].key]);
    expect(adapter.getCoverage(ctx).state).toBe("FULL_POSITION");
  });
  it("a failed inner read keeps discovery incomplete instead of a checked zero", async () => {
    const { ctx, adapter } = mock("morpho-blue-1", {});
    ctx.refs = refs;
    ctx.readAggregate = async (calls) =>
      calls.map((_, i) =>
        i === 5
          ? {
              status: "rejected" as const,
              reason: Error("INNER_CALL_REVERTED"),
            }
          : { status: "fulfilled" as const, value: [0n, 0n, 0n] },
      );
    expect(await adapter.discover(ctx)).toEqual([]);
    expect(adapter.getCoverage(ctx)).toEqual({
      state: "PARTIAL_POSITION",
      reason: "DISCOVERY_INCOMPLETE",
    });
  });
});
describe("V1.14 pinned Multicall3 reads", () => {
  const blue = deployments.find((x) => x.id === "morpho-blue-1")!;
  const marketId = ("0x" + "12".repeat(32)) as Hex;
  const positionData = encodeFunctionData({
    abi: abiFor("position"),
    functionName: "position",
    args: [marketId, W],
  });
  it("RPC policy accepts aggregate3 inner calls only when each equals a server-built capability", () => {
    const call = (inner: { target: string; callData: Hex }[]) => ({
      method: "eth_call",
      params: [{ to: MULTICALL3, data: encodeAggregate3(inner) }, "0x64"],
    });
    const policy = {
      ecosystem: "EVM" as const,
      multicall: MULTICALL3,
      defiViews: [{ to: blue.contracts.blue, data: positionData }],
    };
    expect(() =>
      assertAllowed(
        call([{ target: blue.contracts.blue, callData: positionData }]),
        policy,
      ),
    ).not.toThrow();
    const otherWallet = encodeFunctionData({
      abi: abiFor("position"),
      functionName: "position",
      args: [marketId, A(0x1)],
    });
    expect(() =>
      assertAllowed(
        call([{ target: blue.contracts.blue, callData: otherWallet }]),
        policy,
      ),
    ).toThrow();
    expect(() =>
      assertAllowed(
        call([{ target: A(0x77), callData: positionData }]),
        policy,
      ),
    ).toThrow();
    expect(() =>
      assertAllowed(
        call([{ target: MULTICALL3, callData: positionData }]),
        policy,
      ),
    ).toThrow();
    expect(() =>
      assertAllowed(
        call([{ target: blue.contracts.blue, callData: positionData }]),
        { ecosystem: "EVM", multicall: MULTICALL3 },
      ),
    ).toThrow();
  });
  const endpoint = {
    id: "synthetic",
    chainId: "1",
    url: "https://synthetic.test",
    priority: 1,
    supportsLogs: false,
    maxLogRange: 0,
    supportsBatch: false,
    supportsFinalized: false,
    supportsSafe: false,
    archive: true,
  };
  const pin = {
    number: 100n,
    hash: ("0x" + "cd".repeat(32)) as Hex,
    timestamp: 1n,
    observedAt: Date.now(),
    endpointId: "synthetic",
    endpointGroup: "SYNTHETIC_FIXTURE",
  };
  it("an unverified Multicall3 code hash fails closed (no aggregate is sent)", async () => {
    const methods: string[] = [];
    const pool = new RpcPool(
      "1",
      { ecosystem: "EVM" },
      [endpoint],
      async (_e, body) => {
        const b = body as { id: number; method: string };
        methods.push(b.method);
        return { jsonrpc: "2.0", id: b.id, result: "0x6000" };
      },
    );
    const r = new DefiReader(blue, W, pin, new AbortController().signal, pool);
    expect(
      await r.readAggregate([
        { target: blue.contracts.blue, name: "position", args: [marketId, W] },
      ]),
    ).toBeNull();
    expect(methods).toEqual(["eth_getCode"]);
  });
  it("decodes each inner result at the pinned block and records one evidence entry per aggregate", async () => {
    const bodies: { method: string; params: unknown[] }[] = [];
    const pool = new RpcPool(
      "1",
      { ecosystem: "EVM" },
      [endpoint],
      async (_e, body) => {
        const b = body as { id: number; method: string; params: unknown[] };
        bodies.push(b);
        return {
          jsonrpc: "2.0",
          id: b.id,
          result: encodeFunctionResult({
            abi: multicall3Abi,
            functionName: "aggregate3",
            result: [
              {
                success: true,
                returnData: encodeFunctionResult({
                  abi: abiFor("position"),
                  functionName: "position",
                  result: [5n, 0n, 0n],
                }),
              },
              { success: false, returnData: "0x" },
            ],
          }),
        };
      },
    );
    const r = new DefiReader(blue, W, pin, new AbortController().signal, pool);
    (
      r as unknown as { multicallVerified: Promise<boolean> }
    ).multicallVerified = Promise.resolve(true);
    const before = r.evidence.length;
    const out = await r.readAggregate([
      { target: blue.contracts.blue, name: "position", args: [marketId, W] },
      { target: blue.contracts.blue, name: "position", args: [marketId, W] },
    ]);
    expect(out![0]).toEqual({ status: "fulfilled", value: [5n, 0n, 0n] });
    expect(out![1].status).toBe("rejected");
    expect(bodies[0].params[1]).toBe("0x64");
    expect((bodies[0].params[0] as { to: string }).to).toBe(MULTICALL3);
    expect(r.evidence.length - before).toBe(1);
    expect(r.calls).toBe(2);
    await expect(
      r.readAggregate([
        { target: A(0x77), name: "position", args: [marketId, W] },
      ]),
    ).rejects.toThrow("TARGET_NOT_AUTHORIZED");
  });
});
describe("V1.14 reverse contract index", () => {
  const index = new ReverseIndex(buildReverseIndex(deployments));
  it("maps exact chain + contract to reviewed protocol, product, version and role", () => {
    const reth = deployments.find((x) => x.id === "lst-reth-1")!;
    expect(
      index
        .lookup("1", reth.contracts.token)
        .map((e) => e.role)
        .sort(),
    ).toEqual(["receipt-token", "staking"]);
    const eigen = deployments.find((x) => x.id === "eigenlayer-1")!;
    for (const s of eigen.strategies ?? [])
      expect(
        index
          .lookup("1", s.strategy)
          .some((e) => e.role === "strategy" && e.protocolId === "eigenlayer"),
      ).toBe(true);
    const lido = deployments.find((x) => x.id === "lido-1")!;
    expect(index.lookup("1", lido.contracts.withdrawalQueue!)[0].role).toBe(
      "withdrawal-queue",
    );
  });
  it("never matches by case-variant, another chain, or malformed input", () => {
    const reth = deployments.find((x) => x.id === "lst-reth-1")!;
    expect(index.lookup("10", reth.contracts.token)).toEqual([]);
    expect(index.lookup("1", reth.contracts.token.toUpperCase())).toEqual([]);
    expect(index.lookup("1; DROP", reth.contracts.token)).toEqual([]);
    expect(
      index.receiptHits(["1:" + reth.contracts.token]).has("lst-reth-1"),
    ).toBe(true);
  });
});
describe("V1.14 registry lanes", () => {
  const d = deployments.find((x) => x.id === "morpho-blue-1")!;
  const spec = LANES["morpho-blue"]![0];
  const params = [
    USDC,
    WETH,
    A(0x0c),
    A(0x1e),
    (86n * WAD) / 100n,
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
  const data = encodeAbiParameters(
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
  );
  const log = (over: Record<string, unknown> = {}) => ({
    address: d.contracts.blue,
    topics: [toEventSelector(spec.signature), id],
    data,
    blockNumber: "0x10",
    blockHash: "0x" + "ab".repeat(32),
    transactionHash: "0x" + "cd".repeat(32),
    logIndex: "0x0",
    ...over,
  });
  it("decodes a canonical CreateMarket whose id is the hash of its parameters", () => {
    const x = decodeLaneLog(d, spec, log(), 1n, 100n);
    expect(x.entryKey).toBe(id);
    expect(x.detail).toMatchObject({
      loanToken: USDC,
      collateralToken: WETH,
      lltv: ((86n * WAD) / 100n).toString(),
    });
  });
  it.each([
    [
      "id mismatch",
      { topics: [toEventSelector(spec.signature), "0x" + "00".repeat(32)] },
      "MARKET_ID_MISMATCH",
    ],
    ["removed log", { removed: true }, "NONCANONICAL_LOG"],
    ["outside window", { blockNumber: "0x1000" }, "NONCANONICAL_LOG"],
    ["foreign emitter", { address: A(0xbad) }, "LOG_ADDRESS_MISMATCH"],
    [
      "other event",
      { topics: ["0x" + "ee".repeat(32), id] },
      "EVENT_NOT_ALLOWED",
    ],
  ])("rejects %s", (_n, over, code) => {
    expect(() => decodeLaneLog(d, spec, log(over), 1n, 100n)).toThrow(code);
  });
  it("operator log sources are HTTPS, credential-free and host-allowlisted; only read methods are sent", async () => {
    for (const bad of [
      "http://gateway.tenderly.co/public/mainnet",
      "https://user:pw@gateway.tenderly.co/x",
      "https://evil.example/rpc",
      "https://gateway.tenderly.co.evil.example/",
    ])
      expect(() => httpLogSource(bad)).toThrow("LOG_SOURCE_NOT_ALLOWED");
    const methods: string[] = [];
    const src = httpLogSource(
      "https://mainnet.gateway.tenderly.co/public",
      (async (_u: unknown, init?: { body?: unknown }) => {
        const b = JSON.parse(String(init?.body)) as {
          id: number;
          method: string;
        };
        methods.push(b.method);
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: b.id,
            result: b.method === "eth_getLogs" ? [] : "0x10",
          }),
        );
      }) as typeof fetch,
    );
    expect(await src.head()).toBe(16n);
    expect(
      await src.logs(d.contracts.blue, toEventSelector(spec.signature), 1n, 2n),
    ).toEqual([]);
    expect(methods).toEqual(["eth_blockNumber", "eth_getLogs"]);
    const failing = httpLogSource(
      "https://mainnet.gateway.tenderly.co/public",
      (async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            error: { message: "execution reverted" },
          }),
        )) as typeof fetch,
    );
    await expect(failing.head()).rejects.toThrow("RPC_ERROR");
  });
});
describe("V1.14 value summary and exposure graph v2", () => {
  const asset = (
    contract: string,
    raw: bigint,
    role: PositionAsset["role"],
    usd: string | null,
    symbol = "TKN",
  ): PositionAsset => ({
    assetId: "1:" + contract,
    chainId: "1",
    contract,
    symbol,
    decimals: 18,
    rawAmount: raw.toString(),
    role,
    valueUsd: usd,
  });
  const position = (over: Partial<DefiPosition>): DefiPosition => ({
    id: "x:" + Math.random(),
    wallet: W,
    chainId: "1",
    deploymentId: "aave-v3-1",
    protocolId: "aave-v3",
    protocolName: "Aave V3",
    category: "lending",
    positionKey: "k",
    adapterVersion: "1.1.0",
    sourceBlock: "1",
    sourceBlockHash: "0x" + "ab".repeat(32),
    observedAt: Date.now(),
    supplied: [],
    collateral: [],
    borrowed: [],
    underlying: [],
    representations: [],
    rewards: [],
    rewardsStatus: "CHECKED",
    risk: { kind: "not-available", reason: "NOT_APPLICABLE" },
    grossAssetsUsd: "0.000000",
    debtUsd: "0.000000",
    knownNetUsd: "0.000000",
    confidence: "EXACT_WITH_PRICE",
    coverage: "FULL_POSITION",
    warnings: [],
    evidence: [],
    details: {},
    ...over,
  });
  const scanOf = (
    positions: DefiPosition[],
    states: string[] = ["FULL_POSITION"],
  ) => ({
    version: 2 as const,
    wallet: W,
    scanId: "synthetic",
    observedAt: Date.now(),
    positions,
    coverage: states.map((state, i) => ({
      deploymentId: "d" + i,
      protocolId: "p",
      protocolName: "P",
      chainId: "1",
      adapterVersion: "1.1.0" as const,
      state: state as "FULL_POSITION",
      result: "NONZERO" as const,
      reason: "CHECKED",
      sourceBlock: "1",
      sourceBlockHash: "0x" + "ab".repeat(32),
      observedAt: Date.now(),
      calls: 1,
      batches: 0,
      fallbacks: 0,
      errors: 0,
      durationMs: 1,
    })),
    replacedWalletAssets: [],
    replacementOwners: {},
    continuation: [],
    nonEvm: "NOT_CHECKED" as const,
    elapsedMs: 1,
    peakConcurrency: 1,
  });
  it("claimable rewards, uncollected fees and derivative notionals are shown beside the net, never inside it", () => {
    const p = position({
      supplied: [asset(WETH, WAD, "supplied", "2000.000000")],
      borrowed: [asset(USDC, WAD, "borrowed", "500.000000")],
      grossAssetsUsd: "2000.000000",
      debtUsd: "500.000000",
      rewards: [
        {
          asset: asset(DAI, WAD, "reward", "30.000000"),
          rawClaimable: WAD.toString(),
          sourceContract: DAI,
          confidence: "protocol-view",
          observedAt: Date.now(),
        },
      ],
      fees: [asset(USDC, 10n, "fee", "4.000000")],
      details: { notional: "1000000" },
    });
    const t = portfolioTotals([], scanOf([p]));
    expect(t.defiUsd).toBe("2000.000000");
    expect(t.debtUsd).toBe("500.000000");
    expect(t.knownNetUsd).toBe("1500.000000");
    expect(t.rewardsUsd).toBe("30.000000");
    expect(t.feesUsd).toBe("4.000000");
    expect(leverage(p)).toBe("1.333333");
  });
  it("unchecked coverage and unpriced debt make the net explicitly incomplete; leverage is withheld", () => {
    const p = position({
      supplied: [asset(WETH, WAD, "supplied", "2000.000000")],
      borrowed: [asset(USDC, WAD, "borrowed", null)],
      grossAssetsUsd: "2000.000000",
    });
    const t = portfolioTotals(
      [],
      scanOf([p], ["FULL_POSITION", "NOT_CHECKED", "PARTIAL_POSITION"]),
    );
    expect(t.uncheckedCoverage).toBe(2);
    expect(t.unpricedDebt).toBe(1);
    expect(t.partial).toBe(true);
    expect(leverage(p)).toBeNull();
  });
  it("aggregates long and short exposure per exact asset and keeps wrappers undecomposed", () => {
    const a = position({
      id: "a",
      underlying: [
        asset(WETH, 2n * WAD, "underlying", "4000.000000", "wstETH"),
      ],
      warnings: ["UNDERLYING_NOT_DECOMPOSED"],
      details: { notDecomposed: "wstETH" },
    });
    const b = position({
      id: "b",
      supplied: [asset(WETH, WAD, "supplied", "2000.000000", "wstETH")],
      borrowed: [asset(USDC, 3n, "borrowed", "3.000000", "USDC")],
    });
    const graph = exposureGraph([a, b]);
    const weth = graph.find((n) => n.assetId === "1:" + WETH)!;
    expect(weth).toMatchObject({
      longRaw: (3n * WAD).toString(),
      shortRaw: "0",
      longUsd: "6000.000000",
      decomposition: "UNDERLYING_NOT_DECOMPOSED",
      positions: ["a", "b"],
    });
    expect(graph.find((n) => n.assetId === "1:" + USDC)).toMatchObject({
      shortRaw: "3",
      shortUsd: "3.000000",
    });
    expect(graph[0].assetId).toBe("1:" + WETH);
  });
});
describe("V1.14 SparkLend (Aave V3 fork, same reviewed views)", () => {
  const manifest = JSON.parse(
    readFileSync("src/defi/sources/manifest.json", "utf8"),
  ) as { url: string; local: string }[];
  it("every SparkLend contract and reserve token is a literal in its pinned official registry file", () => {
    for (const id of ["sparklend-1", "sparklend-100"]) {
      const d = deployments.find((x) => x.id === id)!;
      expect(d.adapter).toBe("aave-v3");
      expect(d.protocolId).toBe("sparklend");
      const src = manifest.find((m) => m.url === d.source)!;
      const text = readFileSync(
        "src/defi/sources/" + src.local,
        "utf8",
      ).toLowerCase();
      for (const a of Object.values(d.contracts)) expect(text).toContain(a);
      expect(d.assets!.length).toBeGreaterThan(5);
      for (const a of d.assets!) {
        expect(text).toContain(a.receipt);
        expect(text).toContain(a.debt);
      }
    }
  });
  const d = deployments.find((x) => x.id === "sparklend-1")!;
  const known = d.assets![0];
  const reads = (unknownBalance: bigint): Record<string, Handler> => ({
    getPool: () => d.contracts.pool,
    getPoolDataProvider: () => d.contracts.provider,
    getUserAccountData: () => [0n, 0n, 0n, 0n, 0n, 2n ** 256n - 1n],
    getAllReservesTokens: () => [
      { symbol: known.symbol, tokenAddress: known.underlying },
      { symbol: "NEW", tokenAddress: A(0x4e) },
    ],
    getUserReserveData: (_t, [asset]) =>
      asset === A(0x4e)
        ? [unknownBalance, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false]
        : [0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n, false],
  });
  it("a reserve outside the reviewed registry is a checked zero when empty, and never valued when nonzero", async () => {
    const empty = mock("sparklend-1", reads(0n));
    expect(
      await empty.adapter.readPosition(
        { key: "account", discovery: "registry" },
        empty.ctx,
      ),
    ).toBeNull();
    const held = mock("sparklend-1", reads(5n));
    await expect(
      held.adapter.readPosition(
        { key: "account", discovery: "registry" },
        held.ctx,
      ),
    ).rejects.toThrow("RESERVE_READ_INCOMPLETE");
  });
});
