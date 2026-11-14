import { publicText } from "./neutral";
import type { Universe, UniverseStats } from "./model";
// Machine + human diff between the last-good catalog and a candidate sync. Renames, slug changes, chain-set changes
// and chain identity changes are always surfaced; nothing is auto-applied to financial logic.
export interface UniverseDiff {
  from: string | null;
  to: string;
  protocols: {
    added: { id: string; name: string; slug: string; category: string }[];
    removed: { id: string; name: string; slug: string }[];
    renamed: { id: string; from: string; to: string }[];
    slugChanged: { id: string; from: string; to: string }[];
    categoryChanged: { id: string; from: string; to: string }[];
    statusChanged: { id: string; from: string; to: string }[];
    chainsChanged: { id: string; added: string[]; removed: string[] }[];
  };
  chains: {
    added: { key: string; name: string; vm: string }[];
    removed: { key: string; name: string }[];
    aliasesChanged: { key: string; added: string[]; removed: string[] }[];
    chainIdChanged: { key: string; from: string | null; to: string | null }[];
    vmChanged: { key: string; from: string; to: string }[];
    mappingChanged: { key: string; from: string; to: string }[];
  };
  categories: { added: string[]; removed: string[] };
  counts: Record<string, number>;
}
export function universeDiff(
  prev: Universe | undefined,
  next: Universe,
): UniverseDiff {
  const p = new Map((prev?.protocols ?? []).map((x) => [x.id, x]));
  const n = new Map(next.protocols.map((x) => [x.id, x]));
  const live = (s: string) => s !== "REMOVED_UPSTREAM";
  const d: UniverseDiff = {
    from: prev?.syncId ?? null,
    to: next.syncId,
    protocols: {
      added: [],
      removed: [],
      renamed: [],
      slugChanged: [],
      categoryChanged: [],
      statusChanged: [],
      chainsChanged: [],
    },
    chains: {
      added: [],
      removed: [],
      aliasesChanged: [],
      chainIdChanged: [],
      vmChanged: [],
      mappingChanged: [],
    },
    categories: { added: [], removed: [] },
    counts: {},
  };
  for (const [id, x] of n) {
    const old = p.get(id);
    if (!old || !live(old.status)) {
      if (live(x.status))
        d.protocols.added.push({
          id,
          name: x.name,
          slug: x.slug,
          category: x.category,
        });
      continue;
    }
    if (!live(x.status)) {
      d.protocols.removed.push({ id, name: x.name, slug: x.slug });
      continue;
    }
    if (old.name !== x.name)
      d.protocols.renamed.push({ id, from: old.name, to: x.name });
    if (old.slug !== x.slug)
      d.protocols.slugChanged.push({ id, from: old.slug, to: x.slug });
    if (old.category !== x.category)
      d.protocols.categoryChanged.push({
        id,
        from: old.category,
        to: x.category,
      });
    if (old.status !== x.status)
      d.protocols.statusChanged.push({ id, from: old.status, to: x.status });
    const a = new Set(old.chains),
      b = new Set(x.chains);
    const added = [...b].filter((c) => !a.has(c)),
      removed = [...a].filter((c) => !b.has(c));
    if (added.length || removed.length)
      d.protocols.chainsChanged.push({ id, added, removed });
  }
  for (const [id, old] of p)
    if (!n.has(id) && live(old.status))
      d.protocols.removed.push({ id, name: old.name, slug: old.slug });
  const pc = new Map((prev?.chains ?? []).map((c) => [c.key, c]));
  for (const c of next.chains) {
    const old = pc.get(c.key);
    if (!old || !live(old.status)) {
      if (live(c.status))
        d.chains.added.push({ key: c.key, name: c.name, vm: c.vm });
      continue;
    }
    if (!live(c.status)) {
      d.chains.removed.push({ key: c.key, name: c.name });
      continue;
    }
    const a = new Set(old.aliases),
      b = new Set(c.aliases);
    const added = [...b].filter((x) => !a.has(x)),
      removed = [...a].filter((x) => !b.has(x));
    if (added.length || removed.length)
      d.chains.aliasesChanged.push({ key: c.key, added, removed });
    if (old.chainId !== c.chainId)
      d.chains.chainIdChanged.push({
        key: c.key,
        from: old.chainId,
        to: c.chainId,
      });
    if (old.vm !== c.vm)
      d.chains.vmChanged.push({ key: c.key, from: old.vm, to: c.vm });
    if (old.mapping.status !== c.mapping.status)
      d.chains.mappingChanged.push({
        key: c.key,
        from: old.mapping.status,
        to: c.mapping.status,
      });
  }
  const nextKeys = new Set(next.chains.map((c) => c.key));
  for (const [key, old] of pc)
    if (!nextKeys.has(key) && live(old.status))
      d.chains.removed.push({ key, name: old.name });
  const pcat = new Set((prev?.categories ?? []).map((c) => c.raw)),
    ncat = new Set(next.categories.map((c) => c.raw));
  d.categories.added = [...ncat].filter((c) => !pcat.has(c)).sort();
  d.categories.removed = [...pcat].filter((c) => !ncat.has(c)).sort();
  for (const [group, value] of Object.entries({
    protocols: d.protocols,
    chains: d.chains,
    categories: d.categories,
  }))
    for (const [k, v] of Object.entries(value))
      d.counts[`${group}.${k}`] = (v as unknown[]).length;
  return d;
}
const cap = <T>(list: T[], n = 200) => ({
  shown: list.slice(0, n),
  more: Math.max(0, list.length - n),
});
const esc = (v: string) =>
  publicText(v).replace(/[|\\`*_<>[\]]/g, (c) => "\\" + c);
export function diffMarkdown(
  diff: UniverseDiff,
  stats: UniverseStats,
  title = "DeFi universe sync diff",
) {
  const lines = [
    `# ${title}`,
    "",
    `From \`${diff.from ?? "none (bootstrap)"}\` to \`${diff.to}\`. Machine diff: \`content/defi-universe/diff.generated.json\`.`,
    "Catalog changes are informational: no adapter, deployment or valuation rule changes because of a sync.",
    "",
    "## Totals",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...Object.entries(stats).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Changes",
    "",
    "| Change | Count |",
    "| --- | ---: |",
    ...Object.entries(diff.counts).map(([k, v]) => `| ${k} | ${v} |`),
  ];
  const section = <T>(name: string, list: T[], fmt: (x: T) => string) => {
    if (!list.length) return;
    const c = cap(list);
    lines.push(
      "",
      `### ${name} (${list.length})`,
      "",
      ...c.shown.map((x) => `- ${fmt(x)}`),
    );
    if (c.more) lines.push(`- … ${c.more} more in the machine diff`);
  };
  section(
    "Protocols added",
    diff.protocols.added,
    (x) => `${esc(x.name)} (\`${x.id}\`, ${esc(x.category)})`,
  );
  section(
    "Protocols removed upstream (kept as REMOVED_UPSTREAM)",
    diff.protocols.removed,
    (x) => `${esc(x.name)} (\`${x.id}\`)`,
  );
  section(
    "Protocols renamed",
    diff.protocols.renamed,
    (x) => `\`${x.id}\`: ${esc(x.from)} → ${esc(x.to)}`,
  );
  section(
    "Protocol slug changes (review)",
    diff.protocols.slugChanged,
    (x) => `\`${x.id}\`: ${esc(x.from)} → ${esc(x.to)}`,
  );
  section(
    "Category changes",
    diff.protocols.categoryChanged,
    (x) => `\`${x.id}\`: ${esc(x.from)} → ${esc(x.to)}`,
  );
  section(
    "Status changes",
    diff.protocols.statusChanged,
    (x) => `\`${x.id}\`: ${x.from} → ${x.to}`,
  );
  section(
    "Protocol chain changes",
    diff.protocols.chainsChanged,
    (x) =>
      `\`${x.id}\`: +${x.added.join(", ") || "∅"} / −${x.removed.join(", ") || "∅"}`,
  );
  section(
    "Chains added",
    diff.chains.added,
    (x) => `${esc(x.name)} (\`${x.key}\`, ${x.vm})`,
  );
  section(
    "Chains removed upstream",
    diff.chains.removed,
    (x) => `${esc(x.name)} (\`${x.key}\`)`,
  );
  section(
    "Chain alias changes",
    diff.chains.aliasesChanged,
    (x) =>
      `\`${x.key}\`: +${x.added.map(esc).join(", ") || "∅"} / −${x.removed.map(esc).join(", ") || "∅"}`,
  );
  section(
    "Chain id changes (identity review)",
    diff.chains.chainIdChanged,
    (x) => `\`${x.key}\`: ${x.from} → ${x.to}`,
  );
  section(
    "VM family changes",
    diff.chains.vmChanged,
    (x) => `\`${x.key}\`: ${x.from} → ${x.to}`,
  );
  section(
    "Chain mapping changes",
    diff.chains.mappingChanged,
    (x) => `\`${x.key}\`: ${x.from} → ${x.to}`,
  );
  section("Categories added", diff.categories.added, esc);
  section("Categories removed", diff.categories.removed, esc);
  return publicText(lines.join("\n") + "\n");
}
