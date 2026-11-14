// V1.6 G5: bounded public-source capture. Saves raw body + URL + timestamp + SHA-256 + trust label.
// Usage: node scripts/g5-v16-fetch.mjs <trustLabel> <relativeOutPath> <url>
import {
  writeFileSync,
  appendFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { sha256, now, logPath } from "./g5-v16-lib.mjs";

const LABELS = new Set([
  "ONCHAIN_RPC",
  "OFFICIAL_EXPLORER_INDEX",
  "THIRD_PARTY_EXPLORER",
  "OFFICIAL_GIT",
  "CONTENT_ADDRESSED_METADATA",
  "DERIVED",
  "OFFICIAL_API",
  "OFFICIAL_DOCS",
]);
const ALLOWED_HOSTS = [
  /^(www\.)?crossscan\.io$/,
  /^explorer\.onechain\.nexus$/,
  /^docs\.onechain\.nexus$/,
  /^(www\.)?onechain\.nexus$/,
  /^api\.github\.com$/,
  /^raw\.githubusercontent\.com$/,
  /^github\.com$/,
  /^codeload\.github\.com$/,
  /^repo\.sourcify\.dev$/,
  /^sourcify\.dev$/,
  /^server\.verify\.sourcify\.dev$/,
  /^ipfs\.io$/,
  /^dweb\.link$/,
  /^cloudflare-ipfs\.com$/,
  /^gateway\.pinata\.cloud$/,
  /^[a-z0-9]+\.ipfs\.dweb\.link$/,
  /^w3s\.link$/,
  /^4everland\.io$/,
  /^nftstorage\.link$/,
  /^(api\.)?bscscan\.com$/,
  /^api\.etherscan\.io$/,
  /^bridge-api\.crosstoken\.io$/,
  /^wallet-server\.crosstoken\.io$/,
  /^binaries\.soliditylang\.org$/,
  /^(www\.)?certik\.com$/,
  /^skynet\.certik\.com$/,
  /^chainid\.network$/,
  /^chainlist\.org$/,
  /^bsc\.blockscout\.com$/,
  /^(www\.)?oklink\.com$/,
  /^bsctrace\.com$/,
];

export async function fetchSave(
  label,
  rel,
  url,
  { timeoutMs = 30000, maxBytes = 50 * 2 ** 20, accept = "*/*" } = {},
) {
  if (!LABELS.has(label)) throw new Error(`BAD_LABEL ${label}`);
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    !ALLOWED_HOSTS.some((r) => r.test(u.hostname))
  )
    throw new Error(`HOST_NOT_ALLOWED ${u.hostname}`);
  const at = now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let status = 0,
    body = Buffer.alloc(0),
    error = null,
    ctype = null;
  try {
    const res = await fetch(url, {
      headers: {
        accept,
        "user-agent": "otherbridge-g5-forensics/1.6 (read-only research)",
      },
      signal: ctl.signal,
      redirect: "follow",
    });
    status = res.status;
    ctype = res.headers.get("content-type");
    const ab = await res.arrayBuffer();
    if (ab.byteLength > maxBytes) throw new Error("TOO_LARGE");
    body = Buffer.from(ab);
  } catch (e) {
    error = String(e?.cause?.code ?? e?.message ?? e);
  } finally {
    clearTimeout(t);
  }
  const p = logPath(rel);
  writeFileSync(p, body);
  const rec = {
    at,
    label,
    url,
    status,
    contentType: ctype,
    error,
    bytes: body.length,
    sha256: sha256(body),
    path: rel,
  };
  appendFileSync(
    logPath("g5-sources/source-log.jsonl"),
    JSON.stringify(rec) + "\n",
  );
  return { ...rec, body };
}

if (
  process.argv[1] &&
  process.argv[1].endsWith("g5-v16-fetch.mjs") &&
  process.argv.length >= 5
) {
  const [label, rel, url] = process.argv.slice(2);
  const r = await fetchSave(label, rel, url);
  const { body, ...meta } = r;
  console.log(JSON.stringify(meta));
  if (process.argv.includes("--print"))
    console.log(body.toString("utf8").slice(0, 4000));
}
export { existsSync, readFileSync };
