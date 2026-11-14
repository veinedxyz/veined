// V1.11 ONEbridge registered token pairs (READ-ONLY). The operator's pairs API only proposes candidates; a pair is
// published only when the LIVE registry confirms it on BOTH chains, through TWO sources per chain:
//   ONEchain: getTokenPair(56, localToken) on both official ONE endpoints at one pinned block (head - 3, same hash)
//   BSC:      getTokenPair(612055, remoteToken) on the independent pair of the canonical common finalized pin
// and both directions name each other exactly. Pairs are matched by exact token address only (never by symbol).
// Uses the G7 read-only client (src/g7/rpc.ts: method allowlist, vetted endpoints, no signer, no write method).
// Only the ONE native → CROSS route is G5-verified; any other registered pair is shown as "No verified route".
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decodeFunctionResult,
  encodeFunctionData,
  parseAbi,
  type Abi,
  type Hex,
} from "viem";
import { ReadOnlyRpc } from "../../src/g7/rpc";
import { selectCommonPin } from "../../src/g7/common-pin";
import {
  BSC_LOGS_WITNESS,
  BSC_PIN_POLICY,
  BSC_STATE_SOURCES,
  ENDPOINTS,
  ONE_PIN_LAG,
} from "../../src/g7/policy";
import { G5_ROUTE_PINS } from "../../src/g5/route-pins";
import { CROSS, NATIVE } from "../../src/core/model";
import { safeGet, safeJsonParse } from "../../src/assets/safe-fetch";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(REPO, "src/assets/onebridge-pairs.generated.json");
const evidenceDir = (() => {
  const p = join(REPO, ".otherbridge", "v111-evidence-path.txt");
  const dir = join(
    REPO,
    existsSync(p)
      ? readFileSync(p, "utf8").trim()
      : "evidence/otherbridge-v1-11/adhoc",
    "asset-sync",
  );
  mkdirSync(dir, { recursive: true });
  return dir;
})();
const audit: unknown[] = [];
const rpc = new ReadOnlyRpc({ timeoutMs: 20_000, audit: (r) => audit.push(r) });
const ABI = parseAbi([
  "function getTokenPair(uint256,address) view returns ((address localToken,address remoteToken,bool isOrigin,bool paused,uint256 pendingAmount,uint256 deposited,uint256 minted))",
  "function isTokenFinalizePaused(uint256,address) view returns (bool)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
]) as Abi;
async function view<T>(
  url: string,
  to: string,
  fn: string,
  args: unknown[],
  block: string,
) {
  const data = encodeFunctionData({ abi: ABI, functionName: fn, args });
  const out = await rpc.retry<Hex>(url, "eth_call", [{ to, data }, block]);
  return decodeFunctionResult({ abi: ABI, functionName: fn, data: out }) as T;
}
type Pair = {
  localToken: string;
  remoteToken: string;
  isOrigin: boolean;
  paused: boolean;
  pendingAmount: bigint;
  deposited: bigint;
  minted: bigint;
};
const lc = (s: string) => s.toLowerCase();
const json = (v: unknown) =>
  JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

// 1. candidates
const api = await safeGet("https://bridge-api.crosstoken.io/bridge/pairs", {
  allowedHosts: ["bridge-api.crosstoken.io"],
  maxBytes: 500_000,
  timeoutMs: 20_000,
  accept: "application/json",
});
const apiSha = createHash("sha256").update(api.body).digest("hex");
writeFileSync(join(evidenceDir, "onebridge-pairs-api.json"), api.body);
type ApiList = {
  data?: {
    list?: {
      local_chain?: number;
      bridge?: string;
      pairs?: Record<string, { localToken?: string; remoteToken?: string }[]>;
    }[];
  };
};
const list =
  (safeJsonParse(api.body.toString("utf8")) as ApiList).data?.list ?? [];
const one = list.find(
  (x) =>
    x.local_chain === 612055 &&
    lc(x.bridge ?? "") === G5_ROUTE_PINS.source.proxy,
);
const candidates = (one?.pairs?.["56"] ?? []).filter(
  (p) =>
    /^0x[0-9a-fA-F]{40}$/.test(p.localToken ?? "") &&
    /^0x[0-9a-fA-F]{40}$/.test(p.remoteToken ?? ""),
);
// 2. pins
const oneHead = Number(
  BigInt(await rpc.retry<string>(ENDPOINTS.one[0], "eth_blockNumber", [])),
);
const oneBlock = `0x${(oneHead - ONE_PIN_LAG).toString(16)}`;
const oneHashes = await Promise.all(
  ENDPOINTS.one.map((u) =>
    rpc
      .retry<{ hash: string }>(u, "eth_getBlockByNumber", [oneBlock, false])
      .then((b) => lc(b.hash)),
  ),
);
if (oneHashes[0] !== oneHashes[1]) throw new Error("ONE_PIN_HASH_DISAGREEMENT");
const bscPin = await selectCommonPin(
  BSC_STATE_SOURCES,
  (url, method, params, timeoutMs) => rpc.call(url, method, params, timeoutMs),
  { ...BSC_PIN_POLICY, witnesses: [BSC_LOGS_WITNESS] },
);
const bscUrls = bscPin.sources.map((s) => s.url);
// 3. verify every candidate on both chains through two sources each
const pairs = [];
const rejected = [];
for (const c of candidates) {
  const oneToken = lc(c.localToken!),
    bscToken = lc(c.remoteToken!);
  const oneReads = await Promise.all(
    ENDPOINTS.one.map(async (u) => ({
      pair: await view<Pair>(
        u,
        G5_ROUTE_PINS.source.proxy,
        "getTokenPair",
        [56n, oneToken],
        oneBlock,
      ),
      finalizePaused: await view<boolean>(
        u,
        G5_ROUTE_PINS.source.proxy,
        "isTokenFinalizePaused",
        [56n, oneToken],
        oneBlock,
      ),
      decimals:
        oneToken === lc(NATIVE)
          ? 18
          : Number(await view<number>(u, oneToken, "decimals", [], oneBlock)),
      symbol:
        oneToken === lc(NATIVE)
          ? "ONE"
          : await view<string>(u, oneToken, "symbol", [], oneBlock),
    })),
  );
  const bscReads = await Promise.all(
    bscUrls.map(async (u) => ({
      pair: await view<Pair>(
        u,
        G5_ROUTE_PINS.destination.proxy,
        "getTokenPair",
        [612055n, bscToken],
        bscPin.block,
      ),
      finalizePaused: await view<boolean>(
        u,
        G5_ROUTE_PINS.destination.proxy,
        "isTokenFinalizePaused",
        [612055n, bscToken],
        bscPin.block,
      ),
      decimals: Number(
        await view<number>(u, bscToken, "decimals", [], bscPin.block),
      ),
      symbol: await view<string>(u, bscToken, "symbol", [], bscPin.block),
    })),
  );
  const agree = (xs: unknown[]) => xs.every((x) => json(x) === json(xs[0]));
  const reasons: string[] = [];
  if (!agree(oneReads)) reasons.push("ONE_SOURCES_DISAGREE");
  if (!agree(bscReads)) reasons.push("BSC_SOURCES_DISAGREE");
  const o = oneReads[0],
    b = bscReads[0];
  if (lc(o.pair.localToken) !== oneToken || lc(o.pair.remoteToken) !== bscToken)
    reasons.push("ONE_REGISTRY_MISMATCH");
  if (lc(b.pair.localToken) !== bscToken || lc(b.pair.remoteToken) !== oneToken)
    reasons.push("BSC_REGISTRY_MISMATCH");
  if (o.decimals !== b.decimals) reasons.push("DECIMALS_DIFFER");
  if (reasons.length) {
    rejected.push({ oneToken, bscToken, reasons });
    continue;
  }
  const g5Verified = oneToken === lc(NATIVE) && bscToken === lc(CROSS);
  pairs.push({
    id: `onebridge:612055:${oneToken}:56:${bscToken}`,
    route: "ONEchain → BNB Smart Chain",
    local: {
      chainId: "612055",
      address: oneToken,
      native: oneToken === lc(NATIVE),
      symbol: String(o.symbol).slice(0, 32),
      decimals: o.decimals,
    },
    remote: {
      chainId: "56",
      address: bscToken,
      native: false,
      symbol: String(b.symbol).slice(0, 32),
      decimals: b.decimals,
    },
    source: {
      isOrigin: o.pair.isOrigin,
      paused: o.pair.paused,
      finalizePaused: o.finalizePaused,
      pendingAmount: o.pair.pendingAmount.toString(),
      deposited: o.pair.deposited.toString(),
      minted: o.pair.minted.toString(),
    },
    destination: {
      isOrigin: b.pair.isOrigin,
      paused: b.pair.paused,
      finalizePaused: b.finalizePaused,
      pendingAmount: b.pair.pendingAmount.toString(),
      deposited: b.pair.deposited.toString(),
      minted: b.pair.minted.toString(),
    },
    // Reserve semantics: an origin-side token is locked on the source; the destination pays out from its own
    // origin reserve (no mint) when the destination side is also an origin registration, otherwise it mints.
    reserveSemantics: b.pair.isOrigin
      ? "Destination releases the remote token from the bridge-held reserve (no mint): delivery is limited by that reserve."
      : "Destination mints the remote token (no reserve limit; mint authority is a trust assumption).",
    g5Verified,
    status: g5Verified ? "VERIFIED_ROUTE" : "REGISTERED_NOT_VERIFIED",
  });
}
const out = {
  version: 1,
  generatedAt: new Date().toISOString(),
  note: "Generated by `pnpm assets:sync:onebridge`. Only pairs confirmed on-chain on both chains by two sources each. Sending stays closed by the global execution gate; only the G5-verified pair has a verified route.",
  candidatesSource: {
    url: "https://bridge-api.crosstoken.io/bridge/pairs",
    sha256: apiSha,
    candidates: candidates.length,
  },
  pins: {
    one: {
      block: oneHead - ONE_PIN_LAG,
      hash: oneHashes[0],
      sources: ENDPOINTS.one.map((u) => new URL(u).host),
    },
    bsc: {
      block: bscPin.number,
      hash: bscPin.hash,
      ageSec: bscPin.ageSec,
      operatorGroups: bscPin.operatorGroups,
      sources: bscUrls.map((u) => new URL(u).host),
    },
  },
  pairs,
  rejected,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + "\n");
writeFileSync(
  join(evidenceDir, "onebridge-rpc-audit.jsonl"),
  audit.map((r) => json(r)).join("\n") + "\n",
);
console.log(
  `onebridge: ${pairs.length} verified registered pairs, ${rejected.length} rejected; ONE ${out.pins.one.block} BSC ${out.pins.bsc.block}`,
);
