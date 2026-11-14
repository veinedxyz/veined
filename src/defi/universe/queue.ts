import { publicText } from "./neutral";
import { interactionLikelihood, receiptLikelihood } from "./categories";
import type { CatalogIndex } from "./store";
import { linksFor } from "./coverage";
import type {
  CoverageStatus,
  ProductCategory,
  UniverseProtocol,
} from "./model";
// Global adapter queue: every active cataloged protocol with its coverage truth, likely adapter family, source
// status, blocker and a transparent priority score. Priority is planning context only; it never enables anything.
export interface QueueEntry {
  rank: number;
  protocolId: string;
  name: string;
  slug: string;
  category: string;
  productCategory: ProductCategory;
  chains: number;
  topChains: string[];
  evmChains: number;
  tvlUsd: number | null;
  coverage: CoverageStatus;
  coverageCounts: Partial<Record<CoverageStatus, number>>;
  existingAdapter: string[];
  likelyFamily: string;
  officialSource:
    | "PINNED_OFFICIAL_SOURCE"
    | "GITHUB_ORG_LISTED"
    | "NO_OFFICIAL_SOURCE_RECORDED";
  deploymentSource: "REVIEWED_DEPLOYMENTS" | "TVL_MODULE_CLUE" | "NONE";
  proof: "REAL_NONZERO_PROOF" | "FIXTURE_ONLY" | "NONE";
  priority: number;
  tier: "P0" | "P1" | "P2" | "P3" | "P4";
  blocker: string;
  discoveryCost: "LOW" | "MEDIUM" | "HIGH";
  securityComplexity: "LOW" | "MEDIUM" | "HIGH";
  factors: Record<string, number>;
}
// Fork parents whose position semantics Otherbridge reviewed (by DefiLlama id). A fork is never auto-supported; this
// only estimates reuse for planning.
const FORK_FAMILY: Record<string, string> = {
  "1599": "aave-v3-compatible",
  "111": "aave-v2-compatible",
  "114": "compound-v2-compatible",
  "2088": "compound-iii-compatible",
  "2197": "uniswap-v2-compatible",
  "119": "uniswap-v2-compatible",
  "194": "uniswap-v2-compatible",
  "2198": "uniswap-v3-compatible",
  "2769": "uniswap-v3-compatible",
  "3": "curve-compatible",
  "2611": "balancer-v2-compatible",
  "116": "balancer-v1-compatible",
  "1799": "solidly-compatible",
  "3302": "solidly-compatible",
  "3450": "solidly-compatible",
  "270": "liquity-compatible",
  "337": "gmx-v1-compatible",
  "4025": "morpho-blue-compatible",
  "182": "lst-exchange-rate",
};
const IMPLEMENTED_FORK_FAMILIES = new Set([
  "aave-v3-compatible",
  "compound-iii-compatible",
  "uniswap-v2-compatible",
  "uniswap-v3-compatible",
  "morpho-blue-compatible",
  "lst-exchange-rate",
]);
const CATEGORY_FAMILY: Record<ProductCategory, string> = {
  lending: "lending-protocol-specific",
  cdp: "cdp-protocol-specific",
  stablecoin: "stablecoin-wallet-asset",
  dex: "dex-family-unknown",
  "dex-aggregator": "no-position-expected",
  yield: "vault-erc4626-or-custom",
  farm: "farm-reviewed-deployments-only",
  "liquid-staking": "lst-exchange-rate",
  restaking: "restaking-protocol-specific",
  "liquid-restaking": "lrt-exchange-rate",
  derivatives: "perps-protocol-specific",
  options: "options-protocol-specific",
  prediction: "prediction-protocol-specific",
  rwa: "rwa-token-wallet-asset",
  insurance: "insurance-protocol-specific",
  "nft-finance": "nft-finance-protocol-specific",
  bridge: "no-active-position-model",
  cex: "no-onchain-user-position",
  chain: "no-onchain-user-position",
  launchpad: "no-position-expected",
  services: "no-position-expected",
  gaming: "no-position-expected",
  other: "unknown",
};
const COST: Record<ProductCategory, QueueEntry["discoveryCost"]> = {
  lending: "LOW",
  cdp: "MEDIUM",
  stablecoin: "LOW",
  dex: "MEDIUM",
  "dex-aggregator": "LOW",
  yield: "MEDIUM",
  farm: "HIGH",
  "liquid-staking": "LOW",
  restaking: "MEDIUM",
  "liquid-restaking": "LOW",
  derivatives: "HIGH",
  options: "HIGH",
  prediction: "HIGH",
  rwa: "LOW",
  insurance: "HIGH",
  "nft-finance": "HIGH",
  bridge: "HIGH",
  cex: "HIGH",
  chain: "HIGH",
  launchpad: "MEDIUM",
  services: "LOW",
  gaming: "HIGH",
  other: "HIGH",
};
const SECURITY: Record<ProductCategory, QueueEntry["securityComplexity"]> = {
  lending: "MEDIUM",
  cdp: "MEDIUM",
  stablecoin: "LOW",
  dex: "MEDIUM",
  "dex-aggregator": "LOW",
  yield: "MEDIUM",
  farm: "HIGH",
  "liquid-staking": "LOW",
  restaking: "HIGH",
  "liquid-restaking": "MEDIUM",
  derivatives: "HIGH",
  options: "HIGH",
  prediction: "HIGH",
  rwa: "MEDIUM",
  insurance: "HIGH",
  "nft-finance": "HIGH",
  bridge: "HIGH",
  cex: "HIGH",
  chain: "HIGH",
  launchpad: "MEDIUM",
  services: "LOW",
  gaming: "HIGH",
  other: "HIGH",
};
const level = { LOW: 1, MEDIUM: 0.6, HIGH: 0.2 } as const;
export function buildQueue(
  index: CatalogIndex,
  proofs: ReadonlySet<string> = new Set(),
  fixtures: ReadonlySet<string> = new Set(),
): QueueEntry[] {
  const entries: QueueEntry[] = [];
  for (const p of index.universe.protocols) {
    if (p.status !== "ACTIVE") continue;
    const rows = index.rowsByProtocol.get(p.id) ?? [];
    const summary = index.summaries.get(p.id);
    const reviewed = linksFor(p).links;
    const chains = rows
      .map((r) => index.chains.get(r.chainKey))
      .filter((c) => !!c);
    const evm = chains.filter((c) => c!.vm === "EVM");
    const fork = p.forkedFrom.map((id) => FORK_FAMILY[id]).find(Boolean);
    const family = reviewed.length
      ? reviewed.map((l) => l.protocolIds.join("+")).join(", ")
      : fork
        ? `${fork} (fork; exact deployment review required)`
        : CATEGORY_FAMILY[p.productCategory] +
          (rows.length && !evm.length ? " (non-EVM)" : "");
    const tvl = p.tvlUsd ?? 0;
    const rpcTvl = rows.reduce(
      (s, r) =>
        s +
        (index.chains.get(r.chainKey)?.capabilities.includes("RPC_READ")
          ? (r.tvlUsd ?? 0)
          : 0),
      0,
    );
    const rowTvl = rows.reduce((s, r) => s + (r.tvlUsd ?? 0), 0);
    const officialSource: QueueEntry["officialSource"] = reviewed.length
      ? "PINNED_OFFICIAL_SOURCE"
      : p.github.length
        ? "GITHUB_ORG_LISTED"
        : "NO_OFFICIAL_SOURCE_RECORDED";
    const deploymentSource: QueueEntry["deploymentSource"] = reviewed.length
      ? "REVIEWED_DEPLOYMENTS"
      : p.module
        ? "TVL_MODULE_CLUE"
        : "NONE";
    const cost =
      fork && IMPLEMENTED_FORK_FAMILIES.has(fork)
        ? "LOW"
        : COST[p.productCategory];
    const security = SECURITY[p.productCategory];
    const factors = {
      tvl: Math.min(1, Math.log10(tvl + 1) / 11),
      chains: Math.min(1, Math.log10(rows.length + 1) / Math.log10(51)),
      interaction: interactionLikelihood[p.productCategory],
      receipt: receiptLikelihood[p.productCategory],
      reuse: reviewed.length
        ? 1
        : fork && IMPLEMENTED_FORK_FAMILIES.has(fork)
          ? 0.8
          : fork
            ? 0.5
            : 0,
      source:
        officialSource === "PINNED_OFFICIAL_SOURCE"
          ? 1
          : officialSource === "GITHUB_ORG_LISTED"
            ? 0.5
            : 0,
      chainSupport:
        rowTvl > 0
          ? rpcTvl / rowTvl
          : evm.length && rows.length
            ? evm.length / rows.length
            : 0,
      discoveryCost: level[cost],
      securityComplexity: level[security],
    };
    const priority =
      Math.round(
        (factors.tvl * 35 +
          factors.chains * 10 +
          factors.interaction * 15 +
          factors.receipt * 10 +
          factors.reuse * 10 +
          factors.source * 5 +
          factors.chainSupport * 10 +
          factors.discoveryCost * 2.5 +
          factors.securityComplexity * 2.5) *
          1000,
      ) / 1000;
    const headline = summary?.headline ?? "CATALOG_ONLY";
    const allFull =
      !!summary &&
      Object.keys(summary.counts).every((k) => k === "FULL_POSITION");
    const blocker = allFull
      ? "NONE"
      : reviewed.length
        ? headline === "FULL_POSITION" || headline === "PARTIAL_POSITION"
          ? (reviewed.find((l) => l.status !== "FULL_POSITION")?.reason ??
            "REVIEWED_DEPLOYMENTS_ON_SOME_CHAINS_ONLY")
          : "NO_REVIEWED_DEPLOYMENT_ON_LISTED_CHAINS"
        : p.mapping.status === "UNMAPPED"
          ? "IDENTITY_" + (p.mapping.reason ?? "REVIEW")
          : p.productCategory === "cex" || p.productCategory === "chain"
            ? "NO_ONCHAIN_USER_POSITION"
            : !rows.length
              ? "NO_CHAIN_RELATION_IN_SOURCE"
              : !evm.length
                ? "UNSUPPORTED_VM"
                : "NO_REVIEWED_DEPLOYMENT_SOURCE";
    entries.push({
      rank: 0,
      protocolId: p.id,
      name: p.name,
      slug: p.slug,
      category: p.category,
      productCategory: p.productCategory,
      chains: rows.length,
      topChains: [...rows]
        .sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1))
        .slice(0, 3)
        .map((r) => index.chains.get(r.chainKey)?.name ?? r.rawChain),
      evmChains: evm.length,
      tvlUsd: p.tvlUsd,
      coverage: headline,
      coverageCounts: summary?.counts ?? {},
      existingAdapter: reviewed.map((l) => `${l.product} (${l.attribution})`),
      likelyFamily: family,
      officialSource,
      deploymentSource,
      proof: reviewed.some((l) => l.protocolIds.some((id) => proofs.has(id)))
        ? "REAL_NONZERO_PROOF"
        : reviewed.some((l) => l.protocolIds.some((id) => fixtures.has(id)))
          ? "FIXTURE_ONLY"
          : "NONE",
      priority,
      tier:
        priority >= 70
          ? "P0"
          : priority >= 55
            ? "P1"
            : priority >= 40
              ? "P2"
              : priority >= 25
                ? "P3"
                : "P4",
      blocker,
      discoveryCost: cost,
      securityComplexity: security,
      factors: Object.fromEntries(
        Object.entries(factors).map(([k, v]) => [
          k,
          Math.round(v * 1000) / 1000,
        ]),
      ),
    });
  }
  entries.sort(
    (a, b) =>
      b.priority - a.priority ||
      (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) ||
      a.protocolId.localeCompare(b.protocolId),
  );
  entries.forEach((e, i) => (e.rank = i + 1));
  return entries;
}
const money = (v: number | null) =>
  v === null
    ? "—"
    : v >= 1e9
      ? `$${(v / 1e9).toFixed(2)}B`
      : v >= 1e6
        ? `$${(v / 1e6).toFixed(2)}M`
        : v >= 1e3
          ? `$${(v / 1e3).toFixed(1)}K`
          : `$${v.toFixed(0)}`;
const cell = (v: string) =>
  publicText(v)
    .replace(/[|\\`*_<>[\]]/g, (c) => "\\" + c)
    .replace(/\n/g, " ");
export function queueMarkdown(queue: QueueEntry[], index: CatalogIndex) {
  const tiers = queue.reduce<Record<string, number>>(
    (a, e) => ((a[e.tier] = (a[e.tier] ?? 0) + 1), a),
    {},
  );
  const blockers = queue.reduce<Record<string, number>>(
    (a, e) => ((a[e.blocker] = (a[e.blocker] ?? 0) + 1), a),
    {},
  );
  return [
    "# DeFi global adapter queue",
    "",
    `Catalog \`${index.universe.syncId}\` (sha256 \`${index.sha256}\`). Every ACTIVE cataloged protocol (${queue.length}) appears below with its coverage truth.`,
    "Machine queue: `content/defi-universe/adapter-queue.generated.json` (all fields, including the priority factors).",
    "",
    "Priority (0–100) = 35·TVL(log) + 10·chain count(log) + 15·wallet-interaction likelihood + 10·receipt-token likelihood + 10·adapter reuse + 5·official-source quality + 10·share of TVL on Otherbridge RPC-read chains + 2.5·(low discovery cost) + 2.5·(low security complexity). TVL is DefiLlama protocol context, never a wallet value. Forks are never auto-supported.",
    "",
    "## Tiers",
    "",
    "| Tier | Protocols |",
    "| --- | ---: |",
    ...["P0", "P1", "P2", "P3", "P4"].map((t) => `| ${t} | ${tiers[t] ?? 0} |`),
    "",
    "## Blockers",
    "",
    "| Blocker | Protocols |",
    "| --- | ---: |",
    ...Object.entries(blockers)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Queue",
    "",
    "| # | Protocol | Category | Chains (EVM) | TVL context | Coverage | Existing adapter | Likely family | Official source | Deployment source | Proof | Priority | Tier | Blocker | Discovery | Security |",
    "| ---: | --- | --- | ---: | ---: | --- | --- | --- | --- | --- | --- | ---: | --- | --- | --- | --- |",
    ...queue.map(
      (e) =>
        `| ${e.rank} | ${cell(e.name)} \`${e.protocolId}\` | ${cell(e.category)} | ${e.chains} (${e.evmChains}) | ${money(e.tvlUsd)} | ${e.coverage} | ${cell(e.existingAdapter.join("; ") || "—")} | ${cell(e.likelyFamily)} | ${e.officialSource} | ${e.deploymentSource} | ${e.proof} | ${e.priority.toFixed(1)} | ${e.tier} | ${e.blocker} | ${e.discoveryCost} | ${e.securityComplexity} |`,
    ),
    "",
  ].join("\n");
}
export const protocolLabel = (p: UniverseProtocol) => `${p.name} (${p.id})`;
