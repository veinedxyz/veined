import type { AdapterContext } from "./adapters";
import type { DefiPosition, PositionRef } from "./model";
import { basePosition, finalize } from "./adapters";
import { authorize, exactAddress, NATIVE_ASSET, tuple } from "./reader";
import { mulDiv, uint, UINT256_MAX, WAD } from "./math";
// V1.14 reviewed position families. Each reads only exact protocol views at the pinned block; identity is proven
// on-chain against the reviewed deployment (registry/factory/vault) before any value is reported.
const ZERO = "0x0000000000000000000000000000000000000000";
const CURVE_NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const assetId = (c: AdapterContext, a: string) =>
  c.deployment.chainId + ":" + a;
// V1.14.1: independent reads are issued together (the reader coalesces them into one request) and consumed in the
// V1.14 program order, so the first failure in that order is still the error that surfaces.
const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> =>
  p.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
const valueOf = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status === "rejected") throw r.reason;
  return r.value;
};
const nonzero = (p: DefiPosition) =>
  [...p.supplied, ...p.collateral, ...p.borrowed, ...p.underlying].some(
    (a) => BigInt(a.rawAmount) > 0n,
  ) || p.rewards.some((r) => BigInt(r.rawClaimable) > 0n);
/** Liquid staking / restaking tokens: exact protocol conversion view or protocol-reported rate; never 1:1. */
export async function lstRate(_ref: PositionRef, c: AdapterContext) {
  const { token, converter, underlying } = c.deployment.contracts,
    cfg = c.deployment.config;
  if (!cfg || !token || !converter) throw Error("DEPLOYMENT_CONFIG_MISSING");
  const raw = uint(await c.read(token, "balanceOf", [c.wallet]));
  if (!raw) return null;
  const [shareR, convR] = await Promise.all([
    settle(c.asset(token, raw, "supplied")),
    settle(
      cfg.mode === "convert"
        ? c.read(
            converter,
            cfg.call as
              | "getEthValue"
              | "getEETHByWeETH"
              | "mETHToETH"
              | "convertToAssets",
            [raw],
          )
        : c.read(
            converter,
            cfg.call as "exchangeRate" | "swETHToETHRate" | "rsETHPrice",
          ),
    ),
  ]);
  const share = valueOf(shareR);
  let out: bigint;
  if (cfg.mode === "convert") {
    out = uint(valueOf(convR));
  } else {
    // Rate views are 1e18-scaled ETH per token; only an 18-decimals token may use them.
    if (share.decimals !== 18) throw Error("RATE_DECIMALS_UNSUPPORTED");
    const rate = uint(valueOf(convR));
    if (!rate) throw Error("RATE_UNAVAILABLE");
    out = mulDiv(raw, rate, WAD);
  }
  const p = basePosition(c, token);
  p.underlying.push(
    cfg.underlying === "native"
      ? await c.asset(NATIVE_ASSET, out, "underlying", {
          symbol: "ETH",
          decimals: 18,
        })
      : await c.asset(exactAddress(underlying), out, "underlying"),
  );
  p.representations.push(assetId(c, token));
  p.details = {
    positionToken: share.symbol,
    rawShares: raw.toString(),
    shareDecimals: String(share.decimals),
    conversion: cfg.call,
    rateSource: cfg.rateSource,
    rateRaw: mulDiv(out, WAD, raw).toString(),
    identity: c.deployment.identity ?? "OFFICIAL_SOURCE_LITERAL",
  };
  if (cfg.mode === "rate") p.warnings.push("PROTOCOL_REPORTED_RATE");
  return finalize(p, c);
}
/** EigenLayer: reviewed strategies only, withdrawable (slashing-aware) shares, exact sharesToUnderlyingView. */
export async function eigenlayer(_ref: PositionRef, c: AdapterContext) {
  const { strategyManager, delegationManager, eigenPodManager } =
    c.deployment.contracts;
  const reviewed = new Map(
    (c.deployment.strategies ?? []).map((s) => [s.strategy, s]),
  );
  const account = await Promise.all([
    settle(c.read(strategyManager, "getDeposits", [c.wallet])),
    settle(c.read(eigenPodManager, "podOwnerDepositShares", [c.wallet])),
    settle(c.read(delegationManager, "getQueuedWithdrawalRoots", [c.wallet])),
  ]);
  const deposits = tuple(valueOf(account[0]), 2);
  const strategies = (deposits[0] as unknown[]).map(exactAddress);
  if (strategies.length > 32) throw Error("STRATEGY_LIMIT");
  const p = basePosition(c, "restaking");
  const known = strategies.filter((s) => reviewed.has(s));
  if (known.length !== strategies.length) {
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("UNREVIEWED_STRATEGY");
  }
  if (known.length) {
    const w = tuple(
      await c.read(delegationManager, "getWithdrawableShares", [
        c.wallet,
        known,
      ]),
      2,
    );
    const withdrawable = (w[0] as unknown[]).map((v) => uint(v));
    if (withdrawable.length !== known.length) throw Error("MALFORMED_SHARES");
    const views = known.map((strategy, i) => {
      if (!withdrawable[i]) return undefined;
      const s = reviewed.get(strategy)!;
      authorize(c, s.strategy);
      return Promise.all([
        settle(c.read(s.strategy, "underlyingToken")),
        settle(c.read(s.strategy, "sharesToUnderlyingView", [withdrawable[i]])),
      ]);
    });
    for (let i = 0; i < known.length; i++) {
      if (!withdrawable[i]) continue;
      const s = reviewed.get(known[i])!;
      const [token, shares] = await views[i]!;
      if (exactAddress(valueOf(token)) !== s.underlying)
        throw Error("STRATEGY_IDENTITY_MISMATCH");
      const amount = uint(valueOf(shares));
      p.supplied.push(await c.asset(s.underlying, amount, "supplied"));
    }
  }
  const native = valueOf(account[1]) as bigint;
  if (typeof native !== "bigint") throw Error("MALFORMED_SHARES");
  if (native !== 0n) {
    // Beacon-chain ETH shares are wei-denominated restaked validator balance credited through pod checkpoints.
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("NATIVE_RESTAKING_CHECKPOINT_BASED");
    if (native > 0n)
      p.supplied.push(
        await c.asset(NATIVE_ASSET, native, "supplied", {
          symbol: "ETH",
          decimals: 18,
        }),
      );
    else p.warnings.push("NATIVE_RESTAKING_DEFICIT");
  }
  const queued = valueOf(account[2]);
  if (!Array.isArray(queued) || queued.length > 1000)
    throw Error("MALFORMED_QUEUE");
  if (queued.length) {
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("QUEUED_WITHDRAWALS_NOT_VALUED");
  }
  p.details = {
    strategies: String(strategies.length),
    reviewedStrategies: String(known.length),
    queuedWithdrawals: String(queued.length),
    accounting: "withdrawable shares (slashing-aware)",
  };
  if (!nonzero(p) && !queued.length && !strategies.length) return null;
  return finalize(p, c);
}
/** Curve: official MetaRegistry identity for LP and gauge tokens; proportional pool share; one nested level. */
export async function curve(ref: PositionRef, c: AdapterContext) {
  const { metaRegistry, addressProvider } = c.deployment.contracts;
  const token = ref.contract ? exactAddress(ref.contract) : undefined;
  if (!token) throw Error("TOKEN_REQUIRED");
  if (c.deployment.identity === "ONCHAIN_DERIVED" && addressProvider) {
    // Derived registry address: re-proven against the official AddressProvider at the pinned block.
    if (
      exactAddress(await c.read(addressProvider, "get_address", [7n])) !==
      metaRegistry
    )
      throw Error("REGISTRY_IDENTITY_MISMATCH");
  }
  authorize(c, token);
  let pool = exactAddress(
    await c.read(metaRegistry, "get_pool_from_lp_token", [token]),
  );
  let lp = token,
    gauge: string | null = null;
  if (pool === ZERO) {
    // A gauge token: its LP must resolve through the registry and the registry must name this exact gauge.
    let candidate: string;
    try {
      candidate = exactAddress(await c.read(token, "lp_token"));
    } catch {
      return null;
    }
    authorize(c, candidate);
    pool = exactAddress(
      await c.read(metaRegistry, "get_pool_from_lp_token", [candidate]),
    );
    if (pool === ZERO) return null;
    if (exactAddress(await c.read(metaRegistry, "get_gauge", [pool])) !== token)
      return null;
    lp = candidate;
    gauge = token;
  }
  const amount = uint(await c.read(token, "balanceOf", [c.wallet]));
  if (!amount) return null;
  const p = basePosition(c, token);
  const share = await c.asset(token, amount, "supplied");
  const split = async (
    poolAddress: string,
    lpToken: string,
    lpAmount: bigint,
    depth: number,
  ) => {
    authorize(c, lpToken);
    const views = await Promise.all([
      settle(c.read(lpToken, "totalSupply")),
      settle(c.read(metaRegistry, "get_n_coins", [poolAddress])),
      settle(c.read(metaRegistry, "get_coins", [poolAddress])),
      settle(c.read(metaRegistry, "get_balances", [poolAddress])),
    ]);
    const supply = uint(valueOf(views[0]));
    if (!supply || lpAmount > supply) throw Error("INVALID_LP_SUPPLY");
    const n = Number(valueOf(views[1]));
    if (!Number.isInteger(n) || n < 2 || n > 8)
      throw Error("INVALID_POOL_COINS");
    const coins = (valueOf(views[2]) as unknown[])
      .slice(0, n)
      .map(exactAddress);
    const balances = (valueOf(views[3]) as unknown[])
      .slice(0, n)
      .map((v) => uint(v));
    for (let i = 0; i < n; i++) {
      const amountOut = mulDiv(balances[i], lpAmount, supply);
      if (!amountOut) continue;
      if (coins[i] === CURVE_NATIVE)
        p.underlying.push(
          await c.asset(NATIVE_ASSET, amountOut, "lp-component", {
            symbol: "ETH",
            decimals: 18,
          }),
        );
      else {
        // Metapool: the base-pool LP coin is decomposed once more through the same registry (cycle-guarded).
        const basePool =
          depth === 0
            ? exactAddress(
                await c.read(metaRegistry, "get_pool_from_lp_token", [
                  coins[i],
                ]),
              )
            : ZERO;
        if (basePool !== ZERO && basePool !== poolAddress)
          await split(basePool, coins[i], amountOut, depth + 1);
        else
          p.underlying.push(await c.asset(coins[i], amountOut, "lp-component"));
      }
    }
  };
  await split(pool, lp, amount, 0);
  p.representations.push(assetId(c, token));
  p.details = {
    pool,
    lpToken: lp,
    shares: amount.toString(),
    shareDecimals: String(share.decimals),
    shareSymbol: share.symbol,
    ...(gauge ? { gauge, staking: "GAUGE_STAKED_LP" } : {}),
    accounting: "proportional withdrawal share of registry balances",
  };
  // Gauge CRV accrual (claimable_tokens) is not a view: rewards stay unchecked, never estimated as claimable.
  p.rewardsStatus = "NOT_CHECKED";
  p.warnings.push("CURVE_REWARDS_NOT_EXACT");
  p.coverage = "PARTIAL_POSITION";
  return finalize(p, c);
}
/** Balancer V2 WeightedPool (factory V4 only): exact proportional exit math with actual supply and scaling. */
export async function balancerV2(ref: PositionRef, c: AdapterContext) {
  const { vault, weightedPoolFactory } = c.deployment.contracts;
  const bpt = ref.contract ? exactAddress(ref.contract) : undefined;
  if (!bpt) throw Error("TOKEN_REQUIRED");
  authorize(c, bpt);
  if ((await c.read(weightedPoolFactory, "isPoolFromFactory", [bpt])) !== true)
    return null;
  const bptViews = await Promise.all([
    settle(c.read(bpt, "balanceOf", [c.wallet])),
    settle(c.read(bpt, "getPoolId")),
    settle(c.read(bpt, "getActualSupply")),
  ]);
  const amount = uint(valueOf(bptViews[0]));
  if (!amount) return null;
  const poolId = String(valueOf(bptViews[1]));
  if (!/^0x[0-9a-f]{64}$/.test(poolId)) throw Error("INVALID_POOL_ID");
  const vaultViews = await Promise.all([
    settle(c.read(vault, "getVaultPool", [poolId])),
    settle(c.read(vault, "getPoolTokens", [poolId])),
  ]);
  const registered = tuple(valueOf(vaultViews[0]), 2);
  if (exactAddress(registered[0]) !== bpt)
    throw Error("POOL_IDENTITY_MISMATCH");
  const state = tuple(valueOf(vaultViews[1]), 3);
  const tokens = (state[0] as unknown[]).map(exactAddress),
    balances = (state[1] as unknown[]).map((v) => uint(v));
  if (
    tokens.length !== balances.length ||
    tokens.length < 2 ||
    tokens.length > 8
  )
    throw Error("INVALID_POOL_TOKENS");
  const supply = uint(valueOf(bptViews[2]));
  if (!supply || amount > supply) throw Error("INVALID_LP_SUPPLY");
  const p = basePosition(c, bpt);
  const share = await c.asset(bpt, amount, "supplied");
  const ratio = (amount * WAD) / supply; // FixedPoint.divDown
  for (let i = 0; i < tokens.length; i++) {
    const meta = await c.asset(tokens[i], 0n, "lp-component");
    if (meta.decimals > 18) throw Error("INVALID_DECIMALS");
    const scale = 10n ** BigInt(18 - meta.decimals);
    // _upscale (mulDown by 1e18·scale) -> mulDown(bptRatio) -> _downscaleDown.
    const out = (balances[i] * scale * ratio) / WAD / scale;
    if (out) p.underlying.push(await c.asset(tokens[i], out, "lp-component"));
  }
  p.representations.push(assetId(c, bpt));
  p.details = {
    pool: bpt,
    poolId,
    shares: amount.toString(),
    shareDecimals: String(share.decimals),
    shareSymbol: share.symbol,
    poolType: "WeightedPool (factory V4)",
    accounting: "exitExactBPTInForTokensOut with getActualSupply",
  };
  // Staked BPT (gauges, Aura) is held by other contracts and is not read here.
  p.warnings.push("STAKED_BPT_NOT_CHECKED");
  p.coverage = "PARTIAL_POSITION";
  return finalize(p, c);
}
/** Aerodrome / Velodrome basic pools: factory identity, balance-based burn share, gauge stake, exact emissions. */
export async function solidlyV2(ref: PositionRef, c: AdapterContext) {
  const { poolFactory, voter } = c.deployment.contracts;
  const pool = ref.contract ? exactAddress(ref.contract) : undefined;
  if (!pool) throw Error("TOKEN_REQUIRED");
  authorize(c, pool);
  if ((await c.read(poolFactory, "isPool", [pool])) !== true) return null;
  const poolViews = await Promise.all([
    settle(c.read(pool, "token0")),
    settle(c.read(pool, "token1")),
    settle(c.read(pool, "balanceOf", [c.wallet])),
    settle(c.read(voter, "gauges", [pool])),
    settle(c.read(pool, "totalSupply")),
    settle(c.read(pool, "stable")),
  ]);
  const token0 = authorize(c, exactAddress(valueOf(poolViews[0]))),
    token1 = authorize(c, exactAddress(valueOf(poolViews[1])));
  if (token0 === token1) throw Error("POOL_IDENTITY_MISMATCH");
  const held = uint(valueOf(poolViews[2]));
  const gauge = exactAddress(valueOf(poolViews[3]));
  let staked = 0n;
  if (gauge !== ZERO) {
    authorize(c, gauge);
    if (exactAddress(await c.read(gauge, "stakingToken")) !== pool)
      throw Error("GAUGE_IDENTITY_MISMATCH");
    staked = uint(await c.read(gauge, "balanceOf", [c.wallet]));
  }
  const amount = held + staked;
  if (!amount) return null;
  const supply = uint(valueOf(poolViews[4]));
  if (!supply || amount > supply) throw Error("INVALID_LP_SUPPLY");
  const balances = await Promise.all([
    settle(c.read(token0, "balanceOf", [pool])),
    settle(c.read(token1, "balanceOf", [pool])),
  ]);
  const bal0 = uint(valueOf(balances[0])),
    bal1 = uint(valueOf(balances[1]));
  const p = basePosition(c, pool);
  const share = await c.asset(pool, amount, "supplied");
  for (const [t, b] of [
    [token0, bal0],
    [token1, bal1],
  ] as const) {
    const out = mulDiv(amount, b, supply);
    if (out) p.underlying.push(await c.asset(t, out, "lp-component"));
  }
  if (staked) {
    const reward = authorize(
      c,
      exactAddress(await c.read(gauge, "rewardToken")),
    );
    const earned = uint(await c.read(gauge, "earned", [c.wallet]));
    if (earned)
      p.rewards.push({
        asset: await c.asset(reward, earned, "reward"),
        rawClaimable: earned.toString(),
        sourceContract: gauge,
        confidence: "protocol-view",
        observedAt: c.pin.observedAt,
      });
    p.rewardsStatus = "CHECKED";
  }
  p.representations.push(assetId(c, pool));
  p.details = {
    pool,
    stable: String(valueOf(poolViews[5]) === true),
    shares: amount.toString(),
    walletShares: held.toString(),
    stakedShares: staked.toString(),
    shareDecimals: String(share.decimals),
    shareSymbol: share.symbol,
    ...(gauge !== ZERO ? { gauge } : {}),
    accounting: "burn share of pool token balances (no protocol-fee mint)",
  };
  // Trading fees of unstaked LP accrue in a separate fee contract; they are not added to value here.
  if (held) p.warnings.push("UNSTAKED_LP_FEES_NOT_INCLUDED");
  p.coverage = "PARTIAL_POSITION";
  return finalize(p, c);
}
/** Integer square root (floor), identical to UniswapV2 Math.sqrt for the protocol-fee mint. */
export function isqrt(y: bigint) {
  if (y < 0n) throw Error("NEGATIVE_SQRT");
  if (y > 3n) {
    let z = y,
      x = y / 2n + 1n;
    while (x < z) {
      z = x;
      x = (y / x + x) / 2n;
    }
    return z;
  }
  return y === 0n ? 0n : 1n;
}
/** UniswapV2Pair._mintFee: protocol LP minted before burn when feeTo is set. */
export function pendingFeeLiquidity(
  supply: bigint,
  reserve0: bigint,
  reserve1: bigint,
  kLast: bigint,
  denominatorMultiplier: bigint,
) {
  if (!kLast) return 0n;
  const rootK = isqrt(reserve0 * reserve1),
    rootKLast = isqrt(kLast);
  if (rootK <= rootKLast) return 0n;
  return (
    (supply * (rootK - rootKLast)) / (rootK * denominatorMultiplier + rootKLast)
  );
}
/** UniswapV3 Tick.getFeeGrowthInside + Position.update with Solidity 0.7 wrapping arithmetic. */
export function uncollectedFees(input: {
  tick: number;
  lower: number;
  upper: number;
  global: bigint;
  lowerOutside: bigint;
  upperOutside: bigint;
  insideLast: bigint;
  liquidity: bigint;
  owed: bigint;
}) {
  const M256 = UINT256_MAX + 1n,
    M128 = 1n << 128n;
  const wrap = (v: bigint) => ((v % M256) + M256) % M256;
  const below =
    input.tick >= input.lower
      ? input.lowerOutside
      : wrap(input.global - input.lowerOutside);
  const above =
    input.tick < input.upper
      ? input.upperOutside
      : wrap(input.global - input.upperOutside);
  const inside = wrap(input.global - below - above);
  const delta = (wrap(inside - input.insideLast) * input.liquidity) / M128;
  return (input.owed + (delta % M128)) % M128;
}
