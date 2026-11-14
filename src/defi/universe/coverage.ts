import { NO_USER_POSITION_CATEGORIES } from "./categories";
import { REVIEWED_LINKS, type ReviewedLink } from "./adapter-map";
import {
  coverageRank,
  type CoverageRow,
  type CoverageStatus,
  type Universe,
  type UniverseChain,
  type UniverseProtocol,
  type VmFamily,
} from "./model";
// Catalog coverage keyed by protocol + chain + product/version + adapterVersion. Derived only from the reviewed link
// table and reviewed deployments (code), never from catalog metadata: a catalog change cannot enable an adapter.
export interface DeploymentRef {
  id: string;
  protocolId: string;
  chainId: string;
}
/** VM families with a reviewed DeFi position engine. Non-EVM engines are explicit boundaries (engines.ts). */
export const DEFI_ENGINE_VMS: ReadonlySet<VmFamily> = new Set(["EVM"]);
export const UNSPECIFIED_CHAIN = "chain:unspecified";
export function linksFor(
  p: Pick<UniverseProtocol, "llamaId" | "slug">,
  links = REVIEWED_LINKS,
) {
  const byId = links.filter((l) => l.llamaId === p.llamaId);
  return {
    links: byId.filter((l) => l.slug === p.slug),
    // Same id, different slug: the upstream identity changed after review. Never follow it automatically.
    drift: byId.some((l) => l.slug !== p.slug),
    // Same slug claimed by a different id: a clone or rename takeover.
    takeover: links.some((l) => l.slug === p.slug && l.llamaId !== p.llamaId),
  };
}
function linkDeployments(
  link: ReviewedLink,
  chain: UniverseChain,
  deployments: DeploymentRef[],
) {
  if (chain.vm !== "EVM" || !chain.chainId) return [];
  return deployments
    .filter(
      (d) =>
        link.protocolIds.includes(d.protocolId) &&
        d.chainId === chain.chainId &&
        (!link.deploymentIds || link.deploymentIds.includes(d.id)),
    )
    .map((d) => d.id)
    .sort();
}
export function computeCoverage(
  universe: Pick<Universe, "protocols" | "chains" | "rows">,
  deployments: DeploymentRef[],
  links = REVIEWED_LINKS,
): CoverageRow[] {
  const chains = new Map(universe.chains.map((c) => [c.key, c]));
  const rowsByProtocol = new Map<string, string[]>();
  for (const r of universe.rows)
    rowsByProtocol.set(r.protocolId, [
      ...(rowsByProtocol.get(r.protocolId) ?? []),
      r.chainKey,
    ]);
  const out: CoverageRow[] = [];
  for (const p of universe.protocols) {
    const { links: reviewed, drift, takeover } = linksFor(p, links);
    const keys = [...new Set(rowsByProtocol.get(p.id) ?? [])];
    const products = reviewed.length
      ? reviewed.map((l) => ({
          product: l.product,
          version: l.version,
          adapterVersion: l.adapterVersion,
          link: l,
        }))
      : [
          {
            product: p.name,
            version: p.version,
            adapterVersion: null,
            link: undefined,
          },
        ];
    for (const key of keys.length ? keys : [UNSPECIFIED_CHAIN]) {
      const chain = chains.get(key);
      for (const prod of products) {
        const row = (
          status: CoverageStatus,
          reason: string,
          deps: string[] = [],
        ): CoverageRow => ({
          protocolId: p.id,
          chainKey: key,
          product: prod.product,
          version: prod.version,
          adapterVersion: prod.adapterVersion,
          status,
          reason,
          deployments: deps,
        });
        if (drift || takeover)
          out.push(
            row(
              "NEEDS_REVIEW",
              drift
                ? "REVIEWED_IDENTITY_CHANGED"
                : "REVIEWED_SLUG_CLAIMED_BY_OTHER_ID",
            ),
          );
        else if (p.mapping.status === "UNMAPPED")
          out.push(
            row("NEEDS_REVIEW", p.mapping.reason ?? "IDENTITY_REVIEW_REQUIRED"),
          );
        else if (!chain)
          out.push(
            row(
              p.status === "ACTIVE" ? "CATALOG_ONLY" : "DEPRECATED",
              "NO_CHAIN_RELATION_IN_SOURCE",
            ),
          );
        else if (
          chain.mapping.status === "UNMAPPED" &&
          chain.mapping.reason !== "METADATA_ONLY" &&
          chain.mapping.reason !== "UNKNOWN_CHAIN_ID"
        )
          out.push(
            row("NEEDS_REVIEW", "CHAIN_" + (chain.mapping.reason ?? "REVIEW")),
          );
        else if (prod.link) {
          const deps = linkDeployments(prod.link, chain, deployments);
          if (!DEFI_ENGINE_VMS.has(chain.vm))
            out.push(row("UNSUPPORTED", "UNSUPPORTED_VM"));
          else if (deps.length)
            out.push(
              row(
                prod.link.attribution === "PRODUCT_FAMILY" &&
                  prod.link.status === "FULL_POSITION"
                  ? "PARTIAL_POSITION"
                  : prod.link.status,
                prod.link.reason,
                deps,
              ),
            );
          else
            out.push(
              row(
                "NOT_CHECKED",
                chain.chainId
                  ? "NO_REVIEWED_DEPLOYMENT_ON_CHAIN"
                  : "CHAIN_ID_UNKNOWN",
              ),
            );
        } else if (p.status !== "ACTIVE")
          out.push(row("DEPRECATED", "PROTOCOL_" + p.status));
        else if (NO_USER_POSITION_CATEGORIES.has(p.productCategory))
          out.push(row("UNSUPPORTED", "NO_ONCHAIN_USER_POSITION"));
        else if (!DEFI_ENGINE_VMS.has(chain.vm))
          out.push(row("UNSUPPORTED", "UNSUPPORTED_VM"));
        else out.push(row("CATALOG_ONLY", "POSITION_ADAPTER_NOT_IMPLEMENTED"));
      }
    }
  }
  return out;
}
export interface ProtocolCoverageSummary {
  headline: CoverageStatus;
  counts: Partial<Record<CoverageStatus, number>>;
  chains: number;
}
export function summarize(
  rows: CoverageRow[],
): Map<string, ProtocolCoverageSummary> {
  const out = new Map<string, ProtocolCoverageSummary>(),
    chains = new Map<string, Set<string>>();
  for (const r of rows) {
    let s = out.get(r.protocolId);
    if (!s) {
      s = { headline: r.status, counts: {}, chains: 0 };
      out.set(r.protocolId, s);
    }
    s.counts[r.status] = (s.counts[r.status] ?? 0) + 1;
    if (coverageRank[r.status] > coverageRank[s.headline])
      s.headline = r.status;
    if (r.chainKey !== UNSPECIFIED_CHAIN)
      chains.set(
        r.protocolId,
        (chains.get(r.protocolId) ?? new Set()).add(r.chainKey),
      );
  }
  for (const [id, s] of out) s.chains = chains.get(id)?.size ?? 0;
  return out;
}
export function coverageTotals(rows: CoverageRow[]) {
  const totals: Partial<Record<CoverageStatus, number>> = {};
  for (const r of rows) totals[r.status] = (totals[r.status] ?? 0) + 1;
  return totals;
}
