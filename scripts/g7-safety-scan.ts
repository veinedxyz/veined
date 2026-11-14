// V1.7 G7-prep static safety scan: proves at code level that the G7 preparation/tracking tools cannot sign,
// broadcast, approve, permit, deploy, prompt a wallet or read key material, that the application does not import
// them, and that the frozen execution/fee/registry invariants are unchanged. Exit code 1 on any finding.
// This file holds the pattern definitions and is therefore listed as an explicit, reported self-exclusion.
// Usage: node --experimental-transform-types --import ./scripts/ts-hooks.mjs scripts/g7-safety-scan.ts [outJson]
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rel = (p: string) => p.replaceAll("\\", "/");

export const G7_RUNTIME_FILES = [
  ...readdirSync(join(REPO, "src", "g7"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `src/g7/${f}`),
  "scripts/g7-prepare.ts",
  "scripts/g7-track.ts",
  "scripts/g7-docs.ts",
  "scripts/g7-preserve.mjs",
].filter((f) => existsSync(join(REPO, f)));
// Packaging helper (not a runtime tool): it legitimately contains secret-detection patterns, so it is scanned
// with the signing/broadcast/local-account rules only. Reported, not silently skipped.
export const G7_PACKAGING_FILES = ["scripts/g7-bundle.py"].filter((f) =>
  existsSync(join(REPO, f)),
);

export const SELF_EXCLUSIONS = [
  {
    path: "scripts/g7-safety-scan.ts",
    reason: "defines the forbidden patterns (scanner itself)",
  },
  {
    path: "tests/unit/g7-prep.test.ts",
    reason:
      "names the forbidden methods to assert they are refused before any request",
  },
];

// Signing / broadcasting / wallet / key-material / approval / deployment surfaces.
const FORBIDDEN: [string, RegExp][] = [
  ["rpc-send-transaction", /eth_sendTransaction/],
  ["rpc-send-raw-transaction", /eth_sendRawTransaction/],
  ["rpc-sign", /\beth_sign\b/],
  ["rpc-sign-transaction", /eth_signTransaction/],
  ["rpc-sign-typed-data", /eth_signTypedData/],
  ["rpc-personal-sign", /personal_sign/],
  ["rpc-wallet-namespace", /\bwallet_[A-Za-z]/],
  ["rpc-request-accounts", /eth_requestAccounts|eth_accounts/],
  [
    "client-sign-or-send",
    /\b(signTransaction|signMessage|signTypedData|sendTransaction|sendRawTransaction|writeContract|deployContract|sendCalls)\b/,
  ],
  [
    "local-account",
    /\b(privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic|createWalletClient)\b/,
  ],
  ["viem-accounts-import", /from\s+["']viem\/accounts["']/],
  ["injected-wallet", /window\.ethereum|ethereum\.request|\bEIP1193\b/],
  ["approve-call", /\bapprove\s*\(|\bincreaseAllowance\s*\(/],
  ["permit-call", /\bpermit\s*\(|\bsafePermit\s*\(/],
  ["key-material-env", /PRIVATE_?KEY|MNEMONIC|SEED_?PHRASE|\bSEED\b/i],
  ["environment-read", /process\.env/],
];

const ALLOWED_IMPORTS = [
  /^node:(crypto|fs|path|url|child_process)$/,
  /^viem$/,
  /^@noble\/hashes\/sha3\.js$/,
  /^\.\.?\//,
];
const FORBIDDEN_VIEM_NAMES =
  /\b(createWalletClient|privateKeyToAccount|signTransaction|sendTransaction|writeContract|deployContract|walletActions|custom)\b/;

export interface CandidateBaseline {
  path: string;
  sha256: string;
  scope: "dry-validation" | "fixture-validation";
}
export function candidateScanArgs(
  argv: string[],
): CandidateBaseline | undefined {
  const i = argv.indexOf("--candidate-baseline");
  if (i < 0) return undefined;
  return {
    path: argv[i + 1],
    sha256: argv[argv.indexOf("--candidate-sha256") + 1],
    scope: "dry-validation",
  };
}
export function scanG7Sources(candidate?: CandidateBaseline) {
  const findings: { file: string; rule: string; line: number; text: string }[] =
    [];
  const imports: Record<string, string[]> = {};
  const packagingRules = new Set([
    "rpc-send-transaction",
    "rpc-send-raw-transaction",
    "rpc-sign",
    "rpc-sign-transaction",
    "rpc-sign-typed-data",
    "rpc-personal-sign",
    "client-sign-or-send",
    "local-account",
  ]);
  for (const file of G7_PACKAGING_FILES)
    readFileSync(join(REPO, file), "utf8")
      .split(/\r?\n/)
      .forEach((line, idx) => {
        for (const [rule, re] of FORBIDDEN)
          if (packagingRules.has(rule) && re.test(line))
            findings.push({ file, rule, line: idx + 1, text: line.trim() });
      });
  for (const file of G7_RUNTIME_FILES) {
    const text = readFileSync(join(REPO, file), "utf8");
    text.split(/\r?\n/).forEach((line, idx) => {
      for (const [rule, re] of FORBIDDEN)
        if (re.test(line))
          findings.push({ file, rule, line: idx + 1, text: line.trim() });
    });
    const specs = [
      ...text.matchAll(/(?:import|export)[^;]*?from\s+["']([^"']+)["']/g),
    ].map((m) => m[1]);
    imports[file] = specs;
    for (const s of specs)
      if (!ALLOWED_IMPORTS.some((re) => re.test(s)))
        findings.push({
          file,
          rule: "dependency-not-allowed",
          line: 0,
          text: s,
        });
    for (const m of text.matchAll(
      /import\s*\{([^}]*)\}\s*from\s*["']viem["']/g,
    ))
      if (FORBIDDEN_VIEM_NAMES.test(m[1]))
        findings.push({ file, rule: "viem-write-api", line: 0, text: m[1] });
  }
  // The application must not import the G7 tools (no UI/route path, no wallet prompt, no send button).
  const appImporters: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (p !== "src/g7") walk(p);
      } else if (/\.(ts|tsx)$/.test(e.name)) {
        if (/["'][./@]*\/?g7\//.test(readFileSync(join(REPO, p), "utf8")))
          appImporters.push(p);
      }
    }
  };
  walk("src");
  for (const p of appImporters)
    findings.push({
      file: p,
      rule: "application-imports-g7",
      line: 0,
      text: "",
    });

  // Frozen invariants (same assertions as verify-safety, re-checked here for the G7 run).
  const read = (p: string) => readFileSync(join(REPO, p), "utf8");
  const invariants = {
    globalExecutionDisabled: /GLOBAL_EXECUTION_ENABLED = false as const/.test(
      read("src/g5/route-pins.ts"),
    ),
    writeRegistryEmpty:
      /contractRegistry: readonly ContractEntry\[\] = Object\.freeze\(\[\]\)/.test(
        read("src/security/firewall.ts"),
      ),
    globalKillOn: /global: true,/.test(read("src/security/firewall.ts")),
    feeZeroBps: /enabled: false,\s*bps: 0,\s*maxBps: 10/.test(
      read("src/routing/fee-policy.ts"),
    ),
    executionGateClosed: (() => {
      const m = read("src/routing/model.ts");
      return (
        /enabled:\s*false/.test(m) &&
        ["sign", "approve", "broadcast", "deploy"].every((k) =>
          new RegExp(`${k}:\\s*null`).test(m),
        )
      );
    })(),
    mainnetSubmissionFalseInEnvExample: read(".env.example").includes(
      "OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION=false",
    ),
    // Variable NAMES only (`NAME=` lines); comment lines are reported below, not counted as env names.
    noKeyEnvNamesInEnvExample: read(".env.example")
      .split(/\r?\n/)
      .map((l) => /^\s*([A-Za-z0-9_]+)\s*=/.exec(l)?.[1])
      .every((name) => !name || !/PRIVATE_?KEY|MNEMONIC|SEED/i.test(name)),
  };
  const envExampleCommentMentions = read(".env.example")
    .split(/\r?\n/)
    .map((l, i) => ({ line: i + 1, text: l.trim() }))
    .filter(
      (l) => l.text.startsWith("#") && /private|seed|mnemonic/i.test(l.text),
    );
  for (const [k, v] of Object.entries(invariants))
    if (!v)
      findings.push({ file: "-", rule: `invariant:${k}`, line: 0, text: "" });

  // Write registry / firewall / gate files unchanged versus the start-of-run inventory (when present).
  let protectedUnchanged: Record<string, boolean> | null = null;
  const pointer = join(REPO, ".otherbridge", "g7-evidence-path.txt");
  // V1.9: a reviewed re-baseline (after an approved change to protected files) is named explicitly by
  // `.otherbridge/g7-protected-baseline.txt` (path of its protected-hashes.json plus its review record); otherwise
  // the start-of-run inventory of the current G7 evidence root applies, as before.
  const rebaseline = join(REPO, ".otherbridge", "g7-protected-baseline.txt");
  if (existsSync(pointer) || existsSync(rebaseline)) {
    const acceptedFile = existsSync(rebaseline)
      ? join(REPO, readFileSync(rebaseline, "utf8").trim())
      : join(
          REPO,
          readFileSync(pointer, "utf8").trim(),
          "preflight",
          "protected-hashes.json",
        );
    const acceptedHashes = existsSync(acceptedFile)
      ? (JSON.parse(readFileSync(acceptedFile, "utf8")) as Record<
          string,
          string
        >)
      : {};
    let pf = acceptedFile;
    if (candidate) {
      const permitted = new Set([
        ...Object.keys(acceptedHashes),
        "src/g7/witness-pool.ts",
        "src/g7/witness-logs.ts",
        "src/g7/in-flight-reserve.ts",
        "src/data/store/g7-cache.ts",
        "scripts/v112-g7-diagnostics.ts",
        "scripts/v112-seed-checkpoint.ts",
        "src/g7/write-evidence.ts",
        "src/features/wallet/adapter.ts",
      ]);
      const safePath =
        /^evidence\/otherbridge-v1-12-1\/[A-Za-z0-9._-]+\/protected\/candidate\.json$/.test(
          candidate.path,
        ) && !candidate.path.includes("..");
      const cp = join(REPO, candidate.path);
      let valid =
        safePath &&
        /^(dry|fixture)-validation$/.test(candidate.scope) &&
        /^[0-9a-f]{64}$/.test(candidate.sha256) &&
        existsSync(cp);
      if (valid) {
        valid =
          createHash("sha256").update(readFileSync(cp)).digest("hex") ===
          candidate.sha256;
        if (valid) {
          try {
            const h = JSON.parse(readFileSync(cp, "utf8")) as Record<
              string,
              string
            >;
            valid =
              h !== null &&
              !Array.isArray(h) &&
              typeof h === "object" &&
              Object.keys(h).length === permitted.size &&
              [...permitted].every((p) => /^[0-9a-f]{64}$/.test(h[p]));
          } catch {
            valid = false;
          }
        }
      }
      if (valid) pf = cp;
      else
        findings.push({
          file: candidate.path ?? "candidate",
          rule: "candidate-baseline-invalid",
          line: 0,
          text: "",
        });
    }
    if (
      existsSync(rebaseline) &&
      !existsSync(
        join(
          dirname(acceptedFile),
          "..",
          "g7-rebaseline",
          "PROTECTED_REBASELINE_REVIEW.json",
        ),
      )
    )
      findings.push({
        file: ".otherbridge/g7-protected-baseline.txt",
        rule: "rebaseline-without-review-record",
        line: 0,
        text: "",
      });
    if (existsSync(pf)) {
      const hashes = JSON.parse(readFileSync(pf, "utf8")) as Record<
        string,
        string | null
      >;
      protectedUnchanged = Object.fromEntries(
        Object.entries(hashes).map(([p, h]) => [
          p,
          existsSync(join(REPO, p)) &&
            createHash("sha256")
              .update(readFileSync(join(REPO, p)))
              .digest("hex") === h,
        ]),
      );
      for (const [p, ok] of Object.entries(protectedUnchanged))
        if (!ok)
          findings.push({
            file: p,
            rule: "protected-file-changed",
            line: 0,
            text: "",
          });
    }
  }
  const pkg = JSON.parse(read("package.json")) as {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  };
  // G14 closure: canary inventory + canary invariants (added content findings).
  const canary = scanCanaryInventory();
  findings.push(...canary.findings);
  return {
    at: new Date().toISOString(),
    pass: findings.length === 0,
    filesScanned: G7_RUNTIME_FILES.map(rel),
    packagingFilesScanned: G7_PACKAGING_FILES.map(rel),
    selfExclusions: SELF_EXCLUSIONS,
    rules: FORBIDDEN.map(([r, re]) => ({ rule: r, pattern: String(re) })),
    imports,
    applicationImportsG7: appImporters,
    invariants,
    envExampleCommentMentions,
    protectedUnchanged,
    protectedBaselinePass:
      protectedUnchanged !== null &&
      Object.values(protectedUnchanged).every(Boolean) &&
      !findings.some((f) =>
        /candidate-baseline|rebaseline-without/.test(f.rule),
      ),
    contentPass: !findings.some(
      (f) =>
        ![
          "protected-file-changed",
          "candidate-baseline-invalid",
          "rebaseline-without-review-record",
        ].includes(f.rule),
    ),
    baselineScope: candidate?.scope ?? "accepted",
    baselineSelection: candidate ?? null,
    dependencies: { ...pkg.dependencies },
    canaryInventory: {
      files: canary.inventory.length,
      digest: canary.digest,
      hashes: canary.hashes,
    },
    findings,
  };
}

// G14 closure: the canary path's PROPOSED protected inventory, hashed here (src/execution/server/canary/inventory.ts).
// These findings are added to the scan's content findings; the accepted baseline comparison above is unchanged.
// A canary-directory file outside the inventory, a missing inventory file, an armed owner record, a true wiring
// constant or a second canary selector is a finding.
export function scanCanaryInventory(root = REPO) {
  const findings: { file: string; rule: string; line: number; text: string }[] =
    [];
  const at = (p: string) => join(root, p);
  const text = (p: string) =>
    existsSync(at(p)) ? readFileSync(at(p), "utf8") : null;
  const listText = text("src/execution/server/canary/inventory.ts") ?? "";
  const inventory = [...listText.matchAll(/^\s*"([A-Za-z0-9_./-]+)",$/gm)].map(
    (m) => m[1],
  );
  const hashes: Record<string, string | null> = {};
  for (const p of inventory) {
    const t = existsSync(at(p)) ? readFileSync(at(p)) : null;
    hashes[p] = t ? createHash("sha256").update(t).digest("hex") : null;
    if (!t)
      findings.push({
        file: p,
        rule: "canary-inventory-missing",
        line: 0,
        text: "",
      });
  }
  const dir = "src/execution/server/canary";
  if (existsSync(at(dir)))
    for (const f of readdirSync(at(dir)))
      if (/\.(ts|tsx)$/.test(f) && !inventory.includes(`${dir}/${f}`))
        findings.push({
          file: `${dir}/${f}`,
          rule: "canary-inventory-unlisted",
          line: 0,
          text: "",
        });
  const approval = text("src/security/canary-approval.ts") ?? "";
  if (
    !/export const OWNER_CANARY_APPROVAL =\s+null as Readonly<OwnerCanaryApproval> \| null;/.test(
      approval,
    )
  )
    findings.push({
      file: "src/security/canary-approval.ts",
      rule: "canary-owner-record-armed",
      line: 0,
      text: "",
    });
  if (
    !/export const CANARY_LIVE_WIRING = false as const;/.test(
      text("src/execution/server/gate.ts") ?? "",
    )
  )
    findings.push({
      file: "src/execution/server/gate.ts",
      rule: "canary-wiring-on",
      line: 0,
      text: "",
    });
  const firewall = text("src/security/firewall.ts") ?? "";
  const entry = firewall.slice(
    firewall.indexOf("export const canaryContractEntry"),
  );
  const selectors = [
    ...entry
      .slice(0, entry.indexOf("});"))
      .matchAll(/selector: "(0x[0-9a-f]{8})"/g),
  ].map((m) => m[1]);
  if (selectors.length !== 1 || selectors[0] !== "0x1794958f")
    findings.push({
      file: "src/security/firewall.ts",
      rule: "canary-selector-scope",
      line: 0,
      text: selectors.join(","),
    });
  return {
    inventory,
    hashes,
    digest: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
    findings,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const result = scanG7Sources(candidateScanArgs(process.argv.slice(2)));
  const out = process.argv[2];
  if (out) writeFileSync(out, JSON.stringify(result, null, 1));
  console.log(
    JSON.stringify(
      {
        pass: result.pass,
        filesScanned: result.filesScanned.length,
        findings: result.findings,
        invariants: result.invariants,
        applicationImportsG7: result.applicationImportsG7,
      },
      null,
      1,
    ),
  );
  process.exit(result.pass ? 0 : 1);
}
