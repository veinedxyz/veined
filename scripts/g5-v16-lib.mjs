// V1.6 G5 forensic helpers: bounded read-only JSON-RPC with raw capture, CBOR footer parsing.
// Forensics only — never imported by the application bundle. No write methods are allowed.
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { keccak256 } from "viem";

export const REPO = resolve(
  dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "..",
);
// Evidence root of the current V1.6 run; null when the pointer file is absent (e.g. clean reproduction).
const pointer = join(REPO, ".otherbridge", "v16-evidence-path.txt");
export const EVIDENCE = existsSync(pointer)
  ? join(REPO, readFileSync(pointer, "utf8").trim())
  : null;

export const RPCS = {
  one: [
    {
      url: "https://mainnet.crosstoken.io:22001",
      operator: "to-nexus official (chain-info API)",
    },
    {
      url: "https://mainnet.onechain.nexus:22001",
      operator:
        "to-nexus official (chainid.network registry; same organisation)",
    },
  ],
  bsc: [
    {
      url: "https://bsc-dataseed.bnbchain.org",
      operator: "BNB Chain official",
    },
    { url: "https://bsc-rpc.publicnode.com", operator: "Allnodes PublicNode" },
    { url: "https://bsc.drpc.org", operator: "dRPC" },
  ],
};

// Read-only allowlist. Anything else is refused before any network I/O.
const READ_METHODS = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getLogs",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getBalance",
  "eth_getBlockReceipts",
  "eth_gasPrice",
  "debug_traceTransaction",
  "trace_transaction",
  "eth_getTransactionCount",
  "net_version",
  "web3_clientVersion",
  "eth_syncing",
  "eth_getProof",
]);

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
export const now = () => new Date().toISOString();

let counter = 0;
export function logPath(name) {
  if (!EVIDENCE) throw new Error("EVIDENCE_ROOT_UNSET");
  const p = join(EVIDENCE, name);
  mkdirSync(dirname(p), { recursive: true });
  return p;
}

export async function rpcRaw(
  url,
  method,
  params = [],
  { timeoutMs = 20000, log = "chain-pins/rpc-log.jsonl" } = {},
) {
  if (!READ_METHODS.has(method))
    throw new Error(`METHOD_NOT_ALLOWED ${method}`);
  if (method === "eth_call" || method === "eth_estimateGas") {
    const tx = params[0] ?? {};
    for (const k of Object.keys(tx))
      if (!["from", "to", "data", "value", "gas"].includes(k))
        throw new Error(`FIELD_NOT_ALLOWED ${k}`);
  }
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: ++counter,
    method,
    params,
  });
  const started = now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  let status = 0,
    text = "",
    error = null;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
      signal: ctl.signal,
    });
    status = res.status;
    text = await res.text();
  } catch (e) {
    error = String(e?.cause?.code ?? e?.name ?? e);
  } finally {
    clearTimeout(t);
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw kept */
  }
  const rec = {
    at: started,
    url,
    method,
    params,
    status,
    error,
    responseSha256: sha256(text),
    response: json ?? text.slice(0, 2000),
  };
  if (log) appendFileSync(logPath(log), JSON.stringify(rec) + "\n");
  return { status, error, json, text, rec };
}

export async function rpc(url, method, params, opts) {
  const r = await rpcRaw(url, method, params, opts);
  if (r.error) throw new Error(`TRANSPORT ${r.error} ${url} ${method}`);
  if (!r.json)
    throw new Error(
      `NON_JSON ${r.status} ${url} ${method}: ${r.text.slice(0, 200)}`,
    );
  if (r.json.error) {
    const err = new Error(
      `RPC_ERROR ${url} ${method}: ${JSON.stringify(r.json.error)}`,
    );
    err.rpcError = r.json.error;
    throw err;
  }
  return r.json.result;
}

export async function retry(fn, tries = 3, delayMs = 1500) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw last;
}

// --- Minimal CBOR decoder for the Solidity metadata footer (maps, byte/text strings, bools, uints) ---
export function decodeCbor(bytes) {
  let i = 0;
  const readLen = (ai) => {
    if (ai < 24) return ai;
    if (ai === 24) return bytes[i++];
    if (ai === 25) {
      const v = (bytes[i] << 8) | bytes[i + 1];
      i += 2;
      return v;
    }
    if (ai === 26) {
      const v =
        ((bytes[i] << 24) >>> 0) +
        (bytes[i + 1] << 16) +
        (bytes[i + 2] << 8) +
        bytes[i + 3];
      i += 4;
      return v;
    }
    throw new Error("CBOR_UNSUPPORTED_LENGTH");
  };
  const item = () => {
    if (i >= bytes.length) throw new Error("CBOR_TRUNCATED");
    const b = bytes[i++],
      mt = b >> 5,
      ai = b & 31;
    if (mt === 0) return readLen(ai);
    if (mt === 2) {
      const n = readLen(ai);
      if (i + n > bytes.length) throw new Error("CBOR_TRUNCATED");
      const v = bytes.slice(i, i + n);
      i += n;
      return Buffer.from(v);
    }
    if (mt === 3) {
      const n = readLen(ai);
      if (i + n > bytes.length) throw new Error("CBOR_TRUNCATED");
      const v = Buffer.from(bytes.slice(i, i + n)).toString("utf8");
      i += n;
      return v;
    }
    if (mt === 5) {
      const n = readLen(ai);
      if (n > 16) throw new Error("CBOR_MAP_TOO_LARGE");
      const o = {};
      for (let k = 0; k < n; k++) {
        const key = item();
        o[String(key)] = item();
      }
      return o;
    }
    if (mt === 7) {
      if (ai === 20) return false;
      if (ai === 21) return true;
      throw new Error("CBOR_UNSUPPORTED_SIMPLE");
    }
    throw new Error(`CBOR_UNSUPPORTED_MAJOR_${mt}`);
  };
  const v = item();
  if (i !== bytes.length) throw new Error("CBOR_TRAILING_BYTES");
  return v;
}

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
export function base58(buf) {
  let n = BigInt("0x" + Buffer.from(buf).toString("hex"));
  let s = "";
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (const b of buf) {
    if (b === 0) s = "1" + s;
    else break;
  }
  return s;
}

// Returns { executable, cbor, cborLength, metadata } for a hex runtime; throws on malformed footer.
export function parseCborFooter(hex) {
  const code = Buffer.from(hex.replace(/^0x/, ""), "hex");
  if (code.length < 2) throw new Error("CODE_TOO_SHORT");
  const len = code.readUInt16BE(code.length - 2);
  if (len + 2 > code.length || len === 0) throw new Error("NO_CBOR_FOOTER");
  const cbor = code.subarray(code.length - 2 - len, code.length - 2);
  const meta = decodeCbor(cbor);
  const out = {
    cborLength: len,
    cborHex: cbor.toString("hex"),
    executableLength: code.length - 2 - len,
  };
  if (meta.ipfs) {
    out.ipfs = base58(meta.ipfs);
    out.ipfsMultihashHex = Buffer.from(meta.ipfs).toString("hex");
  }
  if (meta.bzzr0) out.bzzr0 = Buffer.from(meta.bzzr0).toString("hex");
  if (meta.bzzr1) out.bzzr1 = Buffer.from(meta.bzzr1).toString("hex");
  if (meta.solc)
    out.solc = Buffer.isBuffer(meta.solc)
      ? [...meta.solc].join(".")
      : meta.solc;
  if ("experimental" in meta) out.experimental = meta.experimental;
  out.keys = Object.keys(meta);
  return out;
}

export const codeKeccak = (hex) => keccak256(hex);
export const codeSha256 = (hex) =>
  sha256(Buffer.from(hex.replace(/^0x/, ""), "hex"));

export function writeJson(rel, obj) {
  const p = logPath(rel);
  const text =
    JSON.stringify(
      obj,
      (_, v) => (typeof v === "bigint" ? v.toString() : v),
      1,
    ) + "\n";
  writeFileSync(p, text);
  return { path: rel, sha256: sha256(text) };
}
