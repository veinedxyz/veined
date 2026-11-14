import { createHash } from "node:crypto";
import type { PortfolioResult } from "../../src/portfolio/model";
import { detectedValue } from "../../src/portfolio/value";
// V1.14.2 economic oracle digest (shared by scripts/wallet-perf.ts and the V1.14.2 tests). Every value-bearing field
// of a final wallet result in canonical order; timing, revision and cursor bytes are excluded.
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
/** Canonical economic digest of a final wallet result: every value-bearing field, no timing / revision fields. */
export function walletEconomics(result: PortfolioResult) {
  const holdings = [...result.holdings]
    .sort((a, b) =>
      a.chainId === b.chainId
        ? a.address.toLowerCase() < b.address.toLowerCase()
          ? -1
          : 1
        : a.chainId < b.chainId
          ? -1
          : 1,
    )
    .map((h) => [
      h.chainId,
      h.address.toLowerCase(),
      h.symbol,
      h.name,
      h.decimals,
      h.balance,
      h.native,
      h.spam,
      h.suspicious,
      h.usd,
      h.discovery ?? null,
      h.observedBlock ?? null,
      h.metadataVerified ?? null,
      h.routable ?? null,
      h.position
        ? [h.position.protocol, h.position.category, h.position.role]
        : null,
      h.price ? [h.price.priceUsd, h.price.method, h.price.confidence] : null,
      h.logo,
    ]);
  const coverage = [...result.coverage]
    .sort((a, b) => (a.chainId < b.chainId ? -1 : 1))
    .map((c) => [
      c.chainId,
      c.state,
      c.tier,
      c.native,
      c.tokens,
      c.reason,
      c.historicalComplete,
      c.indexedFromBlock,
      c.indexedThroughBlock,
      c.headBlock,
      c.observedBlock,
    ]);
  const defi = [...(result.defiCoverage ?? [])]
    .sort((a, b) =>
      `${a.chainId}:${a.protocol}:${a.category}` <
      `${b.chainId}:${b.protocol}:${b.category}`
        ? -1
        : 1,
    )
    .map((d) => [
      d.chainId,
      d.protocol,
      d.category,
      d.state,
      d.checked,
      d.planned,
      d.observedBlock,
    ]);
  const clean = result.holdings.filter(
    (h) => !h.spam && BigInt(h.balance) > 0n,
  );
  const allocation: Record<string, number> = {};
  for (const h of clean)
    allocation[h.chainId] =
      Math.round(
        ((allocation[h.chainId] ?? 0) +
          (h.position?.role === "debt" ? 0 : (h.usd ?? 0))) *
          1e6,
      ) / 1e6;
  const totalKnownUsd = Math.round(detectedValue(result.holdings) * 1e6) / 1e6;
  const economic = {
    state: result.state,
    dataPlane: result.dataPlane,
    summary: result.coverageSummary,
    continuation: result.continuation === null ? null : "PRESENT",
    totalKnownUsd,
    allocation,
    assetCount: clean.length,
    unpriced: clean.filter((h) => h.usd === null).length,
    holdings,
    coverage,
    defi,
  };
  return {
    digest: sha(JSON.stringify(economic)),
    holdingsDigest: sha(JSON.stringify(holdings)),
    coverageDigest: sha(JSON.stringify(coverage)),
    defiDigest: sha(JSON.stringify(defi)),
    totalKnownUsd,
    assetCount: clean.length,
    summary: result.coverageSummary,
    economic,
  };
}
