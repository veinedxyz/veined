import {
  readFileSync,
  readdirSync,
  statSync,
  existsSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
const ev =
  process.env.OTHERBRIDGE_EVIDENCE_ROOT ??
  (existsSync(".otherbridge/v116-evidence-path.txt")
    ? readFileSync(".otherbridge/v116-evidence-path.txt", "utf8").trim()
    : "test-results/v116-browser");
const artifactRoot = resolve(
  process.env.OTHERBRIDGE_BROWSER_ARTIFACT_ROOT ?? ".",
);
const out = resolve(
  process.env.OTHERBRIDGE_BROWSER_SECURITY_OUT ??
    join(ev, "security", "browser"),
);
const buildIdPath = join(artifactRoot, ".next", "BUILD_ID");
mkdirSync(out, { recursive: true });
if (!existsSync(buildIdPath)) throw Error("FRESH_PRODUCTION_BUILD_REQUIRED");
const secrets = [];
const publicConfig = [];
// Privy's app ID is explicitly a public client configuration prop. Do not exempt
// arbitrary NEXT_PUBLIC variables: a mistakenly public provider secret still fails.
const knownPublicKeys = new Set(["NEXT_PUBLIC_PRIVY_APP_ID"]);
for (const file of readdirSync(".").filter(
  (f) => /^\.env/.test(f) && f !== ".env.example",
)) {
  if (!statSync(file).isFile()) continue;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!match) continue;
    const value = match[2].replace(/^["']|["']$/g, "");
    if (value.length >= 12) {
      if (knownPublicKeys.has(match[1]))
        publicConfig.push({ key: match[1], value });
      else secrets.push(value);
    }
    for (const m of value.matchAll(/:\/\/[^:/@]+:([^@]{8,})@/g))
      secrets.push(m[1]);
  }
}
function walk(dir, filter = () => true, acc = []) {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const file = join(dir, item.name);
    if (item.isDirectory()) walk(file, filter, acc);
    else if (filter(file)) acc.push(file);
  }
  return acc;
}
const chunks = walk(join(artifactRoot, ".next/static"), (f) =>
  /\.(?:js|map)$/.test(f),
);
const refs = walk(join(artifactRoot, ".next/server"), (f) =>
  f.endsWith("_client-reference-manifest.js"),
);
if (!chunks.length || !refs.length)
  throw Error("NONEMPTY_PUBLIC_ARTIFACT_AND_CLIENT_REFERENCE_GRAPH_REQUIRED");
const leaks = [],
  clientGraphViolations = [],
  runtimeEnvReferences = [],
  hashes = [],
  publicConfigMatches = [],
  privateKeyFormatMarkers = [];
for (const diskFile of chunks) {
  const file = relative(artifactRoot, diskFile).replaceAll("\\", "/");
  const raw = readFileSync(diskFile),
    text = raw.toString("utf8");
  if (secrets.some((s) => text.includes(s)))
    leaks.push({ file, kind: "actual local env value" });
  for (const entry of publicConfig)
    if (text.includes(entry.value))
      publicConfigMatches.push({
        file,
        key: entry.key,
        valueSha256: createHash("sha256").update(entry.value).digest("hex"),
        classification: "documented public client app ID",
        source: "https://docs.privy.io/basics/react/setup",
      });
  const keyBody =
    /-----BEGIN ((?:RSA |EC |OPENSSH )?PRIVATE KEY)-----(?:\\n|\\r\\n|\r?\n)(?:[A-Za-z0-9+/=]+(?:\\n|\\r\\n|\r?\n)){1,}-----END \1-----/g;
  const literalBodies = [...text.matchAll(keyBody)];
  if (literalBodies.length)
    leaks.push({
      file,
      kind: "literal private key body",
      count: literalBodies.length,
    });
  for (const marker of text.matchAll(
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  )) {
    const delimiter = text[marker.index - 1];
    const standaloneFormatLiteral =
      /["'`]/.test(delimiter ?? "") &&
      text[marker.index + marker[0].length] === delimiter;
    privateKeyFormatMarkers.push({
      file,
      standaloneFormatLiteral,
      literalKeyBodyPresent: literalBodies.length > 0,
    });
    if (!standaloneFormatLiteral && !literalBodies.length)
      leaks.push({ file, kind: "unclassified private key marker" });
  }
  for (const m of text.matchAll(
    /process\.env\.(?:UNISWAP_API_KEY|JUPITER_API_KEY|PCSX_INTEGRATOR_KEY|TITAN_AUTH_TOKEN|TITAN_WS_ENDPOINT|SWAP_HEALTH_PATH)/g,
  ))
    runtimeEnvReferences.push({ file, reference: m[0] });
  hashes.push({
    file,
    bytes: raw.length,
    sha256: createHash("sha256").update(raw).digest("hex"),
  });
}
const forbidden = [
  "swap-providers/runtime",
  "swap-providers/compatibility",
  "src/swap/server",
  "@pancakeswap/smart-router",
  "@pancakeswap/pcsx-sdk",
  "@uniswap/uniswapx-sdk",
  "@titanexchange/sdk-ts",
];
for (const diskFile of refs) {
  const file = relative(artifactRoot, diskFile).replaceAll("\\", "/");
  const text = readFileSync(diskFile, "utf8").replaceAll("\\\\", "/");
  for (const marker of forbidden)
    if (text.includes(marker)) clientGraphViolations.push({ file, marker });
}
const result = {
  at: new Date().toISOString(),
  artifactRoot,
  environmentValuesComparisonRoot: process.cwd(),
  buildId: readFileSync(buildIdPath, "utf8").trim(),
  buildIdModifiedAt: statSync(buildIdPath).mtime.toISOString(),
  chunksScanned: chunks.length,
  javascriptFilesScanned: chunks.filter((f) => f.endsWith(".js")).length,
  sourceMapsScanned: chunks.filter((f) => f.endsWith(".map")).length,
  clientReferenceManifestsScanned: refs.length,
  envValuesCompared: secrets.length,
  publicConfigMatches,
  privateKeyFormatMarkers,
  leaks,
  runtimeEnvReferences,
  clientGraphViolations,
  hashes,
  pass:
    leaks.length === 0 &&
    runtimeEnvReferences.length === 0 &&
    clientGraphViolations.length === 0,
  scope:
    "Actual generated public JS/source-map bytes from artifactRoot compared against the original workspace's local secret env values without disclosure, plus Next client-reference graph paths. No environment file is copied to the fresh artifact root. The documented Privy public app ID and quoted PEM format markers without literal key bodies are classified separately. Other NEXT_PUBLIC vars are not exempt. Server provider SDKs are allowed only in server artifacts. This negative census is supplemented by source boundary tests and measured initial/lazy bundle budgets.",
};
writeFileSync(
  join(out, "browser-secret-and-provider-boundary.json"),
  JSON.stringify(result, null, 2),
);
console.log(
  JSON.stringify({
    pass: result.pass,
    buildId: result.buildId,
    chunksScanned: chunks.length,
    clientReferenceManifestsScanned: refs.length,
    leaks: leaks.length,
    runtimeEnvReferences: runtimeEnvReferences.length,
    clientGraphViolations,
  }),
);
if (!result.pass) process.exitCode = 1;
