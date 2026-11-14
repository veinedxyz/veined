import { publicText } from "../src/defi/universe/neutral";
// V1.14 `pnpm defi:universe:report` — regenerates the global adapter queue, coverage and chain reports and the
// source/license inventory from the accepted last-good catalog plus reviewed code. Deterministic; no network.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
  loadCatalog,
  coverageReport,
  categoryReport,
} from "../src/defi/universe/store";
import { buildQueue, queueMarkdown } from "../src/defi/universe/queue";
import { writeLines } from "../src/defi/universe/io";
import { REVIEWED_LINKS } from "../src/defi/universe/adapter-map";
import { deployments } from "../src/defi/registry";
import { buildReverseIndex } from "../src/defi/reverse-index";

const PROOFS = "src/defi/proofs/core-nonzero.json";
const money = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "—"
    : v >= 1e9
      ? `$${(v / 1e9).toFixed(2)}B`
      : v >= 1e6
        ? `$${(v / 1e6).toFixed(2)}M`
        : v >= 1e3
          ? `$${(v / 1e3).toFixed(1)}K`
          : `$${v.toFixed(0)}`;
const cell = (v: string) =>
  publicText(v).replace(/[|\\`*_<>[\]]/g, (c) => "\\" + c);
async function main() {
  const index = await loadCatalog();
  const proofFile = existsSync(PROOFS)
    ? (JSON.parse(readFileSync(PROOFS, "utf8")) as {
        proofs: { protocolId: string; status: string }[];
      })
    : { proofs: [] };
  const proofs = new Set(
    proofFile.proofs
      .filter((p) => p.status === "REAL_NONZERO_PROOF")
      .map((p) => p.protocolId),
  );
  const fixtures = new Set(deployments.map((d) => d.protocolId));
  const queue = buildQueue(index, proofs, fixtures);
  writeFileSync(
    "content/defi-universe/adapter-queue.generated.json",
    writeLines(queue),
  );
  writeFileSync(
    "docs/DEFI_GLOBAL_ADAPTER_QUEUE.md",
    publicText(queueMarkdown(queue, index)),
  );
  const report = coverageReport(index);
  const categories = categoryReport(index);
  writeFileSync(
    "content/defi-universe/coverage-report.generated.json",
    JSON.stringify({ ...report, categories: categories.categories }, null, 1) +
      "\n",
  );
  const u = index.universe;
  const reviewedRows = index.coverage.filter((c) => c.adapterVersion);
  const lines = [
    "# DeFi global coverage",
    "",
    `Catalog \`${u.syncId}\` (generated ${u.generatedAt}, sha256 \`${index.sha256}\`).`,
    "Coverage is keyed by protocol + chain + product/version + adapter version. Catalog breadth is universal; accounting support is reviewed per deployment. A cataloged protocol without an adapter is CATALOG_ONLY — never a checked zero.",
    "",
    "## Universe",
    "",
    "| Metric | Value |",
    "| --- | ---: |",
    ...Object.entries(u.stats).map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## Protocol headline coverage (best per-chain state; every cataloged protocol counted once)",
    "",
    "| State | Protocols |",
    "| --- | ---: |",
    ...Object.entries(report.protocolHeadline).map(
      ([k, v]) => `| ${k} | ${v} |`,
    ),
    "",
    "## Protocol-chain coverage rows",
    "",
    "| State | Rows |",
    "| --- | ---: |",
    ...Object.entries(report.protocolChainRows).map(
      ([k, v]) => `| ${k} | ${v} |`,
    ),
    "",
    `TVL-weighted (DefiLlama protocol-chain TVL context, active protocols, ${money(report.tvlWeighted.activeTvlUsd)}): FULL ${(report.tvlWeighted.fullShare * 100).toFixed(2)}%, PARTIAL ${(report.tvlWeighted.partialShare * 100).toFixed(2)}%. This is never a wallet value.`,
    "",
    "## Reviewed adapter rows",
    "",
    "| Protocol | Chain | Product | Adapter | State | Reason | Deployments |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...reviewedRows.map(
      (c) =>
        `| ${cell(index.protocols.get(c.protocolId)?.name ?? c.protocolId)} | ${cell(index.chains.get(c.chainKey)?.name ?? c.chainKey)} | ${cell(c.product)} | ${c.adapterVersion} | ${c.status} | ${c.reason} | ${c.deployments.join(", ") || "—"} |`,
    ),
    "",
    "## Categories",
    "",
    "| Raw category | Product category | Protocols | Headline coverage |",
    "| --- | --- | ---: | --- |",
    ...categories.categories.map(
      (c) =>
        `| ${cell(c.raw)} | ${c.productCategory} | ${c.protocols} | ${Object.entries(
          c.coverage,
        )
          .map(([k, v]) => `${k} ${v}`)
          .join(", ")} |`,
    ),
    "",
  ];
  writeFileSync("docs/DEFI_GLOBAL_COVERAGE.md", publicText(lines.join("\n")));
  const chains = [...index.chains.values()].sort(
    (a, b) =>
      (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) || a.name.localeCompare(b.name),
  );
  writeFileSync(
    "docs/DEFI_GLOBAL_CHAINS.md",
    publicText(
      [
        "# DeFi global chain catalog",
        "",
        `Catalog \`${u.syncId}\`. Every chain name seen in the DefiLlama chain catalog, protocol chain lists and chain metadata is represented (${u.stats.chainsSeen} names → ${chains.length} canonical entries). Capabilities are independent; there is no single "supported" flag.`,
        "",
        "| VM | Chains |",
        "| --- | ---: |",
        ...Object.entries(report.chainsByVm).map(([k, v]) => `| ${k} | ${v} |`),
        "",
        "| Capability | Chains |",
        "| --- | ---: |",
        ...Object.entries(report.chainCapabilities).map(
          ([k, v]) => `| ${k} | ${v} |`,
        ),
        "",
        "| Chain | Key | VM | Chain id | Status | Mapping | Capabilities | Protocols | TVL context | Aliases |",
        "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | --- |",
        ...chains.map(
          (c) =>
            `| ${cell(c.name)} | \`${c.key}\` | ${c.vm} | ${c.chainId ?? "—"} | ${c.status} | ${c.mapping.status}${c.mapping.reason ? " " + c.mapping.reason : ""} (${c.mapping.method}${c.mapping.crossChecked ? ", chainlist ✓" : ""}) | ${c.capabilities.join(" ")} | ${c.protocolCount} | ${money(c.tvlUsd)} | ${cell(c.aliases.join(", ") || "—")} |`,
        ),
        "",
      ].join("\n"),
    ),
  );
  const sources = JSON.parse(
    readFileSync("content/defi-universe/sources.json", "utf8"),
  ) as {
    sources: {
      id: string;
      url: string;
      sha256: string;
      bytes: number;
      fetchedAt: string;
    }[];
    pinnedRepositories: {
      repo: string;
      revision: string | null;
      license: string;
      use: string;
    }[];
  };
  const manifest = JSON.parse(
    readFileSync("src/defi/sources/manifest.json", "utf8"),
  ) as {
    repo: string;
    revision: string;
    path: string;
    url: string;
    sha256: string;
    terms: string;
  }[];
  const repos = [
    ...new Map(manifest.map((m) => [m.repo + "@" + m.revision, m])).values(),
  ];
  writeFileSync(
    "docs/DEFI_SOURCE_LICENSE_INVENTORY.md",
    publicText(
      [
        "# DeFi source and license inventory",
        "",
        "Every external source Otherbridge V1.14 uses for the DeFi universe and position adapters. Unknown or undecided terms are `LEGAL_REVIEW_REQUIRED`; a detected SPDX id is a hint only. Legal approval is an external gate and is not self-certified.",
        "",
        "## Catalog APIs (fetched at sync time; data, never code)",
        "",
        "| Source | URL | Use | sha256 (last accepted sync) | Bytes | Terms | Attribution |",
        "| --- | --- | --- | --- | ---: | --- | --- |",
        ...sources.sources.map(
          (s) =>
            `| ${s.id} | ${s.url} | ${s.id === "defillama-protocols" ? "protocol catalog, categories, chain relations, TVL context" : s.id === "defillama-chains" ? "chain catalog, TVL context" : s.id === "defillama-config" ? "chain metadata (categories, chain ids, key labels, parent protocols)" : "chain-id cross-check (text-parsed)"} | \`${s.sha256}\` | ${s.bytes} | LEGAL_REVIEW_REQUIRED | DefiLlama data — attribution expected (review terms) |`,
        ),
        "",
        "## Pinned DefiLlama repositories",
        "",
        "| Repository | Pinned revision | Use | License state |",
        "| --- | --- | --- | --- |",
        ...sources.pinnedRepositories.map(
          (r) =>
            `| ${r.repo} | \`${r.revision ?? "UNPINNED"}\` | ${cell(r.use)} | ${r.license} |`,
        ),
        "",
        "## Official protocol sources for reviewed adapters (pinned, sha256-checked in src/defi/sources/manifest.json)",
        "",
        "| Repository | Revision | Files | Use | Terms |",
        "| --- | --- | ---: | --- | --- |",
        ...repos.map(
          (r) =>
            `| ${r.repo} | \`${r.revision}\` | ${manifest.filter((m) => m.repo === r.repo && m.revision === r.revision).length} | deployment addresses / ABI / math review | ${r.terms} |`,
        ),
        "",
        "## Reviewed catalog links",
        "",
        "| DefiLlama id | Slug | Product | Attribution | Adapter version |",
        "| --- | --- | --- | --- | --- |",
        ...REVIEWED_LINKS.map(
          (l) =>
            `| ${l.llamaId} | ${l.slug} | ${cell(l.product)} | ${l.attribution} | ${l.adapterVersion} |`,
        ),
        "",
        "Third-party JavaScript (DefiLlama adapters, chainlist) is never executed: it is pinned and, where used, parsed as text. Remote logos are never fetched or rendered.",
        "",
      ].join("\n"),
    ),
  );
  const reverse = buildReverseIndex(deployments);
  console.log(
    JSON.stringify({
      syncId: u.syncId,
      queue: queue.length,
      tiers: queue.reduce<Record<string, number>>(
        (a, e) => ((a[e.tier] = (a[e.tier] ?? 0) + 1), a),
        {},
      ),
      reverseIndexEntries: reverse.length,
      coverage: report.protocolHeadline,
    }),
  );
}
main().catch((e) => {
  console.error("REPORT_FAILED", e);
  process.exitCode = 1;
});
