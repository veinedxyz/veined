import { encodeAbiParameters, keccak256 } from "viem";
import { deployments, requireDeployment } from "./registry";
import {
  addressSchema,
  positionSchema,
  type AdapterCoverage,
  type DefiPosition,
  type PositionRef,
  type ProtocolDeployment,
} from "./model";
import {
  all,
  authorize,
  DefiReader,
  exactAddress,
  tuple,
  type ReadContext,
} from "./reader";
import {
  cached as cacheLoad,
  cacheGet as cachePeek,
  cacheKey,
  cacheSet as cacheStore,
  type TtlClass,
} from "./cache";
// V1.14.1: static proofs are read from / written to the process cache only when observed by the pinned production
// reader at a real block (with its evidence); a synthetic or test context always proves everything again.
const cached = <T>(
  c: AdapterContext,
  key: string,
  ttl: TtlClass,
  load: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> =>
  c instanceof DefiReader
    ? cacheLoad(key, ttl, load)
    : load().then((value) => ({ value, hit: false }));
const cacheGet = <T>(c: AdapterContext, key: string) =>
  c instanceof DefiReader ? cachePeek<T>(key) : undefined;
const cacheSet = (
  c: AdapterContext,
  key: string,
  value: unknown,
  ttl: TtlClass,
) => {
  if (c instanceof DefiReader) cacheStore(key, value, ttl);
};
import {
  accrueMorpho,
  decimal,
  liquidityAmounts,
  micros,
  mulDiv,
  sharesToAssets,
  sumUsd,
  uint,
  UINT128_MAX,
  UINT256_MAX,
  WAD,
} from "./math";
import { economicAssets } from "./economic";
import {
  balancerV2,
  curve,
  eigenlayer,
  lstRate,
  pendingFeeLiquidity,
  solidlyV2,
  uncollectedFees,
} from "./families";
import { NATIVE_ASSET } from "./reader";
import { buildReverseIndex, ReverseIndex } from "./reverse-index";
// Exposure graph v2: an economic asset that is itself a reviewed receipt/vault/staking token of another deployment is
// shown as that wrapper (never silently treated as its underlying).
const WRAPPER_ROLES = new Set(["receipt-token", "vault", "staking"]);
const NOT_DECOMPOSED_TEXT_MAX = 200;
let wrappers: ReverseIndex | undefined;
const wrapperIndex = () =>
  (wrappers ??= new ReverseIndex(buildReverseIndex(deployments)));
export interface AdapterContext extends ReadContext {
  refs?: PositionRef[];
  discoveryComplete?: boolean;
  trustedOracles?: Set<string>;
  curatedVaults?: Set<string>;
  /** V1.14: exact held token contracts on this chain (receipt-triggered candidates; identity is proven on-chain). */
  held?: string[];
}
// V1.14 receipt-triggered families: positions are only looked for behind exact held tokens, never brute-forced.
export const RECEIPT_FAMILIES = new Set(["curve", "balancer-v2", "solidly-v2"]);
const PROBE_LIMIT = 32;
export interface DefiProtocolAdapter {
  id: string;
  version: "1.0.0" | "1.1.0";
  deployments(): ProtocolDeployment[];
  discover(ctx: AdapterContext): Promise<PositionRef[]>;
  readPosition(
    ref: PositionRef,
    ctx: AdapterContext,
  ): Promise<DefiPosition | null>;
  getCoverage(ctx: AdapterContext): AdapterCoverage;
}
const assetId = (c: AdapterContext, a: string) =>
  c.deployment.chainId + ":" + a;
export function basePosition(c: AdapterContext, key: string): DefiPosition {
  return {
    id: c.deployment.id + ":" + key,
    wallet: c.wallet,
    chainId: c.deployment.chainId,
    deploymentId: c.deployment.id,
    protocolId: c.deployment.protocolId,
    protocolName: c.deployment.name,
    category: c.deployment.category,
    positionKey: key,
    adapterVersion: ADAPTER_VERSION[c.deployment.adapter],
    sourceBlock: c.pin.number.toString(),
    sourceBlockHash: c.pin.hash,
    observedAt: c.pin.observedAt,
    supplied: [],
    collateral: [],
    borrowed: [],
    underlying: [],
    representations: [],
    rewards: [],
    rewardsStatus: "NOT_CHECKED",
    risk: { kind: "not-available", reason: "NOT_APPLICABLE" },
    grossAssetsUsd: "0.000000",
    debtUsd: "0.000000",
    knownNetUsd: "0.000000",
    confidence: "EXACT_ONCHAIN",
    coverage: "FULL_POSITION",
    warnings: [],
    evidence: [],
    details: {},
  };
}
/** Collateral is a presentation subset of supplied for Aave; otherwise it is separate deposited exposure. */
export function finalize(p: DefiPosition, c: AdapterContext) {
  const assets = economicAssets(p);
  p.grossAssetsUsd = sumUsd(assets.map((a) => a.valueUsd));
  p.debtUsd = sumUsd(p.borrowed.map((a) => a.valueUsd));
  p.knownNetUsd = decimal(micros(p.grossAssetsUsd) - micros(p.debtUsd), 6);
  if (assets.some((a) => a.valueUsd === null))
    p.warnings.push("UNPRICED_UNDERLYING");
  const wrapped = assets.filter((a) =>
    wrapperIndex()
      .lookup(a.chainId, a.contract)
      .some((e) => WRAPPER_ROLES.has(e.role) && e.protocolId !== p.protocolId),
  );
  if (wrapped.length) {
    p.warnings.push("UNDERLYING_NOT_DECOMPOSED");
    p.details.notDecomposed = [...new Set(wrapped.map((a) => a.symbol))]
      .join(", ")
      .slice(0, NOT_DECOMPOSED_TEXT_MAX);
  }
  if (p.borrowed.some((a) => a.valueUsd === null))
    p.warnings.push("UNPRICED_DEBT");
  p.warnings = [...new Set(p.warnings)];
  p.confidence =
    p.coverage !== "FULL_POSITION"
      ? "PARTIAL"
      : assets.every((a) => a.valueUsd === null) && assets.length > 0
        ? "UNPRICED"
        : p.warnings.includes("UNPRICED_UNDERLYING") ||
            p.warnings.includes("UNPRICED_DEBT")
          ? "PARTIAL"
          : "EXACT_WITH_PRICE";
  // Identical view evidence (same kind, source and block) is recorded once per position.
  const seen = new Set<string>();
  p.evidence = c.evidence.filter((e) => {
    const k = e.kind + "|" + e.source + "|" + (e.blockNumber ?? "");
    return seen.has(k) ? false : (seen.add(k), true);
  });
  return positionSchema.parse(p);
}
const nonzero = (p: DefiPosition) =>
  [...p.supplied, ...p.collateral, ...p.borrowed, ...p.underlying].some(
    (a) => BigInt(a.rawAmount) > 0n,
  ) || p.rewards.some((r) => BigInt(r.rawClaimable) > 0n);
function assertContext(c: AdapterContext, id: string) {
  requireDeployment(c.deployment.id, c.deployment.chainId);
  if (c.deployment.adapter !== id) throw Error("UNSUPPORTED_DEPLOYMENT");
  addressSchema.parse(c.wallet);
  if (
    c.pin.observedAt > Date.now() + 30000 ||
    Date.now() - c.pin.observedAt > 60000
  )
    throw Error("STALE_STATE");
}
/** Never-rejecting view of a read (a speculative read must never surface as an unhandled rejection). */
const settle = <T>(p: Promise<T>): Promise<PromiseSettledResult<T>> =>
  p.then(
    (value) => ({ status: "fulfilled", value }),
    (reason) => ({ status: "rejected", reason }),
  );
const valueOf = <T>(r: PromiseSettledResult<T>): T => {
  if (r.status === "rejected") throw r.reason;
  return r.value;
};
const scopeOf = (c: AdapterContext) =>
  c.deployment.id + "@" + ADAPTER_VERSION[c.deployment.adapter];
const countHit = (c: AdapterContext, hit: boolean) => {
  if (hit) c.cacheHits = (c.cacheHits ?? 0) + 1;
};
interface ReserveProof {
  receipt: string;
  debt: string;
  decimals: number;
}
/**
 * V1.14.1 Aave V3 read plan. One coalesced request at the pinned block carries the deployment identity, the account
 * data, the on-chain reserve list and the user data of every planned reserve (the last observed on-chain list, else
 * the reviewed registry order) plus one rewards read with the exact token list the position will report. Reserve
 * identity proofs (aToken / variable-debt token / decimals equal to the reviewed registry) are immutable per reserve
 * and cached (LONG); they are read only for nonzero reserves and compared on every scan. A zero account reads no
 * proofs and uses no rewards result.
 */
async function aave(c: AdapterContext) {
  const { pool, provider, addressesProvider, incentives } =
    c.deployment.contracts;
  const assets = c.deployment.assets ?? [];
  const listKey = cacheKey(
    "aave-reserves",
    c.deployment.chainId,
    scopeOf(c),
    provider,
  );
  const plan =
    cacheGet<string[]>(c, listKey) ?? assets.map((a) => a.underlying);
  const userReads = new Map<string, Promise<PromiseSettledResult<unknown>>>();
  for (const contract of plan)
    userReads.set(
      contract,
      settle(c.read(provider, "getUserReserveData", [contract, c.wallet])),
    );
  const planTokens = plan.flatMap((u) => {
    const known = assets.find((a) => a.underlying === u);
    return known ? [known.receipt, known.debt] : [];
  });
  const speculativeRewards = incentives
    ? settle(c.read(incentives, "getAllUserRewards", [planTokens, c.wallet]))
    : undefined;
  const head = await Promise.all([
    settle(c.read(addressesProvider, "getPool")),
    settle(c.read(addressesProvider, "getPoolDataProvider")),
    settle(c.read(pool, "getUserAccountData", [c.wallet])),
    settle(c.read(provider, "getAllReservesTokens")),
  ]);
  if (
    exactAddress(valueOf(head[0])) !== pool ||
    exactAddress(valueOf(head[1])) !== provider
  )
    throw Error("DEPLOYMENT_IDENTITY_MISMATCH");
  const p = basePosition(c, "account"),
    account = tuple(valueOf(head[2]), 6);
  account.forEach((v) => uint(v));
  const reserveList = valueOf(head[3]);
  if (!Array.isArray(reserveList) || reserveList.length > 128)
    throw Error("MALFORMED_RESERVES");
  const onchain = reserveList.map((row) =>
    exactAddress((row as { tokenAddress?: unknown }).tokenAddress),
  );
  // A reserve listed on-chain after the plan was made is read now (bounded by the 128-reserve limit above).
  for (const contract of onchain)
    if (!userReads.has(contract))
      userReads.set(
        contract,
        settle(c.read(provider, "getUserReserveData", [contract, c.wallet])),
      );
  let failed = 0;
  const open: {
    contract: string;
    known: NonNullable<ProtocolDeployment["assets"]>[number];
    supplied: bigint;
    debt: bigint;
    collateral: boolean;
  }[] = [];
  for (const contract of onchain) {
    const known = assets.find((a) => a.underlying === contract);
    const r = await userReads.get(contract)!;
    if (!known) {
      // V1.14: a reserve outside the reviewed registry is a checked zero when the wallet holds nothing in it; a
      // nonzero balance cannot be valued without reviewed reserve metadata and keeps the position partial.
      try {
        if (r.status === "rejected") throw Error("RESERVE_READ_FAILED");
        const user = tuple(r.value, 9);
        if (user.slice(0, 3).some((v) => uint(v) > 0n)) failed++;
      } catch {
        failed++;
      }
      continue;
    }
    try {
      if (r.status === "rejected") throw Error("RESERVE_READ_FAILED");
      const user = tuple(r.value, 9);
      const [s, stable, d] = user.slice(0, 3).map((v) => uint(v));
      if (typeof user[8] !== "boolean") throw Error("MALFORMED_POSITION");
      p.representations.push(assetId(c, known.receipt), assetId(c, known.debt));
      if (s + stable + d === 0n) continue;
      open.push({
        contract,
        known,
        supplied: s,
        debt: stable + d,
        collateral: user[8],
      });
    } catch {
      failed++;
    }
  }
  // Identity proofs of the nonzero reserves only: one coalesced read for every cache miss.
  const proofs = await Promise.all(
    open.map((x) =>
      settle(
        cached<ReserveProof>(
          c,
          cacheKey(
            "aave-reserve",
            c.deployment.chainId,
            scopeOf(c),
            x.contract,
          ),
          "LONG",
          async () => {
            const [tokens, config] = await all([
              c.read(provider, "getReserveTokensAddresses", [x.contract]),
              c.read(provider, "getReserveConfigurationData", [x.contract]),
            ]);
            const t = tuple(tokens, 3),
              cfg = tuple(config, 10);
            return {
              receipt: exactAddress(t[0]),
              debt: exactAddress(t[2]),
              decimals: Number(cfg[0]),
            };
          },
        ).then((r) => (countHit(c, r.hit), r.value)),
      ),
    ),
  );
  for (const [i, x] of open.entries()) {
    try {
      const proof = valueOf(proofs[i]);
      if (proof.receipt !== x.known.receipt || proof.debt !== x.known.debt)
        throw Error("RESERVE_IDENTITY_MISMATCH");
      if (proof.decimals !== x.known.decimals)
        throw Error("DECIMAL_IDENTITY_MISMATCH");
      if (x.supplied > 0n) {
        const a = await c.asset(x.contract, x.supplied, "supplied", x.known);
        p.supplied.push(a);
        if (x.collateral) p.collateral.push({ ...a, role: "collateral" });
      }
      if (x.debt > 0n)
        p.borrowed.push(await c.asset(x.contract, x.debt, "borrowed", x.known));
    } catch (e) {
      if (e instanceof Error && /IDENTITY_MISMATCH/.test(e.message)) throw e;
      failed++;
    }
  }
  // The on-chain list becomes the next scan's plan only (it is re-read and re-checked at every pinned block).
  if (!failed) cacheSet(c, listKey, onchain, "MEDIUM");
  if (failed) {
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("RESERVE_READ_INCOMPLETE");
  }
  if (uint(account[1]) > 0n && p.borrowed.length === 0)
    throw Error("DEBT_READ_INCOMPLETE");
  const hf = uint(account[5]);
  if (uint(account[1]) > 0n && hf !== UINT256_MAX)
    p.risk = {
      kind: "health-factor",
      value: decimal(hf, 18),
      ltvBps: uint(account[4]).toString(),
      liquidationThresholdBps: uint(account[3]).toString(),
      source: "protocol-view",
      attention:
        hf < WAD ? "attention" : hf < (15n * WAD) / 10n ? "monitor" : "none",
    };
  if (incentives && p.supplied.length + p.borrowed.length > 0) {
    try {
      const tokenContracts = p.representations.map((s) => s.split(":")[1]);
      // The speculative result is used only when its token list is exactly the one this position reports.
      const speculative =
        tokenContracts.length === planTokens.length &&
        tokenContracts.every((t, i) => t === planTokens[i])
          ? await speculativeRewards!
          : undefined;
      const r = tuple(
          speculative?.status === "fulfilled"
            ? speculative.value
            : await c.read(incentives, "getAllUserRewards", [
                tokenContracts,
                c.wallet,
              ]),
          2,
        ),
        contracts = r[0],
        amounts = r[1];
      if (
        !Array.isArray(contracts) ||
        !Array.isArray(amounts) ||
        contracts.length !== amounts.length ||
        contracts.length > 32
      )
        throw Error("MALFORMED_REWARDS");
      for (let i = 0; i < contracts.length; i++) {
        const amount = uint(amounts[i]);
        if (amount > 0n)
          p.rewards.push({
            asset: await c.asset(exactAddress(contracts[i]), amount, "reward"),
            rawClaimable: amount.toString(),
            sourceContract: incentives,
            confidence: "protocol-view",
            observedAt: c.pin.observedAt,
          });
      }
      p.rewardsStatus = "CHECKED";
    } catch {
      p.rewardsStatus = "FAILED";
      p.warnings.push("REWARDS_READ_FAILED");
    }
  }
  if (!nonzero(p) && failed) throw Error("RESERVE_READ_INCOMPLETE");
  return nonzero(p) ? finalize(p, c) : null;
}
/**
 * V1.14.1 Compound III read plan: base token, balances and the collateral count in one request; with the asset list
 * of the last scan (MEDIUM, configuration only) the asset infos and the wallet's collateral balances join that same
 * request. Every planned asset is re-proven by getAssetInfo at this pinned block before its balance is used; an asset
 * that changed is read again. Errors surface in the V1.14 program order.
 */
async function compound(c: AdapterContext) {
  const core = c.deployment.contracts.comet,
    p = basePosition(c, core);
  const planKey = cacheKey(
    "comet-assets",
    c.deployment.chainId,
    scopeOf(c),
    core,
  );
  const plan = cacheGet<string[]>(c, planKey) ?? [];
  if (plan.length) countHit(c, true);
  const infoReads = plan.map((_, i) =>
    settle(c.read(core, "getAssetInfo", [i])),
  );
  const planned = plan.map((asset) =>
    settle(c.read(core, "collateralBalanceOf", [c.wallet, asset])),
  );
  const head = await Promise.all([
    settle(c.read(core, "baseToken")),
    settle(c.read(core, "balanceOf", [c.wallet])),
    settle(c.read(core, "borrowBalanceOf", [c.wallet])),
    settle(c.read(core, "numAssets")),
  ]);
  const base = authorize(c, exactAddress(valueOf(head[0])));
  const supplied = uint(valueOf(head[1])),
    borrowed = uint(valueOf(head[2]));
  const risk = borrowed
    ? Promise.all([
        settle(c.read(core, "isBorrowCollateralized", [c.wallet])),
        settle(c.read(core, "isLiquidatable", [c.wallet])),
      ])
    : undefined;
  if (supplied) p.supplied.push(await c.asset(base, supplied, "supplied"));
  if (borrowed) p.borrowed.push(await c.asset(base, borrowed, "borrowed"));
  p.representations.push(assetId(c, core));
  const count = Number(valueOf(head[3]));
  if (!Number.isInteger(count) || count < 0 || count > 24)
    throw Error("MALFORMED_COLLATERAL_COUNT");
  for (let i = plan.length; i < count; i++)
    infoReads.push(settle(c.read(core, "getAssetInfo", [i])));
  const contracts: string[] = [];
  const balances: Promise<PromiseSettledResult<unknown>>[] = [];
  for (let i = 0; i < count; i++) {
    const a = valueOf(await infoReads[i]) as {
      asset?: unknown;
      scale?: unknown;
      borrowCollateralFactor?: unknown;
      liquidateCollateralFactor?: unknown;
    };
    const contract = exactAddress(a.asset),
      scale = uint(a.scale),
      decimals = scale.toString().length - 1;
    if (scale !== 10n ** BigInt(decimals) || decimals > 36)
      throw Error("INVALID_DECIMALS");
    uint(a.borrowCollateralFactor);
    uint(a.liquidateCollateralFactor);
    contracts.push(contract);
    balances.push(
      plan[i] === contract
        ? planned[i]
        : settle(c.read(core, "collateralBalanceOf", [c.wallet, contract])),
    );
  }
  for (let i = 0; i < count; i++) {
    const amount = uint(valueOf(await balances[i]), UINT128_MAX);
    if (amount)
      p.collateral.push(await c.asset(contracts[i], amount, "collateral"));
  }
  cacheSet(c, planKey, contracts, "MEDIUM");
  if (borrowed) {
    const [okR, liqR] = await risk!;
    const ok = valueOf(okR),
      liq = valueOf(liqR);
    if (typeof ok !== "boolean" || typeof liq !== "boolean")
      throw Error("MALFORMED_RISK");
    p.risk = {
      kind: "collateralization-status",
      borrowCollateralized: ok,
      liquidatable: liq,
      source: "protocol-view",
      attention: !ok || liq ? "attention" : "none",
    };
  }
  return nonzero(p) ? finalize(p, c) : null;
}
/**
 * V1.14.1 Morpho Blue position read: the market parameters are bound to the market id by its hash (MarketParamsLib.id)
 * and therefore cached (LONG) once proven; position, fee recipient and market state are read in one request at the
 * pin; the reviewed IRM rate and the oracle-factory check share the next one; an oracle's price is read only after
 * the official factory proved it (never a speculative call to a market-chosen contract).
 */
async function morpho(ref: PositionRef, c: AdapterContext) {
  if (!ref.marketId || !/^0x[0-9a-f]{64}$/.test(ref.marketId))
    throw Error("INVALID_MARKET_ID");
  const core = c.deployment.contracts.blue;
  const paramsKey = cacheKey(
    "morpho-market",
    c.deployment.chainId,
    scopeOf(c),
    ref.marketId,
  );
  const known = cacheGet<readonly unknown[]>(c, paramsKey);
  if (known) countHit(c, true);
  const r = await Promise.all([
    known
      ? Promise.resolve<PromiseSettledResult<unknown>>({
          status: "fulfilled",
          value: known,
        })
      : settle(c.read(core, "idToMarketParams", [ref.marketId])),
    settle(c.read(core, "position", [ref.marketId, c.wallet])),
    settle(c.read(core, "feeRecipient")),
    settle(c.read(core, "market", [ref.marketId])),
  ]);
  const params = tuple(valueOf(r[0]), 5);
  const addresses = params.slice(0, 4).map(exactAddress),
    lltv = uint(params[4]);
  if (lltv > WAD) throw Error("INVALID_LLTV");
  const computed = keccak256(
    encodeAbiParameters(
      [
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "address" },
        { type: "uint256" },
      ],
      [
        addresses[0] as `0x${string}`,
        addresses[1] as `0x${string}`,
        addresses[2] as `0x${string}`,
        addresses[3] as `0x${string}`,
        lltv,
      ],
    ),
  );
  if (computed !== ref.marketId) throw Error("MARKET_IDENTITY_MISMATCH");
  if (!known) cacheSet(c, paramsKey, params, "LONG");
  const user = tuple(valueOf(r[1]), 3),
    ss = uint(user[0]),
    bs = uint(user[1], UINT128_MAX),
    coll = uint(user[2], UINT128_MAX);
  const feeRecipient = exactAddress(valueOf(r[2]));
  if (ss + bs + coll === 0n && c.wallet !== feeRecipient) return null;
  const p = basePosition(c, ref.marketId);
  const m = tuple(valueOf(r[3]), 6).map((v) => uint(v, UINT128_MAX));
  const needRate =
    m[2] > 0n &&
    m[4] < c.pin.timestamp &&
    addresses[3] !== "0x" + "0".repeat(40);
  if (needRate) {
    if (addresses[3] !== c.deployment.contracts.irm)
      throw Error("UNSUPPORTED_IRM");
    authorize(c, addresses[3]);
  }
  // V1.14 oracle registry: an oracle has reviewed semantics only when it is a MorphoChainlinkOracleV2 created by the
  // official factory pinned for this chain (price() scaled by 1e36, as Morpho's own health check uses it).
  let reviewedOracle = c.trustedOracles?.has(addresses[2]) ?? false;
  const oracleFactory = c.deployment.contracts.oracleFactory;
  const [rateR, oracleR] = await Promise.all([
    needRate
      ? settle(c.read(addresses[3], "borrowRateView", [params, m]))
      : undefined,
    bs && coll && !reviewedOracle && oracleFactory
      ? settle(
          c.read(oracleFactory, "isMorphoChainlinkOracleV2", [addresses[2]]),
        )
      : undefined,
  ]);
  const rate = rateR ? uint(valueOf(rateR)) : 0n;
  const state = accrueMorpho(m, rate, c.pin.timestamp);
  let supplyShares = ss;
  if (c.wallet === feeRecipient) supplyShares += state.supplyShares - m[1];
  const parts = await Promise.all([
    supplyShares
      ? settle(
          c.asset(
            addresses[0],
            sharesToAssets(
              supplyShares,
              state.supplyAssets,
              state.supplyShares,
            ),
            "supplied",
          ),
        )
      : undefined,
    bs
      ? settle(
          c.asset(
            addresses[0],
            sharesToAssets(bs, state.borrowAssets, state.borrowShares, true),
            "borrowed",
          ),
        )
      : undefined,
    coll ? settle(c.asset(addresses[1], coll, "collateral")) : undefined,
  ]);
  if (parts[0]) p.supplied.push(valueOf(parts[0]));
  if (parts[1]) p.borrowed.push(valueOf(parts[1]));
  if (parts[2]) p.collateral.push(valueOf(parts[2]));
  if (oracleR)
    reviewedOracle = oracleR.status === "fulfilled" && oracleR.value === true;
  if (bs && coll && reviewedOracle) {
    try {
      authorize(c, addresses[2]);
      const price = uint(await c.read(addresses[2], "price"));
      if (!price) throw Error("ORACLE_UNAVAILABLE");
      const collateralLoan = (coll * price) / 10n ** 36n;
      if (!collateralLoan) throw Error("ORACLE_UNAVAILABLE");
      const ltv = mulDiv(
        BigInt(p.borrowed[0].rawAmount),
        WAD,
        collateralLoan,
        true,
      );
      p.risk = {
        kind: "ltv",
        ltv: decimal(ltv, 18),
        liquidationLtv: decimal(lltv, 18),
        margin: decimal(lltv - ltv, 18),
        oracle: addresses[2],
        source: "protocol-state",
        attention:
          ltv >= lltv
            ? "attention"
            : ltv * 100n >= lltv * 90n
              ? "monitor"
              : "none",
      };
    } catch {
      p.risk = { kind: "not-available", reason: "ORACLE_UNAVAILABLE" };
    }
  } else if (bs)
    p.risk = { kind: "not-available", reason: "ORACLE_NOT_REVIEWED" };
  p.details = {
    marketId: ref.marketId,
    supplyShares: ss.toString(),
    borrowShares: bs.toString(),
    lltv: decimal(lltv, 18),
  };
  if (!c.discoveryComplete) {
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("MARKET_DISCOVERY_INCOMPLETE");
  }
  return finalize(p, c);
}
/** ERC4626 / MetaMorpho share position. The factory's curation proof of a MetaMorpho vault is immutable (LONG). */
async function vault(ref: PositionRef, c: AdapterContext) {
  const core = ref.contract ?? c.deployment.contracts.vault;
  if (!core) throw Error("VAULT_NOT_CURATED");
  if (c.deployment.adapter === "morpho-vault") {
    const r = await cached(
      c,
      cacheKey("metamorpho-vault", c.deployment.chainId, scopeOf(c), core),
      "LONG",
      async () => {
        const ok = await c.read(
          c.deployment.contracts.factory,
          "isMetaMorpho",
          [core],
        );
        if (ok !== true) throw Error("VAULT_NOT_CURATED");
        return true;
      },
    );
    countHit(c, r.hit);
    authorize(c, core);
  } else if (core !== c.deployment.contracts.vault)
    throw Error("VAULT_NOT_CURATED");
  const head = await Promise.all([
    settle(c.code(core)),
    settle(c.read(core, "balanceOf", [c.wallet])),
    settle(c.read(core, "asset")),
  ]);
  valueOf(head[0]);
  const shares = uint(valueOf(head[1]));
  if (!shares) return null;
  const p = basePosition(c, core),
    asset = exactAddress(valueOf(head[2]));
  if (asset === core) throw Error("VAULT_CYCLE");
  const [shareR, convertR] = await Promise.all([
    settle(c.asset(core, shares, "supplied")),
    settle(c.read(core, "convertToAssets", [shares])),
  ]);
  const share = valueOf(shareR);
  let raw = uint(valueOf(convertR)),
    leaf = asset;
  const seen = new Set([core]);
  for (let depth = 0; c.curatedVaults?.has(leaf); depth++) {
    if (seen.has(leaf)) throw Error("VAULT_CYCLE");
    if (depth >= 3) {
      p.coverage = "PARTIAL_POSITION";
      p.warnings.push("NESTED_DEPTH_LIMIT");
      break;
    }
    seen.add(leaf);
    authorize(c, leaf);
    const nested = await Promise.all([
      settle(c.code(leaf)),
      settle(c.read(leaf, "asset")),
      settle(c.read(leaf, "convertToAssets", [raw])),
    ]);
    valueOf(nested[0]);
    const next = exactAddress(valueOf(nested[1]));
    if (seen.has(next)) throw Error("VAULT_CYCLE");
    raw = uint(valueOf(nested[2]));
    leaf = next;
  }
  p.underlying.push(await c.asset(leaf, raw, "vault-underlying"));
  p.representations.push(assetId(c, core));
  p.details = {
    shares: shares.toString(),
    shareDecimals: String(share.decimals),
    shareSymbol: share.symbol,
    shareContract: core,
    underlyingContract: asset,
  };
  if (c.deployment.adapter === "morpho-vault" && !c.discoveryComplete) {
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("VAULT_DISCOVERY_INCOMPLETE");
  }
  return finalize(p, c);
}
async function lido(ref: PositionRef, c: AdapterContext) {
  const { steth, wsteth } = c.deployment.contracts,
    core = ref.contract;
  if (ref.key === "withdrawals") return lidoWithdrawals(c);
  if (core !== steth && core !== wsteth)
    throw Error("DEPLOYMENT_IDENTITY_MISMATCH");
  const raw = uint(await c.read(core, "balanceOf", [c.wallet]));
  if (!raw) return null;
  const p = basePosition(c, core),
    underlying =
      core === wsteth
        ? uint(await c.read(wsteth, "getStETHByWstETH", [raw]))
        : raw;
  p.underlying.push(
    await c.asset(steth, underlying, "underlying", {
      symbol: "stETH",
      decimals: 18,
    }),
  );
  p.representations.push(assetId(c, core));
  p.details = {
    positionToken: core === wsteth ? "wstETH" : "stETH",
    rawShares: raw.toString(),
    exposure: "stETH",
    rateRaw: mulDiv(underlying, WAD, raw).toString(),
    withdrawalQueue: c.deployment.contracts.withdrawalQueue
      ? "CHECKED_SEPARATELY"
      : "NOT_CHECKED",
  };
  if (!c.deployment.contracts.withdrawalQueue)
    p.warnings.push("WITHDRAWAL_QUEUE_NOT_CHECKED");
  return finalize(p, c);
}
/** V1.14 Lido WithdrawalQueueERC721: finalized and unclaimed ETH is exact (getClaimableEther with checkpoint hints);
 * pending requests are listed by locked stETH but valued only after finalization. Read-only; no claim action. */
async function lidoWithdrawals(c: AdapterContext) {
  const queue = c.deployment.contracts.withdrawalQueue;
  if (!queue) throw Error("DEPLOYMENT_IDENTITY_MISMATCH");
  const ids = (
    (await c.read(queue, "getWithdrawalRequests", [c.wallet])) as unknown[]
  ).map((v) => uint(v));
  if (!ids.length) return null;
  if (ids.length > 200) throw Error("WITHDRAWAL_REQUEST_LIMIT");
  const sorted = [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const statuses = (await c.read(queue, "getWithdrawalStatus", [sorted])) as {
    amountOfStETH: bigint;
    owner: string;
    isFinalized: boolean;
    isClaimed: boolean;
  }[];
  if (!Array.isArray(statuses) || statuses.length !== sorted.length)
    throw Error("MALFORMED_WITHDRAWAL_STATUS");
  const finalized: bigint[] = [],
    pending: bigint[] = [];
  let pendingSteth = 0n;
  statuses.forEach((st, i) => {
    if (exactAddress(st.owner) !== c.wallet)
      throw Error("WITHDRAWAL_OWNER_MISMATCH");
    if (st.isClaimed) return;
    if (st.isFinalized) finalized.push(sorted[i]);
    else {
      pending.push(sorted[i]);
      pendingSteth += uint(st.amountOfStETH);
    }
  });
  if (!finalized.length && !pending.length) return null;
  const p = basePosition(c, "withdrawals");
  if (finalized.length) {
    const last = uint(await c.read(queue, "getLastCheckpointIndex"));
    const hints = (
      (await c.read(queue, "findCheckpointHints", [
        finalized,
        1n,
        last,
      ])) as unknown[]
    ).map((v) => uint(v));
    const claimable = (
      (await c.read(queue, "getClaimableEther", [
        finalized,
        hints,
      ])) as unknown[]
    ).map((v) => uint(v));
    const total = claimable.reduce((a, b) => a + b, 0n);
    if (total)
      p.underlying.push(
        await c.asset(NATIVE_ASSET, total, "underlying", {
          symbol: "ETH",
          decimals: 18,
        }),
      );
  }
  if (pendingSteth) {
    const locked = await c.asset(
      c.deployment.contracts.steth,
      pendingSteth,
      "underlying",
      { symbol: "stETH", decimals: 18 },
    );
    // The ETH paid at finalization can be lower than the locked stETH: never valued before it is final.
    p.underlying.push({ ...locked, valueUsd: null });
    p.warnings.push("WITHDRAWAL_PENDING_FINALIZATION");
  }
  p.details = {
    withdrawalRequests: String(finalized.length + pending.length),
    finalizedUnclaimed: String(finalized.length),
    pending: String(pending.length),
    pendingStETH: pendingSteth.toString(),
    claimAction: "NONE_READ_ONLY",
  };
  return finalize(p, c);
}
/** Exact UniswapV2-family burn: protocol-fee mint first (feeTo/kLast), then the share of token balances. */
async function v2(ref: PositionRef, c: AdapterContext) {
  if (!ref.contract) throw Error("PAIR_NOT_DISCOVERED");
  const core = authorize(c, exactAddress(ref.contract));
  const probe = ref.discovery === "token-triggered";
  let token0: string, token1: string;
  try {
    // V1.14.1: identity reads share one request; they are checked in the V1.14 order (first failure wins).
    const id = await Promise.all([
      settle(c.code(core)),
      settle(c.read(core, "factory")),
      settle(c.read(core, "token0")),
      settle(c.read(core, "token1")),
    ]);
    valueOf(id[0]);
    if (exactAddress(valueOf(id[1])) !== c.deployment.contracts.factory)
      throw Error("PAIR_IDENTITY_MISMATCH");
    token0 = exactAddress(valueOf(id[2]));
    token1 = exactAddress(valueOf(id[3]));
    if (token0 === token1) throw Error("PAIR_IDENTITY_MISMATCH");
    const pairKey = cacheKey(
      "univ2-pair",
      c.deployment.chainId,
      scopeOf(c),
      core,
    );
    const r = await cached(c, pairKey, "LONG", async () => {
      if (
        exactAddress(
          await c.read(c.deployment.contracts.factory, "getPair", [
            token0,
            token1,
          ]),
        ) !== core
      )
        throw Error("PAIR_IDENTITY_MISMATCH");
      return [token0, token1];
    });
    countHit(c, r.hit);
    if (r.value[0] !== token0 || r.value[1] !== token1)
      throw Error("PAIR_IDENTITY_MISMATCH");
  } catch (e) {
    // A held token that is not a pair of this factory is simply not a position of this protocol.
    if (probe) return null;
    throw e;
  }
  authorize(c, token0);
  authorize(c, token1);
  const state = await Promise.all([
    settle(c.read(core, "balanceOf", [c.wallet])),
    settle(c.read(core, "totalSupply")),
    settle(c.read(core, "getReserves")),
    settle(c.read(c.deployment.contracts.factory, "feeTo")),
    settle(c.read(core, "kLast")),
    settle(c.read(token0, "balanceOf", [core])),
    settle(c.read(token1, "balanceOf", [core])),
  ]);
  const amount = uint(valueOf(state[0]));
  if (!amount) return null;
  const total = uint(valueOf(state[1]));
  if (!total || amount > total) throw Error("INVALID_LP_SUPPLY");
  const reserves = tuple(valueOf(state[2]), 3);
  const feeTo = exactAddress(valueOf(state[3]));
  // kLast is used only when the protocol fee is on (V1.14 read it only then).
  const kLast = feeTo === "0x" + "0".repeat(40) ? 0n : uint(valueOf(state[4]));
  const mint = pendingFeeLiquidity(
    total,
    uint(reserves[0]),
    uint(reserves[1]),
    kLast,
    c.deployment.variant === "fee3" ? 3n : 5n,
  );
  const supply = total + mint;
  const bal0 = uint(valueOf(state[5])),
    bal1 = uint(valueOf(state[6]));
  const p = basePosition(c, core);
  p.underlying = await Promise.all([
    c.asset(token0, mulDiv(amount, bal0, supply), "lp-component"),
    c.asset(token1, mulDiv(amount, bal1, supply), "lp-component"),
  ]);
  p.representations.push(assetId(c, core));
  p.details = {
    shares: amount.toString(),
    pair: core,
    pendingProtocolFeeLiquidity: mint.toString(),
    accounting: "burn share of pair token balances after the protocol-fee mint",
  };
  if (!c.discoveryComplete && !probe)
    p.warnings.push("PAIR_DISCOVERY_INCOMPLETE");
  return finalize(p, c);
}
interface PoolIdentity {
  pool: string;
  spacing: number;
}
/**
 * UniswapV3 / PancakeV3 NFT position. V1.14.1: the pool of (token0, token1, fee) and its immutable identity
 * (factory, tokens, fee, tick spacing) are proven once and cached (LONG); the position, slot0, fee growth and the
 * two boundary ticks are read in one request at the pin. V1.14 exact source-block fee math is unchanged.
 */
async function v3(ref: PositionRef, c: AdapterContext) {
  if (!ref.tokenId || !/^\d+$/.test(ref.tokenId))
    throw Error("INVALID_TOKEN_ID");
  const { manager, factory } = c.deployment.contracts;
  const pancake = c.deployment.variant === "pancake";
  const head = await Promise.all([
    settle(c.read(manager, "ownerOf", [BigInt(ref.tokenId)])),
    settle(c.read(manager, "factory")),
    pancake ? settle(c.read(manager, "deployer")) : undefined,
    settle(c.read(manager, "positions", [BigInt(ref.tokenId)])),
  ]);
  if (exactAddress(valueOf(head[0])) !== c.wallet)
    throw Error("NFT_OWNER_MISMATCH");
  if (exactAddress(valueOf(head[1])) !== factory)
    throw Error("DEPLOYMENT_IDENTITY_MISMATCH");
  if (
    pancake &&
    exactAddress(valueOf(head[2]!)) !== c.deployment.contracts.deployer
  )
    throw Error("DEPLOYMENT_IDENTITY_MISMATCH");
  const state = tuple(valueOf(head[3]), 12),
    token0 = exactAddress(state[2]),
    token1 = exactAddress(state[3]),
    fee = Number(state[4]),
    lower = Number(state[5]),
    upper = Number(state[6]),
    liquidity = uint(state[7], UINT128_MAX);
  if (token0 === token1 || !Number.isInteger(fee) || fee < 0 || fee > 1000000)
    throw Error("INVALID_POOL");
  const poolKey = cacheKey(
    "univ3-pool",
    c.deployment.chainId,
    scopeOf(c),
    keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "uint24" }],
        [token0 as `0x${string}`, token1 as `0x${string}`, fee],
      ),
    ),
  );
  const identity = await cached<PoolIdentity>(c, poolKey, "LONG", async () => {
    const pool = authorize(
      c,
      exactAddress(await c.read(factory, "poolFor", [token0, token1, fee])),
    );
    const id = await Promise.all([
      settle(c.code(pool)),
      settle(c.read(pool, "factory")),
      settle(c.read(pool, "token0")),
      settle(c.read(pool, "token1")),
      settle(c.read(pool, "fee")),
      settle(c.read(pool, "tickSpacing")),
    ]);
    valueOf(id[0]);
    if (
      exactAddress(valueOf(id[1])) !== factory ||
      exactAddress(valueOf(id[2])) !== token0 ||
      exactAddress(valueOf(id[3])) !== token1 ||
      Number(valueOf(id[4])) !== fee
    )
      throw Error("POOL_IDENTITY_MISMATCH");
    return { pool, spacing: Number(valueOf(id[5])) };
  });
  countHit(c, identity.hit);
  const { pool, spacing } = identity.value;
  authorize(c, pool);
  if (
    !Number.isInteger(spacing) ||
    spacing <= 0 ||
    lower % spacing ||
    upper % spacing
  )
    throw Error("INVALID_RANGE");
  const reads = await Promise.all([
    settle(c.code(pool)),
    settle(c.read(pool, pancake ? "slot0Pancake" : "slot0")),
    settle(c.read(pool, "feeGrowthGlobal0X128")),
    settle(c.read(pool, "feeGrowthGlobal1X128")),
    settle(c.read(pool, "ticks", [lower])),
    settle(c.read(pool, "ticks", [upper])),
  ]);
  valueOf(reads[0]);
  const slot = tuple(valueOf(reads[1]), 7),
    tick = Number(slot[1]);
  const amounts = liquidityAmounts(liquidity, uint(slot[0]), lower, upper),
    p = basePosition(c, ref.tokenId);
  for (let i = 0; i < 2; i++)
    if (amounts[i] > 0n)
      p.underlying.push(
        await c.asset(i === 0 ? token0 : token1, amounts[i], "lp-component"),
      );
  // V1.14 exact uncollected fees: Tick.getFeeGrowthInside + NPM accounting at the pinned block (what collect() pays).
  const g0 = valueOf(reads[2]),
    g1 = valueOf(reads[3]),
    loT = tuple(valueOf(reads[4]), 8),
    hiT = tuple(valueOf(reads[5]), 8);
  const owed = [0, 1].map((k) =>
    uncollectedFees({
      tick,
      lower,
      upper,
      global: uint(k === 0 ? g0 : g1),
      lowerOutside: uint(loT[2 + k]),
      upperOutside: uint(hiT[2 + k]),
      insideLast: uint(state[8 + k]),
      liquidity,
      owed: uint(state[10 + k], UINT128_MAX),
    }),
  );
  p.fees = [];
  for (let i = 0; i < 2; i++)
    if (owed[i] > 0n)
      p.fees.push(await c.asset(i === 0 ? token0 : token1, owed[i], "fee"));
  p.details = {
    tokenId: ref.tokenId,
    pool,
    fee: fee.toString(),
    lower: lower.toString(),
    upper: upper.toString(),
    range: tick >= lower && tick < upper ? "IN_RANGE" : "OUT_OF_RANGE",
    liquidity: liquidity.toString(),
    tokensOwed0: owed[0].toString(),
    tokensOwed1: owed[1].toString(),
    fees: "UNCOLLECTED_EXACT_AT_SOURCE_BLOCK",
  };
  if (pancake) {
    // Positions staked in MasterChefV3 are owned by that contract and are not enumerated here.
    p.coverage = "PARTIAL_POSITION";
    p.warnings.push("STAKED_POSITIONS_NOT_CHECKED");
  }
  if (!nonzero(p) && owed[0] + owed[1] === 0n) return null;
  return finalize(p, c);
}
// Adapter versions are part of the coverage key: families whose semantics changed in V1.14 carry 1.1.0.
export const ADAPTER_VERSION: Record<
  ProtocolDeployment["adapter"],
  "1.0.0" | "1.1.0"
> = {
  "aave-v3": "1.1.0",
  "compound-iii": "1.0.0",
  erc4626: "1.0.0",
  "morpho-vault": "1.0.0",
  "morpho-blue": "1.1.0",
  lido: "1.1.0",
  "uniswap-v2": "1.1.0",
  "uniswap-v3": "1.1.0",
  "lst-rate": "1.1.0",
  eigenlayer: "1.1.0",
  curve: "1.1.0",
  "balancer-v2": "1.1.0",
  "solidly-v2": "1.1.0",
};
// A complete registry (every market / vault since deployment) is reduced to the wallet's nonzero entries with batched
// exact reads at the pinned block; a failed batch keeps discovery incomplete instead of guessing.
// V1.14.1: PREFILTER_CHUNK exact reads per pinned aggregate (the policy maximum; the reader splits a failed chunk in
// halves at most twice and never on a rate limit), at most PREFILTER_PARALLEL aggregates in flight, and no fan-out
// to single calls: once a provider throttles or the endpoint is in cooldown no further chunk is sent and discovery
// stays incomplete (PARTIAL), with every successful chunk's nonzero entries retained.
export const PREFILTER_CHUNK = 500;
const PREFILTER_PARALLEL = 2;
const THROTTLED = /RATE_LIMITED|NO_HEALTHY_ENDPOINT|ENDPOINT_COOLDOWN/;
async function prefilterRegistry(
  c: AdapterContext,
  id: "morpho-blue" | "morpho-vault",
): Promise<PositionRef[]> {
  const refs = c.refs ?? [];
  const chunks: PositionRef[][] = [];
  for (let i = 0; i < refs.length; i += PREFILTER_CHUNK)
    chunks.push(refs.slice(i, i + PREFILTER_CHUNK));
  const found: PositionRef[][] = chunks.map(() => []);
  let next = 0,
    throttled = false;
  const throttle = (r: PromiseSettledResult<unknown>) =>
    r.status === "rejected" &&
    THROTTLED.test(
      `${(r.reason as { code?: string })?.code ?? ""} ${(r.reason as { detail?: string })?.detail ?? ""} ${(r.reason as Error)?.message ?? ""}`,
    );
  const run = async () => {
    while (next < chunks.length && !throttled && !c.signal.aborted) {
      const k = next++,
        chunk = chunks[k];
      const calls = chunk.map((r) => {
        if (id === "morpho-vault") authorize(c, exactAddress(r.contract));
        return id === "morpho-blue"
          ? {
              target: c.deployment.contracts.blue,
              name: "position" as const,
              args: [r.marketId, c.wallet],
            }
          : {
              target: exactAddress(r.contract),
              name: "balanceOf" as const,
              args: [c.wallet],
            };
      });
      // One pinned Multicall3 aggregate per chunk; without a verified Multicall3 the reads are coalesced into
      // JSON-RPC batches by the reader (still stopping at the first throttled chunk).
      const aggregated = c.readAggregate
        ? await c.readAggregate(calls).catch(() => null)
        : null;
      const results =
        aggregated ??
        (c.readMany
          ? (
              await Promise.all(
                Array.from({ length: Math.ceil(calls.length / 125) }, (_, o) =>
                  c.readMany!(calls.slice(o * 125, o * 125 + 125)),
                ),
              )
            ).flat()
          : await Promise.allSettled(
              calls.map((x) => c.read(x.target, x.name, x.args)),
            ));
      if (results.length !== chunk.length) {
        c.discoveryComplete = false;
        continue;
      }
      results.forEach((r, j) => {
        if (r.status === "rejected") {
          c.discoveryComplete = false;
          if (throttle(r)) throttled = true;
          return;
        }
        const v = r.value;
        const nonzeroValue = Array.isArray(v)
          ? v.slice(0, 3).some((x) => typeof x === "bigint" && x > 0n)
          : typeof v === "bigint" && v > 0n;
        if (nonzeroValue) found[k].push(chunk[j]);
      });
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(PREFILTER_PARALLEL, chunks.length) }, run),
  );
  // Chunks never sent (throttling or deadline) leave discovery incomplete: never a checked zero.
  if (next < chunks.length) c.discoveryComplete = false;
  return found.flat();
}
function heldRefs(c: AdapterContext): PositionRef[] {
  return [...new Set(c.held ?? [])]
    .filter((a) => /^0x[0-9a-f]{40}$/.test(a))
    .slice(0, PROBE_LIMIT)
    .map((contract) => ({
      key: contract,
      contract,
      discovery: "token-triggered" as const,
    }));
}
/**
 * V1.14.1 metadata prewarm for one deployment (startup / sync time). Reads only deployment-level static facts through
 * the same pinned reader, cache keys and identity checks the adapters use: reserve identities and the reserve list
 * (Aave V3 / Spark), the comet configuration and its token metadata (Compound III). It never issues a wallet-scoped
 * view (the reader's wallet is the zero address and no user view is called) and it never caches a failure.
 */
export async function prewarmDeployment(c: AdapterContext) {
  if (!(c instanceof DefiReader)) throw Error("PREWARM_REQUIRES_READER");
  const d = c.deployment;
  if (d.adapter === "aave-v3") {
    const { provider } = d.contracts;
    const list = tuple(await c.read(provider, "getAllReservesTokens"), 0);
    if (list.length > 128) throw Error("MALFORMED_RESERVES");
    const onchain = list.map((row) =>
      exactAddress((row as { tokenAddress?: unknown }).tokenAddress),
    );
    cacheSet(
      c,
      cacheKey("aave-reserves", d.chainId, scopeOf(c), provider),
      onchain,
      "MEDIUM",
    );
    let proven = 0;
    await Promise.all(
      (d.assets ?? [])
        .filter((a) => onchain.includes(a.underlying))
        .map(async (a) => {
          const r = await cached<ReserveProof>(
            c,
            cacheKey("aave-reserve", d.chainId, scopeOf(c), a.underlying),
            "LONG",
            async () => {
              const [tokens, config] = await all([
                c.read(provider, "getReserveTokensAddresses", [a.underlying]),
                c.read(provider, "getReserveConfigurationData", [a.underlying]),
              ]);
              const t = tuple(tokens, 3),
                cfg = tuple(config, 10);
              const proof = {
                receipt: exactAddress(t[0]),
                debt: exactAddress(t[2]),
                decimals: Number(cfg[0]),
              };
              // A mismatching reserve is never cached: the scan reports it (DEPLOYMENT/RESERVE_IDENTITY_MISMATCH).
              if (
                proof.receipt !== a.receipt ||
                proof.debt !== a.debt ||
                proof.decimals !== a.decimals
              )
                throw Error("RESERVE_IDENTITY_MISMATCH");
              return proof;
            },
          ).catch(() => undefined);
          if (r) proven++;
        }),
    );
    return { reserves: onchain.length, proven };
  }
  if (d.adapter === "compound-iii") {
    const core = d.contracts.comet;
    const [baseRaw, countRaw] = await all([
      c.read(core, "baseToken"),
      c.read(core, "numAssets"),
    ]);
    const base = authorize(c, exactAddress(baseRaw));
    const count = Number(countRaw);
    if (!Number.isInteger(count) || count < 0 || count > 24)
      throw Error("MALFORMED_COLLATERAL_COUNT");
    const infos = await all(
      Array.from({ length: count }, (_, i) =>
        c.read(core, "getAssetInfo", [i]),
      ),
    );
    const assets = infos.map((x) =>
      exactAddress((x as { asset?: unknown }).asset),
    );
    cacheSet(
      c,
      cacheKey("comet-assets", d.chainId, scopeOf(c), core),
      assets,
      "MEDIUM",
    );
    // Token metadata (decimals / symbol) of the base and collateral tokens (amount 0: metadata only).
    await Promise.allSettled(
      [base, ...assets].map((t) => c.asset(t, 0n, "supplied")),
    );
    return { assets: assets.length };
  }
  return {};
}
export function adapterFor(
  deployment: ProtocolDeployment,
): DefiProtocolAdapter {
  const id = deployment.adapter;
  return {
    id,
    version: ADAPTER_VERSION[id],
    deployments: () => deployments.filter((d) => d.adapter === id),
    getCoverage: (c) =>
      id === "morpho-blue" || id === "morpho-vault"
        ? {
            state: c.discoveryComplete ? "FULL_POSITION" : "PARTIAL_POSITION",
            reason: c.discoveryComplete ? "CHECKED" : "DISCOVERY_INCOMPLETE",
          }
        : id === "uniswap-v2"
          ? c.discoveryComplete
            ? { state: "FULL_POSITION", reason: "CHECKED" }
            : {
                state: "PARTIAL_POSITION",
                reason: c.refs?.length
                  ? "DISCOVERY_INCOMPLETE"
                  : "RECEIPT_DISCOVERY_ONLY",
              }
          : id === "uniswap-v3"
            ? deployment.variant === "pancake"
              ? {
                  state: "PARTIAL_POSITION",
                  reason: "STAKED_POSITIONS_NOT_CHECKED",
                }
              : { state: "FULL_POSITION", reason: "CHECKED" }
            : id === "curve"
              ? { state: "PARTIAL_POSITION", reason: "CURVE_REWARDS_NOT_EXACT" }
              : id === "balancer-v2"
                ? {
                    state: "PARTIAL_POSITION",
                    reason: "WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED",
                  }
                : id === "solidly-v2"
                  ? {
                      state: "PARTIAL_POSITION",
                      reason: "RECEIPT_DISCOVERY_ONLY",
                    }
                  : { state: "FULL_POSITION", reason: "CHECKED" },
    async discover(c) {
      assertContext(c, id);
      if (
        id === "aave-v3" ||
        id === "compound-iii" ||
        id === "lst-rate" ||
        id === "eigenlayer"
      )
        return [{ key: "account", discovery: "registry" }];
      if (id === "erc4626")
        return [
          {
            key: deployment.contracts.vault,
            contract: deployment.contracts.vault,
            discovery: "registry",
          },
        ];
      if (id === "lido")
        return [
          ...[deployment.contracts.steth, deployment.contracts.wsteth].map(
            (contract) => ({
              key: contract,
              contract,
              discovery: "registry" as const,
            }),
          ),
          ...(deployment.contracts.withdrawalQueue
            ? [{ key: "withdrawals", discovery: "registry" as const }]
            : []),
        ];
      if (RECEIPT_FAMILIES.has(id)) return heldRefs(c);
      if (
        (id === "morpho-blue" || id === "morpho-vault") &&
        (c.refs?.length ?? 0) > 16
      )
        return prefilterRegistry(c, id);
      if (id === "uniswap-v2") {
        const indexed = c.refs ?? [];
        const seen = new Set(indexed.map((r) => r.contract));
        return [
          ...indexed,
          ...heldRefs(c).filter((r) => !seen.has(r.contract)),
        ];
      }
      if (id === "uniswap-v3") {
        const n = uint(
          await c.read(deployment.contracts.manager, "balanceOf", [c.wallet]),
        );
        if (n > 100n) throw Error("NFT_ENUMERATION_LIMIT");
        // V1.14.1: every index in one request; ids keep the enumeration order (first failure in order wins).
        const ids = await Promise.all(
          Array.from({ length: Number(n) }, (_, i) =>
            settle(
              c.read(deployment.contracts.manager, "tokenOfOwnerByIndex", [
                c.wallet,
                BigInt(i),
              ]),
            ),
          ),
        );
        return ids.map((r) => {
          const tokenId = uint(valueOf(r)).toString();
          return {
            key: tokenId,
            tokenId,
            discovery: "enumeration" as const,
          };
        });
      }
      return c.refs ?? [];
    },
    async readPosition(ref, c) {
      assertContext(c, id);
      switch (id) {
        case "aave-v3":
          return aave(c);
        case "compound-iii":
          return compound(c);
        case "morpho-blue":
          return morpho(ref, c);
        case "morpho-vault":
        case "erc4626":
          return vault(ref, c);
        case "lido":
          return lido(ref, c);
        case "uniswap-v2":
          return v2(ref, c);
        case "uniswap-v3":
          return v3(ref, c);
        case "lst-rate":
          return lstRate(ref, c);
        case "eigenlayer":
          return eigenlayer(ref, c);
        case "curve":
          return curve(ref, c);
        case "balancer-v2":
          return balancerV2(ref, c);
        case "solidly-v2":
          return solidlyV2(ref, c);
      }
    },
  };
}
