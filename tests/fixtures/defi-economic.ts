import type {
  DefiPosition,
  DeploymentCoverage,
  PositionAsset,
} from "../../src/defi/model";
// Economic projection of a DeFi scan (SYNTHETIC_TEST_ONLY helper): every value-bearing field of each position and the
// coverage outcome of each deployment, without scan ids, timings, observation times or per-read evidence records
// (whose granularity is a transport detail: one record per aggregate instead of one per call).
const asset = (a: PositionAsset) => [
  a.assetId,
  a.rawAmount,
  a.decimals,
  a.symbol,
  a.role,
  a.price?.priceUsd ?? null,
  a.valueUsd,
];
export function economicView(
  positions: DefiPosition[],
  coverage: DeploymentCoverage[],
) {
  return {
    positions: [...positions]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((p) => ({
        id: p.id,
        deploymentId: p.deploymentId,
        positionKey: p.positionKey,
        adapterVersion: p.adapterVersion,
        sourceBlock: p.sourceBlock,
        sourceBlockHash: p.sourceBlockHash,
        supplied: p.supplied.map(asset),
        collateral: p.collateral.map(asset),
        borrowed: p.borrowed.map(asset),
        underlying: p.underlying.map(asset),
        fees: (p.fees ?? []).map(asset),
        rewards: p.rewards.map((r) => [
          asset(r.asset),
          r.rawClaimable,
          r.sourceContract,
          r.confidence,
        ]),
        rewardsStatus: p.rewardsStatus,
        representations: p.representations,
        risk: p.risk,
        grossAssetsUsd: p.grossAssetsUsd,
        debtUsd: p.debtUsd,
        knownNetUsd: p.knownNetUsd,
        confidence: p.confidence,
        coverage: p.coverage,
        warnings: p.warnings,
        details: p.details,
      })),
    coverage: [...coverage]
      .sort((a, b) => (a.deploymentId < b.deploymentId ? -1 : 1))
      .map((c) => ({
        deploymentId: c.deploymentId,
        adapterVersion: c.adapterVersion,
        state: c.state,
        result: c.result,
        reason: c.reason,
        scanResult: c.scanResult ?? null,
        sourceBlock: c.sourceBlock,
      })),
  };
}
