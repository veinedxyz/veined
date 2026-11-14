// V1.14 `pnpm defi:universe:sync` — READ-ONLY catalog sync of the current DeFi universe.
//   pnpm defi:universe:sync [--dry-run] [--fixture <dir>] [--out <dir>] [--previous <file>] [--evidence <dir>]
//                           [--accept-review=CODE,CODE]
// Fetches the current DefiLlama protocol, chain and chain-metadata catalogs plus pinned DefiLlama GitHub revisions,
// validates and normalizes every row, proves there is no silent omission, compares with the last-good catalog
// (diff + anomaly checks) and only then replaces the last-good files. A rejected sync leaves the last-good catalog
// serving and records the attempt. Upstream data is untrusted text: third-party source is never executed, no remote
// logo is fetched, and nothing here can enable or change a financial adapter (coverage comes from reviewed code).
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  copyFileSync,
} from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { safeGet, safeJsonParse } from "../src/assets/safe-fetch";
import {
  normalizeUniverse,
  auditParity,
  parseChainlistText,
  type IdentityRecord,
} from "../src/defi/universe/normalize";
import { universeDiff, diffMarkdown } from "../src/defi/universe/diff";
import { anomalyChecks, syncAccepted } from "../src/defi/universe/anomaly";
import {
  parseUniverse,
  serializeUniverse,
  writeLines,
} from "../src/defi/universe/io";
import { buildIndex, coverageReport } from "../src/defi/universe/store";
import type { SourceRecord, Universe } from "../src/defi/universe/model";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const value = (name: string) => {
  const i = args.indexOf(name);
  const inline = args.find((a) => a.startsWith(name + "="));
  return inline
    ? inline.slice(name.length + 1)
    : i >= 0
      ? args[i + 1]
      : undefined;
};
const DATA = value("--out") ?? "content/defi-universe";
const PREVIOUS = value("--previous") ?? join(DATA, "universe.generated.json");
const fixture = value("--fixture");
const dryRun = flag("--dry-run");
const evidence = value("--evidence") ?? process.env.OTHERBRIDGE_V114_EVIDENCE;
const acceptReview = new Set(
  (value("--accept-review") ?? "")
    .split(",")
    .filter((c) => /^[A-Z_]{3,40}$/.test(c)),
);
const started = Date.now();
const stamp = new Date(started)
  .toISOString()
  .replace(/[-:]/g, "")
  .replace(/\.\d+Z$/, "Z");
const syncId = `u${stamp}-${randomBytes(3).toString("hex")}`;
const sha256 = (b: Buffer | string) =>
  createHash("sha256").update(b).digest("hex");
const MAX = {
  protocols: 64 * 1024 * 1024,
  chains: 4 * 1024 * 1024,
  config: 64 * 1024 * 1024,
  chainlist: 2 * 1024 * 1024,
};
const SOURCES = [
  {
    id: "defillama-protocols",
    url: "https://api.llama.fi/protocols",
    file: "protocols.json",
    max: MAX.protocols,
  },
  {
    id: "defillama-chains",
    url: "https://api.llama.fi/v2/chains",
    file: "chains.json",
    max: MAX.chains,
  },
  {
    id: "defillama-config",
    url: "https://api.llama.fi/config",
    file: "config.json",
    max: MAX.config,
  },
] as const;
const REPOS = [
  "DefiLlama/chainlist",
  "DefiLlama/DefiLlama-Adapters",
  "DefiLlama/dimension-adapters",
  "DefiLlama/icons",
] as const;
const ALLOWED = ["api.llama.fi", "api.github.com", "raw.githubusercontent.com"];
async function get(url: string, maxBytes: number, accept = "application/json") {
  // Bounded retries for transient transport failures only; validation failures are never retried away.
  for (let attempt = 1; ; attempt++) {
    try {
      return await getOnce(url, maxBytes, accept);
    } catch (e) {
      const transient = /^(NETWORK|TIMEOUT|DNS_FAILED|HTTP_(429|5\d\d))/.test(
        String((e as Error).message),
      );
      if (!transient || attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 2000 * attempt));
    }
  }
}
async function getOnce(url: string, maxBytes: number, accept: string) {
  const r = await safeGet(url, {
    allowedHosts: ALLOWED,
    maxBytes,
    timeoutMs: 120_000,
    maxRedirects: 0,
    accept,
    // The compressed transfer is bounded by maxBytes and the decompressed body by the same limit (no zip bomb).
    headers: {
      "User-Agent": "Otherbridge-readonly-catalog-sync",
      "Accept-Encoding": "gzip",
    },
  });
  if (r.status !== 200) throw Error(`HTTP_${r.status}:${url}`);
  if (r.contentEncoding === "gzip")
    return gunzipSync(r.body, { maxOutputLength: maxBytes });
  if (r.contentEncoding && r.contentEncoding !== "identity")
    throw Error(`UNSUPPORTED_ENCODING:${r.contentEncoding}`);
  return r.body;
}
function atomicWrite(path: string, content: string | Buffer) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}
interface PinnedRepo {
  repo: string;
  revision: string | null;
  committedAt: string | null;
  license: string;
  use: string;
  error?: string;
}
const repoUse: Record<string, string> = {
  "DefiLlama/chainlist":
    "chain identity cross-check (constants/chainIds.js parsed as text)",
  "DefiLlama/DefiLlama-Adapters":
    "TVL methodology and deployment clues (module paths at the pinned revision); never executed",
  "DefiLlama/dimension-adapters":
    "optional volume/fees/revenue context only; never wallet value; never executed",
  "DefiLlama/icons":
    "logo provenance reference only; logos are never fetched or rendered",
};
async function pinRepos(): Promise<PinnedRepo[]> {
  const out: PinnedRepo[] = [];
  for (const repo of REPOS) {
    try {
      const meta = safeJsonParse(
        (
          await get(
            `https://api.github.com/repos/${repo}`,
            2_000_000,
            "application/vnd.github+json",
          )
        ).toString("utf8"),
      ) as {
        default_branch?: string;
        license?: { spdx_id?: string } | null;
      };
      const branch =
        typeof meta.default_branch === "string" &&
        /^[\w.-]{1,60}$/.test(meta.default_branch)
          ? meta.default_branch
          : "main";
      const commit = safeJsonParse(
        (
          await get(
            `https://api.github.com/repos/${repo}/commits/${branch}`,
            4_000_000,
            "application/vnd.github+json",
          )
        ).toString("utf8"),
      ) as { sha?: string; commit?: { committer?: { date?: string } } };
      const spdx = meta.license?.spdx_id;
      out.push({
        repo,
        revision:
          typeof commit.sha === "string" && /^[a-f0-9]{40}$/.test(commit.sha)
            ? commit.sha
            : null,
        committedAt: commit.commit?.committer?.date ?? null,
        // GitHub's detected SPDX id is a hint, not a legal conclusion; every source stays LEGAL_REVIEW_REQUIRED.
        license:
          spdx && spdx !== "NOASSERTION"
            ? `${spdx} (detected; LEGAL_REVIEW_REQUIRED)`
            : "LEGAL_REVIEW_REQUIRED",
        use: repoUse[repo],
      });
    } catch (e) {
      out.push({
        repo,
        revision: null,
        committedAt: null,
        license: "LEGAL_REVIEW_REQUIRED",
        use: repoUse[repo],
        error: String((e as Error).message).slice(0, 120),
      });
    }
  }
  return out;
}
function identities(): IdentityRecord[] {
  const file = JSON.parse(
    readFileSync("src/registry/chain-identities.generated.json", "utf8"),
  ) as { chains: IdentityRecord[] };
  return file.chains
    .filter(
      (c) =>
        (c as unknown as { environment: string }).environment === "mainnet",
    )
    .map((c) => ({
      id: c.id,
      chainId: c.chainId,
      caip2: c.caip2,
      name: c.name,
      ecosystem: c.ecosystem,
    }));
}
async function main() {
  const raw: Record<string, Buffer> = {};
  const sources: SourceRecord[] = [];
  let repos: PinnedRepo[] = [];
  let chainlistText: string | null = null;
  if (fixture) {
    for (const s of SOURCES) raw[s.file] = readFileSync(join(fixture, s.file));
    const cl = join(fixture, "chainIds.js");
    if (existsSync(cl)) chainlistText = readFileSync(cl, "utf8");
    repos = REPOS.map((repo) => ({
      repo,
      revision: null,
      committedAt: null,
      license: "LEGAL_REVIEW_REQUIRED",
      use: repoUse[repo],
      error: "FIXTURE_MODE",
    }));
  } else {
    for (const s of SOURCES) raw[s.file] = await get(s.url, s.max);
    repos = await pinRepos();
    const chainlist = repos.find((r) => r.repo === "DefiLlama/chainlist");
    if (chainlist?.revision)
      chainlistText = (
        await get(
          `https://raw.githubusercontent.com/DefiLlama/chainlist/${chainlist.revision}/constants/chainIds.js`,
          MAX.chainlist,
          "text/plain",
        )
      ).toString("utf8");
  }
  const fetchedAt = new Date().toISOString();
  const parsed: Record<string, unknown> = {};
  for (const s of SOURCES) {
    parsed[s.file] = safeJsonParse(raw[s.file].toString("utf8"));
    const rows =
      s.file === "config.json"
        ? Object.keys(
            (parsed[s.file] as { chainCoingeckoIds?: object })
              ?.chainCoingeckoIds ?? {},
          ).length
        : Array.isArray(parsed[s.file])
          ? (parsed[s.file] as unknown[]).length
          : 0;
    sources.push({
      id: s.id,
      url: fixture ? `https://fixture.invalid/${s.file}` : s.url,
      sha256: sha256(raw[s.file]),
      bytes: raw[s.file].length,
      fetchedAt,
      rows,
    });
  }
  const chainlist = chainlistText
    ? parseChainlistText(chainlistText)
    : undefined;
  if (chainlistText) {
    const pin = repos.find((r) => r.repo === "DefiLlama/chainlist")?.revision;
    sources.push({
      id: "defillama-chainlist-chainids",
      url: pin
        ? `https://raw.githubusercontent.com/DefiLlama/chainlist/${pin}/constants/chainIds.js`
        : "https://fixture.invalid/chainIds.js",
      sha256: sha256(chainlistText),
      bytes: Buffer.byteLength(chainlistText),
      fetchedAt,
      rows: Object.keys(chainlist ?? {}).length,
    });
  }
  let previous: Universe | undefined;
  if (existsSync(PREVIOUS)) {
    try {
      previous = parseUniverse(readFileSync(PREVIOUS, "utf8"));
    } catch {
      throw Error(
        "LAST_GOOD_CATALOG_CORRUPT: refusing to overwrite without a readable last-good catalog",
      );
    }
  }
  const rawSources = {
    protocols: parsed["protocols.json"],
    chains: parsed["chains.json"],
    config: parsed["config.json"],
  };
  const result = normalizeUniverse(rawSources, {
    syncId,
    generatedAt: fetchedAt,
    sources,
    previous,
    identities: identities(),
    chainlist,
  });
  const parity = auditParity(rawSources, result);
  const diff = universeDiff(previous, result.universe);
  const checks = anomalyChecks(
    previous,
    result.universe,
    diff,
    parity,
    acceptReview,
  );
  const accepted = syncAccepted(checks);
  const index = buildIndex(result.universe, "candidate");
  const coverage = coverageReport(index);
  const reasons = (list: { reason: string }[]) =>
    list.reduce<Record<string, number>>(
      (a, x) => ((a[x.reason] = (a[x.reason] ?? 0) + 1), a),
      {},
    );
  const receipt = {
    syncId,
    mode: fixture ? "fixture" : "live",
    dryRun,
    accepted,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    previous: previous
      ? { syncId: previous.syncId, stats: previous.stats }
      : null,
    sources,
    pinnedRepositories: repos,
    stats: result.universe.stats,
    parity,
    anomalyChecks: checks,
    acceptedReviewCodes: [...acceptReview],
    diffCounts: diff.counts,
    unmappedChainReasons: reasons(result.unmappedChains),
    unmappedProtocolReasons: reasons(result.unmappedProtocols),
    aliasReview: result.aliasReview,
    newCategories: result.newCategories,
    coverage: {
      protocolHeadline: coverage.protocolHeadline,
      protocolChainRows: coverage.protocolChainRows,
      tvlWeighted: coverage.tvlWeighted,
      chainsByVm: coverage.chainsByVm,
      chainCapabilities: coverage.chainCapabilities,
    },
    financialLogicChanged: false,
    outputs: {} as Record<string, string>,
  };
  const cacheDir = join(".otherbridge/data-cache/defi-universe", syncId);
  if (!fixture) {
    mkdirSync(cacheDir, { recursive: true });
    for (const s of SOURCES) writeFileSync(join(cacheDir, s.file), raw[s.file]);
    if (chainlistText)
      writeFileSync(join(cacheDir, "chainIds.js.txt"), chainlistText);
  }
  const files: Record<string, string> = {
    "universe.generated.json": serializeUniverse(result.universe),
    "unmapped-chains.json": writeLines(result.unmappedChains),
    "unmapped-protocols.json": writeLines(result.unmappedProtocols),
    "diff.generated.json": JSON.stringify(diff, null, 1) + "\n",
    "sources.json":
      JSON.stringify({ syncId, sources, pinnedRepositories: repos }, null, 2) +
      "\n",
  };
  for (const [name, content] of Object.entries(files))
    receipt.outputs[name] = sha256(content);
  const markdown = diffMarkdown(
    diff,
    result.universe.stats,
    `DeFi universe sync diff — ${syncId}`,
  );
  if (accepted && !dryRun) {
    for (const [name, content] of Object.entries(files))
      atomicWrite(join(DATA, name), content);
    atomicWrite(
      join(DATA, "sync-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    if (!value("--out")) atomicWrite("docs/DEFI_UNIVERSE_DIFF.md", markdown);
  } else if (!accepted) {
    atomicWrite(
      // An explicit --out (fixture/test runs) keeps rejected receipts beside its own output, never in the repo cache.
      join(
        value("--out")
          ? join(DATA, "rejected")
          : ".otherbridge/data-cache/defi-universe/rejected",
        syncId + ".json",
      ),
      JSON.stringify({ receipt, diff }, null, 2),
    );
  }
  if (evidence) {
    const dir = join(
      evidence,
      accepted ? "universe" : "failed-attempts",
      syncId,
    );
    mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files))
      writeFileSync(join(dir, name), content);
    writeFileSync(
      join(dir, "sync-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
    );
    writeFileSync(join(dir, "DIFF.md"), markdown);
    if (!fixture) {
      const src = join(evidence, "sources", syncId);
      mkdirSync(src, { recursive: true });
      for (const s of SOURCES)
        copyFileSync(join(cacheDir, s.file), join(src, s.file));
      if (chainlistText)
        writeFileSync(join(src, "chainIds.js.txt"), chainlistText);
    }
  }
  console.log(
    JSON.stringify(
      {
        syncId,
        accepted,
        dryRun,
        stats: result.universe.stats,
        parity: parity.pass,
        failedChecks: checks.filter((c) => !c.pass).map((c) => c.code),
        durationMs: receipt.durationMs,
      },
      null,
      1,
    ),
  );
  if (!accepted) {
    console.error(
      "SYNC_REJECTED: last-good catalog unchanged. Review the rejected receipt; accept only reviewed overridable codes with --accept-review=CODE.",
    );
    process.exitCode = 2;
  }
}
main().catch((e) => {
  console.error(
    "SYNC_FAILED:",
    e instanceof Error ? e.message : e,
    "— last-good catalog unchanged",
  );
  process.exitCode = 1;
});
