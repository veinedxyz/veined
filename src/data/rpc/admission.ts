import { z } from "zod";
import { TRANSFER_TOPIC } from "../evm/erc20";
import { admitRpcUrl } from "./url-policy";
import {
  RpcError,
  rpcBatch,
  rpcCall,
  type RpcEndpoint,
  type RpcTransport,
} from "./transport";
import type { ApprovedEndpoint } from "./pool";
export const SOLANA_MAINNET_GENESIS =
  "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d";
export interface Candidate {
  chainId: string;
  ecosystem: "EVM" | "SVM";
  url: string;
  provenance: "curated" | "public-registry" | "operator";
  priority?: number;
}
export interface AdmissionResult {
  chainId: string;
  url: string;
  host: string | null;
  provenance: Candidate["provenance"];
  status: "APPROVED" | "REJECTED";
  reason: string | null;
  latencyMs: number | null;
  latestBlock: string | null;
  supportsLogs: boolean;
  maxLogRange: number;
  supportsBatch: boolean;
  supportsFinalized: boolean;
  supportsSafe: boolean;
  archive: boolean;
  logsPerBlock: number | null;
  checkedAt: number;
}
const quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/);
// Balances are uint256: precompile 0x..01 holds more than 2^64 wei on several chains.
const balanceQuantity = z
  .string()
  .regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/);
const blockShape = z
  .object({ number: quantity, hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/) })
  .passthrough();
const LOG_RANGES = [10, 100, 1000, 5000];
// candidate -> URL policy -> HTTPS -> DNS public IP (transport) -> chainId -> read-only probes -> capability
export async function admit(
  candidate: Candidate,
  transport: RpcTransport,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    logProbe?: boolean;
  } = {},
): Promise<AdmissionResult> {
  const now = options.now ?? Date.now;
  const result: AdmissionResult = {
    chainId: candidate.chainId,
    url: candidate.url,
    host: null,
    provenance: candidate.provenance,
    status: "REJECTED",
    reason: null,
    latencyMs: null,
    latestBlock: null,
    supportsLogs: false,
    maxLogRange: 0,
    supportsBatch: false,
    supportsFinalized: false,
    supportsSafe: false,
    archive: false,
    logsPerBlock: null,
    checkedAt: now(),
  };
  const verdict = admitRpcUrl(candidate.url, {
    allowPort: candidate.provenance !== "public-registry",
  });
  if (!verdict.ok) return { ...result, reason: verdict.reason };
  result.url = verdict.url;
  result.host = verdict.host;
  const endpoint: RpcEndpoint = {
    id: `probe:${verdict.host}`,
    chainId: candidate.chainId,
    url: verdict.url,
    allowPort: candidate.provenance !== "public-registry",
  };
  const opts = { signal: options.signal, timeoutMs: 6000 };
  let step = "identity";
  try {
    if (candidate.ecosystem === "SVM") {
      const started = now();
      const genesis = await rpcCall(
        transport,
        endpoint,
        { method: "getGenesisHash", params: [] },
        { ecosystem: "SVM" },
        opts,
      );
      result.latencyMs = now() - started;
      if (genesis !== SOLANA_MAINNET_GENESIS)
        return { ...result, reason: "CHAIN_MISMATCH" };
      const slot = z
        .number()
        .int()
        .nonnegative()
        .parse(
          await rpcCall(
            transport,
            endpoint,
            { method: "getSlot", params: [{ commitment: "finalized" }] },
            { ecosystem: "SVM" },
            opts,
          ),
        );
      result.latestBlock = String(slot);
      result.supportsFinalized = true;
      return { ...result, status: "APPROVED" };
    }
    const policy = { ecosystem: "EVM" as const, maxLogRange: 5001 };
    const started = now();
    const chain = quantity.parse(
      await rpcCall(
        transport,
        endpoint,
        { method: "eth_chainId", params: [] },
        policy,
        opts,
      ),
    );
    result.latencyMs = now() - started;
    if (BigInt(chain) !== BigInt(candidate.chainId))
      return { ...result, reason: "CHAIN_MISMATCH" };
    step = "head";
    const head = blockShape.parse(
      await rpcCall(
        transport,
        endpoint,
        { method: "eth_getBlockByNumber", params: ["latest", false] },
        policy,
        opts,
      ),
    );
    const latest = BigInt(head.number);
    result.latestBlock = latest.toString();
    step = "balance";
    balanceQuantity.parse(
      await rpcCall(
        transport,
        endpoint,
        {
          method: "eth_getBalance",
          params: ["0x0000000000000000000000000000000000000001", "latest"],
        },
        policy,
        opts,
      ),
    );
    for (const tag of ["finalized", "safe"] as const) {
      try {
        const b = blockShape.parse(
          await rpcCall(
            transport,
            endpoint,
            { method: "eth_getBlockByNumber", params: [tag, false] },
            policy,
            opts,
          ),
        );
        if (BigInt(b.number) <= latest) {
          if (tag === "finalized") result.supportsFinalized = true;
          else result.supportsSafe = true;
        }
      } catch {
        /* Tag unsupported: the chain falls back to its configured confirmation depth. */
      }
    }
    try {
      const items = await rpcBatch(
        transport,
        endpoint,
        [
          { method: "eth_chainId", params: [] },
          { method: "eth_blockNumber", params: [] },
        ],
        policy,
        opts,
      );
      result.supportsBatch =
        items.every((i) => i.ok) &&
        items[0].ok &&
        BigInt(quantity.parse(items[0].value)) === BigInt(candidate.chainId);
    } catch {
      result.supportsBatch = false;
    }
    try {
      await rpcCall(
        transport,
        endpoint,
        {
          method: "eth_getBalance",
          params: ["0x0000000000000000000000000000000000000001", "0x1"],
        },
        policy,
        opts,
      );
      result.archive = true;
    } catch {
      result.archive = false;
    }
    if (options.logProbe !== false)
      for (const range of LOG_RANGES) {
        if (BigInt(range) > latest) break;
        try {
          const logs = z
            .array(z.unknown())
            .max(200000)
            .parse(
              await rpcCall(
                transport,
                endpoint,
                {
                  method: "eth_getLogs",
                  params: [
                    {
                      fromBlock: `0x${(latest - BigInt(range) + 1n).toString(16)}`,
                      toBlock: `0x${latest.toString(16)}`,
                      topics: [TRANSFER_TOPIC],
                    },
                  ],
                },
                policy,
                { ...opts, maxBytes: 8000000, timeoutMs: 10000 },
              ),
            );
          result.supportsLogs = true;
          result.maxLogRange = range;
          result.logsPerBlock = Math.round((logs.length / range) * 100) / 100;
          // Large result sets make wider probes pointless and expensive.
          if (logs.length > 5000) break;
        } catch {
          break;
        }
      }
    return { ...result, status: "APPROVED" };
  } catch (error) {
    return {
      ...result,
      reason: error instanceof RpcError ? error.code : `PROBE_FAILED:${step}`,
    };
  }
}
export function toApproved(
  r: AdmissionResult,
  priority = 100,
): ApprovedEndpoint {
  if (r.status !== "APPROVED" || !r.host) throw Error("NOT_APPROVED");
  return {
    id: `${r.chainId}:${r.host}${new URL(r.url).pathname === "/" ? "" : new URL(r.url).pathname}`,
    chainId: r.chainId,
    url: r.url,
    allowPort: r.provenance !== "public-registry",
    priority,
    supportsLogs: r.supportsLogs,
    maxLogRange: r.maxLogRange,
    supportsBatch: r.supportsBatch,
    supportsFinalized: r.supportsFinalized,
    supportsSafe: r.supportsSafe,
    archive: r.archive,
  };
}
