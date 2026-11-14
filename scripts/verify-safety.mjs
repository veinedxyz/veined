import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import ts from "typescript";

// Review 23: the VISIBLE code of a TypeScript / TSX file — every comment the TypeScript parser itself records as
// trivia is removed (a comment between two pieces of code on one line becomes one space; a comment on its own or at the
// end of a line disappears; the line breaks inside a block comment stay), while strings, template literals, regular
// expressions and JSX text are untouched. No comment construction can hide code from a rule that reads it, nor supply
// a match to one. (A parse error does not throw: the parser recovers, and the rules then see whatever it recovered.)
function stripComments(text, fileName) {
  const ranges0 = new Map();
  // Review 26 R26-1: TypeScript treats `#!` as trivia only at offset 0, so after a byte-order mark it would read the
  // hashbang line as code (a `/*`, a backtick or a `<tag` there would shift how every later line is read). The parse
  // and every comment-range scan therefore read a copy with the first-line hashbang (and a BOM before it) blanked to
  // spaces of the same length; the output is still cut from the original text, so every offset is unchanged.
  const hb = /^\uFEFF?#![^\n\r\u2028\u2029]*/.exec(text);
  const src = hb ? " ".repeat(hb[0].length) + text.slice(hb[0].length) : text;
  const sf = ts.createSourceFile(
    fileName,
    src,
    ts.ScriptTarget.Latest,
    false,
    /\.tsx$/.test(fileName)
      ? ts.ScriptKind.TSX
      : /\.jsx$/.test(fileName)
        ? ts.ScriptKind.JSX
        : /\.[mc]?js$/.test(fileName)
          ? ts.ScriptKind.JS
          : ts.ScriptKind.TS,
  );
  // Review 24 R24-5: a hashbang (`#!` on the first line) is comment trivia too.
  const shebang = /^\uFEFF?#![^\n\r\u2028\u2029]*/.exec(text);
  if (shebang)
    ranges0.set(text.startsWith("\uFEFF") ? 1 : 0, shebang[0].length);
  const ranges = new Map(ranges0);
  const jsxText = [];
  const add = (list) => {
    for (const r of list ?? []) ranges.set(r.pos, r.end);
  };
  // Leading ranges hold the comments that start a line, trailing ranges the same-line ones; both are collected at every
  // node and token. JSX text is never trivia: a range that starts inside JSX text is not a comment (it was read past the
  // end of an element tag) and is dropped.
  const visit = (node) => {
    if (node.kind === ts.SyntaxKind.JsxText) jsxText.push([node.pos, node.end]);
    else {
      add(ts.getLeadingCommentRanges(src, node.getFullStart()));
      add(ts.getTrailingCommentRanges(src, node.getEnd()));
    }
    for (const child of node.getChildren(sf)) visit(child);
  };
  visit(sf);
  for (const pos of [...ranges.keys()])
    if (jsxText.some(([a, b]) => pos >= a && pos < b)) ranges.delete(pos);
  const starts = [...ranges.keys()].sort((a, b) => a - b);
  let out = "";
  let at = 0;
  for (const pos of starts) {
    const end = ranges.get(pos);
    if (pos < at) continue;
    let from = pos;
    while (from > at && (text[from - 1] === " " || text[from - 1] === "\t"))
      from--;
    let to = end;
    while (to < text.length && (text[to] === " " || text[to] === "\t")) to++;
    const lineStart = from === 0 || /[\n\r\u2028\u2029]/.test(text[from - 1]);
    const lineEnd = to >= text.length || /[\n\r\u2028\u2029]/.test(text[to]);
    const breaks = (
      text.slice(pos, end).match(/\r\n|[\n\r\u2028\u2029]/g) ?? []
    ).join("");
    out += text.slice(at, from) + (breaks || (lineStart || lineEnd ? "" : " "));
    at = to;
  }
  return out + text.slice(at);
}
// Without an explicit unique evidence root, never overwrite historical evidence.
const base = process.env.OTHERBRIDGE_EVIDENCE_ROOT ?? "test-results";
const files = [];
async function walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = `${dir}/${entry.name}`;
    if (entry.isDirectory()) await walk(p);
    else files.push(p);
  }
}
await walk("src");
// V1.4: the self-hosted data plane, its services and the client SDK share the same boundary.
const dataFiles = [];
for (const dir of ["services", "packages"]) {
  const before = files.length;
  await walk(dir);
  dataFiles.push(...files.splice(before));
}
for (const file of dataFiles.filter((f) => /\.(ts|mjs|js)$/.test(f))) {
  const text = await readFile(file, "utf8");
  assert(
    !/privateKeyToAccount|mnemonicToAccount|eth_sendRawTransaction|eth_sendTransaction|personal_sign|eth_signTypedData|sendTransaction\s*\(/.test(
      text,
    ),
    `Data plane write/signing surface: ${file}`,
  );
}
for (const file of [...files, ...dataFiles].filter((f) =>
  /\.(ts|tsx|mjs)$/.test(f),
))
  assert(
    !/OTHERBRIDGE_PORTFOLIO_API_KEY|api\.covalenthq\.com|\.slice\(0,\s*40\)/.test(
      await readFile(file, "utf8"),
    ),
    `Retired paid portfolio dependency or 40-chain cap: ${file}`,
  );
const methods = await readFile("src/data/rpc/methods.ts", "utf8");
assert(
  !/eth_send|personal_|eth_sign|wallet_|debug_|admin_/.test(methods),
  "Data-plane RPC allowlist must stay read-only",
);
const findings = [];
// V1.9: the single provider adapter documents the methods it refuses in one frozen deny list; that list is the
// only place in src/ allowed to name them (it is removed before the scan, never exempted otherwise).
const ADAPTER = "src/features/wallet/adapter.ts";
const DENY_LIST =
  /export const FORBIDDEN_WALLET_METHODS = Object\.freeze\(\[[^\]]*\]\);/;
// The Privy layer may only test whether an extension exposes a provider (to time Privy's own detection).
const PRESENCE_ONLY =
  /"ethereum" in window && !!\(window as \{ ethereum\?: unknown \}\)\.ethereum/;
const scanned = (file, text) =>
  file === ADAPTER
    ? text.replace(DENY_LIST, "")
    : file === "src/features/wallet/privy/layer.tsx"
      ? text.replace(PRESENCE_ONLY, "")
      : text;
let sendLiterals = 0;
for (const file of files) {
  const raw = await readFile(file, "utf8");
  const text = scanned(file, raw);
  assert(
    !/privateKeyToAccount|mnemonicToAccount|eth_sendRawTransaction|personal_sign|eth_signTypedData|eth_signTransaction|eth_requestAccounts|\beth_sign\b|wallet_sendCalls|wallet_grantPermissions/.test(
      text,
    ),
    `Forbidden signer surface: ${file}`,
  );
  if (text.includes("eth_sendTransaction")) {
    // V1.9: exactly one wallet send in the application, inside the adapter's gated canonical send.
    assert(file === ADAPTER, `Wallet writes must be centralized: ${file}`);
    sendLiterals += text.split("eth_sendTransaction").length - 1;
  }
  if (/\.sendCanonicalTransaction\(/.test(text))
    assert(
      file === "src/features/bridge/submission.ts",
      `Only the submission boundary may call the canonical send: ${file}`,
    );
  // V1.9: no raw injected-wallet discovery or fallback anywhere (Privy is the only EVM connection layer).
  assert(
    !/window\.ethereum|eip6963|\.ethereum\b|["']ethereum["'] in window/.test(
      text,
    ),
    `Raw injected EVM provider access: ${file}`,
  );
  if (/@privy-io\//.test(text))
    assert(
      file === "src/features/wallet/privy/layer.tsx",
      `Privy SDK imported outside the wallet layer: ${file}`,
    );
  if (
    file.startsWith("src/routing/") ||
    file.includes("routing-core") ||
    file.includes("api/routing") ||
    file.includes("multichain-") ||
    file.includes("routing-observation")
  )
    assert(
      !/\b(executeRoute|executeStep|resumeRoute|createWalletClient|sendTransaction|signTransaction|signMessage|signTypedData|sendRawTransaction|createSigner|approveToken)\s*\(/.test(
        text,
      ),
      `Routing write call found: ${file}`,
    );
  if (file !== "src/adapters/routing-core.ts")
    assert(
      !/from\s+["']@lifi\/sdk/.test(text),
      `SDK must stay inside the server adapter: ${file}`,
    );
  assert(
    !/dangerouslySetInnerHTML/.test(text),
    "Raw external HTML is prohibited",
  );
  findings.push({ file, checked: true });
}
assert(
  (await readFile(".env.example", "utf8")).includes(
    "OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION=false",
  ),
);
const adapter = await readFile("src/adapters/routing-core.ts", "utf8");
assert(
  /providers:\s*\[\]/.test(adapter) && /preloadChains:\s*false/.test(adapter),
);
const model = await readFile("src/routing/model.ts", "utf8");
assert(
  /enabled:\s*false/.test(model) &&
    ["sign", "approve", "broadcast", "deploy"].every((key) =>
      new RegExp(`${key}:\\s*null`).test(model),
    ),
);
const pkg = JSON.parse(await readFile("package.json", "utf8"));
assert(
  Object.keys(pkg.dependencies).every(
    (key) => !key.startsWith("@lifi/sdk-provider-"),
  ),
);
assert(
  /process\.env\.NODE_ENV\s*===\s*["']production["']/.test(
    await readFile("src/server/config.ts", "utf8"),
  ),
);
// V1.5 pre-release invariants: strict production CSP, no inline-style sinks, internal-only metrics,
// frozen kill/fee/registry constants mirrored by the monitoring invariants.
const proxySource = await readFile("src/proxy.ts", "utf8");
assert(
  /"style-src-attr 'none'"/.test(proxySource) &&
    // V1.9: optionally followed by the pinned SDK SVG style hashes (exact hashes, never 'unsafe-inline').
    /`style-src 'self' 'nonce-\$\{nonce\}'(\$\{extra\(PRIVY_CSP\.styleHashes\)\})?`/.test(
      proxySource,
    ) &&
    !/script-src[^"`]*'unsafe-inline'/.test(proxySource),
  "Production CSP must not allow inline script/style",
);
for (const file of files.filter((f) => /\.tsx$/.test(f)))
  assert(
    !/\sstyle=\{|from "next\/image"/.test(await readFile(file, "utf8")),
    `Inline style sink (blocked by production CSP): ${file}`,
  );
assert(
  !(await readFile("src/data/api/router.ts", "utf8")).includes(
    "pattern: /^\\/v1\\/metrics$/",
  ),
  "Operational metrics must not be served by the public Data API",
);
const firewall = await readFile("src/security/firewall.ts", "utf8");
assert(
  /contractRegistry: readonly ContractEntry\[\] = Object\.freeze\(\[\]\)/.test(
    firewall,
  ) && /global: true,/.test(firewall),
  "Write registry must stay empty and global kill ON",
);
const fee = await readFile("src/routing/fee-policy.ts", "utf8");
assert(
  /enabled: false,\s*bps: 0,\s*maxBps: 10/.test(fee),
  "Real Otherbridge fee must stay 0 bps (10 bps hard max)",
);
assert(
  sendLiterals === 1,
  `Exactly one wallet send expected, found ${sendLiterals}`,
);
{
  const adapter = await readFile(ADAPTER, "utf8");
  const body = adapter.slice(
    adapter.indexOf("  async sendCanonicalTransaction("),
  );
  assert(
    body.includes('method: "eth_sendTransaction"') &&
      /compareCanonicalTx\(canonical, request\)/.test(body) &&
      /await this\.identity\(/.test(body) &&
      /context\.gate !== "otherbridge-submission"/.test(body),
    "The single wallet send must compare canonical vs request, re-read identity and require a gate",
  );
  // The Privy layer may use only connect-only hooks: no login, signing, sending, wallet creation or funding hook.
  const layer = await readFile("src/features/wallet/privy/layer.tsx", "utf8");
  const imported = [
    ...layer.matchAll(/import\s*\{([^}]*)\}\s*from\s*"@privy-io\/react-auth"/g),
  ]
    .flatMap((m) => m[1].split(","))
    .map((x) => x.trim())
    .filter(Boolean)
    .sort();
  assert.deepEqual(
    imported,
    [
      "PrivyProvider",
      "SUPPORTED_CHAINS",
      "useConnectWallet",
      "useModalStatus",
      "usePrivy",
      "useWallets",
    ],
    "Privy layer imports must stay connect-only",
  );
  assert(
    !/@privy-io\/react-auth\/(?!")/.test(layer),
    "No Privy sub-path (smart wallets, solana, funding) may be imported",
  );
  const config = await readFile("src/features/wallet/privy/config.ts", "utf8");
  assert(
    /loginMethods: \["wallet"\]/.test(config) &&
      (config.match(/createOnLogin: "off"/g) ?? []).length === 2 &&
      /showWalletUIs: false/.test(config) &&
      /options: "eoaOnly"/.test(config) &&
      !/defaultChain\s*:/.test(config) &&
      /cookieWriteBehavior: "never"/.test(config),
    "Privy must stay external-wallet connect-only (no embedded wallet, no auto chain switch)",
  );
  const proxy = await readFile("src/proxy.ts", "utf8");
  const origins = [...proxy.matchAll(/"((?:https|wss):\/\/[^"]*)"/g)].map(
    (m) => m[1],
  );
  assert(
    origins.length > 0 &&
      origins.every((o) => /^(https|wss):\/\/[a-z0-9.-]+$/.test(o)) &&
      !/(connect|script|img|frame|style)-src[^"`]*\*/.test(proxy) &&
      !/script-src[^"`]*'unsafe-inline'/.test(proxy),
    "Privy CSP origins must be exact",
  );
  for (const file of files.filter((f) => /\.(ts|tsx)$/.test(f)))
    assert(
      !/["'][a-z0-9]{25}["']/.test(
        (await readFile(file, "utf8")).replace(/0x[0-9a-fA-F]+/g, ""),
      ) || !/privy/i.test(await readFile(file, "utf8")),
      `Possible hard-coded Privy App ID: ${file}`,
    );
}
// G14 closure: the owner-signed canary's OWN boundary. These rules are ADDED; every rule above stays exactly as it was
// (empty general registry, global kill ON, one wallet send in the adapter, the submission boundary as its only caller,
// no signer surface, no raw injected wallet access ...). Each rule pins a literal or a structure of the canary path;
// tests/unit/verify-safety-regression.test.ts breaks each one on purpose and expects this script to fail.
const canary = {};
{
  // Review 23: every .ts / .tsx file the canary rules read is its VISIBLE code (stripComments above).
  const readRaw = (p) => readFile(p, "utf8");
  const SRC_CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
  // rc26 / rc27 (speed): each file is parsed once per scan (the rc25 unit gate showed the parse cost starving a parallel
  // test). Every file is parsed — review 25 R25-1: rc26 also skipped files without certain words, which handed rules 1
  // and 12 the comments of those files.
  const visible = new Map();
  const read = async (p) => {
    if (!SRC_CODE.test(p)) return readRaw(p);
    if (!visible.has(p)) visible.set(p, stripComments(await readRaw(p), p));
    return visible.get(p);
  };
  // Comment handling (reviews 19-23). `read` returns the VISIBLE code of every .ts / .tsx file (the TypeScript parser's
  // comment trivia removed), so every rule below — counts, negative and positive checks — reads code only. `code` and
  // `code2` (the earlier line filters) are kept as no-op-safe helpers: on visible code they change nothing a rule needs;
  // the raw-text cross-checks of rc22 / rc23 are now plain counts on visible code (no comment mention left to pin).
  // Review 24 R24-2: the rules read visible code already (`read`), so the earlier line filters are identities now
  // (`code2` used to cut a line at a `//` inside a string).
  const code = (text) => text;
  const code2 = (text) => text;
  // A slice between two anchors of visible code; both anchors must exist, in order (review 24 R24-1: an anchor that
  // was a comment silently made the slice run to the end of the file).
  const span = (text, a, b) => {
    const i = text.indexOf(a);
    const j = b === undefined ? text.length : text.indexOf(b, i);
    assert(
      i >= 0 && j > i,
      `Canary scanner: slice anchor missing: ${a} … ${b ?? "EOF"}`,
    );
    return text.slice(i, j);
  };
  // A gap between tokens in the RAW text: whitespace or block comments.
  const G = String.raw`(?:\s|\/\*[\s\S]*?\*\/)*`;
  const count = (re, text) => (text.match(new RegExp(re, "g")) ?? []).length;
  // present in the visible code, and `a` before `b` there (an absent text is never "before" anything; review 22 R22-6)
  const before = (body, a, b) => {
    const v = code2(body);
    return (
      v.indexOf(a) >= 0 && v.indexOf(b) >= 0 && v.indexOf(a) < v.indexOf(b)
    );
  };
  const DIR = "src/execution/server/canary";
  const selectorOk = (f, raw) =>
    count(String.raw`0xa1f1ce43`, raw.toLowerCase()) === 0 &&
    !/0xa1f1ce43/i.test(code2(raw));
  // 1. The proposed protected inventory names every canary-path file, and nothing in the canary directory escapes it.
  const inventoryText = await read(`${DIR}/inventory.ts`);
  const inventory = [
    ...inventoryText.matchAll(/^\s*"([A-Za-z0-9_./-]+)",$/gm),
  ].map((m) => m[1]);
  const REQUIRED = [
    "src/security/canary-approval.ts",
    "src/security/firewall.ts",
    "src/features/wallet/adapter.ts",
    "src/features/bridge/submission.ts",
    "src/features/wallet-rainbow/config.ts",
    "src/features/wallet-rainbow/layer.tsx",
    "src/adapters/routing-core.ts",
    "src/swap/server/config.ts",
    "src/swap/server/egress.ts",
    "src/swap/server/transport.ts",
    "src/release/config.ts",
    "src/execution/server/gate.ts",
    "src/app/api/execution/route.ts",
    "src/components/execution-review.tsx",
    `${DIR}/engine.ts`,
    `${DIR}/runtime.ts`,
    `${DIR}/durable-store.ts`,
    `${DIR}/rpc-pool.ts`,
    `${DIR}/authorization-store.ts`,
    `${DIR}/attestation.ts`,
    `${DIR}/audit-anchor.ts`,
    `${DIR}/pin-reads.ts`,
    `${DIR}/inventory.ts`,
    "src/execution/canary/chain-reads.ts",
    "src/execution/canary/simulation.ts",
    "src/execution/canary/settlement.ts",
    "src/execution/canary/quote-verify.ts",
    "src/execution/canary/pins.ts",
    "src/execution/canary/scope.ts",
    "src/execution/canary/across-decoder.ts",
    "src/execution/canary/readiness.ts",
    "src/execution/model.ts",
    "src/execution/lifecycle.ts",
    "src/execution/canonical.ts",
    "src/execution/binding.ts",
    "src/server/api-guard.ts",
  ];
  for (const p of REQUIRED)
    assert(inventory.includes(p), `Canary inventory misses ${p}`);
  for (const p of inventory)
    assert(files.includes(p), `Canary inventory names a missing file: ${p}`);
  for (const f of files.filter((f) => f.startsWith(`${DIR}/`)))
    assert(inventory.includes(f), `Canary file outside the inventory: ${f}`);
  // Review 2 R5: the inventory is checked against the canary path's REAL static import closure, not only a list.
  // Every file that decides, reads, stores, composes, dispatches or shows a canary step and is reachable from the
  // composition entry points must be in the inventory; a missing entry is never accepted as safe.
  const DECISION =
    /^src\/(?:execution\/|security\/|guardian\/|server\/|swap\/server\/|swap\/model\.ts$|data\/(?:config|plane)\.ts$|adapters\/|routing\/|features\/wallet\/|features\/wallet-rainbow\/|features\/bridge\/submission\.ts$|assets\/(?:registry|model)\.ts$)/;
  const ENTRIES = [
    `${DIR}/runtime.ts`,
    "src/app/api/execution/route.ts",
    "src/components/execution-review.tsx",
    "src/features/bridge/submission.ts",
    "src/features/wallet/adapter.ts",
    "src/features/wallet-rainbow/layer.tsx",
    "src/server/api-guard.ts",
  ];
  const SPEC =
    /(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\sfrom\s+)?["'`]([^"'`$]+)["'`]|import\(\s*["'`]([^"'`$]+)["'`]\s*\)|require\(\s*["'`]([^"'`$]+)["'`]\s*\)/g;
  const resolveSpec = (from, spec) => {
    let base;
    if (spec.startsWith("@/")) base = `src/${spec.slice(2)}`;
    else if (spec.startsWith(".")) {
      const parts = from.split("/").slice(0, -1);
      for (const seg of spec.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
      }
      base = parts.join("/");
    } else return null;
    base = base.replace(/\.(?:m?js|jsx?)$/, "");
    for (const c of [
      base,
      ...["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].flatMap((x) => [
        `${base}.${x}`,
        `${base}/index.${x}`,
      ]),
    ])
      if (files.includes(c)) return c;
    return null;
  };
  const closure = new Set();
  const pending = [...ENTRIES];
  while (pending.length) {
    const f = pending.pop();
    if (closure.has(f)) continue;
    closure.add(f);
    if (!SRC_CODE.test(f)) continue;
    for (const m of (await read(f)).matchAll(SPEC)) {
      const r = resolveSpec(f, m[1] ?? m[2] ?? m[3]);
      if (r && !closure.has(r)) pending.push(r);
    }
  }
  const decisionClosure = [...closure].filter((f) => DECISION.test(f)).sort();
  for (const f of decisionClosure)
    assert(
      inventory.includes(f),
      `Canary decision file outside the inventory: ${f}`,
    );
  canary.inventory = inventory.length;
  canary.decisionClosure = decisionClosure.length;

  // 2. Disarmed final policy: no owner record, no revocation entries needed, wiring false.
  const approval = await read("src/security/canary-approval.ts");
  assert(
    /export const OWNER_CANARY_APPROVAL =\s+null as Readonly<OwnerCanaryApproval> \| null;/.test(
      approval,
    ),
    "Canary owner record must stay null in this build",
  );
  assert(
    /export const OWNER_CANARY_KEY_SHA256 = null as string \| null;/.test(
      approval,
    ),
    "Canary owner key digest must stay null in this build",
  );
  assert(
    /export const REVOKED_CANARY_APPROVALS: readonly string\[\] = Object\.freeze\(\[/.test(
      approval,
    ),
    "Canary revocation list must stay a frozen protected constant",
  );
  const gate = await read("src/execution/server/gate.ts");
  assert(
    /export const CANARY_LIVE_WIRING = false as const;/.test(gate),
    "CANARY_LIVE_WIRING must stay false in this build",
  );
  // 3. One scope, one selector, one chain pair, one token pair, one target = spender, the frozen pin set.
  const bounds = span(
    approval,
    "export const CANARY_APPROVAL_BOUNDS",
    "export interface OwnerCanaryApproval",
  );
  for (const literal of [
    'scope: "base-arbitrum-usdc-max5",',
    'pinSet: "g14-canary-pins.2026-11-12.2",',
    'sourceChainId: "8453",',
    'destinationChainId: "42161",',
    'token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",',
    'destinationToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",',
    'target: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",',
    'spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",',
    'selector: "0x1794958f",',
    'maxAmount: "5000000",',
  ])
    assert(bounds.includes(literal), `Canary bound changed: ${literal}`);
  const firewall = await read("src/security/firewall.ts");
  const entry = span(
    firewall,
    "export const canaryContractEntry",
    "export interface CanaryPinEvidence",
  );
  assert(
    (firewall.match(/export const canaryContractEntry/g) ?? []).length === 1 &&
      entry.includes('chainId: "8453",') &&
      entry.includes('selector: "0x1794958f",') &&
      entry.includes(
        'contract: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",',
      ) &&
      entry.includes(
        'spender: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",',
      ) &&
      entry.includes('token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",') &&
      (entry.match(/selector:/g) ?? []).length === 1,
    "Exactly one canary entry: Base, the pinned Diamond, USDC, one selector",
  );
  for (const f of files.filter((f) => SRC_CODE.test(f)))
    assert(
      selectorOk(f, await read(f)),
      `Out-of-scope selector 0xa1f1ce43 in code: ${f}`,
    );
  // 4. One composition: the engine and the durable store are built only by the runtime; only the store-backed journal
  //    claims durability; the runtime reads no environment and has no other egress or key path.
  for (const f of files.filter((f) => SRC_CODE.test(f))) {
    const raw = await read(f);
    const text = code2(raw);
    if (/new CanaryEngine\s*\(/.test(raw))
      assert(
        f === `${DIR}/runtime.ts`,
        `Canary engine constructed outside the runtime: ${f}`,
      );
    if (/CanaryDurableStore\.open\s*\(|new CanaryRuntime\s*\(/.test(raw))
      assert(
        f === `${DIR}/runtime.ts`,
        `Canary store or runtime opened outside the runtime: ${f}`,
      );
    // Review 2 R6: also a quoted key ("durable": true / 'durable': ...).
    const claims = (
      text.match(
        /(?:\bdurable|\[?\s*["']durable["']\s*\]?)\s*(?::|=(?!=))\s*(?!boolean\b)[^\s,;)}]+|defineProperty\([^)]*["']durable["']/g,
      ) ?? []
    ).length;
    // Review 22: a durable claim a comment construction hides from the visible code still counts (one pinned comment
    // mention in the durable store itself).
    const rawClaims = (
      raw.match(
        /(?:\bdurable|\[?\s*["']durable["']\s*\]?)\s*(?::|=(?!=))\s*(?!boolean\b)[^\s,;)}]+|defineProperty\([^)]*["']durable["']/g,
      ) ?? []
    ).length;
    assert(
      rawClaims === claims,
      `A canary journal claims durability outside the durable store: ${f}`,
    );
    if (claims)
      assert(
        (f === `${DIR}/runtime.ts` && claims === 1) ||
          (f === `${DIR}/engine.ts` &&
            claims === 1 &&
            /this\.deps\.uses\.durable === true/.test(text)),
        `A canary journal claims durability outside the durable store: ${f}`,
      );
    // Review 2 R6: every specifier is RESOLVED against the importing file, so "./canary/runtime" from
    // src/execution/server/gate.ts (or any other spelling) is caught like the full path.
    const importsRuntime = [
      ...raw.matchAll(
        /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\()(?:\s|\/\*[\s\S]*?\*\/)*["'`]([^"'`$]+)["'`]/g,
      ),
    ].some((m) => resolveSpec(f, m[1]) === `${DIR}/runtime.ts`);
    if (
      importsRuntime ||
      /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\()(?:\s|\/\*[\s\S]*?\*\/)*["'`][^"'`]*execution\/server\/canary\/runtime(?:\.[jt]sx?)?["'`]/.test(
        raw,
      ) ||
      (f.startsWith(`${DIR}/`) &&
        f !== `${DIR}/runtime.ts` &&
        /(?:\bfrom|\bimport\s*\(|\bimport)(?:\s|\/\*[\s\S]*?\*\/)*["'`]\.\/runtime["'`]/.test(
          raw,
        ))
    )
      assert(
        f === "src/app/api/execution/route.ts",
        `Canary runtime imported outside the API route: ${f}`,
      );
  }
  const runtime = await read(`${DIR}/runtime.ts`);
  assert(
    !/process\.env|fetch\s*\(|jsonRead|MemoryUseJournal|MemoryNonceJournal|privateKeyToAccount|eth_send|setCanary|ForTests/.test(
      runtime,
    ),
    "Canary runtime: no environment, fetch, memory journal, key, send or test hook",
  );
  const runtimeImports = [...runtime.matchAll(/from\s+["']([^"']+)["']/g)].map(
    (m) => m[1],
  );
  const RUNTIME_IMPORTS = new Set([
    "node:crypto",
    "node:path",
    "viem",
    "../../../adapters/routing-core",
    "../../../assets/registry",
    "../../../guardian/verdict",
    "../../../guardian/model",
    "../../../security/canary-approval",
    "../../../swap/server/config",
    "../../canonical",
    "../../model",
    "../../lifecycle",
    "../../canary/pins",
    "../../canary/scope",
    "../../canary/across-decoder",
    "../../canary/chain-reads",
    "../../canary/settlement",
    "../gate",
    "./engine",
    "./authorization-store",
    "./attestation",
    "./audit-anchor",
    "./durable-store",
    "./rpc-pool",
  ]);
  for (const s of runtimeImports)
    assert(RUNTIME_IMPORTS.has(s), `Canary runtime import not allowed: ${s}`);
  // 5. The pool and the transport are ONE method policy; reads only; four exact URLs, two operators per chain.
  const transport = await read("src/swap/server/transport.ts");
  const list = span(
    transport,
    "export const CANARY_READ_METHODS",
    "export const CANARY_READ_LIMITS",
  );
  const methods = [...list.matchAll(/"([a-zA-Z0-9_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(
    methods,
    [
      "eth_chainId",
      "eth_getBlockByNumber",
      "eth_getCode",
      "eth_getStorageAt",
      "eth_call",
      "eth_getBalance",
      "eth_getTransactionCount",
      "eth_getTransactionByHash",
      "eth_getTransactionReceipt",
      "eth_getLogs",
      "eth_maxPriorityFeePerGas",
      "eth_simulateV1",
    ],
    "Canary read methods are exactly the reviewed read-only list",
  );
  assert(
    /stateOverrides|"stateOverrides"/.test(transport) === false &&
      /plainObject\(p\[0\], \["blockStateCalls", "validation", "traceTransfers"\]\)/.test(
        transport,
      ) &&
      /plainObject\(b\.blockOverrides, \["baseFeePerGas"\]\)/.test(transport),
    "Canary simulation: no state override, base fee is the only block override",
  );
  const poolRaw = await read(`${DIR}/rpc-pool.ts`);
  const pool = code2(poolRaw);
  assert(
    /export const POOL_READ_METHODS: readonly string\[\] = CANARY_READ_METHODS;/.test(
      pool,
    ) && !/fetch\s*\(|jsonRead/.test(poolRaw),
    "Canary pool: the transport's own method list, and no other egress",
  );
  for (const f of files.filter(
    (f) => f.startsWith("src/execution/") && SRC_CODE.test(f),
  ))
    assert(
      !/\bfetch\s*\(|jsonRead/.test(await read(f)),
      `Canary/execution code with its own egress: ${f}`,
    );
  const swapConfig = await read("src/swap/server/config.ts");
  const poolBlock = span(
    swapConfig,
    "export const CANARY_RPC_POOL",
    "satisfies Readonly<Record<string, readonly [RpcSource, RpcSource]>>",
  );
  const ops = [...poolBlock.matchAll(/operator: "([a-z0-9-]+)"/g)].map(
    (m) => m[1],
  );
  const urls = [...poolBlock.matchAll(/url: ([^,\n]+),/g)].map((m) =>
    m[1].trim(),
  );
  assert(
    ops.length === 4 &&
      urls.length === 4 &&
      ops[0] !== ops[1] &&
      ops[2] !== ops[3] &&
      new Set(urls).size === 4,
    "Canary RPC pool: four exact sources, two different operators per chain",
  );
  const release = await read("src/release/config.ts");
  assert(
    /canaryReleaseOrigins\(\)/.test(release) &&
      /CANARY_RPC_NOT_IN_RELEASE_ALLOWLIST/.test(release) &&
      /CANARY_RPC_POOL/.test(release),
    "Release egress must see the canary RPC pool",
  );
  const egress = await read("src/swap/server/egress.ts");
  assert(
    /Object\.values\(CANARY_RPC_POOL\)\.flatMap\(\(pool\) => pool\.map\(\(s\) => s\.url\)\)/.test(
      egress,
    ),
    "Canary egress URLs come only from the configured pool",
  );
  // 6. The last dispatch check: after the adapter's last await (the identity read) the owner window, authorization,
  //    quote and gesture are checked again, and nothing else is awaited before the wallet request.
  const adapterText = await read(ADAPTER);
  const sendBody = adapterText.slice(
    adapterText.indexOf("  async sendCanonicalTransaction("),
  );
  const lastIdentity = sendBody.lastIndexOf("await this.identity(");
  const request = sendBody.indexOf('method: "eth_sendTransaction"');
  const rawBetween = sendBody.slice(lastIdentity, request);
  const between = code2(rawBetween);
  assert(
    lastIdentity > 0 &&
      request > lastIdentity &&
      // Review 23 R23-2: exactly one identity read in the send path (a second one, even dead code, would move the start
      // of the slice this rule counts in).
      count(String.raw`await${G}this${G}\.${G}identity${G}\(`, sendBody) ===
        1 &&
      count(String.raw`method${G}:${G}"eth_sendTransaction"`, sendBody) === 1 &&
      // Review 2 R6: the EXACT expression — the veto, then the dispatch limits, then the digest — is what `problem`
      // is; nothing may sit between `const problem =` and it.
      // G14 follow-up F2: on the dispatch AUTHORITY's server limits, judged in server time (never caller limits).
      /const problem =\s*veto !== undefined &&\s*\(typeof veto !== "function" \|\| veto\(\) !== true\)\s*\?\s*"REVIEW_NO_LONGER_CURRENT"\s*:\s*\(canaryDispatchProblem\(\s*OWNER_CANARY_APPROVAL,\s*canonical,\s*grant!\.limits,\s*clock\(cc\?\.notBefore\) \+ grant!\.offsetMs,?\s*\)\s*\?\?\s*preparedDigestProblem\(grant!\.limits, canonical\)\);\s*if \(problem\)\s*throw Object\.assign\(new BridgeError\("CANARY_REQUEST_REFUSED"\)/.test(
        between,
      ) &&
      (between.match(/const problem =/g) ?? []).length === 1 &&
      (rawBetween.match(/const problem =/g) ?? []).length === 1 &&
      (between.match(/\bawait\b/g) ?? []).length === 2 &&
      (rawBetween.match(/\bawait\b/g) ?? []).length === 2 &&
      /await this\.#raw\.request\(\{\s*$/.test(between.trimEnd()),
    "Canary: the dispatch limits are re-checked after the last await, with no await before the wallet request",
  );
  assert(
    /canaryDispatchProblem\(/.test(sendBody.slice(0, lastIdentity)),
    "Canary: the dispatch limits are checked before the identity read as well",
  );
  const submission = await read("src/features/bridge/submission.ts");
  const canaryPart = submission.slice(
    submission.indexOf("export async function submitCanary("),
  );
  assert(
    /canary: \{\s*authority,/.test(canaryPart) &&
      /canaryDispatchProblem\(/.test(canaryPart) &&
      /persistNotRequested\(ref\)/.test(canaryPart) &&
      /await confirmCanaryPreparation\(provider, \{/.test(canaryPart) &&
      /await commitCanaryDispatch\(confirmed\.confirmation, \{/.test(
        canaryPart,
      ) &&
      canaryPart.indexOf("await confirmCanaryPreparation(") <
        canaryPart.indexOf("live = await provider.identity(") &&
      canaryPart.indexOf("live = await provider.identity(") <
        canaryPart.indexOf("await commitCanaryDispatch(") &&
      /discardCanaryDispatchAuthority\(authority\);\s*throw refuse\(\(await notRequested\(\)\)/.test(
        canaryPart,
      ) &&
      /recorded: stored\.ok && stored\.value === true,/.test(canaryPart) &&
      // Review 7 R7-7 / R7-6: the late check is judged in the server's time; a commit that may have been written is
      // always followed by the conditional clean-up, and only the server's definitive "not written" skips it.
      /const late = alive\(confirmed\.offsetMs\) \?\? stopped\(\);/.test(
        canaryPart,
      ) &&
      // Review 8 R8-2: the late check moves the owner's click into server time too.
      /gesture: \{\s*trusted: gesture\.trusted,\s*at: Number\(gesture\.at\) \+ offsetMs,\s*\},\s*\},\s*now\(\) \+ offsetMs,/.test(
        canaryPart,
      ) &&
      /if \(obtained\.written === false\) \{\s*if \(canarySteps\.get\(step\) === holder\) canarySteps\.delete\(step\);\s*throw refuse\(obtained\.code\);\s*\}\s*const cleared = await notRequested\(\);\s*throw refuse\(cleared \? "RECORD_NOT_WRITTEN" : "RECORD_OUTCOME_UNKNOWN"\);/.test(
        canaryPart,
      ) &&
      !/confirmPrepared|persistUnknown|canary: \{\s*limits/.test(canaryPart) &&
      !/await context\.persist/.test(canaryPart),
    "Canary submission: the adapter's authority, conditional clean-up, every record write bounded, recorded only on true",
  );
  // 8. G14 follow-up F2 (R3): the dispatch AUTHORITY. Only the adapter mints it, from its OWN same-origin server calls
  //    (the server's confirmed preparation and its committed durable REQUESTED record), through the fetch it captured
  //    at load; it is kept in a private registry (never exported), spent at the send, and caller limits are refused.
  const adapterCode = code2(adapterText);
  const confirmAt = adapterText.indexOf(
    "export async function confirmCanaryPreparation(",
  );
  const mintAt = adapterText.indexOf(
    "export async function commitCanaryDispatch(",
  );
  const confirmBody = span(
    adapterText,
    "export async function confirmCanaryPreparation(",
    "export async function commitCanaryDispatch(",
  );
  const mintBody = span(
    adapterText,
    "export async function commitCanaryDispatch(",
    "export async function obtainCanaryDispatchAuthority(",
  );
  assert(
    mintAt > 0 &&
      confirmAt > 0 &&
      confirmAt < mintAt &&
      (
        adapterText.match(
          /const confirmations = new WeakMap<object, Confirmed>\(\);/g,
        ) ?? []
      ).length === 1 &&
      !/export\s+(?:const|let|function)\s+confirmations\b/.test(adapterText) &&
      count(String.raw`confirmations${G}\.${G}set${G}\(`, adapterText) === 1 &&
      count(String.raw`confirmations\s*\.\s*set\s*\(`, adapterCode) === 1 &&
      /action: "canary-confirm"/.test(confirmBody) &&
      before(confirmBody, "structural.length || !owner", "canaryServer(") &&
      before(
        confirmBody,
        "preparationDigest(prep) !== prep.digest",
        "confirmations.set(",
      ) &&
      !/canary-record/.test(confirmBody) &&
      !/canary-confirm/.test(mintBody) &&
      before(
        mintBody,
        "approvalRecordProblems(owner).length || !owner",
        "canaryServer(",
      ) &&
      before(mintBody, "confirmations.delete(confirmation)", "canaryServer(") &&
      (
        adapterText.match(
          /const grants = new WeakMap<object, DispatchGrant>\(\);/g,
        ) ?? []
      ).length === 1 &&
      !/export\s+(?:const|let|function)\s+(?:grants|takeGrant|grantProblem|PAGE_FETCH)\b/.test(
        adapterText,
      ) &&
      // Review 23 R23-8: nor through an export list.
      !/export\s*(?:type\s*)?\{[^}]*\b(?:grants|takeGrant|grantProblem|PAGE_FETCH|confirmations)\b[^}]*\}/.test(
        adapterText,
      ) &&
      // Review 25 R25-3: neither registry escapes as a value — each name occurs only in its own declaration or right
      // before `.get(` / `.set(` / `.delete(` / `.has(` (no return, alias, argument or property of it).
      count(String.raw`\bgrants\b`, adapterText) ===
        count(
          String.raw`const grants = new WeakMap<object, DispatchGrant>\(\);`,
          adapterText,
        ) +
          count(
            String.raw`\bgrants\s*\.\s*(?:get|set|delete|has)\s*\(`,
            adapterText,
          ) &&
      count(String.raw`\bconfirmations\b`, adapterText) ===
        count(
          String.raw`const confirmations = new WeakMap<object, Confirmed>\(\);`,
          adapterText,
        ) +
          count(
            String.raw`\bconfirmations\s*\.\s*(?:get|set|delete|has)\s*\(`,
            adapterText,
          ) &&
      // Review 24 R24-3: nor as a default export, an `export =`, or an exported alias / object of them.
      !/export\s+default\s+[^;]*\b(?:grants|takeGrant|grantProblem|PAGE_FETCH|confirmations)\b/.test(
        adapterText,
      ) &&
      !/export\s*=\s*[^;]*\b(?:grants|takeGrant|grantProblem|PAGE_FETCH|confirmations)\b/.test(
        adapterText,
      ) &&
      !/export\s+(?:const|let|var)\s+[^=;]+=\s*[^;]*\b(?:grants|takeGrant|grantProblem|PAGE_FETCH|confirmations)\b/.test(
        adapterText,
      ) &&
      count(String.raw`grants${G}\.${G}set${G}\(`, adapterText) === 1 &&
      count(String.raw`grants\s*\.\s*set\s*\(`, adapterCode) === 1 &&
      before(mintBody, 'ans.state === "REQUESTED"', "grants.set(") &&
      before(mintBody, 'kind: "requested"', 'ans.state === "REQUESTED"') &&
      /export const CANARY_API_PATH = "\/api\/execution";/.test(adapterText) &&
      /const PAGE_FETCH: typeof fetch \| null =\s*typeof globalThis\.fetch === "function"\s*\?\s*globalThis\.fetch\.bind\(globalThis\)\s*:\s*null;/.test(
        adapterText,
      ) &&
      count(String.raw`\bfetch${G}\(`, adapterText) === 0 &&
      count(
        String.raw`pageFetch${G}\(${G}CANARY_API_PATH${G},`,
        adapterText,
      ) === 1 &&
      count(String.raw`pageFetch\s*\(\s*CANARY_API_PATH\s*,`, adapterCode) ===
        1 &&
      /const pageFetch = PAGE_FETCH;/.test(adapterText) &&
      count(String.raw`globalThis\s*\.\s*fetch`, adapterCode) === 2 &&
      count(String.raw`globalThis${G}\.${G}fetch`, adapterText) === 2 &&
      /grant = canary \? takeGrant\(cc\?\.authority\) : null;/.test(sendBody) &&
      before(
        sendBody,
        "grant = canary ? takeGrant(",
        "compareCanonicalTx(canonical, request)",
      ) &&
      /grantProblem\(grant, this, this\.#epoch, cc, canonical\) \?\?\s*canaryDispatchProblem\(/.test(
        sendBody,
      ) &&
      !/cc\??\.limits(?!Given)/.test(adapterText) &&
      /if \(cc\?\.limitsGiven\) return "DISPATCH_LIMITS_FROM_CALLER";/.test(
        adapterText,
      ) &&
      /if \(structural\.length \|\| !owner\)\s*return no\(/.test(confirmBody) &&
      /return \{ ok: true, confirmation, offsetMs \};/.test(confirmBody) &&
      // Review 7 R7-1: a general gate reaches only a chain of TRUSTED_CHAINS (never Base, the canary's chain).
      /if \(!canary && TRUSTED_CHAINS\[chainId\]\?\.switchable !== true\)\s*throw new BridgeError\("WALLET_CHAIN_NOT_TRUSTED"\);/.test(
        sendBody,
      ),
    "Canary dispatch authority: minted only by the adapter from its own server calls, private, spent, no caller limits",
  );
  for (const f of files.filter((f) => SRC_CODE.test(f)))
    if (
      /(?:obtainCanaryDispatchAuthority|confirmCanaryPreparation|commitCanaryDispatch)\s*\(/.test(
        await read(f),
      )
    )
      assert(
        f === ADAPTER || f === "src/features/bridge/submission.ts",
        `Canary dispatch authority obtained outside the submission boundary: ${f}`,
      );
  // Review 23 R23-8: the two registries are touched by the adapter only.
  for (const f of files.filter((f) => SRC_CODE.test(f) && f !== ADAPTER))
    assert(
      !new RegExp(
        String.raw`\b(?:grants|confirmations)${G}\.${G}(?:set|get|delete|has)${G}\(`,
      ).test(await read(f)),
      `Canary dispatch authority: a registry of the adapter touched in ${f}`,
    );
  // 9. G14 follow-up F1 (R6-1): an undecided replacement search never ends a record. The one negative end in the
  //    consumed-nonce branch is NOT_FOUND over the complete agreed range after the drop window, with its evidence.
  //    Review 7 R7-2 / R7-3: that range reaches the block the nonce was seen consumed at, and it is the ONLY
  //    TX_DROPPED of the runtime: elapsed time alone (ABSENT with an unused nonce, an unanswered prompt) ends nothing.
  const runtimeText = await read(`${DIR}/runtime.ts`);
  const poolText = (await read(`${DIR}/rpc-pool.ts`)) ?? "";
  // Review 18 R18-2: a statement sequence with an honest `//` line allowed between statements; the comment never spans a
  // non-LF line terminator (JavaScript ends a `//` comment at CR, U+2028 and U+2029).
  const C = String.raw`\s*(?:\/\/[^\n\r\u2028\u2029]*\r?\n\s*)*`;
  const seq = (...parts) => new RegExp(parts.join(C));
  const consumed = span(
    runtimeText,
    "const found = await this.#findReplacement(",
    '} else if (nonce.nonce === null) notes.push("NONCE_NOT_PROVEN");',
  );
  assert(
    consumed.length > 0 &&
      (consumed.match(/type: "TX_DROPPED"/g) ?? []).length === 1 &&
      /\} else if \(lapsed && found\.status === "NOT_FOUND"\) \{[\s\S]*?type: "TX_DROPPED"/.test(
        consumed,
      ) &&
      /rule: "INTENT_LOG_ABSENT_OVER_COMPLETE_AGREED_RANGE"/.test(consumed) &&
      !/stayedUndecided|dropAfterMs/.test(consumed) &&
      /status: "NOT_FOUND",\s*from,\s*to: final\.toString\(\),\s*head: head\.number,\s*headHash: head\.hash,\s*depth: depth\.toString\(\),\s*tailTo: again\.head\.number,\s*nonceBlock: nonceBlock\.number,/.test(
        runtimeText,
      ) &&
      /this\.#findReplacement\(\s*mine,\s*role,\s*seenConsumedAt,\s*nonce\.head,\s*signal,?\s*\)/.test(
        consumed,
      ) &&
      // Review 9 R9-4: the first sighting itself is bound — defined from the journaled map (or this call's sighting),
      // journaled with the mark and restored — and the search head must reach this call's sighting too.
      /const seenConsumedAt =\s*this\.#consumedAt\.get\(mine\.attempt\) \?\? nonce\.head;/.test(
        runtimeText,
      ) &&
      /block: nonce\.head\?\.number \?\? null,\s*blockHash: nonce\.head\?\.hash \?\? null,/.test(
        runtimeText,
      ) &&
      /else if \(typeof d\.block === "string" && typeof d\.blockHash === "string"\)\s*this\.#consumedAt\.set\(/.test(
        runtimeText,
      ) &&
      /\(!currentSeen \|\| BigInt\(head\.number\) < BigInt\(currentSeen\.number\)\)/.test(
        runtimeText,
      ) &&
      // Review 9 R9-3: the not-final tail is read on every call before a negative end; R9-2: one exact own match over
      // the complete final range; R9-1: a claimed-but-unseen or rejected hash is searched too; the adoption re-checks.
      /const firstTail = await tailDecision\(final \+ 1n, BigInt\(head\.number\)\);\s*if \(firstTail\) return firstTail;/.test(
        runtimeText,
      ) &&
      // Review 10 R10-3: the branches themselves — an incomplete tail or a budget-stopped read decides nothing, another
      // intent in the not-final tail decides nothing, the OWN match is journaled and restored.
      /if \(!tail\.complete\) return \{ status: "SCANNING", cursor: lo\.toString\(\) \};\s*return null;/.test(
        runtimeText,
      ) &&
      /if \(candidateReads >= CANDIDATE_READS_PER_CALL\) \{\s*this\.#journalChecked\(a\.attempt, notOurs\);\s*return \{ kind: "READ", hits, complete: false \};/.test(
        runtimeText,
      ) &&
      /\? \{ status: "FOUND", hash: tail\.hits\[0\]\.hash, sameIntent: true \}\s*: \{ status: "UNKNOWN", reason: "OTHER_INTENT_NOT_FINAL" \};/.test(
        runtimeText,
      ) &&
      /this\.#store\.append\("OWN_CANDIDATE", \{/.test(runtimeText) &&
      /else if \(e\.type === "OWN_CANDIDATE" && typeof d\.hash === "string"\)\s*this\.#ownHit\.set\(/.test(
        runtimeText,
      ) &&
      // Review 10 R10-2: one chain view — the nonce is still consumed and the head did not go back; late blocks read.
      /BigInt\(again\.nonce\) <= BigInt\(a\.txNonce!\)\s*\)\s*return \{ status: "UNKNOWN", reason: "NONCE_NOT_CONSUMED_AT_DECISION" \};/.test(
        runtimeText,
      ) &&
      // Review 11 R11-3 / review 12 R12-1: after the nonce re-read, the head may not go back and the WHOLE not-final tail
      // is read again up to the new head before NOT_FOUND.
      /if \(BigInt\(again\.head\.number\) < BigInt\(head\.number\)\)\s*return \{ status: "UNKNOWN", reason: "HEAD_WENT_BACK_DURING_DECISION" \};\s*const secondTail = await tailDecision\(\s*final \+ 1n,\s*BigInt\(again\.head\.number\),?\s*\);\s*if \(secondTail\) return secondTail;/.test(
        runtimeText,
      ) &&
      // Review 13 R13-1: the premise of the end is read at the FINAL block itself (both operators), right before
      // NOT_FOUND; R13-2: tracking calls of one record are serialised; R13-3: the checked set is read fresh per range.
      /const atFinal = await readNonceAtBlockPair\(\s*"8453",\s*owner\.account,\s*final\.toString\(\),\s*signal,?\s*\)\.catch\(\(\) => null\);\s*if \(\s*!atFinal\?\.block \|\|\s*atFinal\.nonce === null \|\|\s*BigInt\(atFinal\.nonce\) <= BigInt\(a\.txNonce!\)\s*\)\s*return \{\s*status: "UNKNOWN",\s*reason: "NONCE_NOT_CONSUMED_AT_FINAL_BLOCK",?\s*\};\s*return \{\s*status: "NOT_FOUND",/.test(
        runtimeText,
      ) &&
      /const previous = this\.#tracking\.get\(i\.record\) \?\? Promise\.resolve\(\);\s*const run = previous\s*\.catch\(\(\) => undefined\)\s*\.then\(\(\) => this\.#track\(i\.record, signal\)\);/.test(
        runtimeText,
      ) &&
      /const seen = this\.#checked\.get\(a\.attempt\) \?\? checked;/.test(
        runtimeText,
      ) &&
      // Review 14 R14-1: a destination fill and a source refund count only in FINAL blocks.
      /const finalArb =\s*BigInt\(head\.number\) - BigInt\(EXECUTION_POLICY\.confirmations\["42161"\]\);/.test(
        runtimeText,
      ) &&
      /const to =\s*finalArb < BigInt\(start\) \+ 4_999n \? finalArb : BigInt\(start\) \+ 4_999n;/.test(
        runtimeText,
      ) &&
      /BigInt\(baseHead\.number\) -\s*BigInt\(EXECUTION_POLICY\.confirmations\["8453"\]\)/.test(
        runtimeText,
      ) &&
      /const until = baseFinal < from \+ 4_999n \? baseFinal : from \+ 4_999n;/.test(
        runtimeText,
      ) &&
      runtimeText.indexOf(
        "  #journalChecked(attempt: string, hashes: string[]) {",
      ) > runtimeText.indexOf("  async #findReplacement(") &&
      runtimeText.indexOf("  async #findReplacement(") > 0 &&
      // Review 14 R14-3: exactly two NOT_FOUND answers in the search (mode OWN, mode REPLACEMENT after the premise);
      // the queue entry is stored; the pool helper reads THE asked block and answers only for it.
      (
        runtimeText
          .slice(
            runtimeText.indexOf("  async #findReplacement("),
            runtimeText.indexOf(
              "  #journalChecked(attempt: string, hashes: string[]) {",
            ),
          )
          .match(/status: "NOT_FOUND"(?!;)/g) ?? []
      ).length === 2 &&
      // Review 15 R15-2 (N3b): the premise read follows the second tail read directly (nothing answers between them).
      /if \(secondTail\) return secondTail;\s*(?:\/\/[^\n]*\n\s*)*const atFinal = await readNonceAtBlockPair\(/.test(
        runtimeText,
      ) &&
      /this\.#tracking\.set\(i\.record, run\);/.test(runtimeText) &&
      /async function blocksAtNumber\([\s\S]{0,200}?const tag = `0x\$\{BigInt\(number\)\.toString\(16\)\}`;[\s\S]{0,300}?"eth_getBlockByNumber", \[tag, false\][\s\S]{0,300}?const b = agreedBlock\(blocks\);\s*if \(!b \|\| b\.number !== BigInt\(number\)\.toString\(\)\) return null;\s*return \[blocks\[0\]!, blocks\[1\]!\];/.test(
        poolText,
      ) &&
      /export async function readNonceAtBlockPair\([\s\S]{0,250}?const blocks = await blocksAtNumber\(chain, number, signal\);\s*if \(!blocks\) return \{ nonce: null, block: null \};\s*return \{\s*nonce: await nonceAt\(chain, owner, blocks, signal\),\s*block: blocks\[0\],/.test(
        poolText,
      ) &&
      /export async function readBalancesAtBlockPair\([\s\S]{0,400}?const blocks = await blocksAtNumber\(chain, number, signal\);\s*if \(!blocks\) return \{ balances: \[null, null\], block: null \};\s*return \{\s*balances: await balancesAt\(chain, owner, signal, blocks\),\s*block: blocks\[0\],/.test(
        poolText,
      ) &&
      // Review 15 R15-2: the read bounds and the two cursors themselves (not only the definitions they use).
      /topics: \[FILLED_RELAY_TOPIC, word\(8453n\), word\(depositId\)\],\s*fromBlock: start,\s*toBlock: to\.toString\(\),/.test(
        runtimeText,
      ) &&
      /pad\(owner\.account\),\s*\],\s*fromBlock: from\.toString\(\),\s*toBlock: until\.toString\(\),/.test(
        runtimeText,
      ) &&
      /if \(destinationFinal && fills\.logs!\.length === 0 && to < finalArb\) \{\s*this\.#store\.append\("CURSOR", \{\s*record: r\.id,\s*block: \(to \+ 1n\)\.toString\(\),\s*\}\);\s*this\.#cursor\.set\(r\.id, \(to \+ 1n\)\.toString\(\)\);/.test(
        runtimeText,
      ) &&
      /if \(until < baseFinal\) \{\s*const next = \(until \+ 1n\)\.toString\(\);[\s\S]{0,300}?this\.#store\.append\("REFUND_CURSOR", \{\s*record: r\.id,\s*block: next,[\s\S]{0,120}?this\.#refundCursor\.set\(r\.id, next\);/.test(
        runtimeText,
      ) &&
      // Review 15 R15-1: the reconciliation that ends a record reads the FINAL block of each chain, and only once that
      // block holds the deposit and the fill it reconciles.
      /const baseFinal =\s*BigInt\(base\.head\.number\) - BigInt\(EXECUTION_POLICY\.confirmations\["8453"\]\);\s*const arbFinal =\s*BigInt\(arb\.head\.number\) - BigInt\(EXECUTION_POLICY\.confirmations\["42161"\]\);\s*const from = BigInt\(this\.#cursor\.get\(r\.id\) \?\? reads\.arbStartBlock\);\s*if \(baseFinal < BigInt\(receipt\.blockNumber\) \|\| arbFinal < from\) \{\s*notes\.push\("RECONCILIATION_NOT_FINAL_YET"\);\s*return r;\s*\}\s*const to = arbFinal < from \+ 4_999n \? arbFinal : from \+ 4_999n;/.test(
        runtimeText,
      ) &&
      /topics: \[FILLED_RELAY_TOPIC, word\(8453n\), word\(deposit\.depositId\)\],\s*fromBlock: from\.toString\(\),\s*toBlock: to\.toString\(\),[\s\S]{0,120}?if \(\s*fill\?\.status !== "AGREE" \|\|\s*!fill\.logs\?\.some\(\(l\) => lower\(l\.transactionHash\) === lower\(fillHash\)\)\s*\) \{\s*notes\.push\("RECONCILIATION_NOT_FINAL_YET"\);\s*return r;/.test(
        runtimeText,
      ) &&
      /readBalancesAtBlockPair\(\s*"8453",\s*owner\.account,\s*baseFinal\.toString\(\),\s*signal,?\s*\)[\s\S]{0,40}?readBalancesAtBlockPair\(\s*"42161",\s*owner\.account,\s*arbFinal\.toString\(\),\s*signal,?\s*\)/.test(
        runtimeText,
      ) &&
      /if \(!baseAt\?\.block \|\| !arbAt\?\.block\) \{\s*notes\.push\("RECONCILIATION_FINAL_BLOCK_UNREAD"\);\s*return r;\s*\}\s*const out = this\.#batch\(\(\) =>\s*this\.#engine\.reconcile\(r\.id, \{\s*baseBefore: reads\.baseBefore,\s*baseAfter: baseAt\.balances,\s*arbBefore: reads\.arbBefore,\s*arbAfter: arbAt\.balances,/.test(
        runtimeText,
      ) &&
      (runtimeText.match(/this\.#engine\.reconcile\(/g) ?? []).length === 1 &&
      // Review 18 R18-1 (c): no lone CR and no U+2028 / U+2029 in the runtime (a `//` comment ends there in JavaScript,
      // so text a comment allowance accepts could run as code).
      !/\r(?!\n)|[\u2028\u2029]/.test(runtimeText) &&
      // Review 16 R16-1 / review 17 (A2, A3): the allowance is read and its notes are pushed on every call that reached
      // the head reads, also while the verdict waits.
      seq(
        String.raw`if \(!base \|\| !arb\) return r;`,
        String.raw`const out = await this\.#reconcileAtFinal\(r, notes, signal, base, arb\);`,
        String.raw`const allowance = await this\.#readAllowance\(r\.id, signal, base\);`,
        String.raw`if \(allowance\.status === "NONZERO"\)\s*notes\.push\("ALLOWANCE_NOT_ZERO_AFTER"\);`,
        String.raw`else if \(allowance\.status === "UNKNOWN"\)\s*notes\.push\("ALLOWANCE_UNKNOWN_AFTER"\);`,
        String.raw`return out;\s*\}`,
      ).test(runtimeText) &&
      // Review 16 (Q1 / Q6), reviews 17-19: in #reconcile + #reconcileAtFinal and in #settle the head reads, the head
      // checks and the final-block arithmetic are pinned statement by statement, the helper's parameter list included.
      // A `//` line is allowed between the TOP-LEVEL statements of each sequence only (not inside its blocks, lists or
      // the parameter list); a failure names only rule 9. Counted to occur once in runtime.ts (fail-safe: a second
      // correct copy is rejected too): the verdict-helper call and its guard, the head check, the head-read tail of
      // #settle, the finalArb / arbFinal definitions and the whole reconciliation baseFinal definition — the joins
      // between THESE pins. Not counted: other repeated statements (e.g. `const owner = this.#record();`) and the joins
      // of older rule-9 pins (e.g. the premise read). A text pin cannot exclude every construct that changes behaviour;
      // what these do not bind is caught by the positive fixtures (evidence/mutation-r15), not here.
      seq(
        String.raw`async #reconcile\(r: ExecutionRecord, notes: string\[\], signal: AbortSignal\) \{`,
        String.raw`const owner = this\.#record\(\);`,
        String.raw`const reads = this\.#reads\.get\(r\.id\);`,
        String.raw`if \(!reads\) return r;`,
        String.raw`const \[base, arb\] = await Promise\.all\(\[\s*readBalancesAtHead\("8453", owner\.account, signal\)\.catch\(\(\) => null\),\s*readBalancesAtHead\("42161", owner\.account, signal\)\.catch\(\(\) => null\),\s*\]\);`,
        String.raw`if \(!base \|\| !arb\) return r;`,
        String.raw`const out = await this\.#reconcileAtFinal\(r, notes, signal, base, arb\);`,
      ).test(runtimeText) &&
      seq(
        String.raw`async #reconcileAtFinal\(\s*r: ExecutionRecord,\s*notes: string\[\],\s*signal: AbortSignal,\s*base: Awaited<ReturnType<typeof readBalancesAtHead>>,\s*arb: Awaited<ReturnType<typeof readBalancesAtHead>>,?\s*\): Promise<ExecutionRecord> \{`,
        String.raw`const owner = this\.#record\(\);`,
        String.raw`const reads = this\.#reads\.get\(r\.id\)!;`,
        String.raw`if \(!base\.head \|\| !arb\.head\) \{\s*notes\.push\("RECONCILIATION_HEAD_UNREAD"\);\s*return r;\s*\}`,
        String.raw`const receipt = r\.hashes\.main\s*\? this\.#receipts\.get\(lower\(r\.hashes\.main\)\)\s*: undefined;`,
        String.raw`const deposit = receipt \? depositOf\(receipt\) : null;`,
        String.raw`const fillHash = r\.hashes\.destination;`,
        String.raw`if \(!receipt \|\| !deposit \|\| !fillHash \|\| !reads\.arbStartBlock\) \{\s*notes\.push\("RECONCILIATION_EVIDENCE_UNKNOWN"\);\s*return r;\s*\}`,
        String.raw`const baseFinal =\s*BigInt\(base\.head\.number\) - BigInt\(EXECUTION_POLICY\.confirmations\["8453"\]\);`,
      ).test(runtimeText) &&
      seq(
        String.raw`const start = this\.#cursor\.get\(r\.id\) \?\? reads\.arbStartBlock;`,
        String.raw`const head =\s*\(\s*await readBalancesAtHead\("42161", owner\.account, signal\)\.catch\(\s*\(\) => null,?\s*\)\s*\)\?\.head \?\? null;`,
        String.raw`if \(!head\) return r;`,
        String.raw`const finalArb =`,
      ).test(runtimeText) &&
      (runtimeText.match(/if \(!base\.head \|\| !arb\.head\) \{/g) ?? [])
        .length === 1 &&
      (
        runtimeText.match(/\)\?\.head \?\? null;\s*if \(!head\) return r;/g) ??
        []
      ).length === 1 &&
      (runtimeText.match(/async #reconcileAtFinal\(/g) ?? []).length === 1 &&
      // Review 19 R19-1: the three joins between pins (a dead copy of the shared text would let each pin match a
      // different copy).
      (
        runtimeText.match(
          /const out = await this\.#reconcileAtFinal\(r, notes, signal, base, arb\);/g,
        ) ?? []
      ).length === 1 &&
      (runtimeText.match(/if \(!base \|\| !arb\) return r;/g) ?? []).length ===
        1 &&
      (runtimeText.match(/const finalArb =/g) ?? []).length === 1 &&
      (runtimeText.match(/const arbFinal =/g) ?? []).length === 1 &&
      (
        runtimeText.match(
          /const baseFinal =\s*BigInt\(base\.head\.number\) - BigInt\(EXECUTION_POLICY\.confirmations\["8453"\]\);/g,
        ) ?? []
      ).length === 1 &&
      /async function refresh\(\) \{\s*const r = review \?\? resumed\.current;\s*if \(!r\) return;[\s\S]{0,200}?setBusy\(true\);\s*try \{/.test(
        await read("src/components/execution-review.tsx"),
      ) &&
      // Review 12 R12-2: an adoption ends the tracking call (no event with an earlier time after it).
      /await this\.#verifyClaim\(a, signal\);\s*notes\.push\(`OWN_TRANSACTION_FOUND_ON_CHAIN:\$\{claimed\}`\);[\s\S]{0,400}?return this\.view\(record, notes\);/.test(
        runtimeText,
      ) &&
      // Review 11 R11-1: an own-search NOT_FOUND tells the owner what it can mean.
      /"OWN_TRANSACTION_NOT_FOUND:NOT_CONFIRMED_OR_EDITED_OR_REVERTED"/.test(
        runtimeText,
      ) &&
      // Review 10 R10-1: an UNCERTAIN record whose nonce moved has its allowance read (and the view states it).
      /ALLOWANCE_READ_WHILE_UNCERTAIN:\$\{\(await this\.#readAllowance\(record, signal\)\)\.status\}/.test(
        runtimeText,
      ) &&
      /ALLOWANCE_STANDS_WHILE_UNCERTAIN:\$\{allowance\.value\}/.test(
        runtimeText,
      ) &&
      /if \(final < BigInt\(nonceBlock\.number\)\)\s*return \{ status: "UNKNOWN", reason: undecided\(\) \};[\s\S]{0,1800}?const again = await readNoncePair\([\s\S]{0,3000}?return \{\s*status: "NOT_FOUND",/.test(
        runtimeText,
      ) &&
      /if \(known && known !== lower\(tx\.hash\)\)\s*return \{ status: "UNKNOWN", reason: "MORE_THAN_ONE_CANDIDATE" \};/.test(
        runtimeText,
      ) &&
      /x\.state === "HASH_CLAIMED" \|\|\s*x\.state === "HASH_REJECTED"/.test(
        runtimeText,
      ) &&
      /a\.hash !== before\.hash \|\|\s*this\.#engine\.record\(record\)\?\.state !== "UNCERTAIN"/.test(
        runtimeText,
      ) &&
      // Review 8 R8-4: final blocks only (the Base confirmation depth), the first sighting of the consumed nonce, the
      // attempt's own hash in the range decides nothing, and a revert ends a record only at that depth.
      /const depth = BigInt\(EXECUTION_POLICY\.confirmations\["8453"\]\);\s*const final = BigInt\(head\.number\) - depth;/.test(
        runtimeText,
      ) &&
      /const hi = final < lo \+ 4_999n \? final : lo \+ 4_999n;/.test(
        runtimeText,
      ) &&
      /if \(mode === "REPLACEMENT" && a\.hash && inRange\.includes\(lower\(a\.hash\)\)\)\s*return \{ kind: "UNKNOWN", reason: "OWN_HASH_LOG_IN_RANGE" \};/.test(
        runtimeText,
      ) &&
      /!receipt\.success &&\s*rc\.confirmations < EXECUTION_POLICY\.confirmations\["8453"\]/.test(
        runtimeText,
      ) &&
      // Review 8 R8-1: an UNCERTAIN step's own transaction is adopted only when it matches EXACTLY, and only through
      // the verified claim path.
      /mode === "OWN"\s*\?\s*BigInt\(tx\.nonce\) >= BigInt\(a\.accountNonce!\) && exact\(tx\)/.test(
        runtimeText,
      ) &&
      /state: "HASH_CLAIMED",\s*hash: claimed,\s*source: "CHAIN_SEARCH",[\s\S]{0,300}?a\.state = "HASH_CLAIMED";\s*a\.hash = claimed;\s*await this\.#verifyClaim\(a, signal\);/.test(
        runtimeText,
      ) &&
      /if \(lo <= final\) return \{ status: "SCANNING", cursor: lo\.toString\(\) \};/.test(
        runtimeText,
      ) &&
      /consumedSeenAtBlock: found\.nonceBlock,/.test(consumed) &&
      (runtimeText.match(/type: "TX_DROPPED"/g) ?? []).length === 1 &&
      !/type: "UNCERTAIN_TIMEOUT"/.test(runtimeText) &&
      /"RECORD_STAYS_ACTIVE_TX_MAY_STILL_BE_MINED"/.test(runtimeText) &&
      /"RECORD_STAYS_ACTIVE_PROMPT_MAY_STILL_BE_CONFIRMED"/.test(runtimeText) &&
      /REPLACEMENT_SEARCH_\|RECORD_STAYS_ACTIVE\|INTENT_LOG_ABSENT\|CONSUMING_TRANSACTION\|TX_MINED_AFTER_END\|SPEED_UP_TRACKED/.test(
        runtimeText,
      ),
    "Canary tracking: an undecided search never ends a record; the negative end needs the complete agreed range",
  );
  // 10. G14 follow-up F3: an allowance is ZERO / NONZERO only when both operators state the same number at one agreed
  //     block; anything else is UNKNOWN (never 0), and the view says which.
  assert(
    /b && b\.head && typeof v0 === "string" && \/\^\\d\+\$\/\.test\(v0\) && v0 === v1/.test(
      runtimeText,
    ) &&
      /status: "UNKNOWN",\s*value: null,/.test(runtimeText) &&
      !/allowance !== "0" \|\|/.test(runtimeText) &&
      /ALLOWANCE_UNKNOWN\|ALLOWANCE_MAY_STAND\|ALLOWANCE_STANDS/.test(
        runtimeText,
      ),
    "Canary allowance: two-operator read, unknown never zero",
  );
  // 11. G14 follow-up F4 (i18n / success label): the panel says "completed" in ONE place, only for a RECONCILED,
  //     attention-free, durable record; and in every one of the 24 locales the completed text is a text of its own
  //     (no attention / state / uncertain text reads the same), so no translation can show an open record as done.
  const panel = await read("src/components/execution-review.tsx");
  assert(
    (panel.match(/t\("g14\.c\.completed"\)/g) ?? []).length === 1 &&
      /const done = canaryShowsCompleted\(view\);[\s\S]{0,400}\{done\s*\?\s*t\("g14\.c\.completed"\)/.test(
        panel,
      ) &&
      /view\.completed === true &&\s*view\.state === "RECONCILED" &&\s*view\.needsAttention !== true &&\s*!view\.notDurable/.test(
        panel,
      ),
    "Canary panel: one completed label, only for a reconciled, attention-free, durable record",
  );
  const localeDir = "src/i18n/locales";
  const locales = (await readdir(localeDir)).filter((f) => f.endsWith(".json"));
  assert(locales.length === 24, "Canary i18n: the 24 locales");
  for (const f of locales) {
    const c = JSON.parse(await read(`${localeDir}/${f}`)).g14?.c ?? {};
    const done = c.completed;
    assert(
      typeof done === "string" &&
        done.trim().length > 0 &&
        Object.entries(c)
          .filter(([k]) => k !== "completed")
          .every(([, v]) => typeof v !== "string" || v.trim() !== done.trim()),
      `Canary i18n: the completed text of ${f} is not a text of its own`,
    );
  }
  // 12. G14 follow-up F4 (lock): the supported deployment is enforced by the store itself.
  const store = await read(`${DIR}/durable-store.ts`);
  assert(
    /if \(!isMainThread\) throw new StoreError\("STORE_THREAD_UNSUPPORTED"\);/.test(
      store,
    ) &&
      /throw new StoreError\("STORE_SHARED_PATH_UNSUPPORTED"\)/.test(store) &&
      /throw new StoreError\("STORE_LOCKED_FOREIGN_HOST"\)/.test(store) &&
      /this\.#io\.fsyncSync\(fd\);[\s\S]{0,900}?this\.#checkLock\(\);\s*this\.#entries\.push\(\.\.\.batch\);/.test(
        store,
      ),
    "Canary store: one main thread on one local machine; a lost lock never reports a write as durable",
  );
  // 7. The API refuses every signing-path action while the canary is not armed, before the runtime is touched.
  const route = await read("src/app/api/execution/route.ts");
  const runtimeCalls = [
    ...route.matchAll(new RegExp(String.raw`canaryRuntime${G}\(`, "g")),
  ].map((m) => m.index);
  const closedAt = route.indexOf("if (!armed.armed) {");
  assert(
    runtimeCalls.length === 1 &&
      count(String.raw`canaryRuntime\s*\(`, code2(route)) === 1 &&
      count(String.raw`if \(!armed\.armed\) \{`, route) === 1 &&
      count(String.raw`if \(!armed\.armed\) \{`, code2(route)) === 1 &&
      closedAt > 0 &&
      runtimeCalls[0] > closedAt,
    "Canary API: WRITE_DISABLED before the runtime while not armed",
  );
  // Review 23 R23-4: THE closed check of the handler, pinned as one contiguous block that ends right before the runtime
  // (a guard of the same text elsewhere, or a lazy span across other code, cannot stand in for it).
  assert(
    /const armed = canaryArmed\(\);\s*if \(!armed\.armed\) \{\s*if \(!CANARY_WRITES\.has\(r\.action\)\)\s*return reply\(\{ \.\.\.canaryStatus\(\), review: null, resume: null \}\);\s*guardStatus\("WRITE_DISABLED"\);\s*return reply\(\{ error: "WRITE_DISABLED", gate: canaryStatus\(\)\.gate \}, 403\);\s*\}\s*let rt: ReturnType<typeof canaryRuntime>;\s*try \{\s*rt = canaryRuntime\(\);/.test(
      route,
    ),
    "Canary API: WRITE_DISABLED before the runtime while not armed",
  );
  canary.rules = 12;
}
const result = {
  at: new Date().toISOString(),
  result: "PASS",
  v15: {
    productionCspInlineAllowed: false,
    inlineStyleSinks: 0,
    publicMetricsRoute: false,
    writeRegistryEmpty: true,
    globalKill: true,
    realFeeBps: 0,
  },
  v19: {
    walletSendLiterals: sendLiterals,
    walletSendFile: ADAPTER,
    privyLayerOnly: true,
    privyConnectOnly: true,
    rawInjectedDiscovery: false,
    privyCspExactOrigins: true,
  },
  g14Canary: canary,
  sourceFiles: findings.length,
  dataPlaneFiles: dataFiles.length,
  paidPortfolioDependency: false,
  fortyChainCap: false,
  mainnetSubmission: false,
  privateKeys: false,
  productionDeploy: false,
  scope: "Static application boundary checks, not independent security audit",
};
await mkdir(base, { recursive: true });
await writeFile(`${base}/safety.json`, JSON.stringify(result, null, 2));
console.log(result);
