// V1.4 supply-chain/static evidence: SBOM, licenses/lifecycle, secret/static scan (src, scripts,
// services, packages, infra, tests, CI), dependency-graph diff, separate production/dev audits and
// build-artifact dependency proof. Writes only into a unique OTHERBRIDGE_EVIDENCE_ROOT.
import { readFile, readdir, mkdir, writeFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT;
if (!base) throw Error("UNIQUE_EVIDENCE_ROOT_REQUIRED");
await mkdir(base, { recursive: true });
const write = (name, value) =>
  writeFile(`${base}/${name}`, JSON.stringify(value, null, 2), { flag: "wx" });
const pnpm = (args) => {
  try {
    return execFileSync("pnpm", args, {
      encoding: "utf8",
      shell: true,
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    return e.stdout?.toString() ?? "";
  }
};
const packages = [];
for (const dir of await readdir("node_modules/.pnpm", {
  withFileTypes: true,
})) {
  if (!dir.isDirectory() || dir.name === "node_modules") continue;
  const root = `node_modules/.pnpm/${dir.name}/node_modules`;
  try {
    for (const item of await readdir(root)) {
      const names = item.startsWith("@")
        ? (await readdir(`${root}/${item}`)).map((n) => `${item}/${n}`)
        : [item];
      for (const name of names)
        try {
          const p = JSON.parse(
            await readFile(`${root}/${name}/package.json`, "utf8"),
          );
          if (
            packages.some((v) => v.name === p.name && v.version === p.version)
          )
            continue;
          packages.push({
            name: p.name,
            version: p.version,
            license:
              typeof p.license === "string"
                ? p.license
                : (p.license?.type ?? p.licenses?.[0]?.type ?? "UNKNOWN"),
            lifecycle: Object.fromEntries(
              Object.entries(p.scripts ?? {}).filter(([k]) =>
                /^(preinstall|install|postinstall|prepare)$/.test(k),
              ),
            ),
          });
        } catch {}
    }
  } catch {}
}
packages.sort(
  (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
);
// Lockfile-resolved graph (orphan store directories in a reused node_modules are not part of it).
const flatten = (tree, out = new Set()) => {
  for (const [name, dep] of Object.entries(tree?.dependencies ?? {})) {
    if (dep?.version) out.add(`${name}@${dep.version}`);
    flatten(dep, out);
  }
  for (const [name, dep] of Object.entries(tree?.devDependencies ?? {})) {
    if (dep?.version) out.add(`${name}@${dep.version}`);
    flatten(dep, out);
  }
  return out;
};
const graphNow = JSON.parse(
  pnpm(["list", "--json", "--depth", "Infinity"]) || "[]",
);
const graphProd = JSON.parse(
  pnpm(["list", "--json", "--depth", "Infinity", "--prod"]) || "[]",
);
const nowSet = flatten(graphNow[0] ?? {}),
  prodSet = flatten(graphProd[0] ?? {});
let beforeSet = new Set();
try {
  const before = JSON.parse(
    await readFile(process.env.OTHERBRIDGE_GRAPH_BEFORE ?? "missing", "utf8"),
  );
  beforeSet = flatten(before[0] ?? {});
} catch {}
const graphDiff = {
  before: beforeSet.size,
  now: nowSet.size,
  production: prodSet.size,
  added: [...nowSet].filter((p) => !beforeSet.has(p)).sort(),
  removed: [...beforeSet].filter((p) => !nowSet.has(p)).sort(),
};
const audit = (args) => {
  const raw = pnpm(["audit", "--json", ...args]);
  try {
    const j = JSON.parse(raw);
    return {
      metadata: j.metadata,
      advisories: Object.values(j.advisories ?? {}).map((a) => ({
        id: a.github_advisory_id,
        module: a.module_name,
        severity: a.severity,
        paths: a.findings?.flatMap((f) => f.paths),
      })),
    };
  } catch {
    return { error: "AUDIT_UNAVAILABLE", raw: raw.slice(0, 500) };
  }
};
const auditAll = audit([]),
  auditProd = audit(["--prod"]),
  auditDev = audit(["--dev"]);
const files = [];
async function walk(dir) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const file = `${dir}/${e.name}`;
    if (e.isDirectory()) await walk(file);
    else files.push(file);
  }
}
for (const d of [
  "src",
  "scripts",
  ".github",
  "services",
  "packages",
  "infra",
  "tests",
])
  await walk(d);
// Synthetic literals that exist only to test redaction; listed explicitly, never pattern-wide.
const SYNTHETIC_ALLOWED = ["postgres://u:p@h/db"];
const findings = [],
  hashes = {};
for (const file of files) {
  const raw = await readFile(file, "utf8");
  const text = SYNTHETIC_ALLOWED.reduce((t, v) => t.split(v).join(""), raw);
  hashes[file] = createHash("sha256").update(raw).digest("hex");
  if (
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|(?:AKIA|ASIA)[A-Z0-9]{16}|gh[pousr]_[A-Za-z0-9]{30,}|ob_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}|postgres(?:ql)?:\/\/[^\s"'`$]+:[^\s"'`$@]+@/.test(
      text,
    )
  )
    findings.push({ file, kind: "secret-pattern", value: "REDACTED" });
  if (
    /^(src|services|packages)\//.test(file) &&
    /dangerouslySetInnerHTML|eval\s*\(|new Function\s*\(/.test(text)
  )
    findings.push({ file, kind: "unsafe-evaluation" });
  // Trojan-Source guard for executable code; translation data may legitimately contain ZWNJ/ZWSP,
  // so locale JSON is checked only for directional overrides/isolates.
  if (
    /^(src|services|packages)\//.test(file) &&
    /\.(ts|tsx|mjs|cjs|js|sql)$/.test(file) &&
    /[\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/.test(text)
  )
    findings.push({ file, kind: "bidi-or-zero-width" });
  if (
    /\/locales\/.*\.json$/.test(file) &&
    /[\u202a-\u202e\u2066-\u2069]/.test(text)
  )
    findings.push({ file, kind: "locale-directional-override" });
}
// Build artifact dependency proof: browser chunks contain no server driver, data env names or the
// retired paid portfolio host; the server route trace includes the driver as an external package.
const artifact = { built: false };
try {
  await stat(".next/static");
  artifact.built = true;
  const chunks = [];
  const scan = async (d) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) await scan(p);
      else if (p.endsWith(".js")) chunks.push(p);
    }
  };
  await scan(".next/static");
  const hits = {
    postgresDriver: [],
    dataEnv: [],
    paidHost: [],
    apiKeyPattern: [],
  };
  for (const c of chunks) {
    const t = await readFile(c, "utf8");
    if (/porsager|postgres\.js|PostgresStore|pg_advisory/.test(t))
      hits.postgresDriver.push(c);
    if (/OTHERBRIDGE_DATA_|OTHERBRIDGE_PG_/.test(t)) hits.dataEnv.push(c);
    if (/covalenthq|OTHERBRIDGE_PORTFOLIO_API_KEY/.test(t))
      hits.paidHost.push(c);
    if (/ob_live_[a-z0-9]{12}_[A-Za-z0-9_-]{43}/.test(t))
      hits.apiKeyPattern.push(c);
  }
  artifact.browserChunks = chunks.length;
  artifact.hits = hits;
  try {
    const trace = JSON.parse(
      await readFile(
        ".next/server/app/api/portfolio/route.js.nft.json",
        "utf8",
      ),
    );
    artifact.portfolioRouteTracesPostgres = trace.files.some((f) =>
      /node_modules[\\/](\.pnpm[\\/])?postgres/.test(f),
    );
  } catch {
    artifact.portfolioRouteTracesPostgres = "TRACE_UNAVAILABLE";
  }
  assert.ok(
    Object.values(hits).every((h) => h.length === 0),
    "Browser bundle contains server-only material",
  );
} catch (e) {
  if (e instanceof assert.AssertionError) throw e;
}
assert.equal(
  findings.length,
  0,
  `Secret/static findings require review: ${JSON.stringify(findings)}`,
);
const lock = await readFile("pnpm-lock.yaml");
await write("sbom.cdx.json", {
  bomFormat: "CycloneDX",
  specVersion: "1.6",
  version: 1,
  metadata: {
    timestamp: new Date().toISOString(),
    component: {
      type: "application",
      name: "otherbridge",
      version: "V1.4-readonly",
    },
  },
  components: packages.map((p) => ({
    type: "library",
    name: p.name,
    version: p.version,
    purl: `pkg:npm/${p.name.replace("@", "%40")}@${p.version}`,
    licenses: [{ license: { name: p.license } }],
  })),
});
await write("licenses-lifecycle.json", {
  packages,
  unknown: packages.filter((p) => p.license === "UNKNOWN"),
  lifecycle: packages.filter((p) => Object.keys(p.lifecycle).length),
  policy:
    "frozen install; lifecycle scripts denied; optional prebuilt binaries",
});
await write("static-secrets-check.json", {
  at: new Date().toISOString(),
  findings,
  scanned: files.length,
  lockSha256: createHash("sha256").update(lock).digest("hex"),
  hashes,
  scope: "Pattern/static checks; not a penetration test or independent audit",
});
await write("dependency-audit.json", {
  at: new Date().toISOString(),
  all: auditAll,
  production: auditProd,
  development: auditDev,
  decision:
    "Production-reachable high/critical and dev-only high are reported separately; none suppressed",
});
await write("dependency-graph-diff.json", graphDiff);
await write("build-artifact-dependencies.json", artifact);
const summary = {
  packages: packages.length,
  unknownLicenses: packages.filter((p) => p.license === "UNKNOWN").length,
  lifecycle: packages.filter((p) => Object.keys(p.lifecycle).length).length,
  findings: findings.length,
  scanned: files.length,
  auditAll: auditAll.metadata?.vulnerabilities,
  auditProd: auditProd.metadata?.vulnerabilities,
  auditDev: auditDev.metadata?.vulnerabilities,
  graphAdded: graphDiff.added,
  graphRemoved: graphDiff.removed.length,
  artifact: {
    built: artifact.built,
    browserChunks: artifact.browserChunks,
    hits:
      artifact.hits &&
      Object.fromEntries(
        Object.entries(artifact.hits).map(([k, v]) => [k, v.length]),
      ),
    portfolioRouteTracesPostgres: artifact.portfolioRouteTracesPostgres,
  },
};
await write("security-summary.json", summary);
console.log(JSON.stringify(summary, null, 1));
