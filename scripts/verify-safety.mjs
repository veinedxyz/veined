import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import ts from "typescript";
import { resolve as resolveManualPath } from "node:path";
const manualProfile = process.argv.includes("--manual-wallet-candidate");
const MANUAL_RUNTIME = "src/manual-wallet/server/runtime.ts";
if (manualProfile) {
  assert.equal(
    resolveManualPath(process.cwd()).toLowerCase(),
    resolveManualPath(
      "D:/vnd/post-hackathon-20261117-01/candidate",
    ).toLowerCase(),
    "Manual profile is candidate-local only",
  );
  await import("./manual-wallet-safety.mjs");
}

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
// VEINED-MC1 lanes review R2 MINOR-2: rule 13 also reads lane code as a TypeScript syntax tree (the parser above), so a
// different spelling of a banned construct (an alias, a property chain, a built string) is still the same node. Each
// tree is parsed from the VISIBLE code once per scan.
const kindOf = (fileName) =>
  /\.tsx$/.test(fileName)
    ? ts.ScriptKind.TSX
    : /\.jsx$/.test(fileName)
      ? ts.ScriptKind.JSX
      : /\.[mc]?js$/.test(fileName)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
const trees = new Map();
const astOf = (fileName, text) => {
  const hit = trees.get(fileName);
  if (hit && hit.text === text) return hit.sf;
  const sf = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    kindOf(fileName),
  );
  trees.set(fileName, { text, sf });
  return sf;
};
const eachNode = (node, fn) => {
  fn(node);
  ts.forEachChild(node, (c) => eachNode(c, fn));
};
// The same walk without one subtree (`skip`: a syntax node, never a text span).
const eachNodeExcept = (node, skip, fn) => {
  if (node === skip) return;
  fn(node);
  ts.forEachChild(node, (c) => eachNodeExcept(c, skip, fn));
};
// Every string-like literal's text and every numeric literal's decimal value of a file, in source order, joined with
// NOTHING between them: a word cut into fragments ("x-f" + "l1-s" + ...) is whole again wherever the cuts are.
const joinedLiterals = (sf, skip) => {
  let s = "";
  eachNodeExcept(sf, skip, (n) => {
    if (
      ts.isStringLiteral(n) ||
      ts.isNoSubstitutionTemplateLiteral(n) ||
      n.kind === ts.SyntaxKind.TemplateHead ||
      n.kind === ts.SyntaxKind.TemplateMiddle ||
      n.kind === ts.SyntaxKind.TemplateTail
    )
      s += n.text;
    else if (ts.isNumericLiteral(n)) s += n.text;
  });
  return s;
};
// The value of every numeric and bigint literal (0xcdc, 0o6334, 3_292 and 3292n are all 3292).
const numericValues = (sf, skip) => {
  const out = [];
  eachNodeExcept(sf, skip, (n) => {
    try {
      if (ts.isNumericLiteral(n) && /^\d+$/.test(n.text))
        out.push(BigInt(n.text));
      else if (ts.isBigIntLiteral(n))
        out.push(BigInt(String(n.text).slice(0, -1).split("_").join("")));
    } catch {
      /* not an integer */
    }
  });
  return out;
};
// VEINED-MC1 lanes review R2 NEW-4: an explicit, never-default ARMED-PROFILE scan (`--armed-profile`). It exempts ONLY
// the exact armed signer declarations of the two lane approval files (a loopback `http://127.0.0.1:329x/` url and a
// `<drive>:/.../journal/signer-v5.token` token file; each read as the disarmed declaration by every rule) and turns the
// two disarmed-value rules into armed-shape rules. Every other rule applies unchanged. Its result is never "PASS":
// it reports ARMED_PROFILE_PASS into safety-armed-profile.json. The default scan is unchanged.
const CLI = process.argv.slice(2);
for (const a of CLI)
  assert(
    a === "--armed-profile" || a === "--manual-wallet-candidate",
    `verify-safety: unknown argument ${a}`,
  );
const ARMED_PROFILE = CLI.includes("--armed-profile");
const ARMED_SIGNER_FACTS = {
  "src/swap/lane/approval.ts": "OWNER_SWAP_LANE_SIGNER",
  "src/swap/lane/bridge-approval.ts": "OWNER_BRIDGE_LANE_SIGNER",
};
// VEINED-MC1 lanes review R3-4: a protected fact is the SYNTAX NODE of its declaration, never a text match. It is the
// file's one top-level `export const NAME = <value> as <type>;` statement, and NAME is bound nowhere else in the file
// (no second declaration, no shadow, no export alias). A string, template literal or comment that holds the same text
// is not a VariableStatement node, so it never counts as the declaration, and nothing is exempted around it.
const DECL_NAME_KINDS = new Set([
  ts.SyntaxKind.VariableDeclaration,
  ts.SyntaxKind.BindingElement,
  ts.SyntaxKind.Parameter,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.FunctionExpression,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.ClassExpression,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ImportClause,
  ts.SyntaxKind.ImportSpecifier,
  ts.SyntaxKind.NamespaceImport,
  ts.SyntaxKind.ImportEqualsDeclaration,
  ts.SyntaxKind.ExportSpecifier,
  ts.SyntaxKind.NamespaceExport,
]);
// The declaration-name identifiers of `name` in a file (every binding: declarations, parameters, imports, exports).
const bindingsOf = (sf, name) => {
  const out = [];
  eachNode(sf, (n) => {
    if (
      ts.isIdentifier(n) &&
      n.text === name &&
      DECL_NAME_KINDS.has(n.parent.kind) &&
      n.parent.name === n
    )
      out.push(n);
  });
  return out;
};
// `name` is bound exactly once in the file, by an unrenamed named import from `spec` (no local stand-in, no shadow).
const importedOnce = (sf, name, spec) => {
  const b = bindingsOf(sf, name);
  const el = b[0]?.parent;
  const decl = el?.parent?.parent?.parent;
  return (
    b.length === 1 &&
    ts.isImportSpecifier(el) &&
    !el.propertyName &&
    !!decl &&
    ts.isImportDeclaration(decl) &&
    ts.isStringLiteral(decl.moduleSpecifier) &&
    decl.moduleSpecifier.text === spec
  );
};
const topConsts = (sf, name) =>
  sf.statements.filter(
    (st) =>
      ts.isVariableStatement(st) &&
      (st.declarationList.flags & ts.NodeFlags.Const) !== 0 &&
      st.declarationList.declarations.length === 1 &&
      ts.isIdentifier(st.declarationList.declarations[0].name) &&
      st.declarationList.declarations[0].name.text === name,
  );
const factDecl = (sf, name) => {
  const top = topConsts(sf, name);
  let bindings = 0;
  eachNode(sf, (n) => {
    if (
      ts.isIdentifier(n) &&
      n.text === name &&
      DECL_NAME_KINDS.has(n.parent.kind) &&
      n.parent.name === n
    )
      bindings++;
  });
  if (top.length !== 1 || bindings !== 1) return null;
  const st = top[0];
  const d = st.declarationList.declarations[0];
  const mods = st.modifiers ?? [];
  if (
    mods.length !== 1 ||
    mods[0].kind !== ts.SyntaxKind.ExportKeyword ||
    d.type ||
    d.exclamationToken ||
    !d.initializer ||
    !ts.isAsExpression(d.initializer)
  )
    return null;
  return {
    st,
    value: d.initializer.expression,
    type: d.initializer.type.getText(sf).replace(/\s+/g, ""),
  };
};
const SIGNER_FACT_TYPE = "Readonly<{url:string;tokenFile:string;}>|null";
// CONTRACT-v5.md fixes the signer endpoint at exactly POST http://127.0.0.1:3292/ (no other port of 3290-3299).
const ARMED_SIGNER_URL = "http://127.0.0.1:3292/";
// An absolute LOCAL drive path (`<drive>:/…/journal/signer-v5.token`, forward slashes): no UNC or device path (it must
// start with a drive letter), no backslash, and no `.` / `..` (or other all-dot or dot-ending) segment.
const armedTokenFileOk = (p) =>
  /^[A-Za-z]:\/(?:[A-Za-z0-9._-]+\/)*journal\/signer-v5\.token$/.test(p) &&
  p
    .slice(3)
    .split("/")
    .every((seg) => !/^\.+$/.test(seg) && !/\.$/.test(seg));
// The exact armed signer value: `{ url: "<ARMED_SIGNER_URL>", tokenFile: "<local journal token path>" }`, two plain
// properties with plain string literals, typed as the disarmed declaration.
const armedSignerValue = (fact) => {
  if (!fact || fact.type !== SIGNER_FACT_TYPE) return false;
  const o = fact.value;
  if (!ts.isObjectLiteralExpression(o) || o.properties.length !== 2)
    return false;
  const [u, t] = o.properties;
  return (
    ts.isPropertyAssignment(u) &&
    ts.isIdentifier(u.name) &&
    u.name.text === "url" &&
    ts.isStringLiteral(u.initializer) &&
    u.initializer.text === ARMED_SIGNER_URL &&
    ts.isPropertyAssignment(t) &&
    ts.isIdentifier(t.name) &&
    t.name.text === "tokenFile" &&
    ts.isStringLiteral(t.initializer) &&
    armedTokenFileOk(t.initializer.text)
  );
};
const armedSigners = [];
// Armed profile only: the ONE exact armed signer declaration node of each approval file is read as the disarmed null
// declaration (its statement's own range is replaced); everything else in the file, every string included, is read
// as written.
const armedView = (file, source) => {
  const name = ARMED_PROFILE ? ARMED_SIGNER_FACTS[file] : undefined;
  if (!name) return source;
  const sf = ts.createSourceFile(
    `${file}#armed-view`,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const armedTop = topConsts(sf, name).filter((st) => {
    const i = st.declarationList.declarations[0].initializer;
    return (
      !!i &&
      ts.isAsExpression(i) &&
      armedSignerValue({
        value: i.expression,
        type: i.type.getText(sf).replace(/\s+/g, ""),
      })
    );
  });
  assert(
    armedTop.length <= 1,
    `Armed profile: more than one armed ${name}: ${file}`,
  );
  const fact = factDecl(sf, name);
  if (!fact || !armedSignerValue(fact)) return source;
  armedSigners.push(name);
  return (
    source.slice(0, fact.st.getStart(sf)) +
    `export const ${name} = null as Readonly<{ url: string; tokenFile: string; }> | null;` +
    source.slice(fact.st.end)
  );
};
// The four protected facts of a lane (P = SWAP | BRIDGE) on the syntax tree. Default scan: each is its disarmed
// value. Armed profile: each is its disarmed value or a well-formed armed value, and the signer is the null declaration
// (armedView above read the exact armed one as null).
const laneFactsOk = (sf, P, recordType, armed) => {
  const N = ts.SyntaxKind;
  const record = factDecl(sf, `OWNER_${P}_LANE_APPROVAL`),
    key = factDecl(sf, `OWNER_${P}_LANE_KEY_SHA256`),
    wiring = factDecl(sf, `${P}_LANE_LIVE_WIRING`),
    signer = factDecl(sf, `OWNER_${P}_LANE_SIGNER`);
  if (!record || !key || !wiring || !signer) return false;
  const isNull = (f) => f.value.kind === N.NullKeyword;
  const shapes =
    record.type === `Readonly<${recordType}>|null` &&
    key.type === "string|null" &&
    wiring.type === "const" &&
    signer.type === SIGNER_FACT_TYPE &&
    isNull(signer);
  if (!armed)
    return (
      shapes &&
      isNull(record) &&
      isNull(key) &&
      wiring.value.kind === N.FalseKeyword
    );
  const r = record.value;
  return (
    shapes &&
    (isNull(record) ||
      ts.isObjectLiteralExpression(r) ||
      (ts.isCallExpression(r) &&
        r.expression.getText(sf) === "Object.freeze" &&
        r.arguments.length === 1 &&
        ts.isObjectLiteralExpression(r.arguments[0]))) &&
    (isNull(key) ||
      (ts.isStringLiteral(key.value) &&
        /^[0-9a-f]{64}$/.test(key.value.text))) &&
    (wiring.value.kind === N.FalseKeyword ||
      wiring.value.kind === N.TrueKeyword)
  );
};
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
  sendLiterals === (manualProfile ? 2 : 1),
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
// VEINED-FIN-LIVE-20261115-01: the separate swap lane reports its own rule count (rule 13), not the canary's.
const swapLane = { rules: 0 };
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
    if (!visible.has(p))
      visible.set(p, armedView(p, stripComments(await readRaw(p), p)));
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
    if (/new CanaryRuntime\s*\(/.test(raw))
      assert(
        f === `${DIR}/runtime.ts`,
        `Canary store or runtime opened outside the runtime: ${f}`,
      );
    // VEINED-FIN-LIVE-20261115-01 (rule 13): the store implementation is opened by exactly three compositions, each in
    // its OWN directory: the canary runtime, the separate swap-lane runtime and (VEINED-MC1) the separate bridge-lane
    // runtime (once each).
    if (/CanaryDurableStore\.open\s*\(/.test(raw))
      assert(
        (f === `${DIR}/runtime.ts` ||
          f === "src/swap/lane/runtime.ts" ||
          f === "src/swap/lane/bridge-runtime.ts" ||
          (manualProfile &&
            (f === MANUAL_RUNTIME || f === "src/scan/server.ts"))) &&
          count(String.raw`CanaryDurableStore\.open\s*\(`, raw) === 1,
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
  // 13. VEINED-FIN-LIVE-20261115-01: the SEPARATE swap lane (src/swap/lane/**, src/app/api/swap-lane/route.ts).
  //     Disarmed by four exact literals; one engine-only dispatch authority; one runtime-only signer hand-off; the
  //     route refuses every write before the runtime; no Permit2 / permit / typed data; reads only through the lane's
  //     own transport (imported by the read module alone; pool URLs by index, redirect "error", no-store); no import of
  //     the canary's record, engine, runtime or the browser wallet adapter. The route table keeps the reviewed Base route.
  {
    const LANE = "src/swap/lane";
    const laneFiles = files.filter(
      (f) => f.startsWith(`${LANE}/`) && /\.ts$/.test(f),
    );
    // The only lane files that may name `fetch`: the loopback signer hand-off and the lane's read transport.
    const LANE_FETCH = [`${LANE}/signer-adapter.ts`, `${LANE}/transport.ts`];
    for (const req of [
      "approval.ts",
      "calldata.ts",
      "engine.ts",
      "pins.ts",
      "reads.ts",
      "runtime.ts",
      "scope.ts",
      "signer-adapter.ts",
      "transport.ts",
    ])
      assert(
        laneFiles.includes(`${LANE}/${req}`),
        `Swap lane file missing: ${req}`,
      );
    const laneApproval = await read(`${LANE}/approval.ts`);
    // VEINED-MC1 lanes review R3-4: the facts are also read as the declaration NODES (laneFactsOk), so a string that
    // holds a disarmed declaration's text can never stand in for the real one.
    const swapFactsOk = laneFactsOk(
      astOf(`${LANE}/approval.ts#facts`, laneApproval),
      "SWAP",
      "OwnerSwapLaneApproval",
      ARMED_PROFILE,
    );
    // VEINED-MC1 lanes review R2 NEW-4 (armed profile only): each protected fact is its disarmed value or a well-formed
    // armed value, and the signer declaration was the exact armed shape (read as null by armedView) or null.
    if (ARMED_PROFILE)
      assert(
        swapFactsOk &&
          count(
            String.raw`export const OWNER_SWAP_LANE_APPROVAL =\s*(?:null|\{[\s\S]*?\}|Object\.freeze\(\{[\s\S]*?\}\))\s*as Readonly<OwnerSwapLaneApproval> \| null;`,
            laneApproval,
          ) === 1 &&
          /export const OWNER_SWAP_LANE_KEY_SHA256 =\s*(?:null|"[0-9a-f]{64}") as string \| null;/.test(
            laneApproval,
          ) &&
          /export const SWAP_LANE_LIVE_WIRING = (?:false|true) as const;/.test(
            laneApproval,
          ) &&
          /export const OWNER_SWAP_LANE_SIGNER = null as Readonly<\{\s*url: string;\s*tokenFile: string;\s*\}> \| null;/.test(
            laneApproval,
          ),
        "Swap lane (armed profile): protected facts are disarmed values or exact armed values",
      );
    else
      assert(
        swapFactsOk &&
          /export const OWNER_SWAP_LANE_APPROVAL =\s*null as Readonly<OwnerSwapLaneApproval> \| null;/.test(
            laneApproval,
          ) &&
          /export const OWNER_SWAP_LANE_KEY_SHA256 = null as string \| null;/.test(
            laneApproval,
          ) &&
          /export const SWAP_LANE_LIVE_WIRING = false as const;/.test(
            laneApproval,
          ) &&
          /export const OWNER_SWAP_LANE_SIGNER = null as Readonly<\{\s*url: string;\s*tokenFile: string;\s*\}> \| null;/.test(
            laneApproval,
          ),
        "Swap lane: disarmed (record null, key digest null, wiring false, signer null)",
      );
    const laneScope = await read(`${LANE}/scope.ts`);
    const lanePins = await read(`${LANE}/pins.ts`);
    // The reviewed Base route and its pin set, each read as ITS OWN entry of the route table (a literal of another
    // route cannot stand in for it); every route's maximum is exactly one unit (6 or 18 decimals).
    const baseRoute = span(
      laneScope,
      '"base-usdc-weth-univ3-max1": route({',
      "}),",
    );
    const basePins = span(
      lanePins,
      '"base-usdc-weth-univ3-max1": pins({',
      "}),",
    );
    const routeEntries = count(String.raw`": route\(\{`, laneScope);
    const maxAmounts = [...laneScope.matchAll(/maxAmount: ([0-9_]+n),/g)].map(
      (m) => m[1],
    );
    assert(
      /maxAmount: 1_000_000n,/.test(baseRoute) &&
        /minAmount: 100_000n,/.test(baseRoute) &&
        /maxSlippageBps: 50,/.test(laneScope) &&
        /chainId: "8453",/.test(baseRoute) &&
        /chainHex: "0x2105",/.test(baseRoute) &&
        /id: "base-usdc-weth-univ3-max1",/.test(baseRoute) &&
        /router: "0x2626664c2603336E57B271c5C0b26F421741e481",/.test(
          baseRoute,
        ) &&
        /poolFee: 500,/.test(baseRoute) &&
        /gasBudgetWei: 17_700_000_000_000n,/.test(baseRoute) &&
        /confirmations: 300,/.test(baseRoute) &&
        /maxFeePerGasWei: 200_000_000n,/.test(baseRoute) &&
        routeEntries >= 1 &&
        maxAmounts.length === routeEntries &&
        maxAmounts.every(
          (a) => a === "1_000_000n" || a === "1_000_000_000_000_000_000n",
        ) &&
        /set: "fl1-swap-lane-pins\.2026-11-15\.1",/.test(basePins) &&
        /address: "0x2626664c2603336E57B271c5C0b26F421741e481",/.test(
          basePins,
        ) &&
        /approve: "0x095ea7b3",\s*multicall: "0x5ae401dc",\s*exactInputSingle: "0x04e45aaf",/.test(
          lanePins,
        ),
      "Swap lane: scope bounds and router / selector pins",
    );
    // The lane's own read transport: per chain exactly two exact https sources of two different operators (Base keeps
    // its live-tested pair), addressed by index; one fetch; redirect "error"; no-store; no other URL in the file.
    const transportText = await read(`${LANE}/transport.ts`);
    const lanePoolBlock = span(
      transportText,
      "export const SWAP_LANE_RPC_POOL",
      "satisfies Readonly<",
    );
    const laneOps = [
      ...lanePoolBlock.matchAll(/operator: "([a-z0-9-]+)"/g),
    ].map((m) => m[1]);
    const laneUrls = [...lanePoolBlock.matchAll(/url: "([^"]+)"/g)].map(
      (m) => m[1],
    );
    const laneChains = [
      ...lanePoolBlock.matchAll(/"(\d+)": Object\.freeze\(\[/g),
    ].map((m) => m[1]);
    const basePool = span(
      lanePoolBlock,
      '"8453": Object.freeze([',
      "] as const)",
    );
    assert(
      laneChains.length >= 1 &&
        new Set(laneChains).size === laneChains.length &&
        laneOps.length === 2 * laneChains.length &&
        laneUrls.length === laneOps.length &&
        laneOps.every((o, i) => i % 2 === 1 || o !== laneOps[i + 1]) &&
        new Set(laneUrls).size === laneUrls.length &&
        laneUrls.every((u) =>
          /^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9]+)?$/.test(u),
        ) &&
        // VEINED-MC1: plus the per-chain LOG pool (pinned in rule 13b) and exactly ONE more URL, the LI.FI quote
        // endpoint (bridge part below).
        [...transportText.matchAll(/https?:\/\//g)].length ===
          laneUrls.length +
            [
              ...span(
                transportText,
                "export const LANE_LOG_POOL",
                "satisfies Readonly<",
              ).matchAll(/url: "([^"]+)"/g),
            ].length +
            1 &&
        count(
          String.raw`export const LANE_LIFI_QUOTE_URL = "https:\/\/li\.quest\/v1\/quote";`,
          transportText,
        ) === 1 &&
        basePool.includes('url: "https://base-rpc.publicnode.com",') &&
        basePool.includes('url: "https://mainnet.base.org",'),
      "Swap lane RPC pool: two exact https sources of two different operators per chain",
    );
    for (const f of files.filter((f) => SRC_CODE.test(f))) {
      const raw = await read(f);
      if (/mintLaneDispatchAuthority\s*\(/.test(raw))
        assert(
          (f === `${LANE}/engine.ts` &&
            // dispatch and (VEINED-MC1 review MINOR-5) revoke: exactly two mints, both in the engine
            count(String.raw`mintLaneDispatchAuthority\s*\(`, raw) === 2) ||
            f === `${LANE}/signer-adapter.ts`,
          `Swap lane dispatch authority minted outside the engine: ${f}`,
        );
      if (/sendLaneTransaction\s*\(/.test(raw))
        assert(
          (f === `${LANE}/runtime.ts` &&
            count(String.raw`sendLaneTransaction\s*\(`, raw) === 1) ||
            f === `${LANE}/signer-adapter.ts`,
          `Swap lane signer hand-off outside the runtime: ${f}`,
        );
      // VEINED-MC1 review MAJOR-1: the signer status (sync + status) is reached by the two runtimes alone, once each.
      if (/laneSignerStatus\s*\(/.test(raw))
        assert(
          ((f === `${LANE}/runtime.ts` || f === `${LANE}/bridge-runtime.ts`) &&
            count(String.raw`laneSignerStatus\s*\(`, raw) === 1) ||
            f === `${LANE}/signer-adapter.ts`,
          `Swap lane signer status outside the runtimes: ${f}`,
        );
      if (/swapLaneRuntime\s*\(/.test(raw))
        assert(
          f === "src/app/api/swap-lane/route.ts" || f === `${LANE}/runtime.ts`,
          `Swap lane runtime reached outside its route: ${f}`,
        );
    }
    for (const f of laneFiles) {
      const raw = await read(f);
      assert(
        !/permit\s*\(|Permit2|0x000000000022d473|signTypedData|eth_sign|wallet_|sendRawTransaction|eth_sendTransaction|privateKey|mnemonic/i.test(
          raw,
        ),
        `Swap lane: no Permit2, permit, typed data, raw broadcast or key material: ${f}`,
      );
      assert(
        !/canary-approval|server\/canary\/(engine|runtime)|features\/wallet\/adapter|features\/bridge\/submission/.test(
          raw,
        ),
        `Swap lane: never reuses the Bridge canary's record, engine, runtime or the browser wallet send path: ${f}`,
      );
      if (/\bfetch\s*\(/.test(raw))
        assert(
          LANE_FETCH.includes(f),
          `Swap lane: chain reads only through the egress-checked transport: ${f}`,
        );
    }
    // Pinned in whitespace-normalised form (formatter-independent): the order of the single-use, compare and gate
    // checks before the loopback-only signer, and the route's closed block right before the runtime.
    const flat = (t) =>
      t
        .replace(/\s+/g, " ")
        .replace(/\( /g, "(")
        .replace(/ \)/g, ")")
        .replace(/,\)/g, ")");
    const laneTransport = flat(transportText);
    // VEINED-MC1: two fetches now — the pool RPC (by index) and the ONE LI.FI quote GET — each with redirect "error"
    // and no-store; both responses through the one size-capped reader; laneJsonRpc still carries no eth_getLogs.
    const transportMethods = span(
      transportText,
      "export const LANE_TRANSPORT_METHODS",
      "export const LANE_TRANSPORT_LIMITS",
    );
    assert(
      count(String.raw`\bfetch\s*\(`, laneTransport) === 2 &&
        count(String.raw`fetch\(source\.url, \{`, laneTransport) === 1 &&
        count(String.raw`fetch\(quoteUrl, \{`, laneTransport) === 1 &&
        laneTransport.includes("const source = pool[operator];") &&
        laneTransport.includes(
          "export async function laneJsonRpc(chainId: string, operator: 0 | 1, method: string, params: readonly unknown[], signal: AbortSignal): Promise<unknown> {",
        ) &&
        count('redirect: "error",', laneTransport) === 2 &&
        count('cache: "no-store",', laneTransport) === 2 &&
        count('credentials: "omit",', laneTransport) === 2 &&
        count(
          String.raw`if \(size > LANE_TRANSPORT_LIMITS\.maxResponseBytes\) \{`,
          laneTransport,
        ) === 1 &&
        count(String.raw`await cappedJson\(r, limit\)`, laneTransport) === 2 &&
        !/eth_getLogs/.test(transportMethods),
      'Swap lane transport: pool URL by index only, one fetch, redirect "error", no-store, size cap',
    );
    // Review MINOR-1: module-path restrictions (aliases and dynamic imports cannot bypass the literal-name checks).
    //   lane signer adapter <- only the lane engine (mint) and the lane runtime (send); lane engine <- only the runtime;
    //   lane runtime <- only its route; lane transport <- only the lane read module; one engine construction; the
    //   signer token header only in the adapter; no `fetch` identifier in any other lane file (adapter and transport
    //   only); no dynamic import of a lane module anywhere in src.
    const laneImporters = {
      // VEINED-MC1: the bridge lane's engine (its own mint) and runtime (its own send) reach the same adapter.
      "src/swap/lane/signer-adapter": [
        `${LANE}/engine.ts`,
        `${LANE}/runtime.ts`,
        `${LANE}/bridge-engine.ts`,
        `${LANE}/bridge-runtime.ts`,
        ...(manualProfile
          ? [MANUAL_RUNTIME, "src/manual-wallet/server/broker.ts"]
          : []),
      ],
      "src/swap/lane/engine": [
        `${LANE}/runtime.ts`,
        ...(manualProfile
          ? [MANUAL_RUNTIME, "src/components/manual-wallet.tsx"]
          : []),
      ],
      "src/swap/lane/runtime": [
        "src/app/api/swap-lane/route.ts",
        ...(manualProfile ? [MANUAL_RUNTIME] : []),
      ],
      "src/swap/lane/transport": [`${LANE}/reads.ts`],
      "src/swap/lane/bridge-engine": [
        `${LANE}/bridge-runtime.ts`,
        ...(manualProfile
          ? [MANUAL_RUNTIME, "src/components/manual-wallet.tsx"]
          : []),
      ],
      "src/swap/lane/bridge-runtime": [
        "src/app/api/bridge-lane/route.ts",
        ...(manualProfile ? [MANUAL_RUNTIME] : []),
      ],
      // VEINED-MC1 lanes review R2 NEW-1: the ONE process-wide dispatch lock — both engines, nothing else.
      "src/swap/lane/dispatch-lock": [
        `${LANE}/engine.ts`,
        `${LANE}/bridge-engine.ts`,
      ],
    };
    const resolveSpec = (from, spec) => {
      // fl1 final review MINOR-5: "@/" paths are normalised like relative ones ("./" and "../" segments).
      const isAlias = spec.startsWith("@/");
      if (!isAlias && !spec.startsWith(".")) return spec;
      const parts = isAlias ? ["src"] : from.split("/").slice(0, -1);
      if (isAlias) spec = "./" + spec.slice(2);
      for (const seg of spec.split("/")) {
        if (seg === "." || seg === "") continue;
        if (seg === "..") parts.pop();
        else parts.push(seg);
      }
      return parts.join("/").replace(/\.(ts|tsx|mts|js|mjs)$/, "");
    };
    let engineConstructions = 0;
    for (const f of files.filter((f) => SRC_CODE.test(f))) {
      const raw = await read(f);
      // Re-verification: require() and any dynamic import() whose argument is not ONE plain string literal are refused
      // everywhere in src (none exist; they would let a module path be built at run time and escape these rules).
      assert(
        f.endsWith(".cjs") ||
          (!/\brequire\s*\(/.test(raw) && !/\bcreateRequire\b/.test(raw)),
        `require() in src (lane import rules): ${f}`,
      );
      assert(
        !/\bimport\s*\(\s*(?!["'][^"'`$+]+["']\s*[,)])/.test(raw),
        `Non-literal dynamic import() in src (lane import rules): ${f}`,
      );
      for (const m of raw.matchAll(
        /(?:from|import)\s*\(?\s*["'`]([^"'`]+)["'`]/g,
      )) {
        // VEINED-MC1 lanes review R2 MINOR-2 (v-case-*): compared without letter case — a case-insensitive file system
        // resolves "./Transport" to the transport.
        const target = resolveSpec(f, m[1]).toLowerCase();
        const allowed = laneImporters[target];
        if (allowed)
          assert(
            allowed.includes(f),
            `Swap lane module ${target} imported outside its allowed importers: ${f}`,
          );
      }
      assert(
        !/import\s*\(\s*[^)]*swap\/lane/i.test(raw) &&
          !/import\s*\(\s*[^)]*["'`]\.\.?\/(?:engine|runtime|signer-adapter|transport|bridge-engine|bridge-runtime|dispatch-lock)["'`]/i.test(
            raw,
          ),
        `Swap lane module loaded dynamically: ${f}`,
      );
      engineConstructions += count(String.raw`new\s+SwapLaneEngine\s*\(`, raw);
      if (/new\s+SwapLaneEngine\s*\(/.test(raw))
        assert(
          f === `${LANE}/runtime.ts` || (manualProfile && f === MANUAL_RUNTIME),
          `Swap lane engine constructed outside the runtime: ${f}`,
        );
      // fl1 final review MINOR-5: the credential header may not be assembled from fragments either.
      if (/x-fl1-signer-token|signer-token|x-fl1-/i.test(raw))
        assert(
          f === `${LANE}/signer-adapter.ts`,
          `Signer credential header outside the lane adapter: ${f}`,
        );
    }
    assert(
      engineConstructions === (manualProfile ? 2 : 1),
      "Swap lane: exactly one engine construction (the runtime)",
    );
    for (const f of laneFiles)
      assert(
        !/node:(?:http|https|net|tls|dgram|child_process|module)|["'](?:http|https|net|tls|undici|child_process|module)["']|\b(?:globalThis|global|self|window)\s*\[|\bglobalThis\.fetch|\bReflect\s*\.|\bcreateRequire\b/.test(
          await read(f),
        ),
        `Swap lane: no raw network module, child process or globalThis indexing: ${f}`,
      );
    // VEINED-MC1 review MINOR-2: every egress / code-loading bypass the review demonstrated, closed in lane files.
    //   (a) the global object under any name is never touched — except the ONE runtime singleton line per runtime
    //       (`const globals = globalThis as typeof globalThis & {`), which aliases nothing callable;
    //   (b) no other network or code-loading global (WebSocket, EventSource, XMLHttpRequest, sendBeacon, eval,
    //       Function(...), import.meta);
    //   (c) no network / process / VM module, bare or node: (http2, dgram, dns, vm, worker_threads, inspector, undici,
    //       cluster, ... and every one of rule 13's own list).
    const RUNTIME_SINGLETON =
      /const globals = globalThis as typeof globalThis & \{/;
    // VEINED-MC1 lanes review R2: the same singleton line holds the process-wide dispatch lock (dispatch-lock.ts), and in
    // each of the three files the alias is used for its ONE holder property only (never `globals[...]`, never another
    // name: the alias would otherwise hand out the global object).
    // VEINED-MC1 lanes review R3 (NIT): dispatch-lock.ts holds its state under a registry symbol instead (null here): its
    // alias is used ONLY as the first argument of `Object.getOwnPropertyDescriptor(` / `Object.defineProperty(` with
    // the key `LANE_DISPATCH_LOCK_KEY` as the second (read on the syntax tree), never as `globals.x` or `globals[...]`.
    const SINGLETON_HOLDERS = {
      [`${LANE}/runtime.ts`]: "__veinedSwapLane",
      [`${LANE}/bridge-runtime.ts`]: "__veinedBridgeLane",
      [`${LANE}/dispatch-lock.ts`]: null,
    };
    for (const f of laneFiles) {
      let raw = await read(f);
      const holder = SINGLETON_HOLDERS[f];
      if (Object.hasOwn(SINGLETON_HOLDERS, f)) {
        assert(
          count(RUNTIME_SINGLETON.source, raw) <= 1,
          `Swap lane: the global object touched in a lane file: ${f}`,
        );
        if (holder === null) {
          const lsf = astOf(f, raw);
          let declared = 0,
            other = 0;
          eachNode(lsf, (n) => {
            if (!ts.isIdentifier(n) || n.text !== "globals") return;
            const p = n.parent;
            if (ts.isVariableDeclaration(p) && p.name === n) declared++;
            else if (!(
              ts.isCallExpression(p) &&
              p.arguments[0] === n &&
              p.arguments.length >= 2 &&
              ts.isIdentifier(p.arguments[1]) &&
              p.arguments[1].text === "LANE_DISPATCH_LOCK_KEY" &&
              [
                "Object.getOwnPropertyDescriptor",
                "Object.defineProperty",
              ].includes(p.expression.getText(lsf))
            ))
              other++;
          });
          assert(
            declared === 1 && other === 0,
            `Swap lane: the global object touched in a lane file: ${f}`,
          );
        }
        raw = raw.replace(
          RUNTIME_SINGLETON,
          "const globals = __SINGLETON__ & {",
        );
        if (holder !== null)
          assert(
            [...raw.matchAll(/\bglobals\b/g)].every(
              (m) =>
                raw.startsWith("globals = __SINGLETON__ & {", m.index) ||
                (raw.startsWith(`globals.${holder}`, m.index) &&
                  !/[\w$]/.test(raw[m.index + 8 + holder.length] ?? "")),
            ),
            `Swap lane: the global object touched in a lane file: ${f}`,
          );
      }
      assert(
        !/\b(?:globalThis|global|self|window)\b/.test(raw),
        `Swap lane: the global object touched in a lane file: ${f}`,
      );
      assert(
        !/\b(?:WebSocket|EventSource|XMLHttpRequest|sendBeacon|eval)\b|\bFunction\s*\(|\bimport\.meta\b/.test(
          raw,
        ),
        `Swap lane: no WebSocket, EventSource, XMLHttpRequest, beacon, eval, Function or import.meta in a lane file: ${f}`,
      );
      assert(
        !/["'`](?:node:)?(?:http|https|http2|net|tls|dgram|dns|vm|worker_threads|inspector|undici|child_process|module|cluster|repl|wasi|v8)(?:\/[^"'`]*)?["'`]/.test(
          raw,
        ),
        `Swap lane: no network, process or VM module (bare or node:) in a lane file: ${f}`,
      );
    }
    // (d) the transport functions are named ONLY by the transport itself and by reads.ts, and reads.ts only CALLS them:
    //     nothing re-exports, aliases or hands out the raw (shape-unchecked) egress.
    const TRANSPORT_FNS =
      /\b(?:laneJsonRpc|laneGetLogs|laneLifiQuote|laneLifiQuery)\b/g;
    for (const f of files.filter((f) => SRC_CODE.test(f))) {
      const raw = await read(f);
      // VEINED-MC1 lanes review R2 MINOR-2 (v-reexport-ns): also `export * as ns from "./transport"`.
      assert(
        !/\bexport\s*(?:type\s*)?(?:\*(?:\s*as\s+[\w$]+)?|\{[^}]*\})\s*from\s*["'`][^"'`]*transport["'`]/.test(
          raw,
        ),
        `Swap lane: a re-export of the lane transport: ${f}`,
      );
      if (f === `${LANE}/transport.ts`) continue;
      // VEINED-MC1 lanes review R2 MINOR-2 (v-useleak-ns): nor reached by a BUILT name ("lane" + "JsonRpc").
      assert(
        !/lanejsonrpc|lanegetlogs|lanelifiquote|lanelifiquery|lanelogpool/.test(
          joinedLiterals(astOf(f, raw)).toLowerCase(),
        ),
        `Swap lane: a transport function named by a string outside the transport: ${f}`,
      );
      const names = raw.match(TRANSPORT_FNS) ?? [];
      if (!names.length) continue;
      assert(
        f === `${LANE}/reads.ts`,
        `Swap lane: a transport function named outside the transport and reads.ts: ${f}`,
      );
      const body = raw.replace(
        /import\s*\{[^}]*\}\s*from\s*["']\.\/transport["'];/,
        "",
      );
      const uses = body.match(TRANSPORT_FNS) ?? [];
      const calls =
        body.match(
          /\b(?:laneJsonRpc|laneGetLogs|laneLifiQuote|laneLifiQuery)\(/g,
        ) ?? [];
      assert(
        uses.length === calls.length &&
          !/\bexport\s*\{[^}]*\b(?:laneJsonRpc|laneGetLogs|laneLifiQuote|laneLifiQuery)\b/.test(
            body,
          ),
        `Swap lane: reads.ts hands out a transport function (only direct calls are allowed): ${f}`,
      );
    }
    // (e) the signer's credential header (or any fragment of it), its token file, its method name and its loopback
    //     port exist in the lane adapter alone, anywhere in src.
    //     VEINED-MC1 lanes review R2 MINOR-2 (v-hdr2: other fragment cuts, the port as 0xcdc): the same words are also
    //     looked for in the file's literals joined with nothing between them (the cut points do not matter), and the
    //     signer's port range is refused as a number in any notation. Loopback literals (127.x, localhost, ::1,
    //     0.0.0.0, the 0x7f000001 integer) are refused in src/swap/** and src/app/api/** (the data plane and the
    //     server's origin policy outside them name loopback hosts for their own reasons; no signer word may appear
    //     there either way).
    const SIGNER_WORDS = /x-fl1|fl1-sig|signer-tok|signer-v5|sign_send/;
    const LOOPBACK =
      /(?<![\d.])127\.\d|localhost|\[::1?\]|(?<![0-9a-f:])::1(?![0-9a-f:])|0\.0\.0\.0|0x7f0*1\b|0x7f\.|\/\/0[0-7]+\.|2130706433/;
    for (const f of files.filter(
      (f) => SRC_CODE.test(f) && f !== `${LANE}/signer-adapter.ts`,
    )) {
      const text = await read(f);
      assert(
        !/x-fl|1-sig|ner-to|ner-tok|signer-v5|\bsign_send\b|127\.0\.0\.1:\s*["'`]?\s*\+|127\.0\.0\.1:329\d|\b329\d\b/i.test(
          text,
        ),
        `Signer endpoint, token or header fragment outside the lane adapter: ${f}`,
      );
      // VEINED-MC1 lanes review R3-4: the two signer declarations belong to the disarmed rules (13 / 13b, or the
      // armed-shape rules of the armed profile), which refuse ANY value but the designed one, so a non-null signer there is
      // refused as "not disarmed", its designed reason. The literal rules below therefore skip exactly that declaration's
      // SYNTAX NODE (the file's one top-level `export const OWNER_*_SIGNER`, its name bound nowhere else) and nothing
      // else. Round 2 cut a TEXT span from the first "export const OWNER_*_SIGNER =" to the next "| null;", which two
      // decoy strings could place around signer words; a string is never that node, so every string is read.
      const sf = astOf(f, text);
      const signerName = ARMED_SIGNER_FACTS[f];
      const top = signerName ? topConsts(sf, signerName) : [];
      const skip =
        top.length === 1 && bindingsOf(sf, signerName).length === 1
          ? top[0]
          : undefined;
      const literals = joinedLiterals(sf, skip).toLowerCase();
      const numbers = numericValues(sf, skip);
      assert(
        !SIGNER_WORDS.test(literals) &&
          !numbers.some((v) => v >= 3290n && v <= 3299n),
        `Signer endpoint, token or header fragment outside the lane adapter: ${f}`,
      );
      // VEINED-MC1 lanes review R3-5 (tripwires, not a closure): no string built from character codes, and no literal
      // path into a journal directory, anywhere in src. Signer words computed at run time some other way stay an
      // accepted residual outside the lane (docs/SPEC_BRIDGE_LANE.md); the signer's token and policy remain the backstop.
      assert(
        !/\bfromCharCode\b|\bfromCodePoint\b/.test(text) &&
          !/fromcharcode|fromcodepoint|[\\/]journal[\\/]/.test(literals),
        `Run-time built string or journal path in src (signer-word tripwire): ${f}`,
      );
      if (
        (f.startsWith("src/swap/") || f.startsWith("src/app/api/")) &&
        !(manualProfile && f === "src/app/api/manual-wallet/route.ts")
      )
        assert(
          !LOOPBACK.test(literals) && !numbers.includes(2130706433n),
          `Loopback literal outside the lane adapter (src/swap, src/app/api): ${f}`,
        );
    }
    // (f) the transport names `fetch` exactly at its two call sites (no alias, no third egress).
    assert(
      count(String.raw`\bfetch\b`, transportText) === 2,
      `Swap lane: the fetch identifier outside the transport's two call sites: ${LANE}/transport.ts`,
    );
    for (const f of laneFiles)
      if (/\bfetch\b/.test(await read(f)))
        assert(
          LANE_FETCH.includes(f),
          `Swap lane: the fetch identifier outside the adapter and the lane transport: ${f}`,
        );
    const signerAdapter = flat(await read(`${LANE}/signer-adapter.ts`));
    const sendBody = signerAdapter.slice(
      signerAdapter.indexOf("export async function sendLaneTransaction("),
    );
    const order = [
      'const g = authority && typeof authority === "object" ? GRANTS.get(authority) : undefined; if (!g) throw new LaneDispatchError("AUTHORITY_UNKNOWN_OR_USED"); GRANTS.delete(authority as object);',
      'if (!sameLaneTx(g.tx, tx)) throw new LaneDispatchError("TX_NOT_AUTHORIZED_TX");',
      'const gate = swapLaneGateState({ ...g.facts, now: Date.now() }); if (!gate.open) throw new LaneDispatchError("SWAP_LANE_GATE_CLOSED", gate.reasons);',
      "!ENDPOINT.test(s.url)",
      "fetch(s.url,",
    ].map((x) => sendBody.indexOf(x));
    assert(
      order.every((x, k) => x > 0 && (k === 0 || x > order[k - 1])) &&
        signerAdapter.includes(
          flat(
            String.raw`const ENDPOINT = /^http:\/\/127\.0\.0\.1:(\d{4,5})\/$/;`,
          ),
        ) &&
        count(String.raw`fetch\(`, signerAdapter) === 1,
      "Swap lane: single-use authority, exact tx, gate re-run and loopback-only signer before anything is sent",
    );
    const laneRoute = flat(await read("src/app/api/swap-lane/route.ts"));
    const laneClosed = laneRoute.indexOf("if (!swapLaneArmed().armed) {");
    const laneRuntimeAt = laneRoute.indexOf("swapLaneRuntime()");
    assert(
      count(String.raw`swapLaneRuntime\s*\(`, laneRoute) === 1 &&
        count(String.raw`if \(!swapLaneArmed\(\)\.armed\) \{`, laneRoute) ===
          1 &&
        laneClosed > 0 &&
        laneRuntimeAt > laneClosed &&
        laneRoute.includes(
          'if (!swapLaneArmed().armed) { guardStatus("WRITE_DISABLED"); return reply({ error: "WRITE_DISABLED", gate: swapLaneGateState() }, 403); } const lane = swapLaneRuntime();',
        ),
      "Swap lane API: WRITE_DISABLED before the runtime while not armed",
    );
    // 13b. VEINED-MC1: the SEPARATE multi-pair BRIDGE lane (src/swap/lane/bridge-*.ts, src/app/api/bridge-lane/route.ts).
    //     Every lane ban above applies to its files (they live in src/swap/lane/). Added here: the bridge files exist;
    //     four exact disarmed literals; the frozen scope (5 USDC in, 4.90 out, 300 bps, 25 bps fee, the six chains of
    //     signer v5, BNB BLOCKED, no Avalanche); the Diamond / selector / fee collector pins; ONE engine construction (the
    //     bridge runtime); an engine-only mint and a runtime-only send of the bridge authority; module-path importers;
    //     the route refuses every write before the runtime; the adapter's bridge send runs single use, exact tx and the
    //     BRIDGE gate before the one loopback POST; the LI.FI quote URL lives in the lane transport alone, behind a GET
    //     with a fixed query; eth_getLogs only on the bridge read path.
    {
      for (const req of [
        "bridge-scope.ts",
        "bridge-pins.ts",
        "bridge-calldata.ts",
        "bridge-approval.ts",
        "bridge-engine.ts",
        "bridge-runtime.ts",
      ])
        assert(
          laneFiles.includes(`${LANE}/${req}`),
          `Bridge lane file missing: ${req}`,
        );
      const BRIDGE_ROUTE = "src/app/api/bridge-lane/route.ts";
      assert(
        files.includes(BRIDGE_ROUTE),
        `Bridge lane file missing: ${BRIDGE_ROUTE}`,
      );
      const bridgeApproval = await read(`${LANE}/bridge-approval.ts`);
      // VEINED-MC1 lanes review R3-4: the declaration NODES, as rule 13 (laneFactsOk).
      const bridgeFactsOk = laneFactsOk(
        astOf(`${LANE}/bridge-approval.ts#facts`, bridgeApproval),
        "BRIDGE",
        "OwnerBridgeLaneApproval",
        ARMED_PROFILE,
      );
      // VEINED-MC1 lanes review R2 NEW-4 (armed profile only): as rule 13's armed-shape rule, for the bridge facts.
      if (ARMED_PROFILE)
        assert(
          bridgeFactsOk &&
            count(
              String.raw`export const OWNER_BRIDGE_LANE_APPROVAL =\s*(?:null|\{[\s\S]*?\}|Object\.freeze\(\{[\s\S]*?\}\))\s*as Readonly<OwnerBridgeLaneApproval> \| null;`,
              bridgeApproval,
            ) === 1 &&
            /export const OWNER_BRIDGE_LANE_KEY_SHA256 =\s*(?:null|"[0-9a-f]{64}") as string \| null;/.test(
              bridgeApproval,
            ) &&
            /export const BRIDGE_LANE_LIVE_WIRING = (?:false|true) as const;/.test(
              bridgeApproval,
            ) &&
            /export const OWNER_BRIDGE_LANE_SIGNER = null as Readonly<\{\s*url: string;\s*tokenFile: string;\s*\}> \| null;/.test(
              bridgeApproval,
            ),
          "Bridge lane (armed profile): protected facts are disarmed values or exact armed values",
        );
      else
        assert(
          bridgeFactsOk &&
            /export const OWNER_BRIDGE_LANE_APPROVAL =\s*null as Readonly<OwnerBridgeLaneApproval> \| null;/.test(
              bridgeApproval,
            ) &&
            /export const OWNER_BRIDGE_LANE_KEY_SHA256 = null as string \| null;/.test(
              bridgeApproval,
            ) &&
            /export const BRIDGE_LANE_LIVE_WIRING = false as const;/.test(
              bridgeApproval,
            ) &&
            /export const OWNER_BRIDGE_LANE_SIGNER = null as Readonly<\{\s*url: string;\s*tokenFile: string;\s*\}> \| null;/.test(
              bridgeApproval,
            ),
          "Bridge lane: disarmed (record null, key digest null, wiring false, signer null)",
        );
      const bridgeScope = await read(`${LANE}/bridge-scope.ts`);
      const bridgeChains = span(
        bridgeScope,
        "export const BRIDGE_LANE_CHAINS",
        "export function bridgeChainById",
      );
      const chainIds = [
        ...bridgeChains.matchAll(/^\s*"(\d+)": chain\(\{$/gm),
      ].map((m) => m[1]);
      const bnb = span(bridgeChains, '"56": chain({', "}),");
      assert(
        /exactAmount: 5_000_000n,/.test(bridgeScope) &&
          /minimumOut: 4_900_000n,/.test(bridgeScope) &&
          /maxCostBps: 300,/.test(bridgeScope) &&
          /maxFeeBps: 25,/.test(bridgeScope) &&
          /minFillWindowSec: 30 \* 60,/.test(bridgeScope) &&
          /maxFillWindowSec: 6 \* 3600,/.test(bridgeScope) &&
          /maxQuoteSkewSec: 10 \* 60,/.test(bridgeScope) &&
          /maxExclusivitySec: 300,/.test(bridgeScope) &&
          /tool: "across",/.test(bridgeScope) &&
          /logWindowBlocks: 100,/.test(bridgeScope) &&
          /const BRIDGE_GAS = \{ APPROVE: 100_000n, EXECUTE: 600_000n \};/.test(
            bridgeScope,
          ) &&
          chainIds.join(",") === "1,8453,42161,10,137,56" &&
          count(String.raw`status: "ENABLED",`, bridgeChains) === 5 &&
          /status: "BLOCKED",\s*blockReason: "NO_CIRCLE_USDC",/.test(bnb) &&
          !/43114/.test(bridgeScope) &&
          count(String.raw`\bmaxGas: BRIDGE_GAS,`, bridgeChains) === 6,
        "Bridge lane: scope bounds (5 USDC in, 4.90 out, 300 bps, 25 bps fee, six chains, BNB BLOCKED, no Avalanche)",
      );
      const bridgePins = await read(`${LANE}/bridge-pins.ts`);
      assert(
        /bridge: "0x1794958f",/.test(bridgePins) &&
          /forwardFees: "0x332d746b",/.test(bridgePins) &&
          /export const BRIDGE_LIFI_DIAMOND =\s*"0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";/.test(
            bridgePins,
          ) &&
          /export const BRIDGE_ACROSS_FACET =\s*"0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd";/.test(
            bridgePins,
          ) &&
          /export const BRIDGE_FEE_COLLECTOR =\s*"0xde2b920506ee931a6a2abdf566526220214fbbae";/.test(
            bridgePins,
          ) &&
          /export const BRIDGE_FEE_RECIPIENT =\s*"0xc06ebbefd94032b85424d51906e2a335efae264b";/.test(
            bridgePins,
          ) &&
          !/43114/.test(bridgePins),
        "Bridge lane: Diamond / selector / facet / fee collector pins",
      );
      let bridgeEngines = 0;
      for (const f of files.filter((f) => SRC_CODE.test(f))) {
        const raw = await read(f);
        bridgeEngines += count(String.raw`new\s+BridgeLaneEngine\s*\(`, raw);
        if (/new\s+BridgeLaneEngine\s*\(/.test(raw))
          assert(
            f === `${LANE}/bridge-runtime.ts` ||
              (manualProfile && f === MANUAL_RUNTIME),
            `Bridge lane engine constructed outside the bridge runtime: ${f}`,
          );
        if (/mintBridgeDispatchAuthority\s*\(/.test(raw))
          assert(
            (f === `${LANE}/bridge-engine.ts` &&
              // dispatch and (review MINOR-5) revoke
              count(String.raw`mintBridgeDispatchAuthority\s*\(`, raw) === 2) ||
              f === `${LANE}/signer-adapter.ts`,
            `Bridge lane dispatch authority minted outside the bridge engine: ${f}`,
          );
        if (/sendBridgeLaneTransaction\s*\(/.test(raw))
          assert(
            (f === `${LANE}/bridge-runtime.ts` &&
              count(String.raw`sendBridgeLaneTransaction\s*\(`, raw) === 1) ||
              f === `${LANE}/signer-adapter.ts`,
            `Bridge lane signer hand-off outside the bridge runtime: ${f}`,
          );
        if (/bridgeLaneRuntime\s*\(/.test(raw))
          assert(
            f === BRIDGE_ROUTE || f === `${LANE}/bridge-runtime.ts`,
            `Bridge lane runtime reached outside its route: ${f}`,
          );
        // The LI.FI quote endpoint: in the lane transport alone (one definition); no other file names it.
        if (/li\.quest\/v1\/quote/.test(raw))
          assert(
            f === `${LANE}/transport.ts` &&
              count(String.raw`li\.quest\/v1\/quote`, raw) === 1,
            `Bridge lane: the LI.FI quote URL outside the lane transport: ${f}`,
          );
        if (f.startsWith(`${LANE}/`) && /li\.quest/.test(raw))
          assert(
            f === `${LANE}/transport.ts`,
            `Bridge lane: the LI.FI quote URL outside the lane transport: ${f}`,
          );
        // eth_getLogs: only the bridge read path (reads -> transport) and the bridge engine's destination search.
        if (f.startsWith(`${LANE}/`) && /eth_getLogs/.test(raw))
          assert(
            [
              `${LANE}/reads.ts`,
              `${LANE}/transport.ts`,
              `${LANE}/bridge-engine.ts`,
            ].includes(f),
            `Bridge lane: eth_getLogs outside the bridge read path: ${f}`,
          );
      }
      assert(
        bridgeEngines === (manualProfile ? 2 : 1),
        "Bridge lane: exactly one engine construction (the bridge runtime)",
      );
      // The per-chain LOG pool: two exact https sources of two different organisations per bridge chain; each source
      // is the chain's RPC-pool source or an evidence-verified eth_getLogs operator of this allowlist (A-rpc.json);
      // never mainnet.base.org (it refuses eth_getLogs); read by laneGetLogs ALONE (laneJsonRpc uses the RPC pool).
      const LOG_ONLY = { 8453: ["https://base.drpc.org"] };
      const logBlock = span(
        transportText,
        "export const LANE_LOG_POOL",
        "satisfies Readonly<",
      );
      const logChains = [
        ...logBlock.matchAll(/"(\d+)": Object\.freeze\(\[/g),
      ].map((m) => m[1]);
      const rpcOf = (c) =>
        [
          ...span(
            lanePoolBlock,
            `"${c}": Object.freeze([`,
            "] as const)",
          ).matchAll(/url: "([^"]+)"/g),
        ].map((m) => m[1]);
      const logOf = (c) => {
        const b = span(logBlock, `"${c}": Object.freeze([`, "] as const)");
        return {
          urls: [...b.matchAll(/url: "([^"]+)"/g)].map((m) => m[1]),
          ops: [...b.matchAll(/operator: "([a-z0-9-]+)"/g)].map((m) => m[1]),
        };
      };
      const getLogsBody = flat(
        span(
          transportText,
          "export async function laneGetLogs(",
          "export const LANE_LIFI_QUOTE_URL",
        ),
      );
      const jsonRpcBody = flat(
        span(
          transportText,
          "export async function laneJsonRpc(",
          "export async function laneGetLogs(",
        ),
      );
      assert(
        logChains.join(",") === "1,8453,42161,10,137,56" &&
          logChains.every((c) => {
            const l = logOf(c);
            return (
              l.urls.length === 2 &&
              l.ops.length === 2 &&
              l.ops[0] !== l.ops[1] &&
              l.urls[0] !== l.urls[1] &&
              l.urls.every(
                (u) =>
                  /^https:\/\/[a-z0-9.-]+(?:\/[a-z0-9]+)?$/.test(u) &&
                  u !== "https://mainnet.base.org" &&
                  (rpcOf(c).includes(u) || (LOG_ONLY[c] ?? []).includes(u)),
              )
            );
          }) &&
          logOf("8453").urls.join(",") ===
            "https://base-rpc.publicnode.com,https://base.drpc.org" &&
          count(String.raw`\blaneLogPool\(`, transportText) === 3 &&
          count(String.raw`\blaneLogPool\(`, getLogsBody) === 2 &&
          getLogsBody.includes(
            'const result = await poolRpc(laneLogPool(chainId), operator, "eth_getLogs", [f], signal',
          ) &&
          jsonRpcBody.includes(
            "return poolRpc(lanePool(chainId), operator, method, params, signal);",
          ) &&
          !/laneLogPool|LANE_LOG_POOL/.test(jsonRpcBody) &&
          // the definition and laneLogPool's own lookup (hasOwnProperty + index + keyof): nothing else names it
          count(String.raw`\bLANE_LOG_POOL\b`, transportText) === 4,
        "Bridge lane LOG pool: two exact https sources of two organisations per chain, evidence-verified, read by laneGetLogs alone",
      );
      for (const f of files.filter(
        (f) => SRC_CODE.test(f) && f !== `${LANE}/transport.ts`,
      ))
        assert(
          !/\blaneLogPool\b|\bLANE_LOG_POOL\b|https:\/\/base\.drpc\.org/.test(
            await read(f),
          ),
          `Bridge lane LOG pool referenced outside the lane transport: ${f}`,
        );
      const quoteBody = flat(
        span(transportText, "export async function laneLifiQuote(", undefined),
      );
      assert(
        quoteBody.includes(
          "const quoteUrl = `${LANE_LIFI_QUOTE_URL}?${laneLifiQuery(q)}`;",
        ) &&
          quoteBody.includes('method: "GET",') &&
          quoteBody.includes('redirect: "error",') &&
          quoteBody.includes('cache: "no-store",') &&
          quoteBody.includes("await cappedJson(r, limit)") &&
          [
            '["slippage", "0.005"]',
            '["order", "CHEAPEST"]',
            '["fee", "0"]',
            '["allowDestinationCall", "false"]',
            '["allowBridges", "across"]',
            '["fromAddress", q.account]',
            '["toAddress", q.account]',
          ].every((s) => laneTransport.includes(s)),
        "Bridge lane: one LI.FI quote GET with the fixed query (slippage 0.005, CHEAPEST, fee 0, no destination call, across, from = to)",
      );
      const sendBridge = signerAdapter.slice(
        signerAdapter.indexOf(
          "export async function sendBridgeLaneTransaction(",
        ),
        signerAdapter.indexOf("function signResult("),
      );
      const bridgeOrder = [
        'const bg = authority && typeof authority === "object" ? BRIDGE_GRANTS.get(authority) : undefined; if (!bg) throw new LaneDispatchError("AUTHORITY_UNKNOWN_OR_USED"); BRIDGE_GRANTS.delete(authority as object);',
        'if (!sameLaneTx(bg.tx, tx)) throw new LaneDispatchError("TX_NOT_AUTHORIZED_TX");',
        'const bridgeGate = bridgeLaneGateState({ ...bg.facts, now: Date.now() }); if (!bridgeGate.open) throw new LaneDispatchError("BRIDGE_LANE_GATE_CLOSED", bridgeGate.reasons);',
        "await postSigner(OWNER_BRIDGE_LANE_SIGNER, {",
      ].map((x) => sendBridge.indexOf(x));
      const post = signerAdapter.slice(
        signerAdapter.indexOf("async function postSigner("),
      );
      const statusFn = signerAdapter.slice(
        signerAdapter.indexOf("export async function laneSignerStatus("),
        signerAdapter.indexOf("const ENDPOINT ="),
      );
      const swapSend = signerAdapter.slice(
        signerAdapter.indexOf("export async function sendLaneTransaction("),
        signerAdapter.indexOf(
          "export async function sendBridgeLaneTransaction(",
        ),
      );
      assert(
        signerAdapter.indexOf(
          "export async function sendBridgeLaneTransaction(",
        ) > 0 &&
          bridgeOrder.every(
            (x, k) => x > 0 && (k === 0 || x > bridgeOrder[k - 1]),
          ) &&
          // ONE post function (the single fetch) and exactly its seven uses: the definition, sync + status, and the
          // two bodies of each lane (CLEANUP REVOKE and the lane's own step), each only after the lane's gate re-run
          count(String.raw`\bpostSigner\(`, signerAdapter) === 7 &&
          count(
            String.raw`await postSigner\(OWNER_SWAP_LANE_SIGNER, \{`,
            swapSend,
          ) === 2 &&
          swapSend.indexOf("await postSigner(OWNER_SWAP_LANE_SIGNER, {") >
            swapSend.indexOf(
              'throw new LaneDispatchError("SWAP_LANE_GATE_CLOSED", gate.reasons);',
            ) &&
          count(
            String.raw`await postSigner\(OWNER_BRIDGE_LANE_SIGNER, \{`,
            sendBridge,
          ) === 2 &&
          swapSend.includes(
            'declared: { lane: "CLEANUP", route: g.facts.route, step: "REVOKE" }, tx,',
          ) &&
          sendBridge.includes(
            'declared: { lane: "CLEANUP", route: bg.facts.route, step: "REVOKE" }, tx,',
          ) &&
          // laneSignerStatus: exactly a sync then a status on the lane's own endpoint fact, nothing else
          statusFn.includes(
            'const s = lane === "SWAP" ? OWNER_SWAP_LANE_SIGNER : OWNER_BRIDGE_LANE_SIGNER; const synced = await postSigner(s, { method: "sync" });',
          ) &&
          statusFn.includes(
            'const st = await postSigner(s, { method: "status" });',
          ) &&
          count(String.raw`\bpostSigner\(`, statusFn) === 2 &&
          post.indexOf("!ENDPOINT.test(s.url)") > 0 &&
          post.indexOf("!ENDPOINT.test(s.url)") <
            post.indexOf("fetch(s.url,") &&
          /declared: \{ lane: "BRIDGE", route: bg\.facts\.route, step: bg\.facts\.step \}, tx, \}\)/.test(
            sendBridge,
          ) &&
          !/swapAmount/.test(sendBridge),
        "Bridge lane: single-use authority, exact tx, BRIDGE gate re-run and loopback-only signer before anything is sent",
      );
      const bridgeRoute = flat(await read(BRIDGE_ROUTE));
      const bridgeClosed = bridgeRoute.indexOf(
        "if (!bridgeLaneArmed().armed) {",
      );
      assert(
        count(String.raw`bridgeLaneRuntime\s*\(`, bridgeRoute) === 1 &&
          count(
            String.raw`if \(!bridgeLaneArmed\(\)\.armed\) \{`,
            bridgeRoute,
          ) === 1 &&
          bridgeClosed > 0 &&
          bridgeRoute.indexOf("bridgeLaneRuntime()") > bridgeClosed &&
          bridgeRoute.includes(
            'if (!bridgeLaneArmed().armed) { guardStatus("WRITE_DISABLED"); return reply({ error: "WRITE_DISABLED", gate: bridgeLaneGateState() }, 403); } const lane = bridgeLaneRuntime();',
          ),
        "Bridge lane API: WRITE_DISABLED before the runtime while not armed",
      );
      const bridgeRuntime = await read(`${LANE}/bridge-runtime.ts`);
      assert(
        /join\(process\.cwd\(\), "\.veined-bridge-lane-store"\)/.test(
          bridgeRuntime,
        ) &&
          !/\.veined-swap-lane-store|\.veined-canary-store/.test(
            bridgeRuntime,
          ) &&
          !/process\.env/.test(bridgeRuntime),
        "Bridge lane runtime: its own store directory, no environment",
      );
      // (g)-(i), (k) and (l) run here, after the reviewed rules above (file presence, adapter order, mints), so a
      // mutation those rules already refuse keeps its own message; (g)-(l) refuse what they let through.
      // VEINED-MC1 lanes review R2 MINOR-2: the 22 variants that passed (a)-(f) (payloads temp/review-lanes-r2/m/), closed
      // on the syntax tree of every lane file:
      //   (g) no `Function` identifier (an alias, `new (Function)`), no `.constructor` / `constructor` name (the Function
      //       constructor from any function), `process` only as `process.cwd()` (no getBuiltinModule / binding / dlopen,
      //       under any spelling), no `require` / `module` / `exports`, and no egress or loader name in the file's joined
      //       literals ("return fe" + "tch(u)");
      //   (h) imports from an allow-list only: viem, node:crypto, node:fs, node:path, existing lane files (exact letter
      //       case) and six named app modules; no import =, no import() call, no import("...") type;
      //   (i) no namespace import and no `export *` in any form (reads.ts names each transport function it imports).
      const LANE_PACKAGES = new Set([
        "viem",
        "node:crypto",
        "node:fs",
        "node:path",
      ]);
      const LANE_APP_MODULES = new Set([
        "src/assets/registry.ts",
        "src/guardian/verdict.ts",
        "src/guardian/model.ts",
        "src/execution/server/canary/attestation.ts",
        "src/execution/server/canary/durable-store.ts",
        "src/swap/model.ts",
      ]);
      const exactModule = (from, spec) => {
        if (!spec.startsWith("./") && !spec.startsWith("../")) return null;
        const parts = from.split("/").slice(0, -1);
        for (const seg of spec.split("/")) {
          if (seg === "." || seg === "") continue;
          if (seg === "..") parts.pop();
          else parts.push(seg);
        }
        const at = parts.join("/");
        return [`${at}.ts`, at].find((c) => files.includes(c)) ?? null;
      };
      // VEINED-MC1 lanes review R3-1: viem carries its own egress (http / webSocket / fallback / custom / ipc transports
      // and the clients built on them). A lane file imports from viem ONLY these named helpers (pure ABI, hashing and
      // serialisation code), each under its own name, and the type Hex: no default, namespace, side-effect or subpath
      // import, no re-export from viem, and no client / transport factory name imported from any module.
      const VIEM_HELPERS = new Set([
        "decodeEventLog",
        "decodeFunctionData",
        "decodeFunctionResult",
        "encodeFunctionData",
        "keccak256",
        "parseAbi",
        "serializeTransaction",
        "stringToHex",
      ]);
      const VIEM_TYPES = new Set(["Hex"]);
      const VIEM_FACTORIES = new Set([
        "createPublicClient",
        "createWalletClient",
        "createTestClient",
        "createClient",
        "http",
        "webSocket",
        "fallback",
        "custom",
        "ipc",
      ]);
      const LANE_LITERAL_BANS =
        /fetch|websocket|eventsource|xmlhttprequest|sendbeacon|getbuiltinmodule|dlopen|constructor|child_process|globalthis|webassembly/;
      const MSG_G =
        "Swap lane: no Function constructor, .constructor, process other than process.cwd(), builtin loader or egress name in a lane file";
      const MSG_H =
        "Swap lane: a lane file imports a module outside the lane allow-list";
      const MSG_I =
        "Swap lane: no namespace import and no export * in a lane file";
      const MSG_V =
        "Swap lane: viem only through its allow-listed named helpers (no client, transport, default, namespace or subpath import)";
      for (const f of laneFiles) {
        const text = await read(f);
        const sf = astOf(f, text);
        const problems = [];
        eachNode(sf, (n) => {
          if (ts.isIdentifier(n)) {
            const t = n.text;
            if (
              [
                "Function",
                "constructor",
                "require",
                "module",
                "exports",
              ].includes(t) ||
              /^__(?:non_)?webpack_require__$/.test(t)
            )
              problems.push(MSG_G);
            if (
              t === "process" &&
              !(
                ts.isPropertyAccessExpression(n.parent) &&
                n.parent.expression === n &&
                n.parent.name.text === "cwd" &&
                ts.isCallExpression(n.parent.parent) &&
                n.parent.parent.expression === n.parent &&
                n.parent.parent.arguments.length === 0
              )
            )
              problems.push(MSG_G);
          }
          if (
            ts.isImportDeclaration(n) ||
            (ts.isExportDeclaration(n) && n.moduleSpecifier)
          ) {
            const spec = ts.isStringLiteral(n.moduleSpecifier)
              ? n.moduleSpecifier.text
              : "";
            const target = exactModule(f, spec);
            if (
              !LANE_PACKAGES.has(spec) &&
              !(
                target &&
                (laneFiles.includes(target) || LANE_APP_MODULES.has(target))
              )
            )
              problems.push(MSG_H);
            if (/^viem(?:\/|$)/i.test(spec)) {
              const clause = ts.isImportDeclaration(n)
                ? n.importClause
                : undefined;
              const named =
                clause &&
                !clause.name &&
                clause.namedBindings &&
                ts.isNamedImports(clause.namedBindings)
                  ? clause.namedBindings.elements
                  : null;
              if (
                spec !== "viem" ||
                !named ||
                named.length === 0 ||
                !named.every(
                  (el) =>
                    !el.propertyName &&
                    (VIEM_HELPERS.has(el.name.text) ||
                      ((el.isTypeOnly || clause.isTypeOnly) &&
                        VIEM_TYPES.has(el.name.text))),
                )
              )
                problems.push(MSG_V);
            }
            if (
              ts.isImportDeclaration(n) &&
              n.importClause &&
              ((n.importClause.namedBindings &&
                ts.isNamespaceImport(n.importClause.namedBindings)) ||
                (n.importClause.name && target?.startsWith(`${LANE}/`)))
            )
              problems.push(MSG_I);
          }
          if (
            (ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) &&
            [n.name, n.propertyName].some(
              (x) => x && VIEM_FACTORIES.has(x.text),
            )
          )
            problems.push(MSG_V);
          if (
            ts.isExportDeclaration(n) &&
            (!n.exportClause || ts.isNamespaceExport(n.exportClause))
          )
            problems.push(MSG_I);
          if (
            ts.isImportEqualsDeclaration(n) ||
            ts.isImportTypeNode(n) ||
            (ts.isCallExpression(n) &&
              n.expression.kind === ts.SyntaxKind.ImportKeyword)
          )
            problems.push(MSG_H);
        });
        if (
          /getBuiltinModule|dlopen|\bbinding\b/.test(text) ||
          LANE_LITERAL_BANS.test(joinedLiterals(sf).toLowerCase())
        )
          problems.push(MSG_G);
        assert(problems.length === 0, `${problems[0]}: ${f}`);
      }
      // (k) VEINED-MC1 lanes review R2 MINOR-2 (adapter-pregate-call / -alias): in the adapter, `postSigner` is named
      //     only by its declaration and as the DIRECT callee of its six calls — two in laneSignerStatus, two in each
      //     send function AFTER that function's gate re-run — and nowhere else (no alias, no .call / .apply, no array);
      //     "sign_send" is exactly four literals, each inside one of those four gated calls (no other spelling in the
      //     joined literals); `fetch` is named once, as the direct callee inside postSigner.
      {
        const A = `${LANE}/signer-adapter.ts`;
        const sf = astOf(A, await read(A));
        const fnNamed = (name) => {
          let hit = null;
          eachNode(sf, (n) => {
            if (ts.isFunctionDeclaration(n) && n.name?.text === name) hit = n;
          });
          return hit;
        };
        const gateEnd = (fn, cond) => {
          let end = -1;
          if (fn)
            eachNode(fn, (n) => {
              if (ts.isIfStatement(n) && n.expression.getText(sf) === cond)
                end = n.end;
            });
          return end;
        };
        const status = fnNamed("laneSignerStatus"),
          swapSend = fnNamed("sendLaneTransaction"),
          bridgeSend = fnNamed("sendBridgeLaneTransaction"),
          post = fnNamed("postSigner");
        const swapGate = gateEnd(swapSend, "!gate.open"),
          bridgeGate = gateEnd(bridgeSend, "!bridgeGate.open");
        const within = (n, fn, from) =>
          !!fn &&
          n.getStart(sf) >= (from ?? fn.getStart(sf)) &&
          n.end <= fn.end;
        let declared = 0,
          loose = 0;
        const calls = [],
          fetches = [],
          signSend = [];
        eachNode(sf, (n) => {
          if (ts.isIdentifier(n) && n.text === "postSigner") {
            if (ts.isFunctionDeclaration(n.parent) && n.parent.name === n)
              declared++;
            else if (ts.isCallExpression(n.parent) && n.parent.expression === n)
              calls.push(n.parent);
            else loose++;
          }
          if (ts.isIdentifier(n) && n.text === "fetch")
            fetches.push(
              ts.isCallExpression(n.parent) && n.parent.expression === n
                ? n.parent
                : null,
            );
          if (
            (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) &&
            n.text === "sign_send"
          )
            signSend.push(n);
        });
        const gated = calls.filter(
          (c) =>
            (swapGate > 0 && within(c, swapSend, swapGate)) ||
            (bridgeGate > 0 && within(c, bridgeSend, bridgeGate)),
        );
        assert(
          declared === 1 &&
            loose === 0 &&
            calls.length === 6 &&
            calls.filter((c) => within(c, status)).length === 2 &&
            gated.length === 4 &&
            calls.filter((c) => within(c, swapSend)).length === 2 &&
            calls.filter((c) => within(c, bridgeSend)).length === 2 &&
            signSend.length === 4 &&
            signSend.every((s) =>
              gated.some(
                (c) => s.getStart(sf) >= c.getStart(sf) && s.end <= c.end,
              ),
            ) &&
            (joinedLiterals(sf).match(/sign_send/gi) ?? []).length === 4 &&
            fetches.length === 1 &&
            fetches[0] !== null &&
            within(fetches[0], post),
          "Swap lane: the signer is reached only through postSigner's six direct calls, sign_send only after the gate re-run (no alias, no .call, no other reference)",
        );
        // (k2) VEINED-MC1 lanes review R3-2 (r3-adapter-hoisted): "after the gate" is EXECUTION order, not text position.
        //   - laneSignerStatus, sendLaneTransaction, sendBridgeLaneTransaction and postSigner are each ONE top-level
        //     function declaration (their names bound nowhere else) whose parameters have no default value;
        //   - none of them holds a nested function of any kind (declaration, expression, arrow, method, accessor,
        //     class, static block): the exempt callback set is EMPTY, none is needed;
        //   - every postSigner call's nearest enclosing function is laneSignerStatus or one of the two send functions,
        //     and lies in a TOP-LEVEL statement of it;
        //   - in each send function the statements before the gate check are exactly the pinned single-use, step, tx
        //     and gate-state statements, the gate check is the next top-level statement, and every postSigner call lies
        //     in a later top-level statement (so on every path the gate check runs before anything can reach the signer);
        //   - postSigner's first statement is the endpoint check; its one fetch lies in a later top-level statement.
        const MSG_K2 =
          "Swap lane: the adapter's send functions hold no nested function, and the gate check is the first statement that can reach postSigner";
        const FN_LIKE = new Set([
          ts.SyntaxKind.FunctionDeclaration,
          ts.SyntaxKind.FunctionExpression,
          ts.SyntaxKind.ArrowFunction,
          ts.SyntaxKind.MethodDeclaration,
          ts.SyntaxKind.GetAccessor,
          ts.SyntaxKind.SetAccessor,
          ts.SyntaxKind.Constructor,
          ts.SyntaxKind.ClassDeclaration,
          ts.SyntaxKind.ClassExpression,
          ts.SyntaxKind.ClassStaticBlockDeclaration,
        ]);
        const fnOf = (n) => {
          for (let p = n.parent; p; p = p.parent)
            if (FN_LIKE.has(p.kind)) return p;
          return null;
        };
        const SEND_FNS = [
          "laneSignerStatus",
          "sendLaneTransaction",
          "sendBridgeLaneTransaction",
          "postSigner",
        ];
        const top = {};
        let k2 = true;
        for (const name of SEND_FNS) {
          const decls = sf.statements.filter(
            (st) => ts.isFunctionDeclaration(st) && st.name?.text === name,
          );
          let bindings = 0;
          eachNode(sf, (n) => {
            if (
              ts.isIdentifier(n) &&
              n.text === name &&
              DECL_NAME_KINDS.has(n.parent.kind) &&
              n.parent.name === n
            )
              bindings++;
          });
          const fn = decls.length === 1 && bindings === 1 ? decls[0] : null;
          if (
            !fn?.body ||
            fn.parameters.some((p) => p.initializer || !ts.isIdentifier(p.name))
          ) {
            k2 = false;
            continue;
          }
          top[name] = fn;
          eachNode(fn.body, (n) => {
            if (FN_LIKE.has(n.kind)) k2 = false;
          });
        }
        // the index of the top-level statement of `fn` that holds `n` (-1: none, e.g. a parameter)
        const stmtIndex = (fn, n) =>
          fn.body.statements.findIndex(
            (st) => n.getStart(sf) >= st.getStart(sf) && n.end <= st.end,
          );
        const flatOf = (st) => flat(st.getText(sf));
        const preGate = {
          sendLaneTransaction: [
            [
              'const g = authority && typeof authority === "object" ? GRANTS.get(authority) : undefined;',
              'if (!g) throw new LaneDispatchError("AUTHORITY_UNKNOWN_OR_USED");',
              "GRANTS.delete(authority as object);",
              'if (g.facts.step !== step) throw new LaneDispatchError("AUTHORITY_STEP_MISMATCH");',
              'if (!sameLaneTx(g.tx, tx)) throw new LaneDispatchError("TX_NOT_AUTHORIZED_TX");',
              "const gate = swapLaneGateState({ ...g.facts, now: Date.now() });",
            ],
            'if (!gate.open) throw new LaneDispatchError("SWAP_LANE_GATE_CLOSED", gate.reasons);',
          ],
          sendBridgeLaneTransaction: [
            [
              'const bg = authority && typeof authority === "object" ? BRIDGE_GRANTS.get(authority) : undefined;',
              'if (!bg) throw new LaneDispatchError("AUTHORITY_UNKNOWN_OR_USED");',
              "BRIDGE_GRANTS.delete(authority as object);",
              'if (bg.facts.step !== step) throw new LaneDispatchError("AUTHORITY_STEP_MISMATCH");',
              'if (!sameLaneTx(bg.tx, tx)) throw new LaneDispatchError("TX_NOT_AUTHORIZED_TX");',
              "const bridgeGate = bridgeLaneGateState({ ...bg.facts, now: Date.now() });",
            ],
            'if (!bridgeGate.open) throw new LaneDispatchError("BRIDGE_LANE_GATE_CLOSED", bridgeGate.reasons);',
          ],
        };
        if (k2) {
          for (const [name, [pinned, gateCheck]] of Object.entries(preGate)) {
            const st = top[name].body.statements;
            const gi = pinned.length;
            if (
              st.length <= gi + 1 ||
              !pinned.every((text, i) => flatOf(st[i]) === text) ||
              flatOf(st[gi]) !== gateCheck ||
              st.filter((s) => flatOf(s) === gateCheck).length !== 1
            )
              k2 = false;
          }
          for (const c of calls) {
            const fn = fnOf(c);
            const name = SEND_FNS.find((x) => top[x] === fn);
            const at = name ? stmtIndex(fn, c) : -1;
            if (
              !name ||
              name === "postSigner" ||
              at < 0 ||
              (preGate[name] && at <= preGate[name][0].length)
            )
              k2 = false;
          }
          // the endpoint facts and the gates are the IMPORTED ones (each bound once in the adapter, by its unrenamed import
          // from the lane's approval file: no local stand-in, no shadow after the gate), the checks they rely on are the
          // adapter's own top-level declarations (bound once), and every send body's postSigner call passes its lane's
          // endpoint fact itself (laneSignerStatus: its `s`, chosen from the two facts)
          for (const [name, spec] of [
            ["OWNER_SWAP_LANE_SIGNER", "./approval"],
            ["swapLaneGateState", "./approval"],
            ["OWNER_BRIDGE_LANE_SIGNER", "./bridge-approval"],
            ["bridgeLaneGateState", "./bridge-approval"],
          ])
            if (!importedOnce(sf, name, spec)) k2 = false;
          for (const name of [
            "GRANTS",
            "BRIDGE_GRANTS",
            "sameLaneTx",
            "LaneDispatchError",
            "ENDPOINT",
            "signResult",
          ]) {
            const b = bindingsOf(sf, name);
            let st = b[0];
            while (st && st.parent !== sf) st = st.parent;
            if (b.length !== 1 || !st) k2 = false;
          }
          for (const c of calls) {
            const first = c.arguments[0];
            const want =
              fnOf(c) === top.sendLaneTransaction
                ? "OWNER_SWAP_LANE_SIGNER"
                : fnOf(c) === top.sendBridgeLaneTransaction
                  ? "OWNER_BRIDGE_LANE_SIGNER"
                  : "s";
            if (!first || !ts.isIdentifier(first) || first.text !== want)
              k2 = false;
          }
          const postFirst = top.postSigner.body.statements[0];
          if (
            !postFirst ||
            flatOf(postFirst) !==
              'if (s === null || typeof s.url !== "string" || !ENDPOINT.test(s.url) || typeof s.tokenFile !== "string") throw new LaneDispatchError("NO_LOCAL_SIGNER");' ||
            fetches.some(
              (c) =>
                !c ||
                fnOf(c) !== top.postSigner ||
                stmtIndex(top.postSigner, c) < 1,
            )
          )
            k2 = false;
        }
        assert(k2, MSG_K2);
      }
      // (l) VEINED-MC1 lanes review R2 NEW-1: ONE process-wide dispatch lock (dispatch-lock.ts), used by both engines and
      //     nothing else. In each engine, dispatch() and revoke() are `this.checkKey(ownerKey); return
      //     withLaneDispatchLock(this.#lockKey, () => new <Lane>Error("DISPATCH_IN_PROGRESS"), async () => { ... })`, and
      //     every preflight, re-check, single-use batch, authority mint, hand-off and outcome record lies inside one of the
      //     two locked spans (the DISPATCH entries are written by #recordDispatch alone).
      {
        const LOCK = `${LANE}/dispatch-lock.ts`;
        const MSG_L =
          "Swap lane: both engines spend a step only inside the ONE process-wide dispatch lock (dispatch-lock.ts)";
        assert(
          laneFiles.includes(LOCK),
          "Swap lane file missing: dispatch-lock.ts",
        );
        for (const f of files.filter((f) => SRC_CODE.test(f))) {
          const text = await read(f);
          if (
            /\bwithLaneDispatchLock\b|\blaneDispatchPending\b|__veinedLaneDispatchLock/.test(
              text,
            ) ||
            /withlanedispatchlock|__veinedlanedispatchlock/.test(
              joinedLiterals(astOf(f, text)).toLowerCase(),
            )
          )
            assert(
              [LOCK, `${LANE}/engine.ts`, `${LANE}/bridge-engine.ts`].includes(
                f,
              ),
              `${MSG_L}: ${f}`,
            );
          for (const [name, home] of [
            ["__veinedSwapLane", `${LANE}/runtime.ts`],
            ["__veinedBridgeLane", `${LANE}/bridge-runtime.ts`],
          ])
            if (text.includes(name))
              assert(
                f === home,
                `Swap lane: the global object touched in a lane file: ${f}`,
              );
        }
        const lockSf = astOf(LOCK, await read(LOCK));
        let lockImports = 0,
          lockDecl = 0;
        eachNode(lockSf, (n) => {
          if (ts.isImportDeclaration(n) || ts.isImportEqualsDeclaration(n))
            lockImports++;
          if (
            ts.isFunctionDeclaration(n) &&
            n.name?.text === "withLaneDispatchLock"
          )
            lockDecl++;
        });
        assert(lockImports === 0 && lockDecl === 1, `${MSG_L}: ${LOCK}`);
        // VEINED-MC1 lanes review R3 (NIT, r3-lock-spoof): the lock state is ONE non-writable, non-configurable,
        // non-enumerable property under the registry symbol "veined.laneDispatchLock", defined and read in
        // dispatch-lock.ts alone. Outside that file, nothing in src names the key (in code or in any joined literal,
        // the legacy "__veinedLaneDispatchLock" included), the lock internals, or the reflection calls that would list
        // the global object's symbols.
        for (const f of files.filter((f) => SRC_CODE.test(f) && f !== LOCK)) {
          const text = await read(f);
          assert(
            !/\bLANE_DISPATCH_LOCK_KEY\b|\bLaneDispatchLockState\b|\blockState\b|__veinedLaneDispatchLock|\bgetOwnPropertySymbols\b|\bgetOwnPropertyDescriptors\b|\bownKeys\b/.test(
              text,
            ) &&
              !/lanedispatchlock|getownpropertysymbols|getownpropertydescriptors|ownkeys/.test(
                joinedLiterals(astOf(f, text)).toLowerCase(),
              ),
            `${MSG_L}: ${f}`,
          );
        }
        {
          const lockText = await read(LOCK);
          const exported = lockSf.statements
            .filter((st) =>
              st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword),
            )
            .map((st) =>
              ts.isFunctionDeclaration(st) ? st.name?.text : "<other>",
            )
            .sort();
          const keyDecls = topConsts(lockSf, "LANE_DISPATCH_LOCK_KEY");
          const defines = [];
          eachNode(lockSf, (n) => {
            if (
              ts.isCallExpression(n) &&
              n.expression.getText(lockSf) === "Object.defineProperty"
            )
              defines.push(n);
          });
          const desc = defines[0]?.arguments[2];
          const props =
            desc && ts.isObjectLiteralExpression(desc)
              ? desc.properties
                  .map((p) => flat(p.getText(lockSf)))
                  .filter((p) => !p.startsWith("value:"))
                  .sort()
              : [];
          const lf = flat(lockText);
          assert(
            exported.join(",") === "laneDispatchPending,withLaneDispatchLock" &&
              keyDecls.length === 1 &&
              !keyDecls[0].modifiers?.length &&
              flat(keyDecls[0].getText(lockSf)) ===
                'const LANE_DISPATCH_LOCK_KEY: unique symbol = Symbol.for("veined.laneDispatchLock");' &&
              defines.length === 1 &&
              desc.properties.length === 4 &&
              props.join(" ") ===
                "configurable: false enumerable: false writable: false" &&
              lf.includes("held.writable !== false ||") &&
              lf.includes("held.configurable !== false ||") &&
              lf.includes(
                'throw new Error("LANE_DISPATCH_LOCK_STATE_INVALID");',
              ),
            `${MSG_L}: ${LOCK}`,
          );
        }
        for (const [f, errorClass] of [
          [`${LANE}/engine.ts`, "SwapLaneError"],
          [`${LANE}/bridge-engine.ts`, "BridgeLaneError"],
        ]) {
          // a missing engine is reported by its own rule (13: "Swap lane file missing", 13b: "Bridge lane file missing")
          if (!laneFiles.includes(f)) continue;
          const sf = astOf(f, await read(f));
          const locks = [];
          const methods = {};
          let recordFn = null;
          eachNode(sf, (n) => {
            if (
              ts.isCallExpression(n) &&
              ts.isIdentifier(n.expression) &&
              n.expression.text === "withLaneDispatchLock"
            )
              locks.push(n);
            if (ts.isMethodDeclaration(n) && n.name) {
              const name = n.name.getText(sf);
              if (name === "dispatch" || name === "revoke") methods[name] = n;
              if (name === "#recordDispatch") recordFn = n;
            }
          });
          const spans = locks
            .map((c) => c.arguments[2])
            .filter((a) => a && ts.isArrowFunction(a))
            .map((a) => [a.getStart(sf), a.end]);
          const inLock = (n) =>
            spans.some(([a, b]) => n.getStart(sf) >= a && n.end <= b);
          const shapeOk = ["dispatch", "revoke"].every((name) => {
            const m = methods[name];
            const st = m?.body?.statements ?? [];
            const ret = st[1];
            const call =
              ret && ts.isReturnStatement(ret) ? ret.expression : undefined;
            return (
              st.length === 2 &&
              st[0].getText(sf) === "this.checkKey(ownerKey);" &&
              call !== undefined &&
              locks.includes(call) &&
              call.arguments.length === 3 &&
              call.arguments[0].getText(sf) === "this.#lockKey" &&
              call.arguments[1].getText(sf).replace(/\s+/g, " ") ===
                `() => new ${errorClass}("DISPATCH_IN_PROGRESS")` &&
              ts.isArrowFunction(call.arguments[2]) &&
              !!call.arguments[2].modifiers?.some(
                (x) => x.kind === ts.SyntaxKind.AsyncKeyword,
              )
            );
          });
          const counts = {};
          let outside = 0;
          const MUST_LOCK = [
            "this.#d.signer.send",
            "this.#preflight",
            "this.#recheck",
            "this.#d.store.batch",
            "this.#recordDispatch",
            "mintLaneDispatchAuthority",
            "mintBridgeDispatchAuthority",
          ];
          eachNode(sf, (n) => {
            if (!ts.isCallExpression(n)) return;
            const callee = n.expression.getText(sf);
            if (MUST_LOCK.includes(callee)) {
              counts[callee] = (counts[callee] ?? 0) + 1;
              if (!inLock(n)) outside++;
            }
            if (!/\.append$/.test(callee)) return;
            // a journal entry type is a literal, or (#recordDispatch only) a choice between two literals
            const first = n.arguments[0];
            const types =
              first && ts.isStringLiteral(first)
                ? [first.text]
                : first &&
                    ts.isConditionalExpression(first) &&
                    ts.isStringLiteral(first.whenTrue) &&
                    ts.isStringLiteral(first.whenFalse)
                  ? [first.whenTrue.text, first.whenFalse.text]
                  : null;
            const inRecord =
              !!recordFn &&
              n.getStart(sf) >= recordFn.getStart(sf) &&
              n.end <= recordFn.end;
            if (callee !== "this.#d.store.append" || types === null) outside++;
            else
              for (const t of types) {
                if (["NONCE", "USE", "PREPARED"].includes(t) && !inLock(n))
                  outside++;
                if (
                  (t === "DISPATCH" || t === "DISPATCH_DUPLICATE") &&
                  !inRecord
                )
                  outside++;
              }
            if (types && types.length === 2 && !inRecord) outside++;
          });
          assert(
            locks.length === 2 &&
              spans.length === 2 &&
              shapeOk &&
              outside === 0 &&
              counts["this.#d.signer.send"] === 2 &&
              counts["this.#preflight"] === 2 &&
              counts["this.#d.store.batch"] === 2 &&
              counts["this.#recheck"] === 1 &&
              counts["this.#recordDispatch"] === 4,
            `${MSG_L}: ${f}`,
          );
        }
        // (l2) VEINED-MC1 lanes review R3-3 (r3-engine-unlocked-send / -use): the lock pins above name call TEXT; these
        //      read the syntax tree. In each engine:
        //   - `#d` is only the field, `this.#d = d` (once, in the constructor) and `this.#d.<name>`; `this.#d.signer` is
        //     only the direct callee object of `.send(` / `.status(`; `this.#d.store` only of `.of(` / `.append(` /
        //     `.batch(` — or, in #mark alone, the initializer of one const alias used only as `<alias>.of(`. No computed
        //     member access (`this.#d["…"]`, `this.#d.signer["send"]`, `this.#d.store["append"]`), no alias, no
        //     destructuring, no `.call` / `.apply` / `.bind` of any of them;
        //   - the constructor's deps parameter is read only as `d.record` / `d.now` and stored once as `this.#d = d`;
        //   - the names `send`, `append` and `batch` occur only as those direct calls (and `send` as the signer
        //     interface's method signature); the engine's own mint function only as its one (unrenamed) import and its
        //     two direct calls; the other lane's mint not at all;
        //   - the two hand-offs and the two mints are direct calls whose nearest enclosing function IS the locked
        //     callback of dispatch() / revoke(); each USE / NONCE / PREPARED append's nearest enclosing function is that
        //     callback or the `this.#d.store.batch(() => …)` callback written directly in it; batch likewise;
        //   - no computed member access whose key literals name the signer, the store or their methods.
        const MSG_L2 =
          "Swap lane: the signer hand-off, the mint and the USE / NONCE / PREPARED appends are direct calls inside the dispatch lock (no computed access, no alias)";
        const FN_KINDS = new Set([
          ts.SyntaxKind.FunctionDeclaration,
          ts.SyntaxKind.FunctionExpression,
          ts.SyntaxKind.ArrowFunction,
          ts.SyntaxKind.MethodDeclaration,
          ts.SyntaxKind.GetAccessor,
          ts.SyntaxKind.SetAccessor,
          ts.SyntaxKind.Constructor,
          ts.SyntaxKind.ClassStaticBlockDeclaration,
        ]);
        const fnAbove = (n) => {
          for (let p = n.parent; p; p = p.parent)
            if (FN_KINDS.has(p.kind)) return p;
          return null;
        };
        const isCallee = (n) =>
          ts.isCallExpression(n.parent) && n.parent.expression === n;
        const WIRED_KEY = /send|append|batch|signer|store|status|mint|dispatch/;
        const MINTS = {
          [`${LANE}/engine.ts`]: "mintLaneDispatchAuthority",
          [`${LANE}/bridge-engine.ts`]: "mintBridgeDispatchAuthority",
        };
        // Every lane file: a computed member access never names the signer, the store or their methods, and the
        // adapter's mint / send / status functions are reached only from their homes, as an unrenamed import plus
        // direct calls (no alias, no .call / .apply / .bind, no argument, no export).
        const WIRED_FNS = {
          mintLaneDispatchAuthority: { [`${LANE}/engine.ts`]: 2 },
          mintBridgeDispatchAuthority: { [`${LANE}/bridge-engine.ts`]: 2 },
          sendLaneTransaction: { [`${LANE}/runtime.ts`]: 1 },
          sendBridgeLaneTransaction: { [`${LANE}/bridge-runtime.ts`]: 1 },
          laneSignerStatus: {
            [`${LANE}/runtime.ts`]: 1,
            [`${LANE}/bridge-runtime.ts`]: 1,
          },
        };
        for (const f of laneFiles) {
          const sf = astOf(f, await read(f));
          let ok = true;
          const seen = {};
          eachNode(sf, (n) => {
            if (
              ts.isElementAccessExpression(n) &&
              (WIRED_KEY.test(
                joinedLiterals(n.argumentExpression).toLowerCase(),
              ) ||
                /^(?:store|signer)$/.test(
                  ts.isIdentifier(n.expression) ? n.expression.text : "",
                ))
            )
              ok = false;
            if (!ts.isIdentifier(n) || !Object.hasOwn(WIRED_FNS, n.text))
              return;
            const name = n.text;
            if (f === `${LANE}/signer-adapter.ts`) {
              if (!(ts.isFunctionDeclaration(n.parent) && n.parent.name === n))
                ok = false;
              return;
            }
            const home = WIRED_FNS[name][f];
            const s = (seen[name] ??= { imports: 0, calls: 0 });
            if (home === undefined) ok = false;
            else if (
              ts.isImportSpecifier(n.parent) &&
              n.parent.name === n &&
              !n.parent.propertyName
            )
              s.imports++;
            else if (isCallee(n)) s.calls++;
            else ok = false;
          });
          for (const [name, s] of Object.entries(seen))
            if (s.imports !== 1 || s.calls !== WIRED_FNS[name][f]) ok = false;
          // outside the engines `append` is only the runtimes' `store.append("LANE_BIND", …)`, `send` only the runtimes'
          // signer property, and neither appears anywhere else in the lane
          if (!Object.hasOwn(MINTS, f))
            eachNode(sf, (n) => {
              if (!ts.isIdentifier(n)) return;
              const rt =
                f === `${LANE}/runtime.ts` || f === `${LANE}/bridge-runtime.ts`;
              if (n.text === "append") {
                const call = n.parent.parent;
                if (
                  !rt ||
                  !ts.isPropertyAccessExpression(n.parent) ||
                  n.parent.name !== n ||
                  n.parent.expression.getText(sf) !== "store" ||
                  !isCallee(n.parent) ||
                  !ts.isStringLiteral(call.arguments[0]) ||
                  call.arguments[0].text !== "LANE_BIND"
                )
                  ok = false;
              }
              if (
                n.text === "send" &&
                !(
                  rt &&
                  ts.isPropertyAssignment(n.parent) &&
                  n.parent.name === n
                )
              )
                ok = false;
            });
          assert(ok, `${MSG_L2}: ${f}`);
        }
        for (const [f, mint] of Object.entries(MINTS)) {
          // a missing engine is reported by its own rule (13 / 13b "file missing")
          if (!laneFiles.includes(f)) continue;
          const sf = astOf(f, await read(f));
          // the two locked callbacks (the (l) rule above pinned them as dispatch()'s and revoke()'s)
          const lockFns = [];
          eachNode(sf, (n) => {
            if (
              ts.isCallExpression(n) &&
              ts.isIdentifier(n.expression) &&
              n.expression.text === "withLaneDispatchLock" &&
              n.arguments[2] &&
              ts.isArrowFunction(n.arguments[2])
            )
              lockFns.push(n.arguments[2]);
          });
          const inLock = (call) => lockFns.includes(fnAbove(call));
          const inBatch = (call) => {
            const fn = fnAbove(call);
            if (lockFns.includes(fn)) return true;
            const b = fn && ts.isArrowFunction(fn) ? fn.parent : null;
            return (
              !!b &&
              ts.isCallExpression(b) &&
              b.arguments.length === 1 &&
              b.arguments[0] === fn &&
              b.expression.getText(sf) === "this.#d.store.batch" &&
              lockFns.includes(fnAbove(b))
            );
          };
          let ok = lockFns.length === 2;
          // the lock and the mint are the IMPORTED ones (each bound once, by its unrenamed import: no local stand-in)
          if (
            !importedOnce(sf, "withLaneDispatchLock", "./dispatch-lock") ||
            !importedOnce(sf, mint, "./signer-adapter")
          )
            ok = false;
          let fields = 0,
            stored = 0,
            aliases = 0,
            sends = 0,
            mints = 0,
            mintImports = 0;
          const allowedNames = new Set();
          eachNode(sf, (n) => {
            if (ts.isPrivateIdentifier(n) && n.text === "#d") {
              const p = n.parent;
              if (ts.isPropertyDeclaration(p) && p.name === n) {
                fields++;
                return;
              }
              if (
                !ts.isPropertyAccessExpression(p) ||
                p.name !== n ||
                p.expression.kind !== ts.SyntaxKind.ThisKeyword
              ) {
                ok = false;
                return;
              }
              const q = p.parent;
              if (ts.isBinaryExpression(q) && q.left === p) {
                if (
                  q.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
                  ts.isIdentifier(q.right) &&
                  q.right.text === "d" &&
                  ts.isExpressionStatement(q.parent) &&
                  fnAbove(q)?.kind === ts.SyntaxKind.Constructor
                )
                  stored++;
                else ok = false;
                return;
              }
              if (
                !ts.isPropertyAccessExpression(q) ||
                q.expression !== p ||
                !ts.isIdentifier(q.name)
              ) {
                ok = false;
                return;
              }
              const r = q.parent;
              const member =
                ts.isPropertyAccessExpression(r) &&
                r.expression === q &&
                ts.isIdentifier(r.name) &&
                isCallee(r)
                  ? r.name.text
                  : null;
              if (q.name.text === "signer") {
                if (member === "status") allowedNames.add(r.name);
                else if (member === "send" && inLock(r.parent)) {
                  allowedNames.add(r.name);
                  sends++;
                } else ok = false;
              } else if (q.name.text === "store") {
                if (member === "of") allowedNames.add(r.name);
                else if (member === "append") {
                  allowedNames.add(r.name);
                  // (the entry type's literal shape is the (l) rule's; here: where a spending type is written)
                  const t = r.parent.arguments[0];
                  const types = !t
                    ? []
                    : ts.isConditionalExpression(t)
                      ? [t.whenTrue, t.whenFalse]
                      : [t];
                  if (
                    !t ||
                    (types.some(
                      (x) =>
                        ts.isStringLiteral(x) &&
                        ["NONCE", "USE", "PREPARED"].includes(x.text),
                    ) &&
                      !inBatch(r.parent))
                  )
                    ok = false;
                } else if (member === "batch") {
                  allowedNames.add(r.name);
                  if (!inLock(r.parent)) ok = false;
                } else {
                  // #mark's read-only alias: `const s = this.#d.store;`, then only `s.of(...)`
                  const m = fnAbove(r);
                  if (
                    ts.isVariableDeclaration(r) &&
                    r.initializer === q &&
                    ts.isIdentifier(r.name) &&
                    (r.parent.flags & ts.NodeFlags.Const) !== 0 &&
                    m &&
                    ts.isMethodDeclaration(m) &&
                    m.name.getText(sf) === "#mark"
                  ) {
                    aliases++;
                    const alias = r.name;
                    eachNode(m.body, (x) => {
                      if (
                        ts.isIdentifier(x) &&
                        x.text === alias.text &&
                        x !== alias &&
                        !(
                          ts.isPropertyAccessExpression(x.parent) &&
                          x.parent.expression === x &&
                          x.parent.name.text === "of" &&
                          isCallee(x.parent)
                        )
                      )
                        ok = false;
                    });
                  } else ok = false;
                }
              }
              return;
            }
            if (!ts.isIdentifier(n)) return;
            if (n.text === mint) {
              if (
                ts.isImportSpecifier(n.parent) &&
                n.parent.name === n &&
                !n.parent.propertyName
              )
                mintImports++;
              else if (isCallee(n) && inLock(n.parent)) mints++;
              else ok = false;
            } else if (Object.values(MINTS).includes(n.text)) ok = false;
          });
          eachNode(sf, (n) => {
            if (
              ts.isIdentifier(n) &&
              ["send", "append", "batch"].includes(n.text) &&
              !allowedNames.has(n) &&
              !(
                n.text === "send" &&
                ts.isMethodSignature(n.parent) &&
                n.parent.name === n
              )
            )
              ok = false;
            // the constructor of the class that holds #d (the engine; its error class has its own)
            if (
              !ts.isConstructorDeclaration(n) ||
              !n.parent.members.some(
                (m) =>
                  ts.isPropertyDeclaration(m) && m.name.getText(sf) === "#d",
              )
            )
              return;
            if (
              n.parameters.length !== 1 ||
              n.parameters[0].name.getText(sf) !== "d"
            )
              ok = false;
            if (n.body)
              eachNode(n.body, (x) => {
                if (!ts.isIdentifier(x) || x.text !== "d") return;
                const p = x.parent;
                if (
                  ts.isPropertyAccessExpression(p) &&
                  p.expression === x &&
                  (p.name.text === "record" || p.name.text === "now")
                )
                  return;
                if (
                  ts.isBinaryExpression(p) &&
                  p.right === x &&
                  p.left.getText(sf) === "this.#d"
                )
                  return;
                ok = false;
              });
          });
          assert(
            ok &&
              fields === 1 &&
              stored === 1 &&
              aliases <= 1 &&
              sends === 2 &&
              mints === 2 &&
              mintImports === 1,
            `${MSG_L2}: ${f}`,
          );
        }
      }
      // (m) VEINED-MC1 lanes review R2: the lane directory holds exactly the reviewed lane files (a new file there is
      //     a new lane module: it must be added here, with its rules, on purpose).
      const LANE_FILE_SET = [
        ...(manualProfile ? ["existing-allowance.ts"] : []),
        "approval.ts",
        "bridge-approval.ts",
        "bridge-calldata.ts",
        "bridge-engine.ts",
        "bridge-pins.ts",
        "bridge-runtime.ts",
        "bridge-scope.ts",
        "calldata.ts",
        "dispatch-lock.ts",
        "engine.ts",
        "pins.ts",
        "reads.ts",
        "receipts.ts",
        "runtime.ts",
        "scope.ts",
        "signer-adapter.ts",
        "transport.ts",
      ].map((x) => `${LANE}/${x}`);
      for (const f of files.filter((f) => f.startsWith(`${LANE}/`)))
        assert(
          LANE_FILE_SET.includes(f),
          `Swap lane: a file in src/swap/lane outside the pinned lane file set: ${f}`,
        );
      // NEW-4: the armed profile validates an ARMED variant; with no exact armed signer declaration there is nothing to
      // validate (the default scan is the one for a disarmed tree).
      if (ARMED_PROFILE)
        assert(
          armedSigners.length >= 1,
          "Armed profile: no exact armed OWNER_SWAP_LANE_SIGNER / OWNER_BRIDGE_LANE_SIGNER declaration (use the default scan)",
        );
    }
  }
  canary.rules = 12;
  // VEINED-MC1: rule 13 (swap lane) + rule 13b (bridge lane).
  swapLane.rules = 2;
}
const result = {
  at: new Date().toISOString(),
  // NEW-4: an armed-profile run is never a release PASS (and is written to its own file below).
  result: manualProfile
    ? "MANUAL_WALLET_PROFILE_PASS"
    : ARMED_PROFILE
      ? "ARMED_PROFILE_PASS"
      : "PASS",
  ...(ARMED_PROFILE
    ? { profile: "armed-profile", armedSigners: [...armedSigners].sort() }
    : {}),
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
  swapLane,
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
await writeFile(
  `${base}/${manualProfile ? "safety-manual-wallet-profile.json" : ARMED_PROFILE ? "safety-armed-profile.json" : "safety.json"}`,
  JSON.stringify(result, null, 2),
);
console.log(result);
