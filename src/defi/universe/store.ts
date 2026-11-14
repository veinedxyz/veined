import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deployments } from "../registry";
import { parseUniverse } from "./io";
import {
  computeCoverage,
  linksFor,
  summarize,
  UNSPECIFIED_CHAIN,
  type ProtocolCoverageSummary,
} from "./coverage";
import {
  chainCapabilities,
  defaultRegistries,
  type CapabilityRegistries,
} from "./capabilities";
import {
  CHAIN_CAPABILITIES,
  COVERAGE_STATUSES,
  PRODUCT_CATEGORIES,
  VM_FAMILIES,
  type ChainCapability,
  type CoverageRow,
  type CoverageStatus,
  type ProductCategory,
  type Universe,
  type UniverseChain,
  type UniverseProtocol,
  type VmFamily,
} from "./model";
// Server-only catalog index over the accepted last-good universe. Wallet requests never fetch upstream catalogs; the
// browser only ever receives bounded pages of this index.
export interface CatalogIndex {
  universe: Universe;
  sha256: string;
  loadedAt: number;
  coverage: CoverageRow[];
  summaries: Map<string, ProtocolCoverageSummary>;
  coverageByProtocol: Map<string, CoverageRow[]>;
  chains: Map<string, UniverseChain>;
  protocols: Map<string, UniverseProtocol>;
  bySlug: Map<string, UniverseProtocol>;
  rowsByProtocol: Map<string, Universe["rows"]>;
  protocolsByChain: Map<string, Set<string>>;
  hay: Map<string, string>;
  chainHay: Map<string, string>;
  byTvl: UniverseProtocol[];
  byName: UniverseProtocol[];
}
export const CATALOG_PATH = () =>
  process.env.OTHERBRIDGE_DEFI_UNIVERSE_PATH ??
  join(process.cwd(), "content/defi-universe/universe.generated.json");
export function buildIndex(
  universe: Universe,
  sha256: string,
  registries?: CapabilityRegistries,
): CatalogIndex {
  const deps = deployments.map((d) => ({
    id: d.id,
    protocolId: d.protocolId,
    chainId: d.chainId,
    adapter: d.adapter,
  }));
  const reg = registries ?? defaultRegistries(deps);
  const chains = new Map(
    universe.chains.map((c) => [
      c.key,
      { ...c, capabilities: chainCapabilities(c, reg) },
    ]),
  );
  const coverage = computeCoverage(universe, reg.deployments);
  const coverageByProtocol = new Map<string, CoverageRow[]>();
  for (const r of coverage)
    coverageByProtocol.set(r.protocolId, [
      ...(coverageByProtocol.get(r.protocolId) ?? []),
      r,
    ]);
  const rowsByProtocol = new Map<string, Universe["rows"]>(),
    protocolsByChain = new Map<string, Set<string>>();
  for (const r of universe.rows) {
    rowsByProtocol.set(r.protocolId, [
      ...(rowsByProtocol.get(r.protocolId) ?? []),
      r,
    ]);
    protocolsByChain.set(
      r.chainKey,
      (protocolsByChain.get(r.chainKey) ?? new Set()).add(r.protocolId),
    );
  }
  const protocols = new Map(universe.protocols.map((p) => [p.id, p]));
  const bySlug = new Map<string, UniverseProtocol>();
  for (const p of universe.protocols)
    if (
      p.status !== "REMOVED_UPSTREAM" &&
      p.mapping.status === "MAPPED" &&
      !bySlug.has(p.slug)
    )
      bySlug.set(p.slug, p);
  const hay = new Map(
    universe.protocols.map((p) => [
      p.id,
      fold(
        [
          p.name,
          p.slug,
          p.category,
          p.productCategory,
          p.parent?.name ?? "",
          ...p.previousNames,
        ].join(" "),
      ),
    ]),
  );
  const chainHay = new Map(
    universe.chains.map((c) => [
      c.key,
      fold([c.name, ...c.aliases, c.chainId ?? "", c.vm].join(" ")),
    ]),
  );
  const byTvl = [...universe.protocols].sort(
    (a, b) =>
      (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.name.localeCompare(b.name, "en"),
  );
  const byName = [...universe.protocols].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id),
  );
  return {
    universe,
    sha256,
    loadedAt: Date.now(),
    coverage,
    summaries: summarize(coverage),
    coverageByProtocol,
    chains,
    protocols,
    bySlug,
    rowsByProtocol,
    protocolsByChain,
    hay,
    chainHay,
    byTvl,
    byName,
  };
}
let loading: Promise<CatalogIndex> | undefined;
export function loadCatalog(path = CATALOG_PATH()): Promise<CatalogIndex> {
  if (!loading)
    loading = (async () => {
      const text = await readFile(path, "utf8");
      return buildIndex(
        parseUniverse(text),
        createHash("sha256").update(text).digest("hex"),
      );
    })().catch((e) => {
      loading = undefined;
      throw Error("CATALOG_UNAVAILABLE", { cause: e });
    });
  return loading;
}
export function resetCatalogForTests() {
  loading = undefined;
}
export function fold(v: string) {
  return v
    .normalize("NFKC")
    .toLocaleLowerCase("en")
    .replace(/\s+/g, " ")
    .trim();
}
// ---- query layer (shared by the app route and the Data API) ----
export class CatalogQueryError extends Error {}
const MAX_LIMIT = 100;
export interface ProtocolQuery {
  q?: string | null;
  category?: string | null;
  chain?: string | null;
  coverage?: string | null;
  status?: string | null;
  vm?: string | null;
  sort?: string | null;
  cursor?: string | null;
  limit?: number | null;
}
const STATUS_FILTERS = ["ACTIVE", "INACTIVE", "ALL"] as const;
function cleanQuery(q: string | null | undefined) {
  if (q === null || q === undefined) return "";
  if (typeof q !== "string" || q.length > 80)
    throw new CatalogQueryError("INVALID_QUERY");
  return fold(
    q.replace(
      /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g,
      "",
    ),
  );
}
function enumOrNull<T extends string>(
  v: string | null | undefined,
  allowed: readonly T[],
): T | null {
  if (v === null || v === undefined || v === "") return null;
  if (!(allowed as readonly string[]).includes(v))
    throw new CatalogQueryError("INVALID_FILTER");
  return v as T;
}
function limitOf(v: number | null | undefined, fallback = 25) {
  if (v === null || v === undefined) return fallback;
  if (!Number.isInteger(v) || v < 1 || v > MAX_LIMIT)
    throw new CatalogQueryError("INVALID_LIMIT");
  return v;
}
function encodeCursor(
  index: CatalogIndex,
  kind: string,
  filters: string,
  offset: number,
) {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      s: index.universe.syncId,
      k: kind,
      f: hash(filters),
      o: offset,
    }),
  ).toString("base64url");
}
function decodeCursor(
  index: CatalogIndex,
  kind: string,
  filters: string,
  raw: string | null | undefined,
) {
  if (!raw) return 0;
  if (raw.length > 300 || !/^[A-Za-z0-9_-]+$/.test(raw))
    throw new CatalogQueryError("INVALID_CURSOR");
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
    if (
      c.v !== 1 ||
      c.s !== index.universe.syncId ||
      c.k !== kind ||
      c.f !== hash(filters) ||
      !Number.isInteger(c.o) ||
      c.o < 0
    )
      throw Error();
    return c.o as number;
  } catch {
    throw new CatalogQueryError("INVALID_CURSOR");
  }
}
const hash = (v: string) =>
  createHash("sha256").update(v).digest("hex").slice(0, 16);
export interface ProtocolListItem {
  id: string;
  slug: string;
  name: string;
  category: string;
  productCategory: ProductCategory;
  parent: string | null;
  status: UniverseProtocol["status"];
  tvlUsd: number | null;
  chainCount: number;
  chains: { key: string; name: string }[];
  coverage: ProtocolCoverageSummary;
  reviewedAdapter: boolean;
  flags: string[];
}
export function listItem(
  index: CatalogIndex,
  p: UniverseProtocol,
): ProtocolListItem {
  const summary = index.summaries.get(p.id) ?? {
    headline: "CATALOG_ONLY" as CoverageStatus,
    counts: {},
    chains: 0,
  };
  const rows = [...(index.rowsByProtocol.get(p.id) ?? [])].sort(
    (a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1),
  );
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    category: p.category,
    productCategory: p.productCategory,
    parent: p.parent?.name ?? null,
    status: p.status,
    tvlUsd: p.tvlUsd,
    chainCount: rows.length,
    chains: rows.slice(0, 4).map((r) => ({
      key: r.chainKey,
      name: index.chains.get(r.chainKey)?.name ?? r.rawChain,
    })),
    coverage: summary,
    reviewedAdapter: linksFor(p).links.length > 0,
    flags: p.flags.filter((f) =>
      /^(NO_CHAIN_RELATION|REMOVED_UPSTREAM|SLUG_CHANGED|NEW_CATEGORY|MIXED_SCRIPT)$/.test(
        f,
      ),
    ),
  };
}
export function queryProtocols(index: CatalogIndex, query: ProtocolQuery) {
  const q = cleanQuery(query.q);
  const category = enumOrNull(query.category, PRODUCT_CATEGORIES);
  const coverage = enumOrNull(query.coverage, COVERAGE_STATUSES);
  const status = enumOrNull(query.status, STATUS_FILTERS) ?? "ACTIVE";
  const vm = enumOrNull(query.vm, VM_FAMILIES);
  const sort = enumOrNull(query.sort, ["tvl", "name"] as const) ?? "tvl";
  const chain = query.chain ?? null;
  if (
    chain !== null &&
    (!/^chain:[a-z0-9-]{1,80}$/.test(chain) || !index.chains.has(chain))
  )
    throw new CatalogQueryError("INVALID_FILTER");
  const limit = limitOf(query.limit);
  const filters = JSON.stringify([
    q,
    category,
    coverage,
    status,
    vm,
    sort,
    chain,
  ]);
  const offset = decodeCursor(index, "protocols", filters, query.cursor);
  const onChain = chain
    ? (index.protocolsByChain.get(chain) ?? new Set<string>())
    : null;
  const vmChains = vm
    ? new Set(
        [...index.chains.values()].filter((c) => c.vm === vm).map((c) => c.key),
      )
    : null;
  const matches = (p: UniverseProtocol) => {
    if (status === "ACTIVE" && p.status !== "ACTIVE") return false;
    if (status === "INACTIVE" && p.status === "ACTIVE") return false;
    if (category && p.productCategory !== category) return false;
    if (onChain && !onChain.has(p.id)) return false;
    if (vmChains && !p.chains.some((c) => vmChains.has(c))) return false;
    if (
      coverage &&
      !(index.coverageByProtocol.get(p.id) ?? []).some(
        (r) => r.status === coverage && (!chain || r.chainKey === chain),
      )
    )
      return false;
    if (q && !index.hay.get(p.id)!.includes(q)) return false;
    return true;
  };
  let list = (sort === "name" ? index.byName : index.byTvl).filter(matches);
  if (q) {
    // Exact and prefix identity matches first; TVL is only a tiebreak/context, never a wallet value.
    const rank = (p: UniverseProtocol) => {
      const n = fold(p.name);
      return n === q || p.slug === q
        ? 0
        : n.startsWith(q) || p.slug.startsWith(q)
          ? 1
          : 2;
    };
    list = list
      .map((p, i) => ({ p, i, r: rank(p) }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.p);
  }
  const page = list.slice(offset, offset + limit);
  return {
    catalogVersion: index.universe.syncId,
    total: list.length,
    items: page.map((p) => listItem(index, p)),
    nextCursor:
      offset + limit < list.length
        ? encodeCursor(index, "protocols", filters, offset + limit)
        : null,
  };
}
export function protocolDetail(index: CatalogIndex, idOrSlug: string) {
  if (typeof idOrSlug !== "string" || idOrSlug.length > 130)
    throw new CatalogQueryError("INVALID_ID");
  const p = idOrSlug.startsWith("llama:")
    ? index.protocols.get(idOrSlug)
    : index.bySlug.get(idOrSlug);
  if (!p) return null;
  const rows = index.rowsByProtocol.get(p.id) ?? [];
  const cov = index.coverageByProtocol.get(p.id) ?? [];
  const reviewed = linksFor(p).links;
  let host: string | null = null;
  try {
    host = p.url ? new URL(p.url).hostname : null;
  } catch {
    host = null;
  }
  return {
    catalogVersion: index.universe.syncId,
    identity: {
      id: p.id,
      llamaId: p.llamaId,
      slug: p.slug,
      name: p.name,
      parent: p.parent,
      version: p.version,
      previousNames: p.previousNames,
      listedAt: p.listedAt,
      websiteHost: host,
      github: p.github,
      module: p.module,
      forkedFrom: p.forkedFrom.map((id) => {
        const f = index.protocols.get("llama:" + id);
        return { id: "llama:" + id, name: f?.name ?? null };
      }),
      flags: p.flags,
      mapping: p.mapping,
      firstSeen: p.firstSeen,
      lastSeen: p.lastSeen,
    },
    category: p.category,
    productCategory: p.productCategory,
    status: p.status,
    deadFrom: p.deadFrom,
    // Protocol TVL context. It is never a wallet value and is rendered separately from any position.
    tvlContext: {
      totalUsd: p.tvlUsd,
      source: "DefiLlama protocol TVL",
      observedSync: index.universe.syncId,
    },
    coverage: index.summaries.get(p.id) ?? null,
    reviewedAdapters: reviewed.map((l) => ({
      product: l.product,
      attribution: l.attribution,
      adapterVersion: l.adapterVersion,
      status: l.status,
      protocolIds: l.protocolIds,
      deploymentIds: l.deploymentIds ?? null,
    })),
    chains: [
      ...rows.map((r) => {
        const c = index.chains.get(r.chainKey);
        return {
          key: r.chainKey,
          name: c?.name ?? r.rawChain,
          vm: c?.vm ?? ("Other" as VmFamily),
          tvlUsd: r.tvlUsd,
          borrowedUsd: r.borrowedUsd,
          capabilities: c?.capabilities ?? [],
          coverage: cov.filter((x) => x.chainKey === r.chainKey),
        };
      }),
      ...(rows.length
        ? []
        : [
            {
              key: UNSPECIFIED_CHAIN,
              name: null,
              vm: null,
              tvlUsd: null,
              borrowedUsd: null,
              capabilities: [],
              coverage: cov,
            },
          ]),
    ],
  };
}
export interface ChainQuery {
  q?: string | null;
  vm?: string | null;
  capability?: string | null;
  status?: string | null;
  sort?: string | null;
  cursor?: string | null;
  limit?: number | null;
}
export function queryChains(index: CatalogIndex, query: ChainQuery) {
  const q = cleanQuery(query.q);
  const vm = enumOrNull(query.vm, VM_FAMILIES);
  const capability = enumOrNull(query.capability, CHAIN_CAPABILITIES);
  const status =
    enumOrNull(query.status, ["CURRENT", "ALL"] as const) ?? "CURRENT";
  const sort =
    enumOrNull(query.sort, ["tvl", "name", "protocols"] as const) ?? "tvl";
  const limit = limitOf(query.limit, 50);
  const filters = JSON.stringify([q, vm, capability, status, sort]);
  const offset = decodeCursor(index, "chains", filters, query.cursor);
  let list = [...index.chains.values()].filter(
    (c) =>
      (status === "ALL" ||
        c.status === "ACTIVE" ||
        c.status === "REFERENCED_ONLY") &&
      (!vm || c.vm === vm) &&
      (!capability || c.capabilities.includes(capability as ChainCapability)) &&
      (!q || index.chainHay.get(c.key)!.includes(q)),
  );
  list.sort((a, b) =>
    sort === "name"
      ? a.name.localeCompare(b.name, "en")
      : sort === "protocols"
        ? b.protocolCount - a.protocolCount ||
          a.name.localeCompare(b.name, "en")
        : (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.key.localeCompare(b.key),
  );
  if (q)
    list = list
      .map((c, i) => ({
        c,
        i,
        r:
          fold(c.name) === q || c.aliases.some((a) => fold(a) === q)
            ? 0
            : fold(c.name).startsWith(q)
              ? 1
              : 2,
      }))
      .sort((a, b) => a.r - b.r || a.i - b.i)
      .map((x) => x.c);
  const page = list.slice(offset, offset + limit);
  return {
    catalogVersion: index.universe.syncId,
    total: list.length,
    items: page.map((c) => ({
      key: c.key,
      name: c.name,
      aliases: c.aliases.slice(0, 8),
      vm: c.vm,
      chainId: c.chainId,
      status: c.status,
      mapping: c.mapping,
      capabilities: c.capabilities,
      protocolCount: c.protocolCount,
      tvlUsd: c.tvlUsd,
      flags: c.flags,
    })),
    nextCursor:
      offset + limit < list.length
        ? encodeCursor(index, "chains", filters, offset + limit)
        : null,
  };
}
export function categoryReport(index: CatalogIndex) {
  const out = new Map<
    string,
    {
      raw: string;
      productCategory: ProductCategory;
      protocols: number;
      coverage: Partial<Record<CoverageStatus, number>>;
    }
  >();
  for (const c of index.universe.categories)
    out.set(c.raw, { ...c, coverage: {} });
  for (const p of index.universe.protocols) {
    const e = out.get(p.category);
    const h = index.summaries.get(p.id)?.headline;
    if (e && h) e.coverage[h] = (e.coverage[h] ?? 0) + 1;
  }
  return {
    catalogVersion: index.universe.syncId,
    categories: [...out.values()],
  };
}
export function coverageReport(index: CatalogIndex) {
  const rowTotals: Partial<Record<CoverageStatus, number>> = {},
    headline: Partial<Record<CoverageStatus, number>> = {};
  for (const r of index.coverage)
    rowTotals[r.status] = (rowTotals[r.status] ?? 0) + 1;
  for (const s of index.summaries.values())
    headline[s.headline] = (headline[s.headline] ?? 0) + 1;
  // TVL-weighted share of active protocol-chain TVL that has FULL or PARTIAL position coverage (context metric).
  let total = 0,
    full = 0,
    partial = 0;
  for (const r of index.universe.rows) {
    const p = index.protocols.get(r.protocolId);
    if (!p || p.status !== "ACTIVE" || !r.tvlUsd) continue;
    total += r.tvlUsd;
    const states = (index.coverageByProtocol.get(p.id) ?? [])
      .filter((c) => c.chainKey === r.chainKey)
      .map((c) => c.status);
    if (states.includes("FULL_POSITION")) full += r.tvlUsd;
    else if (states.includes("PARTIAL_POSITION")) partial += r.tvlUsd;
  }
  const vm: Partial<Record<VmFamily, number>> = {};
  const capabilityCounts: Partial<Record<ChainCapability, number>> = {};
  for (const c of index.chains.values()) {
    if (c.status === "REMOVED_UPSTREAM" || c.status === "METADATA_ONLY")
      continue;
    vm[c.vm] = (vm[c.vm] ?? 0) + 1;
    for (const cap of c.capabilities)
      capabilityCounts[cap] = (capabilityCounts[cap] ?? 0) + 1;
  }
  return {
    catalogVersion: index.universe.syncId,
    catalogSha256: index.sha256,
    stats: index.universe.stats,
    protocolHeadline: headline,
    protocolChainRows: rowTotals,
    tvlWeighted: {
      fullShare: total ? full / total : 0,
      partialShare: total ? partial / total : 0,
      activeTvlUsd: Math.round(total),
      note: "Share of DefiLlama protocol-chain TVL context with reviewed position adapters; never a wallet value.",
    },
    chainsByVm: vm,
    chainCapabilities: capabilityCounts,
  };
}
