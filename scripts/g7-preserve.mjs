// V1.7 G7-prep preflight / preservation (read-only with respect to everything except the new G7 evidence root).
// `start`: creates a unique evidence root, measures HEAD/branch/status/tooling/own processes and hashes every
//          non-excluded file (source + all prior evidence) so the end of the run can prove preservation.
// `end`:   re-hashes, compares with the start inventory and writes the source inventory/checkpoint
//          (V1.6 method: SHA-256 of the canonical sorted JSON path -> content SHA-256 map).
// Usage: node scripts/g7-preserve.mjs start | end
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const REPO = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
const POINTER = join(REPO, ".otherbridge", "g7-evidence-path.txt");
const EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  "test-results",
  "playwright-report",
]);
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const git = (...args) =>
  execFileSync("git", args, {
    cwd: REPO,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
const mode = process.argv[2];

function walk(evidenceRoot) {
  const source = {},
    evidence = {};
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const rel = relative(REPO, abs).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        if (evidenceRoot && rel === evidenceRoot) continue; // the run's own output
        visit(abs);
      } else if (entry.isFile() && !rel.endsWith(".tsbuildinfo")) {
        (rel.startsWith("evidence/") ? evidence : source)[rel] = sha(
          readFileSync(abs),
        );
      }
    }
  };
  visit(REPO);
  return { source, evidence };
}

const inScope = (p) =>
  /^(src|public|tests|scripts|services|packages|infra|docs|\.github)\//.test(
    p,
  ) ||
  /^(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json|next\.config\.ts|next-env\.d\.ts|eslint\.config\.mjs|vitest\.config\.ts|playwright\.config\.ts|\.env\.example|\.gitignore|\.prettierignore|\.dockerignore|README\.md)$/.test(
    p,
  );

// V1.6/V1.5 protected financial, firewall, gate and route files: must stay byte-identical in V1.7.
export const PROTECTED = [
  "src/g5/route-pins.ts",
  "src/g5/reserve.ts",
  "src/g5/status.ts",
  "src/g5/payout-proof.ts",
  "src/security/firewall.ts",
  "src/security/invariants.ts",
  "src/routing/model.ts",
  "src/routing/fee-policy.ts",
  "src/adapters/onebridge.ts",
  "src/adapters/native-abi.ts",
  "src/adapters/native-decoder.ts",
  "src/adapters/native-service.ts",
  "src/adapters/read-only.ts",
  "src/adapters/deployment.ts",
  "src/adapters/reserve-evidence.ts",
  "src/features/bridge/submission.ts",
  "src/features/wallet/provider.ts",
  "src/core/model.ts",
  "src/core/flow.ts",
  "scripts/verify-safety.mjs",
  "scripts/g5-v16-lib.mjs",
  "scripts/g5-v16-simulate.mjs",
  "scripts/g5-v16-snapshot.mjs",
  "scripts/g5-v16-inflight.mjs",
  "scripts/g5-v16-bsc-ledger.mjs",
  "scripts/g5-v16-drift-recheck.mjs",
  "scripts/g5-v16-payout-proof.mjs",
  "scripts/g5-v16-proof-lib.mjs",
  "tests/unit/v16-g5.test.ts",
  "tests/unit/v15-firewall.test.ts",
  "tests/integration/native-replay.test.ts",
  "pnpm-lock.yaml",
  ".env.example",
  "docs/G5_FINAL_EVIDENCE.md",
  "docs/G5_FINAL_AUTONOMOUS_CLOSURE.md",
  "docs/G5_RESERVE_RECONCILIATION.md",
  "docs/G5_LEGACY_RUNTIME_SECURITY_REVIEW.md",
  "docs/G7_CONTROLLED_PILOT_PLAN.md",
  "docs/TRANSACTION_FIREWALL_SPEC.md",
  "GOAL_OTHERBRIDGE_V1_7_G7_CONTROLLED_PILOT_PREP_ONLY.md",
  "AGENTS.md",
  "CLAUDE.md",
];

function processes() {
  // Own processes = command line references this repository (MCP/editor helpers are not Otherbridge-owned).
  try {
    const out = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'otherbridge' -and $_.Name -match 'node|python|next|docker' } | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", timeout: 60000 },
    ).trim();
    const list = out ? [].concat(JSON.parse(out)) : [];
    return list.filter((p) => p.ProcessId !== process.pid);
  } catch (e) {
    return [{ error: String(e.message ?? e).slice(0, 200) }];
  }
}
function listeners() {
  try {
    const out = execFileSync("netstat", ["-ano", "-p", "TCP"], {
      encoding: "utf8",
      timeout: 30000,
    });
    return out
      .split(/\r?\n/)
      .filter((l) => /LISTENING/.test(l) && /:(3100|3101|3200|3300)\s/.test(l))
      .map((l) => l.trim());
  } catch (e) {
    return [`ERR ${e}`];
  }
}

if (mode === "start") {
  if (existsSync(POINTER))
    throw new Error(
      `G7 evidence pointer already exists (${readFileSync(POINTER, "utf8").trim()}); refusing to overwrite`,
    );
  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  const runId = `g7prep-${stamp}Z-${randomBytes(3).toString("hex")}`;
  const root = `evidence/otherbridge-g7-prep/${runId}`;
  mkdirSync(join(REPO, root, "preflight"), { recursive: true });
  writeFileSync(POINTER, root + "\n");
  const { source, evidence } = walk(root);
  const statusShort = git("status", "--short");
  const tooling = {
    node: process.version,
    pnpm: execFileSync("pnpm", ["-v"], {
      encoding: "utf8",
      shell: true,
    }).trim(),
  };
  const protectedHashes = Object.fromEntries(
    PROTECTED.map((p) => [p, source[p] ?? null]),
  );
  const pre = {
    at: new Date().toISOString(),
    runId,
    evidenceRoot: root,
    head: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    remote: git("remote", "-v") || null,
    statusShortLines: statusShort.split(/\r?\n/).filter(Boolean).length,
    untrackedCount: git("ls-files", "--others", "--exclude-standard")
      .split(/\r?\n/)
      .filter(Boolean).length,
    tooling,
    platform: `${process.platform} ${process.arch}`,
    ownProcesses: processes(),
    listenersOnProjectPorts: listeners(),
    sourceFiles: Object.keys(source).length,
    evidenceFiles: Object.keys(evidence).length,
    protectedMissing: PROTECTED.filter((p) => !source[p]),
    noResetCleanStash: true,
  };
  const dir = join(REPO, root, "preflight");
  writeFileSync(join(dir, "git-status-short.txt"), statusShort + "\n");
  writeFileSync(join(dir, "preflight.json"), JSON.stringify(pre, null, 1));
  writeFileSync(
    join(dir, "source-hashes.json"),
    JSON.stringify(source, null, 0),
  );
  writeFileSync(
    join(dir, "evidence-hashes.json"),
    JSON.stringify(evidence, null, 0),
  );
  writeFileSync(
    join(dir, "protected-hashes.json"),
    JSON.stringify(protectedHashes, null, 1),
  );
  console.log(JSON.stringify(pre, null, 1));
} else if (mode === "end") {
  const root = readFileSync(POINTER, "utf8").trim();
  const dir = join(REPO, root, "preflight");
  const out = join(REPO, root, "final");
  mkdirSync(out, { recursive: true });
  const preSource = JSON.parse(readFileSync(join(dir, "source-hashes.json")));
  const preEvidence = JSON.parse(
    readFileSync(join(dir, "evidence-hashes.json")),
  );
  const preProtected = JSON.parse(
    readFileSync(join(dir, "protected-hashes.json")),
  );
  const { source, evidence } = walk(root);
  const cmp = (before, after) => {
    const changed = [],
      missing = [];
    let identical = 0;
    for (const [p, h] of Object.entries(before)) {
      if (!(p in after)) missing.push(p);
      else if (after[p] !== h) changed.push(p);
      else identical++;
    }
    return {
      total: Object.keys(before).length,
      identical,
      changed,
      missing,
      added: Object.keys(after).filter((p) => !(p in before)),
    };
  };
  const ev = cmp(preEvidence, evidence);
  const src = cmp(preSource, source);
  const protectedResult = Object.fromEntries(
    Object.entries(preProtected).map(([p, h]) => [
      p,
      h !== null && source[p] === h,
    ]),
  );
  const untrackedStart = readFileSync(join(dir, "git-status-short.txt"), "utf8")
    .split(/\r?\n/)
    .filter((l) => l.startsWith("?? "))
    .map((l) => l.slice(3).replace(/^"|"$/g, ""));
  const untrackedPresent = untrackedStart.filter((p) =>
    existsSync(join(REPO, p)),
  ).length;
  const all = git("ls-files", "--cached", "--others", "--exclude-standard")
    .split(/\r?\n/)
    .filter(Boolean);
  const paths = all
    .filter((p) => inScope(p) && existsSync(join(REPO, p)))
    .sort();
  const files = Object.fromEntries(
    paths.map((p) => [p, sha(readFileSync(join(REPO, p)))]),
  );
  const sortedJson = JSON.stringify(
    Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((k) => [k, files[k]]),
    ),
  );
  const checkpoint = sha(sortedJson);
  const inventory = {
    at: new Date().toISOString(),
    head: git("rev-parse", "HEAD"),
    branch: git("branch", "--show-current"),
    checkpoint,
    checkpointMethod:
      "SHA256 of canonical sorted JSON path -> content SHA256 map (V1.6 method)",
    excludedDerived: [
      "OTHERBRIDGE_V1_HANDOFF.md, .otherbridge/EXECUTION_STATE.md (prepended after this inventory)",
    ],
    fileCount: paths.length,
    files,
  };
  const preservation = {
    at: inventory.at,
    priorEvidence: {
      files: ev.total,
      byteIdentical: ev.identical,
      changed: ev.changed,
      missing: ev.missing,
    },
    startOfRunSource: {
      files: src.total,
      unchanged: src.identical,
      changed: src.changed,
      missing: src.missing,
      added: src.added,
    },
    protectedUnchanged: protectedResult,
    protectedAllUnchanged: Object.values(protectedResult).every(Boolean),
    lockfileUnchanged: preSource["pnpm-lock.yaml"] === source["pnpm-lock.yaml"],
    startOfRunUntracked: untrackedStart.length,
    startOfRunUntrackedPresent: untrackedPresent,
    ownProcessesAtEnd: processes(),
    listenersOnProjectPortsAtEnd: listeners(),
  };
  writeFileSync(
    join(out, "source-inventory.json"),
    JSON.stringify(inventory, null, 1),
  );
  writeFileSync(
    join(out, "preservation.json"),
    JSON.stringify(preservation, null, 1),
  );
  console.log(
    JSON.stringify(
      {
        checkpoint,
        files: paths.length,
        priorEvidence: `${ev.identical}/${ev.total}`,
        evidenceChanged: ev.changed.length,
        evidenceMissing: ev.missing.length,
        sourceChanged: src.changed,
        sourceMissing: src.missing.length,
        added: src.added,
        protectedAllUnchanged: preservation.protectedAllUnchanged,
        lockfileUnchanged: preservation.lockfileUnchanged,
        untracked: `${untrackedPresent}/${untrackedStart.length}`,
        ownProcessesAtEnd: preservation.ownProcessesAtEnd.length,
        listenersAtEnd: preservation.listenersOnProjectPortsAtEnd,
      },
      null,
      1,
    ),
  );
} else {
  throw new Error("usage: node scripts/g7-preserve.mjs start|end");
}
