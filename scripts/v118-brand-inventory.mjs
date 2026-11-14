import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { sourceInventory } from "./v117-source.mjs";
const [out, phase = "after"] = process.argv.slice(2);
if (!out) throw Error("EVIDENCE_DIRECTORY_REQUIRED");
const pointer = readFileSync(
  ".otherbridge/g7-protected-baseline.txt",
  "utf8",
).trim();
const protectedPaths = JSON.parse(readFileSync(pointer));
const history =
  /^(evidence|audit|legal|pentest|release)\/|^GOAL_|^OTHERBRIDGE|^CONTINUE|^START_HERE|^OWNER_|^REVIEW|^\.otherbridge\/|^docs\//;
const publicSource = /^src\/(app|components|i18n\/locales|data\/api)\//;
const rows = [];
for (const path of Object.keys(sourceInventory())) {
  if (
    !/\.(md|json|ts|tsx|mjs|css|html|svg|ya?ml|txt)$/.test(path) &&
    path !== ".env.example"
  )
    continue;
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  lines.forEach((line, i) => {
    const matches = [...line.matchAll(/other[- ]?bridge(?:\.io)?/gi)];
    if (!matches.length) return;
    let category = "INTERNAL_COMPATIBILITY_IDENTIFIER",
      reason =
        "Stable machine identifier, source comment, test fixture, or internal tooling; no public presentation.";
    if (path in protectedPaths) {
      category = "G7_PROTECTED";
      reason =
        "Active accepted protected baseline; byte-identical preservation required.";
    } else if (history.test(path)) {
      category = "IMMUTABLE_HISTORICAL_EVIDENCE";
      reason =
        "Historical milestone, engineering/audit record, or explicit V1.18 migration mapping; retained without rewriting prior evidence.";
    } else if (path === "README.md") {
      category = "PUBLIC_DOCUMENTATION";
      reason =
        "Current introduction plus explicitly labelled, byte-preserved historical archive.";
    } else if (
      path.startsWith("content/docs/") ||
      path === "src/docs/content.generated.ts" ||
      path === "packages/data-client/README.md"
    ) {
      category = "PUBLIC_DOCUMENTATION";
      reason =
        "Current public documentation; stable code samples retain SDK identifiers.";
    } else if (path === "src/server/site.ts") {
      category = "FUTURE_PRODUCTION_CONFIGURATION";
      reason =
        "Legacy environment keys retained; planned identity is separate from authorized origin configuration.";
    } else if (
      publicSource.test(path) &&
      /Otherbridge/.test(line) &&
      !/^\s*(\/\/|\/\*|\*|import)/.test(line)
    ) {
      category = /layout|meta|openapi/.test(path)
        ? "PUBLIC_METADATA"
        : "CURRENT_PUBLIC_BRAND";
      reason = "Human-readable product presentation requires migration.";
    }
    const unresolved =
      phase === "after" &&
      (category === "CURRENT_PUBLIC_BRAND" || category === "PUBLIC_METADATA");
    rows.push({
      path,
      line: i + 1,
      matches: matches.map((m) => m[0]),
      category,
      reason,
      unresolved,
      excerpt: line.trim().slice(0, 400),
    });
  });
}
const counts = {};
for (const r of rows)
  counts[r.category] = (counts[r.category] ?? 0) + r.matches.length;
const report = {
  phase,
  at: new Date().toISOString(),
  scope:
    "All active source/configuration/docs/tests/vendor snapshots from versioned source inventory, including untracked files; immutable evidence covered by preservation hashes.",
  counts,
  unresolved: rows.filter((r) => r.unresolved),
  rows,
};
mkdirSync(out, { recursive: true });
writeFileSync(
  out + "/brand-" + phase + ".json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(
  JSON.stringify({
    phase,
    counts,
    unresolved: report.unresolved.map((r) => r.path + ":" + r.line),
  }),
);
if (report.unresolved.length) process.exitCode = 1;
