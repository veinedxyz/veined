import type { Holding } from "../portfolio/model";
import type { DefiScan } from "./model";
import { economicAssets } from "./economic";
import { decimal, micros, sumUsd } from "./math";
import { freshPrice, usdValue } from "../data/core/price";
// Client-safe ownership graph. It uses data only; protocol ABIs/reader stay on the server.
export function portfolioTotals(holdings: Holding[], scan?: DefiScan) {
  const positions = [
    ...new Map((scan?.positions ?? []).map((p) => [p.id, p])).values(),
  ];
  const replaced = new Set(scan?.replacedWalletAssets ?? []);
  for (const p of positions)
    for (const id of p.representations) replaced.add(id);
  const wallet = holdings.filter(
    (h) =>
      !h.spam &&
      BigInt(h.balance) > 0n &&
      !replaced.has(h.chainId + ":" + h.address.toLowerCase()),
  );
  const debts = wallet.filter((h) => h.position?.role === "debt"),
    assets = wallet.filter((h) => h.position?.role !== "debt");
  const priceOf = (h: Holding) =>
    h.price
      ? usdValue(BigInt(h.balance), h.decimals, freshPrice(h.price))
      : h.usd === null
        ? null
        : Number.isFinite(h.usd) &&
            h.usd >= 0 &&
            h.usd <= Number.MAX_SAFE_INTEGER
          ? h.usd.toFixed(6)
          : null;
  const walletUsd = sumUsd(assets.map(priceOf)),
    defiUsd = sumUsd(positions.map((p) => p.grossAssetsUsd)),
    debtUsd = sumUsd([
      ...positions.map((p) => p.debtUsd),
      ...debts.map(priceOf),
    ]);
  const unpricedAssets =
    assets.filter((h) => priceOf(h) === null).length +
    positions
      .flatMap(economicAssets)
      .filter((a) => a.valueUsd === null && BigInt(a.rawAmount) > 0n).length;
  const unpricedDebt =
    debts.filter((h) => priceOf(h) === null).length +
    positions
      .flatMap((p) => p.borrowed)
      .filter((a) => a.valueUsd === null && BigInt(a.rawAmount) > 0n).length;
  // V1.14 value summary: claimable rewards and uncollected fees are shown beside the net, never inside it; a
  // derivatives notional is never an asset value; unchecked coverage is counted instead of being read as zero.
  const rewardsUsd = sumUsd(
      positions.flatMap((p) => p.rewards.map((r) => r.asset.valueUsd)),
    ),
    feesUsd = sumUsd(
      positions.flatMap((p) => (p.fees ?? []).map((a) => a.valueUsd)),
    ),
    uncheckedCoverage = (scan?.coverage ?? []).filter(
      (c) => c.state !== "FULL_POSITION",
    ).length;
  return {
    walletUsd,
    defiUsd,
    debtUsd,
    rewardsUsd,
    feesUsd,
    uncheckedCoverage,
    exposure: exposureGraph(positions),
    knownNetUsd: decimal(
      micros(walletUsd) + micros(defiUsd) - micros(debtUsd),
      6,
    ),
    unpricedAssets,
    unpricedDebt,
    partial:
      unpricedAssets > 0 ||
      unpricedDebt > 0 ||
      !scan ||
      scan.continuation.length > 0 ||
      scan.coverage.some((c) => c.state !== "FULL_POSITION"),
    wallet,
    positions,
    replaced: [...replaced],
  };
}
export function mergeDefi(previous: DefiScan, next: DefiScan): DefiScan {
  if (previous.wallet !== next.wallet) throw Error("WALLET_SCOPE_MISMATCH");
  const replaced = new Set(next.coverage.map((c) => c.deploymentId));
  const owners = {
    ...Object.fromEntries(
      Object.entries(previous.replacementOwners ?? {}).filter(
        ([id]) => !replaced.has(id),
      ),
    ),
    ...next.replacementOwners,
  };
  const owned = new Set(Object.values(previous.replacementOwners ?? {}).flat());
  return {
    ...next,
    positions: [
      ...previous.positions.filter((p) => !replaced.has(p.deploymentId)),
      ...next.positions,
    ],
    coverage: [
      ...previous.coverage.filter((c) => !replaced.has(c.deploymentId)),
      ...next.coverage,
    ],
    replacedWalletAssets: [
      ...new Set([
        ...Object.values(owners).flat(),
        ...previous.replacedWalletAssets.filter(
          (id) =>
            !owned.has(id) &&
            !previous.positions.some(
              (p) =>
                replaced.has(p.deploymentId) && p.representations.includes(id),
            ),
        ),
        ...next.replacedWalletAssets,
      ]),
    ],
    replacementOwners: owners,
    elapsedMs: previous.elapsedMs + next.elapsedMs,
    peakConcurrency: Math.max(previous.peakConcurrency, next.peakConcurrency),
    ...(previous.receipt || next.receipt
      ? { receipt: mergeReceipt(previous.receipt, next.receipt, replaced) }
      : {}),
  };
}
// Continuation rounds re-check some deployments: their latest outcome replaces the earlier one.
function mergeReceipt(
  a: DefiScan["receipt"],
  b: DefiScan["receipt"],
  replaced: Set<string>,
): NonNullable<DefiScan["receipt"]> {
  if (!a) return b!;
  if (!b) return a;
  const skipped = [
    ...a.skipped.filter((s) => !replaced.has(s.deploymentId)),
    ...b.skipped,
  ];
  const signals: Record<string, number> = { ...a.signals };
  for (const [k, v] of Object.entries(b.signals))
    signals[k] = Math.max(signals[k] ?? 0, v);
  return {
    catalogVersion: b.catalogVersion ?? a.catalogVersion,
    chainsConsidered: Math.max(a.chainsConsidered, b.chainsConsidered),
    chainsChecked: Math.max(a.chainsChecked, b.chainsChecked),
    funnel: {
      universeRows: b.funnel.universeRows ?? a.funnel.universeRows,
      chainRelevantRows:
        b.funnel.chainRelevantRows ?? a.funnel.chainRelevantRows,
      candidateDeployments: Math.max(
        a.funnel.candidateDeployments,
        b.funnel.candidateDeployments,
      ),
      adaptersRun: a.funnel.adaptersRun + b.funnel.adaptersRun,
    },
    signals,
    candidateProtocols: [
      ...new Set([...a.candidateProtocols, ...b.candidateProtocols]),
    ].slice(0, 500),
    skipped: skipped.slice(0, 1000),
    failed: a.failed + b.failed,
    checkedZero: a.checkedZero + b.checkedZero,
    nonzero: a.nonzero + b.nonzero,
    positions: a.positions + b.positions,
    unpriced: a.unpriced + b.unpriced,
    unpricedDebt: a.unpricedDebt + b.unpricedDebt,
    durationMs: a.durationMs + b.durationMs,
    rpcCalls: a.rpcCalls + b.rpcCalls,
    slowest:
      !a.slowest || (b.slowest && b.slowest.durationMs > a.slowest.durationMs)
        ? b.slowest
        : a.slowest,
    // V1.14.1 census and timing across continuation rounds (tiers: per-round candidate counts, maximum kept).
    ...(a.tiers || b.tiers
      ? {
          tiers: Object.fromEntries(
            [
              ...new Set([
                ...Object.keys(a.tiers ?? {}),
                ...Object.keys(b.tiers ?? {}),
              ]),
            ].map((k) => [k, Math.max(a.tiers?.[k] ?? 0, b.tiers?.[k] ?? 0)]),
          ),
        }
      : {}),
    ...(a.requests || b.requests
      ? {
          requests: Object.fromEntries(
            (
              [
                "http",
                "rpcItems",
                "multicallBatches",
                "retries",
                "cooldownSkips",
                "cacheHits",
                "pins",
                "pinVerifications",
              ] as const
            ).map((k) => [k, (a.requests?.[k] ?? 0) + (b.requests?.[k] ?? 0)]),
          ) as NonNullable<NonNullable<DefiScan["receipt"]>["requests"]>,
        }
      : {}),
    ...(a.timing || b.timing
      ? {
          timing: {
            firstResultMs:
              a.timing?.firstResultMs ?? b.timing?.firstResultMs ?? null,
            roundMs: (a.timing?.roundMs ?? 0) + (b.timing?.roundMs ?? 0),
          },
        }
      : {}),
  };
}

export interface ExposureNode {
  assetId: string;
  symbol: string;
  decimals: number;
  longRaw: string;
  shortRaw: string;
  longUsd: string;
  shortUsd: string;
  unpriced: number;
  decomposition: "DECOMPOSED" | "UNDERLYING_NOT_DECOMPOSED";
  positions: string[];
}
/** Exposure graph v2: economic assets (long) and debts (short) per exact asset id. Rewards, fees and notionals are
 * excluded; an asset that is itself a reviewed wrapper keeps its wrapper identity (UNDERLYING_NOT_DECOMPOSED). */
export function exposureGraph(positions: DefiScan["positions"]) {
  const nodes = new Map<
    string,
    ExposureNode & { long: bigint; short: bigint; lu: string[]; su: string[] }
  >();
  const add = (
    p: DefiScan["positions"][number],
    a: DefiScan["positions"][number]["underlying"][number],
    side: "long" | "short",
  ) => {
    const raw = BigInt(a.rawAmount);
    if (!raw) return;
    const n = nodes.get(a.assetId) ?? {
      assetId: a.assetId,
      symbol: a.symbol,
      decimals: a.decimals,
      longRaw: "0",
      shortRaw: "0",
      longUsd: "0.000000",
      shortUsd: "0.000000",
      unpriced: 0,
      decomposition: "DECOMPOSED" as const,
      positions: [],
      long: 0n,
      short: 0n,
      lu: [],
      su: [],
    };
    if (side === "long") {
      n.long += raw;
      n.lu.push(a.valueUsd ?? "0");
    } else {
      n.short += raw;
      n.su.push(a.valueUsd ?? "0");
    }
    if (a.valueUsd === null) n.unpriced++;
    if (
      p.warnings.includes("UNDERLYING_NOT_DECOMPOSED") &&
      (p.details.notDecomposed ?? "").split(", ").includes(a.symbol)
    )
      n.decomposition = "UNDERLYING_NOT_DECOMPOSED";
    if (!n.positions.includes(p.id)) n.positions.push(p.id);
    nodes.set(a.assetId, n);
  };
  for (const p of positions) {
    for (const a of economicAssets(p)) add(p, a, "long");
    for (const a of p.borrowed) add(p, a, "short");
  }
  return [...nodes.values()]
    .map(({ long, short, lu, su, ...n }) => ({
      ...n,
      longRaw: long.toString(),
      shortRaw: short.toString(),
      longUsd: sumUsd(lu),
      shortUsd: sumUsd(su),
    }))
    .sort(
      (a, b) =>
        Number(micros(b.longUsd) - micros(a.longUsd)) ||
        a.assetId.localeCompare(b.assetId),
    );
}
/** Leverage = gross / (gross - debt) only when both sides are fully priced and equity is positive. */
export function leverage(p: DefiScan["positions"][number]) {
  if (!p.borrowed.length) return null;
  if (
    economicAssets(p).some((a) => a.valueUsd === null) ||
    p.borrowed.some((a) => a.valueUsd === null)
  )
    return null;
  const gross = micros(p.grossAssetsUsd),
    debt = micros(p.debtUsd);
  if (gross <= debt || gross === 0n) return null;
  return decimal((gross * 1_000_000n) / (gross - debt), 6);
}
