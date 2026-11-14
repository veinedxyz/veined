import { encodeAbiParameters, keccak256 } from "viem";
import { deployments } from "../../src/defi/registry";
import type { AdapterContext } from "../../src/defi/adapters";
import { adapterFor } from "../../src/defi/adapters";
import { usdValue } from "../../src/data/core/price";
import type {
  AdapterType,
  DefiScan,
  DefiPosition,
  DeploymentCoverage,
  PositionAsset,
  PositionRef,
} from "../../src/defi/model";
import { WAD } from "../../src/defi/math";
export const defiWallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
export const loan = "0x1111111111111111111111111111111111111111",
  collateral = "0x2222222222222222222222222222222222222222",
  oracle = "0x3333333333333333333333333333333333333333",
  pair = "0x4444444444444444444444444444444444444444",
  vault = "0x5555555555555555555555555555555555555555";
export const families: AdapterType[] = [
  "aave-v3",
  "compound-iii",
  "morpho-blue",
  "morpho-vault",
  "lido",
  "erc4626",
  "uniswap-v2",
  "uniswap-v3",
];
export function adapterFixture(
  id: AdapterType,
  zero = false,
  unpriced = false,
) {
  const deployment = deployments.find(
    (d) => d.adapter === id && d.chainId === "1",
  )!;
  const params = [
    loan,
    collateral,
    oracle,
    (deployment.contracts.irm ?? loan) as `0x${string}`,
    (86n * WAD) / 100n,
  ] as const;
  const marketId = keccak256(
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
  const reserve =
    deployment.assets?.find((a) => a.symbol === "USDC") ??
    deployment.assets?.[0];
  const now = Date.now();
  const refs: PositionRef[] =
    id === "morpho-blue"
      ? [{ key: marketId, marketId, discovery: "event-index" }]
      : id === "morpho-vault"
        ? [{ key: vault, contract: vault, discovery: "event-index" }]
        : id === "uniswap-v2"
          ? [{ key: pair, contract: pair, discovery: "event-index" }]
          : [];
  const ctx: AdapterContext = {
    deployment,
    wallet: defiWallet,
    pin: {
      number: 12345n,
      hash: ("0x" + "ab".repeat(32)) as `0x${string}`,
      timestamp: BigInt(Math.floor(now / 1000)),
      observedAt: now,
      endpointId: "synthetic",
      endpointGroup: "SYNTHETIC_FIXTURE",
    },
    signal: new AbortController().signal,
    evidence: [
      {
        kind: "contract-view",
        source: "SYNTHETIC_FIXTURE_ONLY",
        blockNumber: "12345",
        blockHash: "0x" + "ab".repeat(32),
        observedAt: now,
      },
    ],
    calls: 0,
    errors: 0,
    batches: 0,
    fallbacks: 0,
    refs,
    discoveryComplete: true,
    trustedOracles: new Set([oracle]),
    curatedVaults: new Set(),
    async code() {
      ctx.calls++;
      return "0x6000";
    },
    async asset(target, raw, role, metadata) {
      const decimals =
          metadata?.decimals ??
          (target === loan || target === reserve?.underlying ? 6 : 18),
        symbol =
          metadata?.symbol ??
          (target === vault || target === deployment.contracts.vault
            ? "SHARE"
            : decimals === 6
              ? "USDC"
              : "WETH"),
        price = unpriced ? null : decimals === 6 ? "1" : "2000";
      return {
        assetId: deployment.chainId + ":" + target,
        chainId: deployment.chainId,
        contract: target,
        symbol,
        decimals,
        rawAmount: raw.toString(),
        role,
        price: {
          priceUsd: price,
          observedAt: now,
          method: "synthetic-fixture",
          confidence: price ? "verified" : "unknown",
        },
        valueUsd: usdValue(raw, decimals, price),
      } as PositionAsset;
    },
    async read(target, name, args = []) {
      ctx.calls++;
      const z = zero ? 0n : 1n;
      switch (name) {
        case "getPool":
          return deployment.contracts.pool;
        case "getPoolDataProvider":
          return deployment.contracts.provider;
        case "getUserAccountData":
          return zero
            ? [0n, 0n, 0n, 8000n, 7500n, 0n]
            : [2000n, 100n, 0n, 8000n, 7500n, 2n * WAD];
        case "getAllReservesTokens":
          return [
            { symbol: reserve!.symbol, tokenAddress: reserve!.underlying },
          ];
        case "getUserReserveData":
          return [
            1000n * 1000000n * z,
            0n,
            100n * 1000000n * z,
            0n,
            0n,
            0n,
            0n,
            0n,
            true,
          ];
        case "getReserveTokensAddresses":
          return [reserve!.receipt, "0x" + "0".repeat(40), reserve!.debt];
        case "getReserveConfigurationData":
          return [
            BigInt(reserve!.decimals),
            7500n,
            8000n,
            10500n,
            0n,
            true,
            true,
            true,
            true,
            false,
          ];
        case "getAllUserRewards":
          return [[loan], [10n * 1000000n * z]];
        case "baseToken":
          return loan;
        case "balanceOf":
          // V1.14 exact V2 burn reads the pair's token balances (synced pair: balances equal reserves).
          if (id === "uniswap-v2" && args[0] === pair)
            return target === loan ? 1000n * 1000000n : 10n * WAD;
          return id === "uniswap-v3"
            ? z
            : id === "compound-iii"
              ? 100n * 1000000n * z
              : 10n * WAD * z;
        case "borrowBalanceOf":
          return 20n * 1000000n * z;
        case "numAssets":
          return 1;
        case "getAssetInfo":
          return {
            offset: 0,
            asset: collateral,
            priceFeed: oracle,
            scale: WAD,
            borrowCollateralFactor: (8n * WAD) / 10n,
            liquidateCollateralFactor: (9n * WAD) / 10n,
            liquidationFactor: WAD,
            supplyCap: 100n * WAD,
          };
        case "collateralBalanceOf":
          return 2n * WAD * z;
        case "isBorrowCollateralized":
          return true;
        case "isLiquidatable":
          return false;
        case "idToMarketParams":
          return params;
        case "position":
          return [200n * 10n ** 12n * z, 50n * 10n ** 12n * z, 1n * WAD * z];
        case "market":
          return [
            1000n * 1000000n,
            1000n * 10n ** 12n,
            500n * 1000000n,
            500n * 10n ** 12n,
            ctx.pin.timestamp - 3600n,
            (1n * WAD) / 10n,
          ];
        case "borrowRateView":
          return 1000000000n;
        case "feeRecipient":
          return collateral;
        case "price":
          return 2000n * 10n ** 24n;
        case "isMetaMorpho":
          return true;
        case "asset":
          return loan;
        case "convertToAssets":
          return 11n * 1000000n * z;
        case "decimals":
          return 18;
        case "symbol":
          return "SHARE";
        case "getStETHByWstETH":
          return (BigInt(args[0] as bigint) * 12n) / 10n;
        case "token0":
          return loan;
        case "token1":
          return collateral;
        case "factory":
          return deployment.contracts.factory;
        case "getPair":
          return pair;
        case "getReserves":
          return [1000n * 1000000n, 10n * WAD, 0];
        case "totalSupply":
          return 100n * WAD;
        case "tokenOfOwnerByIndex":
          return 42n;
        case "ownerOf":
          return defiWallet;
        case "positions":
          return [
            0n,
            loan,
            loan,
            collateral,
            3000,
            -60,
            60,
            10n ** 12n * z,
            0n,
            0n,
            0n,
            0n,
          ];
        case "poolFor":
          return pair;
        case "slot0":
          return [2n ** 96n, 0, 0, 0, 0, 0, true];
        case "fee":
          return 3000;
        case "tickSpacing":
          return 60;
        case "feeTo":
          return "0x" + "0".repeat(40);
        case "kLast":
          return 0n;
        case "feeGrowthGlobal0X128":
          // 1 USDC of fee growth per 1e12 liquidity inside the range since the last checkpoint.
          return (2n ** 128n / 10n ** 12n) * 10n ** 6n * z;
        case "feeGrowthGlobal1X128":
          return 0n;
        case "ticks":
          return [0n, 0n, 0n, 0n, 0n, 0n, 0, true];
        case "getWithdrawalRequests":
          return [];
        default:
          throw Error("UNEXPECTED_READ");
      }
    },
  };
  return { ctx, refs, marketId, reserve };
}
export async function defiFixture(wallet = defiWallet): Promise<DefiScan> {
  const positions: DefiPosition[] = [],
    coverage: DeploymentCoverage[] = [];
  for (const id of families) {
    const { ctx } = adapterFixture(id);
    ctx.wallet = wallet;
    const a = adapterFor(ctx.deployment);
    for (const ref of await a.discover(ctx)) {
      const p = await a.readPosition(ref, ctx);
      if (p) positions.push(p);
    }
    coverage.push({
      deploymentId: ctx.deployment.id,
      protocolId: ctx.deployment.protocolId,
      protocolName: ctx.deployment.name,
      chainId: ctx.deployment.chainId,
      adapterVersion: "1.0.0" as const,
      state: a.getCoverage(ctx).state,
      result: "NONZERO" as const,
      reason: "SYNTHETIC_FIXTURE",
      sourceBlock: "12345",
      sourceBlockHash: ctx.pin.hash,
      observedAt: ctx.pin.observedAt,
      calls: ctx.calls,
      batches: 0,
      fallbacks: 0,
      errors: 0,
      durationMs: 1,
    });
  }
  return {
    version: 2,
    wallet,
    scanId: "synthetic-fixture",
    observedAt: Date.now(),
    positions,
    coverage,
    replacedWalletAssets: positions.flatMap((p) => p.representations),
    replacementOwners: Object.fromEntries(
      coverage.map((c) => [
        c.deploymentId,
        positions
          .filter((p) => p.deploymentId === c.deploymentId)
          .flatMap((p) => p.representations),
      ]),
    ),
    continuation: [],
    nonEvm: "NOT_CHECKED",
    elapsedMs: 10,
    peakConcurrency: 3,
  };
}
