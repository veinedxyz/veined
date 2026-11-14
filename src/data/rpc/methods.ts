import { z } from "zod";
import type { Hex } from "viem";
import { SELECTORS, TRANSFER_TOPIC, decodeAggregate3Calls } from "../evm/erc20";
// Read-only JSON-RPC allowlist for admitted data-plane endpoints. Everything else fails closed.
export interface RpcCall {
  method: string;
  params: unknown[];
}
export interface CallPolicy {
  ecosystem: "EVM" | "SVM";
  multicall?: string | null;
  maxLogRange?: number;
  maxInnerCalls?: number;
  /** Server-built exact read capability. Never accepted from API input. */
  defiViews?: readonly { to: string; data: string }[];
  defiLog?: { address: string; topic: string };
}
export class RpcPolicyError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "RpcPolicyError";
  }
}
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const topic = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,15})$/);
const tag = z.union([z.enum(["latest", "finalized", "safe"]), quantity]);
const base58 = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
export const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const SPL_TOKEN_2022_PROGRAM =
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const view = new Set<string>([
  SELECTORS.decimals,
  SELECTORS.symbol,
  SELECTORS.name,
]);
function allowedView(data: string): boolean {
  const d = data.toLowerCase();
  if (view.has(d)) return true;
  return (
    d.startsWith(SELECTORS.balanceOf) && /^0x70a082310{24}[0-9a-f]{40}$/.test(d)
  );
}
const ethCall = z
  .tuple([
    z
      .object({ to: address, data: z.string().regex(/^0x[0-9a-fA-F]{8,}$/) })
      .strict(),
    tag,
  ])
  .readonly();
const logFilter = z
  .object({
    fromBlock: quantity,
    toBlock: quantity,
    address: z.union([address, z.array(address).min(1).max(500)]).optional(),
    topics: z
      .array(z.union([topic, z.null(), z.array(topic).min(1).max(100)]))
      .min(1)
      .max(3),
  })
  .strict();
export function assertAllowed(call: RpcCall, policy: CallPolicy): void {
  const { method, params } = call;
  const ok = (schema: z.ZodType) => schema.safeParse(params).success;
  if (policy.ecosystem === "SVM") {
    const commitment = z
      .object({ commitment: z.literal("finalized") })
      .strict();
    if (method === "getGenesisHash" && ok(z.tuple([]))) return;
    if (method === "getSlot" && ok(z.tuple([commitment]))) return;
    if (method === "getBalance" && ok(z.tuple([base58, commitment]))) return;
    if (
      method === "getTokenAccountsByOwner" &&
      ok(
        z.tuple([
          base58,
          z
            .object({
              programId: z.enum([SPL_TOKEN_PROGRAM, SPL_TOKEN_2022_PROGRAM]),
            })
            .strict(),
          z
            .object({
              encoding: z.literal("jsonParsed"),
              commitment: z.literal("finalized"),
            })
            .strict(),
        ]),
      )
    )
      return;
    throw new RpcPolicyError("RPC_METHOD_REJECTED");
  }
  if (
    (method === "eth_chainId" || method === "eth_blockNumber") &&
    ok(z.tuple([]))
  )
    return;
  if (method === "eth_getBlockByNumber" && ok(z.tuple([tag, z.literal(false)])))
    return;
  if (
    ["eth_getBalance", "eth_getTransactionCount", "eth_getCode"].includes(
      method,
    ) &&
    ok(z.tuple([address, tag]))
  )
    return;
  if (method === "eth_call") {
    const parsed = ethCall.safeParse(params);
    if (!parsed.success) throw new RpcPolicyError("RPC_CALL_REJECTED");
    const { to, data } = parsed.data[0];
    if (
      policy.defiViews?.some(
        (c) =>
          c.to.toLowerCase() === to.toLowerCase() &&
          c.data.toLowerCase() === data.toLowerCase(),
      )
    )
      return;
    if (allowedView(data)) return;
    if (
      policy.multicall &&
      to.toLowerCase() === policy.multicall.toLowerCase() &&
      data.toLowerCase().startsWith(SELECTORS.aggregate3)
    ) {
      let inner: readonly {
        target: string;
        allowFailure: boolean;
        callData: string;
      }[];
      try {
        inner = decodeAggregate3Calls(data as Hex);
      } catch {
        throw new RpcPolicyError("RPC_CALL_REJECTED");
      }
      if (
        inner.length >= 1 &&
        inner.length <= (policy.maxInnerCalls ?? 500) &&
        inner.every(
          (c) =>
            c.allowFailure &&
            address.safeParse(c.target).success &&
            c.target.toLowerCase() !== policy.multicall!.toLowerCase() &&
            // V1.14: an inner call may also be an exact server-built DeFi view capability (target + calldata).
            (allowedView(c.callData) ||
              !!policy.defiViews?.some(
                (v) =>
                  v.to.toLowerCase() === c.target.toLowerCase() &&
                  v.data.toLowerCase() === c.callData.toLowerCase(),
              )),
        )
      )
        return;
    }
    throw new RpcPolicyError("RPC_CALL_REJECTED");
  }
  if (method === "eth_getLogs") {
    const parsed = z.tuple([logFilter]).safeParse(params);
    if (!parsed.success) throw new RpcPolicyError("RPC_LOGS_REJECTED");
    const f = parsed.data[0];
    const range = BigInt(f.toBlock) - BigInt(f.fromBlock);
    if (
      (f.topics[0] !== TRANSFER_TOPIC &&
        !(
          policy.defiLog &&
          f.address === policy.defiLog.address &&
          f.topics[0] === policy.defiLog.topic
        )) ||
      range < 0n ||
      range >= BigInt(policy.maxLogRange ?? 10000)
    )
      throw new RpcPolicyError("RPC_LOGS_REJECTED");
    return;
  }
  throw new RpcPolicyError("RPC_METHOD_REJECTED");
}
