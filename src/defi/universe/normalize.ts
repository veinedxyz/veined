import { createHash } from "node:crypto";
import { z } from "zod";
import { productCategory } from "./categories";
import {
  cleanName,
  cleanUrl,
  finiteNonNegative,
  skeleton,
  slugify,
  validSlug,
} from "./sanitize";
import {
  universeSchema,
  type ChainCapability,
  type SourceRecord,
  type Universe,
  type UniverseChain,
  type UniverseProtocol,
  type ProtocolChainRow,
  type UnmappedChain,
  type UnmappedProtocol,
  type VmFamily,
} from "./model";
// Pure, deterministic normalization of the untrusted DeFiLlama catalog payloads into the Otherbridge universe.
// Every upstream chain name and every upstream protocol row ends up either MAPPED or listed with an exact reason;
// nothing is dropped silently. Nothing here can enable or change a financial adapter: coverage is computed later
// from the reviewed, code-owned adapter map (coverage.ts).
export interface RawSources {
  protocols: unknown;
  chains: unknown;
  config: unknown;
}
export interface IdentityRecord {
  id: string;
  chainId: string | null;
  caip2: string | null;
  name: string;
  ecosystem: string;
}
export interface NormalizeContext {
  syncId: string;
  generatedAt: string;
  sources: SourceRecord[];
  previous?: Universe;
  identities: IdentityRecord[];
  /** Pinned DefiLlama/chainlist chainId -> chain key map, used only as an identity cross-check. */
  chainlist?: Record<string, string>;
}
export interface NormalizeResult {
  universe: Universe;
  unmappedChains: UnmappedChain[];
  unmappedProtocols: UnmappedProtocol[];
  aliasReview: {
    name: string;
    canonical: string;
    method: string;
    detail: string;
  }[];
  newCategories: string[];
}
const chainIdValue = z.union([
  z.number().int().positive().safe(),
  z.string().regex(/^[1-9]\d{0,19}$/),
]);
const v2Row = z
  .object({
    name: z.string().min(1).max(200),
    chainId: chainIdValue.nullable().optional(),
    tvl: z.number().finite().nullable().optional(),
    gecko_id: z.string().max(120).nullable().optional(),
  })
  .passthrough();
const cgMeta = z
  .object({
    chainId: z
      .union([chainIdValue, z.literal(0)])
      .nullable()
      .optional(),
    categories: z.array(z.string().max(60)).max(32).nullable().optional(),
    geckoId: z.string().max(120).nullable().optional(),
    parent: z
      .object({ chain: z.string().max(200) })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
const configSchema = z
  .object({
    chainCoingeckoIds: z.record(z.string(), z.unknown()),
    chainKeyToLabelMap: z.record(z.string(), z.string().max(200)).optional(),
    parentProtocols: z.array(z.unknown()).max(100000).optional(),
  })
  .passthrough();
type Source = "chain-catalog" | "protocols" | "metadata";
interface NameNode {
  raw: string;
  clean: ReturnType<typeof cleanName>;
  sources: Set<Source>;
  tvl: number | null;
  chainId: string | null;
  geckoId: string | null;
  categories: string[];
  parent: string | null;
  protocolRefs: number;
  liveRefs: number;
  reason: UnmappedChain["reason"] | null;
  detail: string;
  method: UniverseChain["mapping"]["method"];
}
const STOP = new Set([
  "chain",
  "network",
  "mainnet",
  "protocol",
  "evm",
  "l1",
  "l2",
  "the",
  "one",
]);
const tokens = (v: string) =>
  new Set(
    v
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1 && !STOP.has(t)),
  );
const compact = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
function similar(a: string, b: string) {
  const x = tokens(a),
    y = tokens(b);
  if ([...x].some((t) => y.has(t))) return true;
  const p = compact(a),
    q = compact(b);
  return p.length >= 3 && q.length >= 3 && (p.includes(q) || q.includes(p));
}
const keyVariants = (name: string) => [
  name.toLowerCase(),
  name.toLowerCase().replace(/[\s-]+/g, "_"),
  name.toLowerCase().replace(/[^a-z0-9]+/g, "_"),
];
const UTXO = new Set([
  "bitcoin",
  "litecoin",
  "doge",
  "dogecoin",
  "bitcoincash",
  "bitcoin cash",
  "bsv blockchain",
  "bitcoin sv",
  "zcash",
  "dash",
  "ravencoin",
  "digibyte",
]);
const NAMED_VM: Record<string, VmFamily> = {
  solana: "Solana",
  sui: "Sui",
  aptos: "Aptos",
  tron: "Tron",
  stellar: "Stellar",
  cosmos: "Cosmos",
  cosmoshub: "Cosmos",
};
function vmOf(names: string[], categories: Set<string>): VmFamily {
  // Explicit network names first: DeFiLlama tags some non-EVM networks (for example Tron) as EVM-compatible.
  const lower = names.map((n) => n.toLowerCase());
  for (const n of lower) if (NAMED_VM[n]) return NAMED_VM[n];
  if (lower.some((n) => UTXO.has(n))) return "Bitcoin";
  if (categories.has("EVM")) return "EVM";
  if (categories.has("SVM")) return "Solana";
  if (categories.has("Cosmos")) return "Cosmos";
  return "Other";
}
// Bounded text length for the upstream "dead from" date/label (not a chain or item cap).
const DEAD_FROM_TEXT_MAX = 40;
const sha = (v: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(v) ?? "undefined")
    .digest("hex");
const IDENTITY_FLAGS = new Set([
  "BIDI_CONTROL_REMOVED",
  "INVISIBLE_REMOVED",
  "CONTROL_REMOVED",
  "MARKUP_REMOVED",
  "MIXED_SCRIPT",
  "NAME_MISSING",
]);
export function normalizeUniverse(
  raw: RawSources,
  ctx: NormalizeContext,
): NormalizeResult {
  if (!Array.isArray(raw.protocols)) throw Error("PROTOCOLS_PAYLOAD_INVALID");
  if (!Array.isArray(raw.chains)) throw Error("CHAINS_PAYLOAD_INVALID");
  const config = configSchema.safeParse(raw.config);
  if (!config.success) throw Error("CONFIG_PAYLOAD_INVALID");
  const cg = config.data.chainCoingeckoIds,
    km = config.data.chainKeyToLabelMap ?? {};
  const unmappedChains: UnmappedChain[] = [],
    unmappedProtocols: UnmappedProtocol[] = [],
    aliasReview: NormalizeResult["aliasReview"] = [];
  const nodes = new Map<string, NameNode>();
  const node = (name: string, source: Source) => {
    let n = nodes.get(name);
    if (!n) {
      const meta = cgMeta.safeParse(cg[name]);
      const m = meta.success ? meta.data : undefined;
      n = {
        raw: name,
        clean: cleanName(name),
        sources: new Set(),
        tvl: null,
        chainId: m?.chainId ? String(m.chainId) : null,
        geckoId: m?.geckoId ?? null,
        categories: (m?.categories ?? []).filter((c) =>
          /^[A-Za-z0-9 _-]{1,60}$/.test(c),
        ),
        parent: m?.parent?.chain
          ? cleanName(m.parent.chain).value || null
          : null,
        protocolRefs: 0,
        liveRefs: 0,
        reason: null,
        detail: "",
        method: "STANDALONE",
      };
      if (cg[name] !== undefined && !meta.success)
        n.detail = "METADATA_MALFORMED";
      nodes.set(name, n);
    }
    n.sources.add(source);
    return n;
  };
  // 1. Chain catalog (v2). Malformed rows are recorded, never skipped silently.
  let invalidChainRows = 0;
  raw.chains.forEach((value, index) => {
    const row = v2Row.safeParse(value);
    if (!row.success) {
      invalidChainRows++;
      unmappedChains.push({
        name:
          cleanName((value as { name?: unknown })?.name).value ||
          `chain-catalog-row-${index}`,
        sources: ["chain-catalog"],
        reason: "SOURCE_INCOMPLETE",
        detail: `MALFORMED_CHAIN_CATALOG_ROW:${index}:${sha(value).slice(0, 16)}`,
        chainId: null,
        catalogKey: null,
      });
      return;
    }
    const n = node(row.data.name, "chain-catalog");
    n.tvl = finiteNonNegative(row.data.tvl);
    if (row.data.chainId) n.chainId = String(row.data.chainId);
    if (row.data.gecko_id && !n.geckoId) n.geckoId = row.data.gecko_id;
  });
  // 2. Protocol chain references and 3. chain metadata names.
  const protocolRows = raw.protocols;
  for (const value of protocolRows) {
    const chains = (value as { chains?: unknown })?.chains;
    if (!Array.isArray(chains)) continue;
    const dead = !!(
      (value as { deadFrom?: unknown }).deadFrom ||
      (value as { deprecated?: unknown }).deprecated ||
      (value as { rugged?: unknown }).rugged
    );
    for (const c of chains)
      if (typeof c === "string" && c.length > 0 && c.length <= 200) {
        const n = node(c, "protocols");
        n.protocolRefs++;
        if (!dead) n.liveRefs++;
      }
  }
  for (const name of Object.keys(cg))
    if (name.length > 0 && name.length <= 200) node(name, "metadata");
  // 3b. Pinned DefiLlama/chainlist (parsed as text, never executed) fills a missing EVM chain id only when exactly one
  // chain id maps to this exact chain key; the value is then recorded as a cross-source identity, never a guess.
  const chainlistByKey = new Map<string, string[]>();
  for (const [id, key] of Object.entries(ctx.chainlist ?? {}))
    if (/^[1-9]\d{0,19}$/.test(id) && typeof key === "string")
      chainlistByKey.set(key, [...(chainlistByKey.get(key) ?? []), id]);
  const chainlistFilled = new Set<string>();
  for (const n of nodes.values()) {
    if (n.chainId || !n.categories.includes("EVM")) continue;
    const hits = [
      ...new Set(
        [...keyVariants(n.raw), compact(n.raw)].flatMap(
          (k) => chainlistByKey.get(k) ?? [],
        ),
      ),
    ];
    if (hits.length === 1) {
      n.chainId = hits[0];
      chainlistFilled.add(n.raw);
    }
  }
  // 4. Alias graph. Evidence: case-insensitive equality, DeFiLlama's own key->label map, and an identical EVM chain id
  // backed by the same gecko id or a similar name. Conflicting evidence is AMBIGUOUS_ALIAS (kept separate, reviewed).
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    while (parent.get(x) !== x) x = parent.get(x)!;
    return x;
  };
  for (const name of nodes.keys()) parent.set(name, name);
  const methods = new Map<string, NameNode["method"]>();
  const union = (a: string, b: string, method: NameNode["method"]) => {
    const x = find(a),
      y = find(b);
    if (x === y) return;
    const ia = nodes.get(x)!,
      ib = nodes.get(y)!;
    if (ia.chainId && ib.chainId && ia.chainId !== ib.chainId) {
      for (const n of [nodes.get(a)!, nodes.get(b)!])
        if (!n.sources.has("chain-catalog") && !n.reason) {
          n.reason = "AMBIGUOUS_ALIAS";
          n.detail = `CONFLICTING_CHAIN_ID:${ia.chainId}/${ib.chainId}`;
        }
      return;
    }
    parent.set(y, x);
    if (ib.chainId && !ia.chainId) ia.chainId = ib.chainId;
    if (!methods.has(b)) methods.set(b, method);
  };
  const flagged = (n: NameNode) =>
    n.clean.flags.some((f) => IDENTITY_FLAGS.has(f));
  for (const n of nodes.values())
    if (flagged(n)) {
      n.reason = "IDENTITY_REVIEW_REQUIRED";
      n.detail = n.clean.flags.join(",");
    }
  const ordered = [...nodes.values()]
    .filter((n) => !n.reason)
    .sort(
      (a, b) =>
        Number(b.sources.has("chain-catalog")) -
          Number(a.sources.has("chain-catalog")) ||
        (b.tvl ?? -1) - (a.tvl ?? -1) ||
        b.protocolRefs - a.protocolRefs ||
        a.raw.localeCompare(b.raw),
    );
  const byLower = new Map<string, string>();
  for (const n of ordered) {
    const lower = n.raw.toLowerCase();
    const hit = byLower.get(lower);
    if (hit) union(hit, n.raw, "CHAIN_CATALOG_NAME");
    else byLower.set(lower, n.raw);
  }
  for (const n of ordered) {
    const label = keyVariants(n.raw)
      .map((k) => km[k])
      .find((l) => typeof l === "string");
    if (!label || label.toLowerCase() === n.raw.toLowerCase()) continue;
    const target = byLower.get(label.toLowerCase());
    if (target && !nodes.get(target)!.reason)
      union(target, n.raw, "KEY_LABEL_MAP");
  }
  const reviewRoots = new Set<string>();
  const byChainId = new Map<string, NameNode[]>();
  for (const n of ordered)
    if (n.chainId && !n.reason)
      byChainId.set(n.chainId, [...(byChainId.get(n.chainId) ?? []), n]);
  for (const group of byChainId.values()) {
    if (group.length < 2) continue;
    const head = group[0];
    for (const n of group.slice(1)) {
      if (find(n.raw) === find(head.raw)) continue;
      const sameGecko = !!n.geckoId && n.geckoId === head.geckoId;
      if (sameGecko || similar(n.raw, head.raw)) {
        union(head.raw, n.raw, "SHARED_CHAIN_ID");
        if (!sameGecko || !similar(n.raw, head.raw))
          aliasReview.push({
            name: n.raw,
            canonical: head.raw,
            method: "SHARED_CHAIN_ID",
            detail: sameGecko
              ? "SAME_GECKO_ID_DISSIMILAR_NAME"
              : "SIMILAR_NAME_NO_GECKO_MATCH",
          });
      } else if (
        [...nodes.keys()].some((k) => k !== n.raw && find(k) === find(n.raw))
      ) {
        // Already merged with other names by stronger evidence: keep both networks visible and flag both for review.
        reviewRoots.add(find(n.raw));
        reviewRoots.add(find(head.raw));
        aliasReview.push({
          name: n.raw,
          canonical: head.raw,
          method: "SHARED_CHAIN_ID",
          detail: "SEPARATE_COMPONENTS_SHARE_CHAIN_ID",
        });
      } else if (
        !n.sources.has("chain-catalog") ||
        !head.sources.has("chain-catalog") ||
        (n.tvl ?? 0) === 0
      ) {
        n.reason = "AMBIGUOUS_ALIAS";
        n.detail = `SHARED_CHAIN_ID_WITHOUT_CORROBORATION:${n.chainId}:${head.raw.slice(0, 60)}`;
      } else {
        // Two live chain-catalog entries claim one EVM network: both stay visible, both need review.
        n.reason = "AMBIGUOUS_ALIAS";
        n.detail = `DUPLICATE_LIVE_CHAIN_ID:${n.chainId}`;
      }
    }
  }
  // 5. Components -> canonical chains.
  const components = new Map<string, NameNode[]>();
  for (const n of nodes.values()) {
    const root = n.reason ? n.raw : find(n.raw);
    components.set(root, [...(components.get(root) ?? []), n]);
  }
  const labels = new Set(Object.values(km).map((l) => l.toLowerCase()));
  const previousChains = new Map(
    (ctx.previous?.chains ?? []).map((c) => [c.key, c]),
  );
  const usedKeys = new Set<string>();
  const nameToKey = new Map<string, string>();
  const chains: UniverseChain[] = [];
  const ids = ctx.identities;
  for (const [root, members] of components) {
    const canonical = [...members].sort(
      (a, b) =>
        Number(!!b.reason === false) - Number(!!a.reason === false) ||
        Number(
          labels.has(b.raw.toLowerCase()) && b.sources.has("chain-catalog"),
        ) -
          Number(
            labels.has(a.raw.toLowerCase()) && a.sources.has("chain-catalog"),
          ) ||
        Number(b.sources.has("chain-catalog")) -
          Number(a.sources.has("chain-catalog")) ||
        Number(labels.has(b.raw.toLowerCase())) -
          Number(labels.has(a.raw.toLowerCase())) ||
        (b.tvl ?? -1) - (a.tvl ?? -1) ||
        b.protocolRefs - a.protocolRefs ||
        a.raw.localeCompare(b.raw),
    )[0];
    const display = canonical.clean.value || "unnamed-chain";
    let key = "chain:" + slugify(display);
    if (usedKeys.has(key))
      key = key.slice(0, 60) + "-" + sha(canonical.raw).slice(0, 8);
    usedKeys.add(key);
    const categories = new Set(members.flatMap((m) => m.categories));
    const chainId = members.find((m) => m.chainId)?.chainId ?? null;
    const vm = vmOf(
      members.map((m) => m.clean.value),
      categories,
    );
    const inCatalog = members.some((m) => m.sources.has("chain-catalog"));
    const referenced = members.some((m) => m.sources.has("protocols"));
    const identity =
      vm === "EVM" && chainId
        ? ids.find((i) => i.chainId === chainId && i.ecosystem === "EVM")
        : ids.find(
            (i) =>
              i.ecosystem !== "EVM" &&
              members.some(
                (m) => m.clean.value.toLowerCase() === i.name.toLowerCase(),
              ),
          );
    const listed = chainId ? ctx.chainlist?.[chainId] : undefined;
    const crossChecked =
      vm === "EVM" &&
      !!listed &&
      members.some(
        (m) =>
          keyVariants(m.raw).includes(listed) ||
          compact(m.raw) === compact(listed) ||
          keyVariants(m.raw).some(
            (k) => km[k] !== undefined && compact(km[k]) === compact(listed),
          ),
      );
    const status: UniverseChain["status"] = inCatalog
      ? "ACTIVE"
      : referenced
        ? "REFERENCED_ONLY"
        : "METADATA_ONLY";
    const tvl = members.reduce<number | null>(
      (s, m) => (m.tvl === null ? s : (s ?? 0) + m.tvl),
      null,
    );
    for (const m of members) {
      if (!m.reason && vm === "EVM" && !chainId) {
        m.reason = "UNKNOWN_CHAIN_ID";
        m.detail = "EVM_CATEGORY_WITHOUT_CHAIN_ID";
      }
      if (!m.reason && status === "METADATA_ONLY") {
        m.reason = "METADATA_ONLY";
        m.detail = "NOT_IN_CHAIN_CATALOG_NOR_REFERENCED_BY_PROTOCOLS";
      }
      m.method =
        m === canonical
          ? inCatalog && m.sources.has("chain-catalog")
            ? "CHAIN_CATALOG_NAME"
            : "STANDALONE"
          : (methods.get(m.raw) ?? "STANDALONE");
      nameToKey.set(m.raw, key);
      if (m.reason)
        unmappedChains.push({
          name: m.clean.value || m.raw.slice(0, 120),
          sources: [...m.sources].sort(),
          reason: m.reason,
          detail: m.detail,
          chainId: m.chainId,
          catalogKey: key,
        });
    }
    const unmapped = canonical.reason !== null;
    const allDead = referenced && members.every((m) => m.liveRefs === 0);
    const capabilities: ChainCapability[] = ["CATALOG"];
    if (
      !unmapped &&
      (vm === "EVM"
        ? !!chainId && (!!identity || crossChecked)
        : !!identity?.caip2)
    )
      capabilities.push("IDENTIFIED");
    if (vm !== "EVM") capabilities.push("UNSUPPORTED_VM");
    if (status === "METADATA_ONLY" || (!inCatalog && allDead))
      capabilities.push("DEPRECATED");
    if (
      reviewRoots.has(root) ||
      members.some((m) => m.reason && m.reason !== "METADATA_ONLY")
    )
      capabilities.push("NEEDS_REVIEW");
    const prev = previousChains.get(key);
    chains.push({
      key,
      name: display,
      aliases: members
        .filter((m) => m !== canonical)
        .map((m) => m.clean.value || m.raw.slice(0, 120))
        .sort()
        .slice(0, 32),
      vm,
      chainId: vm === "EVM" ? chainId : null,
      otherbridgeId: identity?.id ?? null,
      caip2:
        identity?.caip2 ??
        (vm === "EVM" && chainId ? `eip155:${chainId}` : null),
      sources: [
        ...new Set(members.flatMap((m) => [...m.sources])),
      ].sort() as UniverseChain["sources"],
      inChainCatalog: inCatalog,
      tvlUsd: tvl === null ? null : Math.round(tvl * 100) / 100,
      parent: canonical.parent,
      categories: [...categories].sort().slice(0, 16),
      mapping: {
        status: unmapped ? "UNMAPPED" : "MAPPED",
        method: canonical.method,
        reason: canonical.reason,
        crossChecked,
      },
      capabilities,
      protocolCount: 0,
      status,
      flags: [
        ...new Set([
          ...canonical.clean.flags.filter((f) => /^[A-Z0-9_]{1,60}$/.test(f)),
          ...(allDead && !inCatalog ? ["ONLY_INACTIVE_PROTOCOLS"] : []),
          ...(members.some((m) => chainlistFilled.has(m.raw))
            ? ["CHAIN_ID_FROM_CHAINLIST"]
            : []),
        ]),
      ].slice(0, 16),
      firstSeen: prev?.firstSeen ?? ctx.syncId,
      lastSeen: ctx.syncId,
    });
  }
  // 6. Protocols.
  const parents = new Map<string, string>();
  for (const p of config.data.parentProtocols ?? []) {
    const id = (p as { id?: unknown })?.id,
      name = cleanName((p as { name?: unknown })?.name).value;
    if (
      typeof id === "string" &&
      /^parent#[a-z0-9._-]{1,80}$/i.test(id) &&
      name
    )
      parents.set(id, name);
  }
  const previousProtocols = new Map(
    (ctx.previous?.protocols ?? []).map((p) => [p.id, p]),
  );
  const previousSlugOwner = new Map(
    (ctx.previous?.protocols ?? [])
      .filter((p) => p.status !== "REMOVED_UPSTREAM")
      .map((p) => [p.slug, p.id]),
  );
  const protocols: UniverseProtocol[] = [],
    rows: ProtocolChainRow[] = [];
  const seenIds = new Set<string>(),
    slugOwner = new Map<string, string>(),
    nameOwner = new Map<string, string>(),
    skeletonOwner = new Map<string, string>();
  const categoryCount = new Map<
    string,
    { productCategory: UniverseProtocol["productCategory"]; protocols: number }
  >();
  const newCategories = new Set<string>();
  const idSchema = z.union([
    z.string().regex(/^[0-9a-z#._-]{1,80}$/i),
    z.number().int().nonnegative().safe(),
  ]);
  const sorted = protocolRows
    .map((value, index) => ({ value, index }))
    .sort((a, b) => {
      const x = Number((a.value as { id?: unknown })?.id),
        y = Number((b.value as { id?: unknown })?.id);
      return (
        (Number.isFinite(x) ? x : Infinity) -
          (Number.isFinite(y) ? y : Infinity) || a.index - b.index
      );
    });
  for (const { value, index } of sorted) {
    const row = (value && typeof value === "object" ? value : {}) as Record<
      string,
      unknown
    >;
    const rowSha256 = sha(value);
    const id = idSchema.safeParse(row.id);
    const name = cleanName(row.name);
    const unmapped = (
      reason: UnmappedProtocol["reason"],
      detail: string,
      catalogId: string | null,
      slug: string | null,
    ) =>
      unmappedProtocols.push({
        llamaId: id.success ? String(id.data) : null,
        slug,
        name: name.value || null,
        sourceIndex: index,
        rowSha256,
        reason,
        detail,
        catalogId,
      });
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      unmapped("MALFORMED_ROW", "ROW_NOT_OBJECT", null, null);
      continue;
    }
    if (!id.success) {
      // No upstream identity: keep a searchable, clearly unidentified entry if it has a name; never invent a protocol.
      if (!name.value) {
        unmapped("MALFORMED_ROW", "MISSING_OR_INVALID_ID", null, null);
        continue;
      }
    }
    const llamaId = id.success
      ? String(id.data).toLowerCase()
      : "unidentified-" + rowSha256.slice(0, 16);
    const catalogId = "llama:" + llamaId;
    if (seenIds.has(catalogId)) {
      unmapped(
        "IDENTITY_REVIEW_REQUIRED",
        "DUPLICATE_ID",
        null,
        validSlug(row.slug) ? row.slug : null,
      );
      continue;
    }
    seenIds.add(catalogId);
    const flags = name.flags.filter((f) => /^[A-Z0-9_]{1,60}$/.test(f));
    let reason: UnmappedProtocol["reason"] | null = id.success
        ? null
        : "MALFORMED_ROW",
      detail = id.success ? "" : "MISSING_OR_INVALID_ID";
    const fail = (r: UnmappedProtocol["reason"], d: string) => {
      if (!reason) {
        reason = r;
        detail = d;
      }
    };
    if (flags.some((f) => IDENTITY_FLAGS.has(f)))
      fail(
        name.value ? "IDENTITY_REVIEW_REQUIRED" : "SOURCE_INCOMPLETE",
        flags.join(","),
      );
    let slug: string;
    if (validSlug(row.slug)) slug = row.slug;
    else {
      slug = slugify(name.value || llamaId);
      flags.push("SLUG_DERIVED");
      fail("SOURCE_INCOMPLETE", "MISSING_OR_INVALID_SLUG");
    }
    const owner = slugOwner.get(slug),
      historic = previousSlugOwner.get(slug);
    // A slug owned by another id (now, or in the last-good catalog) is never reassigned automatically: rename takeover.
    if (owner || (historic && historic !== catalogId)) {
      fail("SLUG_COLLISION", `SLUG_OWNED_BY:${owner ?? historic}`);
    } else slugOwner.set(slug, catalogId);
    const lowerName = name.value.toLowerCase(),
      skel = skeleton(name.value);
    if (name.value && nameOwner.has(lowerName))
      fail(
        "IDENTITY_REVIEW_REQUIRED",
        `NAME_COLLISION:${nameOwner.get(lowerName)}`,
      );
    else if (name.value) nameOwner.set(lowerName, catalogId);
    const skelHit = skel ? skeletonOwner.get(skel) : undefined;
    if (skelHit && skelHit !== catalogId) {
      if (/[^\x20-\x7e]/.test(name.value))
        fail("IDENTITY_REVIEW_REQUIRED", `CONFUSABLE_NAME:${skelHit}`);
      else flags.push("NAME_SKELETON_COLLISION");
    } else if (skel) skeletonOwner.set(skel, catalogId);
    const prev = previousProtocols.get(catalogId);
    if (prev && prev.slug !== slug) flags.push("SLUG_CHANGED");
    const category = cleanName(row.category, 60).value;
    if (!category) fail("SOURCE_INCOMPLETE", "MISSING_CATEGORY");
    const pc = productCategory(category || "unknown");
    if (!pc.known) {
      flags.push("NEW_CATEGORY");
      if (category) newCategories.add(category);
    }
    const chainList = Array.isArray(row.chains) ? row.chains : [];
    if (!Array.isArray(row.chains))
      fail("SOURCE_INCOMPLETE", "CHAINS_NOT_ARRAY");
    const resolved = new Map<string, string>();
    for (const c of chainList) {
      const key = typeof c === "string" ? nameToKey.get(c) : undefined;
      if (!key) {
        fail("UNKNOWN_CHAIN", "UNRESOLVABLE_CHAIN_NAME");
        continue;
      }
      if (!resolved.has(key)) resolved.set(key, c as string);
    }
    if (chainList.length === 0) flags.push("NO_CHAIN_RELATION");
    const tvls: Record<string, number> = {},
      borrowed: Record<string, number> = {};
    if (
      row.chainTvls &&
      typeof row.chainTvls === "object" &&
      !Array.isArray(row.chainTvls)
    ) {
      for (const [k, v] of Object.entries(
        row.chainTvls as Record<string, unknown>,
      )) {
        const value = finiteNonNegative(v);
        if (value === null) continue;
        const borrow = k.endsWith("-borrowed"),
          chainName = borrow ? k.slice(0, -9) : k;
        if (!borrow && k.includes("-")) continue;
        const key = nameToKey.get(chainName);
        if (!key || !resolved.has(key)) continue;
        const target = borrow ? borrowed : tvls;
        target[key] = Math.round(((target[key] ?? 0) + value) * 100) / 100;
      }
    }
    for (const [key, rawChain] of resolved)
      rows.push({
        protocolId: catalogId,
        chainKey: key,
        rawChain: cleanName(rawChain).value,
        tvlUsd: tvls[key] ?? null,
        borrowedUsd: borrowed[key] ?? null,
      });
    const parentId =
      typeof row.parentProtocol === "string" &&
      /^parent#[a-z0-9._-]{1,80}$/i.test(row.parentProtocol)
        ? row.parentProtocol
        : null;
    const url = cleanUrl(row.url);
    flags.push(...url.flags);
    const status: UniverseProtocol["status"] =
      row.rugged === true
        ? "RUGGED"
        : row.deprecated === true
          ? "DEPRECATED"
          : row.deadFrom
            ? "DEAD"
            : "ACTIVE";
    const version =
      /\bv(\d{1,2}(?:\.\d{1,2})?)\b/i.exec(name.value)?.[1] ?? null;
    if (reason) unmapped(reason, detail, catalogId, slug);
    const cat = categoryCount.get(category || "unknown") ?? {
      productCategory: pc.category,
      protocols: 0,
    };
    cat.protocols++;
    categoryCount.set(category || "unknown", cat);
    protocols.push({
      id: catalogId,
      llamaId,
      slug,
      name: name.value || slug,
      flags: [...new Set(flags)].slice(0, 16),
      category: category || "unknown",
      productCategory: pc.category,
      parent: parentId
        ? { id: parentId, name: parents.get(parentId) ?? parentId.slice(7) }
        : null,
      version: version ? "V" + version : null,
      chains: [...resolved.keys()],
      tvlUsd: finiteNonNegative(row.tvl),
      status,
      deadFrom:
        typeof row.deadFrom === "string" || typeof row.deadFrom === "number"
          ? String(row.deadFrom).slice(0, DEAD_FROM_TEXT_MAX)
          : null,
      forkedFrom: Array.isArray(row.forkedFromIds)
        ? row.forkedFromIds
            .filter(
              (f): f is string =>
                typeof f === "string" && /^[0-9a-z#._-]{1,80}$/i.test(f),
            )
            .slice(0, 32)
        : [],
      listedAt:
        typeof row.listedAt === "number" &&
        Number.isSafeInteger(row.listedAt) &&
        row.listedAt >= 0
          ? row.listedAt
          : null,
      url: url.url,
      module:
        typeof row.module === "string" &&
        /^[A-Za-z0-9_./-]{1,200}$/.test(row.module) &&
        !row.module.includes("..")
          ? row.module
          : null,
      github: Array.isArray(row.github)
        ? row.github
            .filter(
              (g): g is string =>
                typeof g === "string" && /^[A-Za-z0-9_.-]{1,80}$/.test(g),
            )
            .slice(0, 16)
        : [],
      previousNames: Array.isArray(row.previousNames)
        ? row.previousNames
            .map((n) => cleanName(n).value)
            .filter(Boolean)
            .slice(0, 16)
        : [],
      mapping: { status: reason ? "UNMAPPED" : "MAPPED", reason },
      firstSeen: prev?.firstSeen ?? ctx.syncId,
      lastSeen: ctx.syncId,
    });
  }
  // 7. Historical identities: a protocol that disappears upstream stays cataloged as REMOVED_UPSTREAM.
  const removedProtocols = (ctx.previous?.protocols ?? []).filter(
    (p) => !seenIds.has(p.id),
  );
  for (const p of removedProtocols) {
    protocols.push({
      ...p,
      status: "REMOVED_UPSTREAM",
      flags: [...new Set([...p.flags, "REMOVED_UPSTREAM"])].slice(0, 16),
    });
    for (const r of ctx.previous!.rows.filter((r) => r.protocolId === p.id))
      rows.push(r);
  }
  const currentKeys = new Set(chains.map((c) => c.key));
  for (const c of ctx.previous?.chains ?? [])
    if (!currentKeys.has(c.key))
      chains.push({
        ...c,
        status: "REMOVED_UPSTREAM",
        capabilities: [...new Set([...c.capabilities, "DEPRECATED" as const])],
        flags: [...new Set([...c.flags, "REMOVED_UPSTREAM"])].slice(0, 16),
      });
  const removedIds = new Set(removedProtocols.map((p) => p.id));
  const counts = new Map<string, number>();
  for (const r of rows)
    counts.set(r.chainKey, (counts.get(r.chainKey) ?? 0) + 1);
  for (const c of chains) c.protocolCount = counts.get(c.key) ?? 0;
  chains.sort(
    (a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.key.localeCompare(b.key),
  );
  protocols.sort((a, b) => a.id.localeCompare(b.id, "en", { numeric: true }));
  rows.sort(
    (a, b) =>
      a.protocolId.localeCompare(b.protocolId, "en", { numeric: true }) ||
      a.chainKey.localeCompare(b.chainKey),
  );
  const chainNames = nodes.size + invalidChainRows;
  const chainsUnmapped = unmappedChains.length;
  const universe: Universe = {
    version: 1,
    syncId: ctx.syncId,
    generatedAt: ctx.generatedAt,
    sources: ctx.sources,
    stats: {
      chainsSeen: chainNames,
      chainsMapped: chainNames - chainsUnmapped,
      chainsUnmapped,
      chainCatalogRows: raw.chains.length,
      canonicalChains: chains.filter((c) => c.status !== "REMOVED_UPSTREAM")
        .length,
      protocolsSeen: protocolRows.length,
      protocolsMapped: protocolRows.length - unmappedProtocols.length,
      protocolsUnmapped: unmappedProtocols.length,
      activeProtocols: protocols.filter((p) => p.status === "ACTIVE").length,
      deprecatedProtocols: protocols.filter(
        (p) =>
          p.status === "DEPRECATED" ||
          p.status === "DEAD" ||
          p.status === "RUGGED",
      ).length,
      removedUpstreamProtocols: removedProtocols.length,
      categoriesSeen: categoryCount.size,
      protocolChainRows: rows.filter((r) => !removedIds.has(r.protocolId))
        .length,
    },
    categories: [...categoryCount.entries()]
      .map(([rawName, v]) => ({
        raw: rawName,
        productCategory: v.productCategory,
        protocols: v.protocols,
      }))
      .sort((a, b) => b.protocols - a.protocols || a.raw.localeCompare(b.raw)),
    chains,
    protocols,
    rows,
  };
  return {
    universe: universeSchema.parse(universe),
    unmappedChains: unmappedChains.sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) || a.name.localeCompare(b.name),
    ),
    unmappedProtocols: unmappedProtocols.sort(
      (a, b) =>
        a.reason.localeCompare(b.reason) || a.sourceIndex - b.sourceIndex,
    ),
    aliasReview,
    newCategories: [...newCategories].sort(),
  };
}
/** Silent-omission audit: every upstream chain name and protocol row must be accounted for exactly once. */
export function auditParity(raw: RawSources, result: NormalizeResult) {
  const protocols = Array.isArray(raw.protocols) ? raw.protocols : [];
  const chainNames = new Set<string>();
  for (const c of Array.isArray(raw.chains) ? raw.chains : []) {
    const name = (c as { name?: unknown })?.name;
    if (typeof name === "string" && name.length > 0 && name.length <= 200)
      chainNames.add(name);
  }
  for (const p of protocols)
    for (const c of Array.isArray((p as { chains?: unknown })?.chains)
      ? (p as { chains: unknown[] }).chains
      : [])
      if (typeof c === "string" && c.length > 0 && c.length <= 200)
        chainNames.add(c);
  const cg =
    (raw.config as { chainCoingeckoIds?: Record<string, unknown> })
      ?.chainCoingeckoIds ?? {};
  for (const name of Object.keys(cg))
    if (name.length > 0 && name.length <= 200) chainNames.add(name);
  const u = result.universe;
  const represented = new Set<string>();
  const alias = new Map<string, string>();
  for (const c of u.chains)
    for (const n of [c.name, ...c.aliases]) alias.set(n, c.key);
  const missingChains: string[] = [];
  for (const name of chainNames) {
    const clean = cleanName(name).value;
    if (alias.has(clean) || result.unmappedChains.some((m) => m.name === clean))
      represented.add(name);
    else missingChains.push(name);
  }
  const ids = new Set(u.protocols.map((p) => p.llamaId));
  const unmappedIndex = new Set(
    result.unmappedProtocols.map((p) => p.sourceIndex),
  );
  const missingProtocols: number[] = [];
  protocols.forEach((p, i) => {
    const id = (p as { id?: unknown })?.id;
    const ok =
      (id !== undefined && id !== null && ids.has(String(id).toLowerCase())) ||
      unmappedIndex.has(i);
    if (!ok) missingProtocols.push(i);
  });
  const malformedChainRows = result.unmappedChains.filter((c) =>
    c.detail.startsWith("MALFORMED_CHAIN_CATALOG_ROW"),
  ).length;
  return {
    upstreamChainNames: chainNames.size,
    upstreamChainCatalogRows: Array.isArray(raw.chains) ? raw.chains.length : 0,
    malformedChainRows,
    upstreamProtocols: protocols.length,
    missingChains,
    missingProtocols,
    pass: missingChains.length === 0 && missingProtocols.length === 0,
  };
}
/** DefiLlama/chainlist constants/chainIds.js is third-party JavaScript: it is parsed as text, never imported or run. */
export function parseChainlistText(text: string): Record<string, string> {
  if (text.length > 2_000_000 || !/^\s*export default\s*\{/.test(text))
    throw Error("CHAINLIST_FORMAT_UNEXPECTED");
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/"(\d{1,20})"\s*:\s*"([a-z0-9 ._-]{1,80})"/g))
    out[m[1]] = m[2];
  if (Object.keys(out).length < 1) throw Error("CHAINLIST_EMPTY");
  return out;
}
