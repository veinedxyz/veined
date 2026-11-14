import { SwapError, type SwapIntent } from "../model";
import { CANARY_READ_CONTRACTS, CANARY_RPC_POOL, RPC_ORIGINS } from "./config";
import { assertSwapEgress, providerQuota } from "./egress";
import { OWNER_CANARY_APPROVAL } from "../../security/canary-approval";
const EVM_READ = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_call",
  "eth_estimateGas",
  "eth_simulateV1",
  "eth_getBlockByNumber",
  "eth_gasPrice",
]);
const SOL_READ = new Set([
  "getGenesisHash",
  "getBlockHeight",
  "getLatestBlockhash",
  "isBlockhashValid",
  "getAccountInfo",
  "getMultipleAccounts",
  "getMinimumBalanceForRentExemption",
  "getFeeForMessage",
  "simulateTransaction",
]);
/** No caller URL, redirect, raw upstream error or write RPC can cross this boundary. */
export async function jsonRead(
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<unknown> {
  const origin = assertSwapEgress(url);
  providerQuota.take(origin);
  let r: Response;
  try {
    r = await fetch(url, {
      ...init,
      signal,
      redirect: "error",
      cache: "no-store",
    });
  } catch {
    throw new SwapError(
      signal.aborted ? "PROVIDER_TIMEOUT" : "PROVIDER_UNAVAILABLE",
    );
  }
  if (r.status === 429) providerQuota.throttle(origin);
  if (!r.ok)
    throw new SwapError(
      r.status === 429
        ? "RATE_LIMITED"
        : r.status === 401 || r.status === 403
          ? "CREDENTIAL_REQUIRED"
          : r.status >= 500
            ? "HTTP_5XX"
            : "HTTP_4XX",
    );
  const reader = r.body?.getReader();
  if (!reader) throw new SwapError("INVALID_SCHEMA");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 1_000_000) {
        await reader.cancel();
        throw new SwapError("INVALID_SCHEMA");
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (e) {
    if (e instanceof SwapError) throw e;
    throw new SwapError("INVALID_SCHEMA");
  } finally {
    reader.releaseLock();
  }
}
export async function rpc(
  chain: SwapIntent["chain"],
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  if (!(chain === "solana" ? SOL_READ : EVM_READ).has(method))
    throw new SwapError("EXECUTION_CLOSED");
  const body = await jsonRead(
    RPC_ORIGINS[chain],
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    signal,
  );
  if (
    !body ||
    typeof body !== "object" ||
    !("result" in body) ||
    "error" in body
  )
    throw new SwapError(
      method === "eth_call" ||
        method === "eth_estimateGas" ||
        method === "simulateTransaction"
        ? "SIMULATION_FAILED"
        : "INVALID_SCHEMA",
    );
  return body.result;
}
// ---------------------------------------------------------------------------------------------------------------
// G14 closure (B4 / K4) — the canary's own READ-ONLY capability on this transport.
// It is separate from rpc() above on purpose: the general Swap reads keep exactly their method list and their single
// origin per chain; nothing here widens them. canaryRead() is the ONLY way a canary read leaves the server:
//   - two defined chains (Base 8453, Arbitrum 42161) and, per chain, the two configured operators of CANARY_RPC_POOL
//     (config.ts) — four exact URLs, addressed by chain + index, never by a URL a caller passes;
//   - one frozen method list (CANARY_READ_METHODS): reads only. The canary pool reader imports THIS list, so the two
//     can never drift apart;
//   - every parameter is checked against a narrow shape before anything is sent (canaryReadProblem): pinned contracts
//     only (CANARY_READ_CONTRACTS), an explicit block number (no "pending", no "latest" except where a head is the
//     point of the read), bounded calldata, bounded log range / topics, a bounded simulation with NO state override,
//     and — where a read is about an account — only the account of the protected owner record. With the disarmed
//     record those account reads are refused: the capability cannot be used to look up arbitrary accounts;
//   - the same boundary as every other read: egress allowlist, redirect "error", no-store, the 1 MB response cap, no
//     raw upstream error.
// It is not a proxy: no request field, URL, ABI, contract, slot or method reaches it from a client; its callers are
// the server's own canary modules, which build every parameter from pinned values and server records.
export const CANARY_READ_METHODS: readonly string[] = Object.freeze([
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
]);
export const CANARY_READ_LIMITS = Object.freeze({
  /** eth_getLogs: toBlock - fromBlock at most this many blocks, at most two pinned addresses. */
  maxLogBlockRange: 5_000,
  maxLogAddresses: 2,
  maxTopics: 4,
  maxTopicAlternatives: 2,
  /** eth_call / simulated call data, bytes. */
  maxCallDataBytes: 16_384,
  /** eth_simulateV1: one block, at most this many calls. */
  maxSimulationCalls: 6,
  timeoutMs: 8_000,
});
export type CanaryReadChain = keyof typeof CANARY_RPC_POOL;
const C_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const C_HASH = /^0x[0-9a-fA-F]{64}$/;
const C_BLOCK = /^0x(?:0|[1-9a-f][0-9a-f]{0,15})$/;
const C_QUANTITY = /^0x(?:0|[1-9a-f][0-9a-f]{0,63})$/;
const C_DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const plainObject = (
  v: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): v is Record<string, unknown> => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  if (proto !== Object.prototype && proto !== null) return false;
  const keys = Object.keys(v);
  return (
    required.every((k) => keys.includes(k)) &&
    keys.every((k) => required.includes(k) || optional.includes(k))
  );
};
const pinnedContract = (chain: CanaryReadChain, address: unknown) =>
  typeof address === "string" &&
  C_ADDRESS.test(address) &&
  CANARY_READ_CONTRACTS[chain].some(
    (a) => a.toLowerCase() === address.toLowerCase(),
  );
const approvedAccount = (address: unknown) => {
  const record = OWNER_CANARY_APPROVAL;
  return (
    record !== null &&
    typeof address === "string" &&
    C_ADDRESS.test(address) &&
    address.toLowerCase() === record.account.toLowerCase()
  );
};
const callData = (data: unknown) =>
  typeof data === "string" &&
  C_DATA.test(data) &&
  data.length >= 10 &&
  (data.length - 2) / 2 <= CANARY_READ_LIMITS.maxCallDataBytes;
/**
 * Why this exact read is NOT one the canary may make, or null. Pure; nothing is sent before it returns null.
 * The codes are stable (tests and the safety scan name them).
 */
export function canaryReadProblem(
  chain: unknown,
  index: unknown,
  method: unknown,
  params: unknown,
): string | null {
  if (
    typeof chain !== "string" ||
    !Object.prototype.hasOwnProperty.call(CANARY_RPC_POOL, chain)
  )
    return "CANARY_CHAIN_REFUSED";
  if (index !== 0 && index !== 1) return "CANARY_SOURCE_REFUSED";
  if (typeof method !== "string" || !CANARY_READ_METHODS.includes(method))
    return "CANARY_METHOD_REFUSED";
  if (!Array.isArray(params)) return "CANARY_PARAMS_REFUSED";
  const c = chain as CanaryReadChain;
  const p = params as unknown[];
  const bad = "CANARY_PARAMS_REFUSED";
  const block = (v: unknown) => typeof v === "string" && C_BLOCK.test(v);
  switch (method) {
    case "eth_chainId":
    case "eth_maxPriorityFeePerGas":
      return p.length === 0 ? null : bad;
    case "eth_getBlockByNumber":
      // Headers only (never full transactions): the head, or one explicit number.
      return p.length === 2 &&
        (p[0] === "latest" || block(p[0])) &&
        p[1] === false
        ? null
        : bad;
    case "eth_getCode":
      if (p.length !== 2 || !block(p[1])) return bad;
      return pinnedContract(c, p[0]) ? null : "CANARY_CONTRACT_NOT_PINNED";
    case "eth_getStorageAt":
      if (
        p.length !== 3 ||
        typeof p[1] !== "string" ||
        !C_HASH.test(p[1]) ||
        !block(p[2])
      )
        return bad;
      return pinnedContract(c, p[0]) ? null : "CANARY_CONTRACT_NOT_PINNED";
    case "eth_call": {
      if (p.length !== 2 || !block(p[1]) || !plainObject(p[0], ["to", "data"]))
        return bad;
      if (!callData(p[0].data)) return bad;
      return pinnedContract(c, p[0].to) ? null : "CANARY_CONTRACT_NOT_PINNED";
    }
    case "eth_getBalance":
      if (p.length !== 2 || !block(p[1])) return bad;
      return approvedAccount(p[0]) ? null : "CANARY_ACCOUNT_NOT_APPROVED";
    case "eth_getTransactionCount":
      // The head count is what "was the nonce used?" needs; an explicit block is accepted as well.
      if (p.length !== 2 || !(p[1] === "latest" || block(p[1]))) return bad;
      return approvedAccount(p[0]) ? null : "CANARY_ACCOUNT_NOT_APPROVED";
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt":
      return p.length === 1 && typeof p[0] === "string" && C_HASH.test(p[0])
        ? null
        : bad;
    case "eth_getLogs": {
      if (
        p.length !== 1 ||
        !plainObject(p[0], ["address", "fromBlock", "toBlock", "topics"])
      )
        return bad;
      const f = p[0];
      const addresses = Array.isArray(f.address) ? f.address : [f.address];
      if (
        addresses.length < 1 ||
        addresses.length > CANARY_READ_LIMITS.maxLogAddresses ||
        !block(f.fromBlock) ||
        !block(f.toBlock) ||
        !Array.isArray(f.topics) ||
        f.topics.length < 1 ||
        f.topics.length > CANARY_READ_LIMITS.maxTopics
      )
        return bad;
      const from = BigInt(f.fromBlock as string),
        to = BigInt(f.toBlock as string);
      if (to < from || to - from > BigInt(CANARY_READ_LIMITS.maxLogBlockRange))
        return "CANARY_LOG_RANGE_REFUSED";
      const topic = (t: unknown) => typeof t === "string" && C_HASH.test(t);
      // The event itself (topic 0) is always named: there is no "every log of this contract" read.
      if (!topic(f.topics[0])) return bad;
      for (const t of f.topics.slice(1))
        if (!(
          t === null ||
          topic(t) ||
          (Array.isArray(t) &&
            t.length >= 1 &&
            t.length <= CANARY_READ_LIMITS.maxTopicAlternatives &&
            t.every(topic))
        ))
          return bad;
      return addresses.every((a) => pinnedContract(c, a))
        ? null
        : "CANARY_CONTRACT_NOT_PINNED";
    }
    case "eth_simulateV1": {
      // Base only, one block, a handful of calls from the approved account to pinned contracts, the base fee as the
      // only block override, and no state override of any kind (a simulation that invents balances proves nothing).
      if (c !== "8453") return "CANARY_CHAIN_REFUSED";
      if (
        p.length !== 2 ||
        !block(p[1]) ||
        !plainObject(p[0], ["blockStateCalls", "validation", "traceTransfers"])
      )
        return bad;
      const req = p[0];
      if (
        typeof req.validation !== "boolean" ||
        typeof req.traceTransfers !== "boolean" ||
        !Array.isArray(req.blockStateCalls) ||
        req.blockStateCalls.length !== 1 ||
        !plainObject(req.blockStateCalls[0], ["blockOverrides", "calls"])
      )
        return bad;
      const b = req.blockStateCalls[0] as Record<string, unknown>;
      if (
        !plainObject(b.blockOverrides, ["baseFeePerGas"]) ||
        typeof b.blockOverrides.baseFeePerGas !== "string" ||
        !C_QUANTITY.test(b.blockOverrides.baseFeePerGas) ||
        !Array.isArray(b.calls) ||
        b.calls.length < 1 ||
        b.calls.length > CANARY_READ_LIMITS.maxSimulationCalls
      )
        return bad;
      for (const call of b.calls as unknown[]) {
        if (
          !plainObject(
            call,
            ["from", "to", "data"],
            ["value", "gas", "maxFeePerGas", "maxPriorityFeePerGas"],
          ) ||
          !callData(call.data) ||
          (
            ["value", "gas", "maxFeePerGas", "maxPriorityFeePerGas"] as const
          ).some(
            (k) =>
              call[k] !== undefined &&
              (typeof call[k] !== "string" || !C_QUANTITY.test(call[k])),
          )
        )
          return bad;
        if (!approvedAccount(call.from)) return "CANARY_ACCOUNT_NOT_APPROVED";
        if (!pinnedContract(c, call.to)) return "CANARY_CONTRACT_NOT_PINNED";
      }
      return null;
    }
    default:
      return "CANARY_METHOD_REFUSED";
  }
}
/**
 * One read-only JSON-RPC call of the canary to operator `index` of `chain`. Refused before any network use unless
 * canaryReadProblem() is null. No retry and no fallback to the other operator: the caller sees the failure.
 */
export async function canaryRead(
  chain: CanaryReadChain,
  index: 0 | 1,
  method: string,
  params: unknown[],
  signal: AbortSignal,
): Promise<unknown> {
  const problem = canaryReadProblem(chain, index, method, params);
  if (problem)
    throw Object.assign(new SwapError("EXECUTION_CLOSED"), { reason: problem });
  const body = await jsonRead(
    CANARY_RPC_POOL[chain][index].url,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    },
    AbortSignal.any([
      signal,
      AbortSignal.timeout(CANARY_READ_LIMITS.timeoutMs),
    ]),
  );
  if (
    !body ||
    typeof body !== "object" ||
    !("result" in body) ||
    "error" in body
  )
    throw new SwapError(
      method === "eth_call" || method === "eth_simulateV1"
        ? "SIMULATION_FAILED"
        : "INVALID_SCHEMA",
    );
  return body.result;
}
