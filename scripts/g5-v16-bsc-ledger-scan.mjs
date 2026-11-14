// V1.6 G5: resumable, chunked, hash-pinned scan of ALL BSC bridge-proxy logs and ALL CROSS Transfer logs
// to/from the bridge, from proxy creation to a pinned block. Raw chunks live outside the repository
// (they are large); a manifest with per-chunk SHA-256 is written to the evidence root.
// Usage: node scripts/g5-v16-bsc-ledger-scan.mjs <endBlock>
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { join } from "node:path";
import { rpcRaw, sha256, now, writeJson, REPO } from "./g5-v16-lib.mjs";

const PROXY = "0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5";
const CROSS = "0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510";
const TRANSFER =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAD = "0x000000000000000000000000" + PROXY.slice(2);
// Public endpoint published in DefiLlama/chainlist constants/extraRpcs.js (BSC); only historical-getLogs-capable one found.
const URL_ =
  "https://bsc-mainnet.nodereal.io/v1/64a9df0874fb4a93b9d0a3849de012d3";
const START = 48753627; // proxy creation block (archive bisection)
const SPAN = 50000;
const END = Number(process.argv[2]);
if (!Number.isInteger(END) || END <= START)
  throw new Error("usage: <endBlock>");
const DIR = join(
  REPO,
  "..",
  "otherbridge-forensics",
  "v16",
  "bsc-ledger-chunks",
);
mkdirSync(DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hx = (n) => "0x" + n.toString(16);

// Global AIMD pacing shared by all workers: the gap between requests grows x1.5 on every rate-limit
// answer (max 5 s) and shrinks by 5% after each success (min G5_SCAN_MIN_GAP_MS); progress is logged.
let gap = Number(process.env.G5_SCAN_MIN_GAP_MS ?? 400);
const MIN_GAP = gap;
let nextSlot = 0;
const stats = { ok: 0, limited: 0 };
async function slot() {
  const t = Date.now();
  const at = Math.max(t, nextSlot);
  nextSlot = at + gap;
  if (at > t) await sleep(at - t);
}
async function getLogs(filter, a, b) {
  for (let attempt = 0; attempt < 12; attempt++) {
    await slot();
    const r = await rpcRaw(
      URL_,
      "eth_getLogs",
      [{ ...filter, fromBlock: hx(a), toBlock: hx(b) }],
      { timeoutMs: 60000, log: null },
    );
    if (Array.isArray(r.json?.result)) {
      stats.ok++;
      gap = Math.max(MIN_GAP, gap * 0.95);
      return r.json.result;
    }
    const msg = JSON.stringify(r.json?.error ?? r.error ?? r.status);
    // Only a block-range/result-size refusal splits the range; rate limits and transport errors back off.
    if (
      /maximum block range|block range|too many results|response size|more than \d+ results/i.test(
        msg,
      ) &&
      b > a
    ) {
      const m = Math.floor((a + b) / 2);
      return [
        ...(await getLogs(filter, a, m)),
        ...(await getLogs(filter, m + 1, b)),
      ];
    }
    stats.limited++;
    gap = Math.min(5000, gap * 1.5);
    await sleep(gap * 2);
  }
  throw new Error(`getLogs failed ${a}-${b}`);
}

// Bounded worker pool (default 3 concurrent chunks); each chunk is written atomically only when complete.
const WORKERS = Number(process.env.G5_SCAN_WORKERS ?? 3);
const pendingChunks = [];
for (let a = START; a <= END; a += SPAN)
  pendingChunks.push([a, Math.min(a + SPAN - 1, END)]);
let done = 0;
async function worker() {
  for (;;) {
    const next = pendingChunks.shift();
    if (!next) return;
    const [a, b] = next;
    const f = join(DIR, `${a}-${b}.json`);
    if (existsSync(f)) continue;
    const proxyLogs = await getLogs({ address: PROXY }, a, b);
    // G5_SCAN_TRANSFERS=0: proxy logs only (public-quota fallback); the physical balance of such ranges
    // is reconciled by archive-state surplus bisection (scripts/g5-v16-surplus-bisect.mjs) instead.
    const withTransfers = process.env.G5_SCAN_TRANSFERS !== "0";
    const inLogs = withTransfers
      ? await getLogs({ address: CROSS, topics: [TRANSFER, null, PAD] }, a, b)
      : null;
    const outLogs = withTransfers
      ? await getLogs({ address: CROSS, topics: [TRANSFER, PAD] }, a, b)
      : null;
    writeFileSync(
      f + ".tmp",
      JSON.stringify({
        range: [a, b],
        rpc: URL_,
        at: now(),
        proxyLogs,
        crossIn: inLogs,
        crossOut: outLogs,
      }),
    );
    renameSync(f + ".tmp", f);
    if (++done % 25 === 0)
      console.log(
        now(),
        "chunks done",
        done,
        "last",
        a,
        b,
        "gapMs",
        Math.round(gap),
        JSON.stringify(stats),
      );
  }
}
await Promise.all(Array.from({ length: WORKERS }, worker));
// manifest
const files = readdirSync(DIR)
  .filter((x) => /^\d+-\d+\.json$/.test(x))
  .sort((x, y) => Number(x.split("-")[0]) - Number(y.split("-")[0]));
const chunks = files.map((x) => {
  const t = readFileSync(join(DIR, x));
  const j = JSON.parse(t);
  return {
    file: x,
    range: j.range,
    sha256: sha256(t),
    proxyLogs: j.proxyLogs.length,
    transfers: j.crossIn !== null,
    crossIn: j.crossIn?.length ?? 0,
    crossOut: j.crossOut?.length ?? 0,
  };
});
// contiguity check
let expect = START,
  gaps = [];
for (const c of chunks) {
  if (c.range[0] !== expect) gaps.push([expect, c.range[0] - 1]);
  expect = c.range[1] + 1;
}
const manifest = {
  at: now(),
  rpc: URL_,
  rpcProvenance:
    "DefiLlama/chainlist constants/extraRpcs.js BSC public list (captured under g5-sources/chainlist/extraRpcs.js)",
  start: START,
  end: expect - 1,
  requestedEnd: END,
  chunkCount: chunks.length,
  gaps,
  contiguous: gaps.length === 0,
  totals: chunks.reduce(
    (s, c) => ({
      proxyLogs: s.proxyLogs + c.proxyLogs,
      crossIn: s.crossIn + c.crossIn,
      crossOut: s.crossOut + c.crossOut,
    }),
    { proxyLogs: 0, crossIn: 0, crossOut: 0 },
  ),
  transferCoverage: (() => {
    const t = chunks.filter((c) => c.transfers);
    return {
      chunks: t.length,
      from: t[0]?.range[0] ?? null,
      to: t.at(-1)?.range[1] ?? null,
      contiguousPrefix: t.every((c, i) => c === chunks[i]),
    };
  })(),
  chunks,
};
console.log(JSON.stringify({ ...manifest, chunks: undefined }, null, 1));
writeJson("reserve/bsc-ledger-scan-manifest.json", manifest);
