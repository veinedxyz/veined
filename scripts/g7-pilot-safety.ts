// G7 pilot static safety scan. Proves at code level that:
//  - the server side (CLI, preflight, tracker, session, HTTP server) contains no wallet method, signer, key
//    material, raw-transaction, approval/permit, deploy, environment or child-process surface at all;
//  - the browser page contains exactly ONE send-transaction call, inside requestWalletConfirmationOnce(), and no
//    other write/sign method, no HTML sinks, no eval, no automatic clicks, no password/secret input, no
//    cross-origin fetch, no inline script or handler;
//  - the in-product pilot module (scripts/g7-pilot/product) has exactly ONE send call, in wallet-send.ts inside
//    requestWalletConfirmationOnce(), and the same client restrictions; the product launcher only writes its gate env;
//    since V1.9 that call is the active Privy-connected wallet's adapter (wallet.sendCanonicalTransaction with the
//    g7-local-pilot gate) and the RPC method literal exists only once, in src/features/wallet/adapter.ts;
//  - the application (src/) references the pilot only from three gate files: the server-side gate, the app layout and a
//    constant-folded dynamic import in product.tsx; next.config keeps the public build at bundle constant "0" in
//    `.next` and builds/serves the local-g7-pilot profile only in its own directory through the launcher;
//  - the launcher's process supervision (os-probe, supervisor, stop command) is read-only toward other processes:
//    one fixed shell-less execFile import, liveness probes `process.kill(pid, 0)` and exactly one verified stop;
//  - the pilot build script cannot set the runtime pilot flag and has no wallet/signer/key surface;
//  - the frozen G7/G5 invariants and protected files hold.
// This file defines the patterns and is therefore its own reported self-exclusion. Exit code 1 on any finding.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  scanG7Sources,
  candidateScanArgs,
  type CandidateBaseline,
} from "./g7-safety-scan";
import { G7_PILOT_PROFILES, g7BuildProfile } from "../next.config";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(REPO, p), "utf8");
export const PILOT_SERVER_FILES = [
  "scripts/g7-pilot.ts",
  "scripts/g7-product-pilot.ts",
  "scripts/g7-pilot-stop.ts",
  ...readdirSync(join(REPO, "scripts", "g7-pilot"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => `scripts/g7-pilot/${f}`),
];
export const PILOT_CLIENT_SCRIPT = "scripts/g7-pilot/client/app.js";
export const PILOT_CLIENT_HTML = "scripts/g7-pilot/client/index.html";
export const PRODUCT_PILOT_FILES = readdirSync(
  join(REPO, "scripts", "g7-pilot", "product"),
)
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => `scripts/g7-pilot/product/${f}`);
export const PRODUCT_SEND_FILE = "scripts/g7-pilot/product/wallet-send.ts";
export const WALLET_ADAPTER_FILE = "src/features/wallet/adapter.ts";
const CANONICAL_SEND = /\.sendCanonicalTransaction\(/;
// The only src/ files allowed to mention the local pilot.
export const PRODUCT_INTEGRATION_FILES = [
  "src/components/product.tsx",
  // V1.11: the app shell (and with it the server-side pilot gate) moved from the root layout into the (app) route
  // group, so the public landing page and /docs never load it.
  "src/app/(app)/layout.tsx",
  "src/server/g7-local-pilot.ts",
  // V1.9: the wallet adapter names "g7-local-pilot" as one of its two execution-gate ids (checked below: the id
  // string only, no import of pilot code).
  "src/features/wallet/adapter.ts",
] as const;
export const OS_PROBE_FILE = "scripts/g7-pilot/os-probe.ts";
export const PILOT_BUILD_SCRIPT = "scripts/g7-pilot-build.ts";
// Process supervision: the only child-process surface is the read-only OS probe's shell-less execFile import, and
// signals are liveness probes except the stop command's single kill of a launcher it has verified.
const ALLOWED_CHILD_PROCESS_LINES: Record<string, RegExp[]> = {
  [OS_PROBE_FILE]: [/^import \{ execFile \} from "node:child_process";$/],
};
const ALLOWED_KILL_LINES: Record<string, RegExp[]> = {
  "scripts/g7-pilot/supervisor.ts": [/^process\.kill\(pid, 0\);$/],
  "scripts/g7-pilot-stop.ts": [
    /^process\.kill\(pid, 0\);$/,
    /^process\.kill\(record\.pid\);$/,
  ],
};
// The launcher may refuse production and set the server-side gate inputs, nothing else from the environment.
const LAUNCHER_ENV_LINES = [
  /^if \(process\.env\.NODE_ENV === "production"\)$/,
  /^Object\.assign\(process\.env, \{$/,
];
export const ALLOWED_WALLET_METHODS = [
  "eth_accounts",
  "eth_chainId",
  "eth_requestAccounts",
  "wallet_switchEthereumChain",
  "wallet_addEthereumChain",
  "eth_sendTransaction",
] as const;

const SEND = "eth_send" + "Transaction";
const SERVER_FORBIDDEN: [string, RegExp][] = [
  [
    "wallet-rpc-method",
    /\b(eth_send\w*|eth_sign\w*|personal_\w+|wallet_[A-Za-z]\w*|eth_requestAccounts|eth_accounts)\b/,
  ],
  ["injected-wallet", /window\.ethereum|eip6963/i],
  [
    "signer-or-writer",
    /\b(privateKeyToAccount|mnemonicToAccount|hdKeyToAccount|generatePrivateKey|generateMnemonic|createWalletClient|walletActions|signTransaction|signMessage|signTypedData|sendRawTransaction|sendTransaction|writeContract|deployContract|sendCalls)\b/,
  ],
  ["viem-accounts", /["']viem\/accounts["']/],
  [
    "key-material",
    /\b(privateKey|private_key|PRIVATE_KEY|mnemonic|MNEMONIC|seedPhrase|SEED_PHRASE|keystore)\b/,
  ],
  [
    "approve-or-permit-call",
    /\b(approve|increaseAllowance|permit|safePermit)\s*\(/,
  ],
  ["environment-read", /process\.env/],
  [
    "child-process",
    /child_process|\b(execSync|execFileSync|spawnSync|fork)\s*\(/,
  ],
  ["process-signal", /process\.kill\(/],
  ["non-loopback-bind", /0\.0\.0\.0|::\/|listen\(\s*\d/],
  ["cors-header", /access-control-allow/i],
];
const CLIENT_FORBIDDEN: [string, RegExp][] = [
  [
    "raw-or-sign-method",
    /eth_sendRaw|\beth_sign\b|eth_sign[A-Z]|signTypedData|personal_|eth_signTransaction/,
  ],
  [
    "approve-or-permit",
    /\b(approve|increaseAllowance|permit|safePermit)\s*\(|0x095ea7b3|0xd505accf/,
  ],
  [
    "html-sink",
    /innerHTML|outerHTML|insertAdjacentHTML|document\.write|srcdoc/,
  ],
  [
    "dynamic-code",
    /\beval\s*\(|new Function|setTimeout\(\s*["'`]|setInterval\(\s*["'`]/,
  ],
  [
    "automatic-click",
    /\.click\s*\(|new MouseEvent|new PointerEvent|dispatchEvent\(\s*new (?!Event\("eip6963:requestProvider"\))/,
  ],
  [
    "secret-input",
    /type\s*[=:]\s*["']password["']|privateKey|mnemonic|seedPhrase|keystore/,
  ],
  ["storage-of-tx", /localStorage/],
];

export function scanG7Pilot(candidate?: CandidateBaseline) {
  const findings: { file: string; rule: string; line: number; text: string }[] =
    [];
  const add = (file: string, rule: string, line = 0, text = "") =>
    findings.push({ file, rule, line, text });
  for (const file of PILOT_SERVER_FILES) {
    read(file)
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const [rule, re] of SERVER_FORBIDDEN)
          if (
            re.test(line) &&
            !(
              rule === "environment-read" &&
              file === "scripts/g7-product-pilot.ts" &&
              LAUNCHER_ENV_LINES.some((ok) => ok.test(line.trim()))
            ) &&
            !(
              rule === "child-process" &&
              (ALLOWED_CHILD_PROCESS_LINES[file] ?? []).some((ok) =>
                ok.test(line.trim()),
              )
            ) &&
            !(
              rule === "process-signal" &&
              (ALLOWED_KILL_LINES[file] ?? []).some((ok) =>
                ok.test(line.trim()),
              )
            )
          )
            add(file, rule, i + 1, line.trim());
      });
  }
  // ---- OS probe: exactly one shell-less execFile call with the fixed program allowlist
  {
    const probe = read(OS_PROBE_FILE);
    if (
      (probe.match(/\bexecFile\(/g) ?? []).length !== 1 ||
      !/shell: false/.test(probe) ||
      !/file: "powershell\.exe" \| "lsof" \| "ps"/.test(probe) ||
      /(^|[^.\w])(spawn|exec)\s*\(/m.test(probe)
    )
      add(OS_PROBE_FILE, "os-probe-not-fixed-read-only");
  }
  // ---- the stop command kills only after proving the recorded pid is our launcher
  {
    const stop = read("scripts/g7-pilot-stop.ts");
    const kill = stop.indexOf("process.kill(record.pid);");
    const guard = stop.indexOf("if (!isOurLauncher(proc) || !sameStart)");
    if (kill < 0 || guard < 0 || guard > kill)
      add("scripts/g7-pilot-stop.ts", "stop-kill-not-guarded");
  }
  // ---- pilot build script: never the runtime flag, no wallet/signer/key surface
  {
    const text = read(PILOT_BUILD_SCRIPT);
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [rule, re] of SERVER_FORBIDDEN)
        if (
          ![
            "environment-read",
            "child-process",
            "process-signal",
            "non-loopback-bind",
          ].includes(rule) &&
          re.test(line)
        )
          add(PILOT_BUILD_SCRIPT, rule, i + 1, line.trim());
      if (
        /OTHERBRIDGE_G7_LOCAL_PILOT\b/.test(line) &&
        !/^delete childEnv\.OTHERBRIDGE_G7_LOCAL_PILOT(_ORIGIN)?;$/.test(
          line.trim(),
        )
      )
        add(
          PILOT_BUILD_SCRIPT,
          "build-sets-runtime-pilot-flag",
          i + 1,
          line.trim(),
        );
    });
  }
  // ---- browser script
  const js = read(PILOT_CLIENT_SCRIPT);
  const lines = js.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const [rule, re] of CLIENT_FORBIDDEN)
      if (re.test(line)) add(PILOT_CLIENT_SCRIPT, rule, i + 1, line.trim());
  });
  const sendLines = lines
    .map((l, i) => (l.includes(SEND) ? i : -1))
    .filter((i) => i >= 0);
  const fnStart = lines.findIndex((l) =>
    l.startsWith("function requestWalletConfirmationOnce("),
  );
  const fnEnd =
    fnStart >= 0 ? lines.findIndex((l, i) => i > fnStart && l === "}") : -1;
  if (sendLines.length !== 1)
    add(
      PILOT_CLIENT_SCRIPT,
      `send-transaction-occurrences:${sendLines.length}`,
    );
  else if (!(sendLines[0] > fnStart && sendLines[0] < fnEnd))
    add(
      PILOT_CLIENT_SCRIPT,
      "send-transaction-outside-guarded-function",
      sendLines[0] + 1,
      lines[sendLines[0]].trim(),
    );
  const guard = fnStart >= 0 ? lines.slice(fnStart, fnEnd + 1).join("\n") : "";
  if (
    !/if \(ui\.sendAttempted\) throw/.test(guard) ||
    !/ui\.sendAttempted = true;/.test(guard)
  )
    add(PILOT_CLIENT_SCRIPT, "send-guard-missing");
  if ((js.match(/requestWalletConfirmationOnce\(/g) ?? []).length !== 2)
    add(PILOT_CLIENT_SCRIPT, "send-function-called-more-than-once");
  const methods = [
    ...new Set(
      [
        ...js.matchAll(
          /["'`]((?:eth|wallet|personal|net|web3)_[A-Za-z]+)["'`]/g,
        ),
      ].map((m) => m[1]),
    ),
  ];
  for (const m of methods)
    if (!(ALLOWED_WALLET_METHODS as readonly string[]).includes(m))
      add(PILOT_CLIENT_SCRIPT, `wallet-method-not-allowed:${m}`);
  for (const m of js.matchAll(/fetch\(\s*([^,)]*)/g))
    if (!/^`\/api\/\$\{route\}`$/.test(m[1].trim()))
      add(PILOT_CLIENT_SCRIPT, "fetch-not-same-origin-api", 0, m[1]);
  const urls = [...js.matchAll(/https?:\/\/[^\s"'`)]+/g)].map((m) => m[0]);
  const allowedUrls = [
    "https://mainnet.crosstoken.io:22001",
    "https://explorer.onechain.nexus/612055",
  ];
  for (const u of urls)
    if (!allowedUrls.includes(u))
      add(PILOT_CLIENT_SCRIPT, "external-url", 0, u);
  // ---- page shell
  const html = read(PILOT_CLIENT_HTML);
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html))
    add(PILOT_CLIENT_HTML, "inline-script");
  if (/\son[a-z]+\s*=/i.test(html)) add(PILOT_CLIENT_HTML, "inline-handler");
  if (/\sstyle\s*=/i.test(html)) add(PILOT_CLIENT_HTML, "inline-style");
  if (/(src|href)\s*=\s*["'](?!\/app\.(js|css)["'])/i.test(html))
    add(PILOT_CLIENT_HTML, "external-resource");
  if (/type\s*=\s*["']password["']/i.test(html))
    add(PILOT_CLIENT_HTML, "secret-input");
  // ---- in-product pilot module (client)
  const productSends: string[] = [];
  const productMethods = new Set<string>();
  for (const file of PRODUCT_PILOT_FILES) {
    const text = read(file);
    text.split(/\r?\n/).forEach((line, i) => {
      for (const [rule, re] of CLIENT_FORBIDDEN)
        if (re.test(line)) add(file, rule, i + 1, line.trim());
      if (line.includes(SEND))
        add(file, "raw-send-literal-in-pilot", i + 1, line.trim());
      if (CANONICAL_SEND.test(line)) productSends.push(`${file}:${i + 1}`);
    });
    for (const m of text.matchAll(
      /["'`]((?:eth|wallet|personal|net|web3)_[A-Za-z]+)["'`]/g,
    ))
      productMethods.add(m[1]);
    for (const m of text.matchAll(/fetch\(\s*([^,)]*)/g))
      if (!/^`\$\{gate\.apiBase\}\/\$\{route\}`$/.test(m[1].trim()))
        add(file, "fetch-not-pilot-api", 0, m[1]);
    for (const u of text.matchAll(/https?:\/\/[^\s"'`)]+/g))
      add(file, "external-url", 0, u[0]);
    if (/process\.env/.test(text)) add(file, "environment-read");
  }
  for (const m of productMethods)
    if (!(ALLOWED_WALLET_METHODS as readonly string[]).includes(m))
      add("scripts/g7-pilot/product", `wallet-method-not-allowed:${m}`);
  {
    const ls = read(PRODUCT_SEND_FILE).split(/\r?\n/);
    const start = ls.findIndex((l) =>
      l.startsWith("export function requestWalletConfirmationOnce("),
    );
    const end =
      start >= 0 ? ls.findIndex((l, i) => i > start && l === "}") : -1;
    const body = start >= 0 ? ls.slice(start, end + 1).join("\n") : "";
    if (
      productSends.length !== 1 ||
      !productSends[0].startsWith(`${PRODUCT_SEND_FILE}:`) ||
      !CANONICAL_SEND.test(body) ||
      !body.includes('gate: "g7-local-pilot"')
    )
      add(
        PRODUCT_SEND_FILE,
        `product-send-occurrences:${productSends.join(",")}`,
      );
    if (
      !/if \(guard\.attempted\) throw/.test(body) ||
      !/guard\.attempted = true;/.test(body)
    )
      add(PRODUCT_SEND_FILE, "product-send-guard-missing");
    const callers = PRODUCT_PILOT_FILES.flatMap((f) =>
      [...read(f).matchAll(/requestWalletConfirmationOnce\(/g)].map(() => f),
    );
    if (callers.length !== 2)
      add(PRODUCT_SEND_FILE, `product-send-callers:${callers.length}`);
  }
  // ---- the one wallet send of the application: inside the adapter's gated, canonical-compared method
  {
    const adapter = read(WALLET_ADAPTER_FILE);
    const at = adapter.indexOf("  async sendCanonicalTransaction(");
    const occurrences = adapter.split(SEND).length - 1;
    const body = at >= 0 ? adapter.slice(at) : "";
    if (
      occurrences !== 1 ||
      !body.includes(`method: "${SEND}"`) ||
      !body.includes("compareCanonicalTx(canonical, request)") ||
      !body.includes('context.gate !== "g7-local-pilot"')
    )
      add(WALLET_ADAPTER_FILE, `adapter-send-not-single-gated:${occurrences}`);
    if (
      /scripts\/g7-pilot|G7_LOCAL_PILOT|from\s+["'][^"']*g7/.test(adapter) ||
      (adapter.match(/g7-local-pilot/g) ?? []).length !== 2
    )
      add(WALLET_ADAPTER_FILE, "adapter-references-pilot-beyond-gate-id");
  }
  // ---- application isolation: only the three gate files may mention the local pilot
  const appRefs: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(join(REPO, dir), { withFileTypes: true })) {
      const p = `${dir}/${e.name}`;
      if (e.isDirectory()) walk(p);
      else if (
        /\.(ts|tsx|js|mjs)$/.test(e.name) &&
        /g7-pilot|G7_LOCAL_PILOT|g7-local-pilot/.test(read(p))
      )
        appRefs.push(p);
    }
  };
  walk("src");
  for (const p of appRefs)
    if (!(PRODUCT_INTEGRATION_FILES as readonly string[]).includes(p))
      add(p, "application-references-pilot");
  {
    const lines = read("src/components/product.tsx").split(/\r?\n/);
    lines.forEach((line, i) => {
      if (!line.includes("scripts/g7-pilot/")) return;
      const window = lines.slice(Math.max(0, i - 4), i + 1).join("\n");
      if (
        !/process\.env\.OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE === "1"/.test(window)
      )
        add(
          "src/components/product.tsx",
          "ungated-pilot-import",
          i + 1,
          line.trim(),
        );
    });
    const gate = read("src/server/g7-local-pilot.ts");
    if (
      !gate.includes(
        "bundle: string | undefined = process.env.OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE,",
      ) ||
      !gate.includes('if (bundle !== "1") return null;') ||
      !gate.includes('if (env.NODE_ENV !== "production") return null;') ||
      !gate.includes(
        'if (env.OTHERBRIDGE_G7_LOCAL_PILOT !== "1") return null;',
      ) ||
      !gate.includes("/^http:\\/\\/127\\.0\\.0\\.1:(\\d{1,5})$/")
    )
      add("src/server/g7-local-pilot.ts", "gate-not-fail-closed");
    const config = read("next.config.ts");
    if (
      !config.includes("OTHERBRIDGE_G7_LOCAL_PILOT_BUNDLE: profile.bundle,") ||
      !config.includes('if (!profile && !flag) return { bundle: "0" };')
    )
      add("next.config.ts", "public-build-constant-not-zero");
    // Behaviour, not just text: the public profile is "0" in `.next` in every phase; the pilot profile is built
    // only without the runtime flag, served only with it, never in the development server, never into `.next`.
    const [BUILD, SERVER, DEV] = [
      "phase-production-build",
      "phase-production-server",
      "phase-development-server",
    ];
    const outcome = (phase: string, profile?: string, flag?: string) => {
      try {
        return JSON.stringify(g7BuildProfile(phase, profile, flag));
      } catch {
        return "REFUSED";
      }
    };
    const PILOT = '{"bundle":"1","distDir":".next-g7-pilot"}';
    const matrix: [string, string | undefined, string | undefined, string][] = [
      [BUILD, undefined, undefined, '{"bundle":"0"}'],
      [SERVER, undefined, undefined, '{"bundle":"0"}'],
      [DEV, undefined, undefined, '{"bundle":"0"}'],
      [BUILD, undefined, "1", "REFUSED"],
      [SERVER, undefined, "1", "REFUSED"],
      [DEV, undefined, "1", "REFUSED"],
      [BUILD, "local-g7-pilot", undefined, PILOT],
      [BUILD, "local-g7-pilot", "1", "REFUSED"],
      [SERVER, "local-g7-pilot", undefined, "REFUSED"],
      [SERVER, "local-g7-pilot", "1", PILOT],
      [DEV, "local-g7-pilot", "1", "REFUSED"],
      [BUILD, "production", undefined, "REFUSED"],
    ];
    for (const [phase, profile, flag, want] of matrix)
      if (outcome(phase, profile, flag) !== want)
        add("next.config.ts", `profile-matrix:${phase}:${profile}:${flag}`);
    if (
      Object.values(G7_PILOT_PROFILES).some(
        (d) => !/^\.next-g7-pilot(-test)?$/.test(d),
      )
    )
      add("next.config.ts", "pilot-dist-dir-not-separate");
  }
  // ---- frozen invariants + protected files (reviewed V1.7 scan)
  const g7 = scanG7Sources(candidate);
  for (const f of g7.findings) add(f.file, `g7-scan:${f.rule}`, f.line, f.text);
  return {
    at: new Date().toISOString(),
    pass: findings.length === 0,
    serverFiles: PILOT_SERVER_FILES,
    clientFiles: [PILOT_CLIENT_SCRIPT, PILOT_CLIENT_HTML],
    productPilotFiles: PRODUCT_PILOT_FILES,
    productSendOccurrences: productSends,
    walletSendFile: WALLET_ADAPTER_FILE,
    productWalletMethods: [...productMethods].sort(),
    applicationIntegration: appRefs,
    selfExclusion: {
      path: "scripts/g7-pilot-safety.ts",
      reason: "defines the forbidden patterns (scanner itself)",
    },
    clientWalletMethods: methods.sort(),
    clientSendOccurrences: sendLines.map((i) => i + 1),
    invariants: g7.invariants,
    protectedUnchanged: g7.protectedUnchanged,
    baselineScope: g7.baselineScope,
    findings,
  };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const result = scanG7Pilot(candidateScanArgs(process.argv.slice(2)));
  if (process.argv[2])
    writeFileSync(process.argv[2], JSON.stringify(result, null, 1));
  console.log(
    JSON.stringify(
      {
        pass: result.pass,
        findings: result.findings,
        clientWalletMethods: result.clientWalletMethods,
        clientSendOccurrences: result.clientSendOccurrences,
      },
      null,
      1,
    ),
  );
  process.exit(result.pass ? 0 : 1);
}
