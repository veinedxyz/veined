// VEINED-FIN-LIVE-20261115-01: the swap lane's OWN read-only JSON-RPC transport (the lane's only chain egress). It is
// separate from the canary/Swap transport (src/swap/server/transport.ts stays byte-identical): per chain exactly TWO
// operators of DIFFERENT organisations, addressed by index — never a URL from a caller. Imported only by ./reads.ts,
// which checks every read against the lane's narrow read shape BEFORE it reaches this module (verify-safety rule 13).
// POST JSON-RPC only; redirect "error"; no-store; a timeout; the response streamed against a 1 MB cap; the JSON-RPC
// envelope checked; no raw upstream error text ever crosses this boundary (stable SwapError codes only).
//
// Operators (D:/vnd/hk1/mc1/evidence/B-matrix A-rpc.json, 2026-11-15; each: reachable, eth_simulateV1 and RECENT
// receipts verified). Base keeps its live-tested pair. publicnode refuses all receipts on Arbitrum and OP Mainnet, so
// those chains use the official operator + dRPC.
// VEINED-MC1 (bridge lane): two more egress functions, both behind ./reads.ts and both with the same protections:
//   laneGetLogs   eth_getLogs through the separate per-chain LOG pool (LANE_LOG_POOL, by index; used by laneGetLogs
//                 ONLY — laneJsonRpc never reaches it and still refuses the method; the swap lane never calls it).
//   laneLifiQuote ONE GET of exactly https://li.quest/v1/quote with a fixed query schema.
import { SwapError } from "../model";

export interface LaneRpcSource {
  operator: string;
  url: string;
}
export const SWAP_LANE_RPC_POOL = Object.freeze({
  "1": Object.freeze([
    Object.freeze({
      operator: "mevblocker-cowdao",
      url: "https://rpc.mevblocker.io",
    }),
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://ethereum-rpc.publicnode.com",
    }),
  ] as const),
  "8453": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://base-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "base-coinbase",
      url: "https://mainnet.base.org",
    }),
  ] as const),
  "42161": Object.freeze([
    Object.freeze({
      operator: "arbitrum-offchain-labs",
      url: "https://arb1.arbitrum.io/rpc",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://arbitrum.drpc.org",
    }),
  ] as const),
  "10": Object.freeze([
    Object.freeze({
      operator: "optimism-op-labs",
      url: "https://mainnet.optimism.io",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://optimism.drpc.org",
    }),
  ] as const),
  "137": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://polygon-bor-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://polygon.drpc.org",
    }),
  ] as const),
  "56": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://bsc-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "48club",
      url: "https://rpc-bsc.48.club",
    }),
  ] as const),
}) satisfies Readonly<Record<string, readonly [LaneRpcSource, LaneRpcSource]>>;
/**
 * VEINED-MC1: the per-chain LOG pool — the two sources laneGetLogs (fill / deposit searches) reads, and nothing else
 * reads. Evidence D:/vnd/hk1/mc1/evidence/B-matrix A-rpc.json + A-rpc-extra.json (2026-11-15, getLogs100UsdcTransfers
 * and the per-range retests): every member answered eth_getLogs over <= 100-block windows; dRPC caps the free tier at
 * 100 blocks (the lane's window). Base: mainnet.base.org refused eth_getLogs ("-32011 request limit reached"), so its
 * log pool is base-rpc.publicnode.com (Allnodes) + base.drpc.org (dRPC), two organisations. Every other chain: the RPC
 * pool itself (each member served eth_getLogs in the evidence).
 */
export const LANE_LOG_POOL = Object.freeze({
  "1": Object.freeze([
    Object.freeze({
      operator: "mevblocker-cowdao",
      url: "https://rpc.mevblocker.io",
    }),
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://ethereum-rpc.publicnode.com",
    }),
  ] as const),
  "8453": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://base-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://base.drpc.org",
    }),
  ] as const),
  "42161": Object.freeze([
    Object.freeze({
      operator: "arbitrum-offchain-labs",
      url: "https://arb1.arbitrum.io/rpc",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://arbitrum.drpc.org",
    }),
  ] as const),
  "10": Object.freeze([
    Object.freeze({
      operator: "optimism-op-labs",
      url: "https://mainnet.optimism.io",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://optimism.drpc.org",
    }),
  ] as const),
  "137": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://polygon-bor-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "drpc",
      url: "https://polygon.drpc.org",
    }),
  ] as const),
  "56": Object.freeze([
    Object.freeze({
      operator: "allnodes-publicnode",
      url: "https://bsc-rpc.publicnode.com",
    }),
    Object.freeze({
      operator: "48club",
      url: "https://rpc-bsc.48.club",
    }),
  ] as const),
}) satisfies Readonly<Record<string, readonly [LaneRpcSource, LaneRpcSource]>>;
/** The two LOG sources of a chain, or null (own entries only). laneGetLogs alone calls it. */
function laneLogPool(
  chainId: unknown,
): readonly [LaneRpcSource, LaneRpcSource] | null {
  return typeof chainId === "string" &&
    Object.prototype.hasOwnProperty.call(LANE_LOG_POOL, chainId)
    ? LANE_LOG_POOL[chainId as keyof typeof LANE_LOG_POOL]
    : null;
}
/** The two sources of a chain, or null (own entries only: no inherited key). */
export function lanePool(
  chainId: unknown,
): readonly [LaneRpcSource, LaneRpcSource] | null {
  return typeof chainId === "string" &&
    Object.prototype.hasOwnProperty.call(SWAP_LANE_RPC_POOL, chainId)
    ? SWAP_LANE_RPC_POOL[chainId as keyof typeof SWAP_LANE_RPC_POOL]
    : null;
}
/** Read-only methods this transport carries (equal to reads.ts SWAP_LANE_READ_METHODS; a unit test keeps them equal). */
export const LANE_TRANSPORT_METHODS: readonly string[] = Object.freeze([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_getBalance",
  "eth_getTransactionCount",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_maxPriorityFeePerGas",
  "eth_simulateV1",
]);
export const LANE_TRANSPORT_LIMITS = Object.freeze({
  maxResponseBytes: 1_000_000,
  timeoutMs: 8_000,
});
/** An exact https URL: no credentials, query, fragment or port (the pool is static; this re-checks its own entries). */
const exactUrl = (raw: string) => {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  return (
    u.protocol === "https:" &&
    !u.username &&
    !u.password &&
    !u.search &&
    !u.hash &&
    !u.port &&
    (u.href === raw || u.href === raw + "/")
  );
};
/** A non-OK HTTP status as a stable code (the upstream body is cancelled unread). */
async function refuseStatus(r: Response): Promise<never> {
  try {
    await r.body?.cancel();
  } catch {
    /* the status decides */
  }
  throw new SwapError(
    r.status === 429
      ? "RATE_LIMITED"
      : r.status === 401 || r.status === 403
        ? "CREDENTIAL_REQUIRED"
        : r.status >= 500
          ? "HTTP_5XX"
          : "HTTP_4XX",
  );
}
/** The response body streamed against the 1 MB cap and parsed as JSON (stable codes only, no upstream text). */
async function cappedJson(r: Response, limit: AbortSignal): Promise<unknown> {
  const reader = r.body?.getReader();
  if (!reader) throw new SwapError("INVALID_SCHEMA");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > LANE_TRANSPORT_LIMITS.maxResponseBytes) {
        await reader.cancel();
        throw new SwapError("INVALID_SCHEMA");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch (e) {
    if (e instanceof SwapError) throw e;
    throw new SwapError(limit.aborted ? "PROVIDER_TIMEOUT" : "INVALID_SCHEMA");
  } finally {
    reader.releaseLock();
  }
}
/** One POST JSON-RPC call to entry `operator` of `pool` (the caller chose the pool and checked the method). */
async function poolRpc(
  pool: readonly [LaneRpcSource, LaneRpcSource] | null,
  operator: 0 | 1,
  method: string,
  params: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  if (!pool || (operator !== 0 && operator !== 1))
    throw new SwapError("EXECUTION_CLOSED");
  if (!Array.isArray(params)) throw new SwapError("REVIEW_REQUIRED");
  const source = pool[operator];
  if (!exactUrl(source.url)) throw new SwapError("REVIEW_REQUIRED");
  const limit = AbortSignal.any([
    signal,
    AbortSignal.timeout(LANE_TRANSPORT_LIMITS.timeoutMs),
  ]);
  let r: Response;
  try {
    r = await fetch(source.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: limit,
    });
  } catch {
    throw new SwapError(
      limit.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
    );
  }
  if (!r.ok) await refuseStatus(r);
  const body = await cappedJson(r, limit);
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    (body as { jsonrpc?: unknown }).jsonrpc !== "2.0" ||
    (body as { id?: unknown }).id !== 1 ||
    !("result" in body) ||
    "error" in body
  )
    throw new SwapError(
      method === "eth_call" || method === "eth_estimateGas"
        ? "SIMULATION_FAILED"
        : "INVALID_SCHEMA",
    );
  return (body as { result: unknown }).result;
}
/**
 * One JSON-RPC call to operator `operator` of chain `chainId`; resolves to the call's `result`. The URL comes only from
 * SWAP_LANE_RPC_POOL by index. No retry and no fallback to the other operator: the caller sees the failure.
 */
export async function laneJsonRpc(
  chainId: string,
  operator: 0 | 1,
  method: string,
  params: readonly unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  if (!lanePool(chainId) || (operator !== 0 && operator !== 1))
    throw new SwapError("EXECUTION_CLOSED");
  if (typeof method !== "string" || !LANE_TRANSPORT_METHODS.includes(method))
    throw new SwapError("EXECUTION_CLOSED");
  return poolRpc(lanePool(chainId), operator, method, params, signal);
}
const HEX_BLOCK = /^0x(0|[1-9a-f][0-9a-f]{0,15})$/;
/**
 * VEINED-MC1 (bridge lane): ONE eth_getLogs call through the chain's LOG pool, by index, with the same protections. Only the
 * filter shape {address, fromBlock, toBlock, topics} with explicit hex blocks and 32-byte topics is carried; ./reads.ts
 * checks the narrow bridge shape (a pinned SpokePool, fixed topics, <= 100 blocks) BEFORE it reaches this module.
 */
export async function laneGetLogs(
  chainId: string,
  operator: 0 | 1,
  filter: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  if (!laneLogPool(chainId) || (operator !== 0 && operator !== 1))
    throw new SwapError("EXECUTION_CLOSED");
  const f = filter as Record<string, unknown> | null;
  if (
    !f ||
    typeof f !== "object" ||
    Array.isArray(f) ||
    Object.keys(f).sort().join(",") !== "address,fromBlock,toBlock,topics" ||
    typeof f.address !== "string" ||
    !/^0x[0-9a-fA-F]{40}$/.test(f.address) ||
    typeof f.fromBlock !== "string" ||
    !HEX_BLOCK.test(f.fromBlock) ||
    typeof f.toBlock !== "string" ||
    !HEX_BLOCK.test(f.toBlock) ||
    !Array.isArray(f.topics) ||
    f.topics.length < 1 ||
    f.topics.length > 4 ||
    !f.topics.every((t) => typeof t === "string" && /^0x[0-9a-f]{64}$/.test(t))
  )
    throw new SwapError("REVIEW_REQUIRED");
  const result = await poolRpc(
    laneLogPool(chainId),
    operator,
    "eth_getLogs",
    [f],
    signal,
  );
  if (!Array.isArray(result)) throw new SwapError("INVALID_SCHEMA");
  return result;
}

// ---- VEINED-MC1 (bridge lane): the ONE LI.FI quote request -----------------------------------------------------------
/** The only LI.FI endpoint the app lane reaches (GET; verify-safety: this URL appears in this file only). */
export const LANE_LIFI_QUOTE_URL = "https://li.quest/v1/quote";
export const LANE_LIFI_LIMITS = Object.freeze({ timeoutMs: 15_000 });
export interface LaneLifiQuoteRequest {
  fromChain: string;
  toChain: string;
  fromToken: string;
  toToken: string;
  fromAmount: string;
  /** from = to = this account (the owner's own). */
  account: string;
}
const QUOTE_KEYS = "account,fromAmount,fromChain,fromToken,toChain,toToken";
/** The query of a quote request in its FIXED schema (every policy value is a constant here, never a caller's). */
export function laneLifiQuery(q: LaneLifiQuoteRequest): string {
  if (
    !q ||
    typeof q !== "object" ||
    Object.keys(q).sort().join(",") !== QUOTE_KEYS ||
    !/^[1-9]\d{0,9}$/.test(q.fromChain) ||
    !/^[1-9]\d{0,9}$/.test(q.toChain) ||
    q.fromChain === q.toChain ||
    !/^0x[0-9a-fA-F]{40}$/.test(q.fromToken) ||
    !/^0x[0-9a-fA-F]{40}$/.test(q.toToken) ||
    !/^[1-9]\d{0,40}$/.test(q.fromAmount) ||
    !/^0x[0-9a-fA-F]{40}$/.test(q.account) ||
    /^0x0{40}$/i.test(q.account)
  )
    throw new SwapError("REVIEW_REQUIRED");
  return new URLSearchParams([
    ["fromChain", q.fromChain],
    ["toChain", q.toChain],
    ["fromToken", q.fromToken],
    ["toToken", q.toToken],
    ["fromAmount", q.fromAmount],
    ["fromAddress", q.account],
    ["toAddress", q.account],
    ["slippage", "0.005"],
    ["order", "CHEAPEST"],
    ["fee", "0"],
    ["allowDestinationCall", "false"],
    ["allowBridges", "across"],
  ]).toString();
}
/**
 * ONE GET of the LI.FI quote for `q`. Same protections as the RPC transport: the exact URL above, the fixed query,
 * redirect "error", no-store, no credentials, a timeout, the 1 MB response cap, a JSON object or a stable SwapError
 * (no raw upstream text). No retry.
 */
export async function laneLifiQuote(
  q: LaneLifiQuoteRequest,
  signal: AbortSignal,
): Promise<unknown> {
  const quoteUrl = `${LANE_LIFI_QUOTE_URL}?${laneLifiQuery(q)}`;
  const limit = AbortSignal.any([
    signal,
    AbortSignal.timeout(LANE_LIFI_LIMITS.timeoutMs),
  ]);
  let r: Response;
  try {
    r = await fetch(quoteUrl, {
      method: "GET",
      headers: { Accept: "application/json" },
      redirect: "error",
      cache: "no-store",
      credentials: "omit",
      signal: limit,
    });
  } catch {
    throw new SwapError(
      limit.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
    );
  }
  if (!r.ok) await refuseStatus(r);
  const body = await cappedJson(r, limit);
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new SwapError("INVALID_SCHEMA");
  return body;
}
