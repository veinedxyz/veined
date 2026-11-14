import { z } from "zod";
import type { Hex } from "viem";
import {
  balanceOfData,
  decodeAggregate3Result,
  decodeDecimals,
  decodeMetadataString,
  decodeUint256,
  encodeAggregate3,
  SELECTORS,
  tokenMetadataFlags,
} from "../evm/erc20";
import { RpcError } from "../rpc/transport";
import type { RpcPool } from "../rpc/pool";
const quantity = z.string().regex(/^0x(0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/);
const hexTag = (b: bigint) => `0x${b.toString(16)}`;
export interface NativeObservation {
  chainId: string;
  balance: bigint;
  nonce: bigint | null;
  block: bigint;
  observedAt: number;
}
// One round trip where batching is vetted: the chain ID check travels with the balance read.
export async function readNative(
  pool: RpcPool,
  wallet: string,
  signal?: AbortSignal,
): Promise<NativeObservation> {
  const options = { signal, timeoutMs: 5000, maxBytes: 20000 };
  if (pool.available((e) => e.supportsBatch)) {
    try {
      const { items, endpoint } = await pool.batch(
        [
          { method: "eth_chainId", params: [] },
          { method: "eth_blockNumber", params: [] },
          { method: "eth_getBalance", params: [wallet, "latest"] },
          { method: "eth_getTransactionCount", params: [wallet, "latest"] },
        ],
        options,
      );
      if (items.slice(0, 3).every((i) => i.ok)) {
        const [chain, block, balance, nonce] = items as {
          ok: true;
          value: unknown;
        }[];
        if (BigInt(quantity.parse(chain.value)) !== BigInt(pool.chainId)) {
          pool.markFailure(endpoint.id, "CHAIN_MISMATCH");
          throw new RpcError("INVALID_RESPONSE", "CHAIN_MISMATCH");
        }
        return {
          chainId: pool.chainId,
          balance: BigInt(quantity.parse(balance.value)),
          nonce: items[3].ok ? BigInt(quantity.parse(nonce.value)) : null,
          block: BigInt(quantity.parse(block.value)),
          observedAt: Date.now(),
        };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      /* Fall back to individual pinned reads below. */
    }
  }
  const { value: chain, endpoint } = await pool.call(
    { method: "eth_chainId", params: [] },
    options,
  );
  if (BigInt(quantity.parse(chain)) !== BigInt(pool.chainId)) {
    pool.markFailure(endpoint.id, "CHAIN_MISMATCH");
    throw new RpcError("INVALID_RESPONSE", "CHAIN_MISMATCH");
  }
  const sameEndpoint = (e: { id: string }) => e.id === endpoint.id;
  const block = BigInt(
    quantity.parse(
      (
        await pool.call(
          { method: "eth_blockNumber", params: [] },
          { ...options, filter: sameEndpoint, attempts: 1 },
        )
      ).value,
    ),
  );
  const balance = BigInt(
    quantity.parse(
      (
        await pool.call(
          { method: "eth_getBalance", params: [wallet, hexTag(block)] },
          { ...options, filter: sameEndpoint, attempts: 1 },
        )
      ).value,
    ),
  );
  return {
    chainId: pool.chainId,
    balance,
    nonce: null,
    block,
    observedAt: Date.now(),
  };
}
export interface TokenBalanceRead {
  token: string;
  balance: bigint | null;
}
// balanceOf for a bounded candidate list at a pinned block; Multicall3 only when its code hash verified.
export async function readTokenBalances(
  pool: RpcPool,
  wallet: string,
  tokens: string[],
  block: bigint,
  multicall: string | null,
  signal?: AbortSignal,
  limits: { batch: number; individual: number; callBudget?: number } = {
    batch: 200,
    individual: 40,
    callBudget: 40,
  },
): Promise<{ reads: TokenBalanceRead[]; unchecked: string[] }> {
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))];
  const reads: TokenBalanceRead[] = [];
  const data = balanceOfData(wallet);
  if (multicall) {
    // A failing batch (gas cap, oversized return, hostile token) is bisected instead of abandoning
    // the remaining candidates; isolated failures become failed reads. Calls are budgeted.
    let budget = limits.callBudget ?? 40;
    const queue: string[][] = [];
    for (let i = 0; i < unique.length; i += limits.batch)
      queue.push(unique.slice(i, i + limits.batch));
    const unchecked: string[] = [];
    while (queue.length) {
      const chunk = queue.shift()!;
      if (budget-- <= 0) {
        unchecked.push(...chunk, ...queue.flat());
        break;
      }
      try {
        const { value } = await pool.call(
          {
            method: "eth_call",
            params: [
              {
                to: multicall,
                data: encodeAggregate3(
                  chunk.map((target) => ({ target, callData: data })),
                ),
              },
              hexTag(block),
            ],
          },
          {
            signal,
            timeoutMs: 8000,
            maxBytes: 2000000,
            policy: { ...pool.policy, multicall, maxInnerCalls: limits.batch },
          },
        );
        const rows = decodeAggregate3Result(value, chunk.length);
        if (!rows) throw new RpcError("INVALID_RESPONSE", "AGGREGATE_SHAPE");
        rows.forEach((r, j) =>
          reads.push({
            token: chunk[j],
            balance: r.success ? decodeUint256(r.returnData) : null,
          }),
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (chunk.length === 1) reads.push({ token: chunk[0], balance: null });
        else
          queue.unshift(
            chunk.slice(0, Math.ceil(chunk.length / 2)),
            chunk.slice(Math.ceil(chunk.length / 2)),
          );
      }
    }
    return { reads, unchecked };
  }
  const individual = unique.slice(0, limits.individual);
  for (const token of individual) {
    if (signal?.aborted) break;
    try {
      const { value } = await pool.call(
        { method: "eth_call", params: [{ to: token, data }, hexTag(block)] },
        { signal, timeoutMs: 5000, maxBytes: 20000, attempts: 2 },
      );
      reads.push({ token, balance: decodeUint256(value) });
    } catch {
      reads.push({ token, balance: null });
    }
  }
  const done = new Set(reads.map((r) => r.token));
  return { reads, unchecked: unique.filter((t) => !done.has(t)) };
}
export interface TokenMetadata {
  token: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
  suspicious: boolean;
}
export async function readMetadata(
  pool: RpcPool,
  tokens: string[],
  multicall: string | null,
  signal?: AbortSignal,
): Promise<TokenMetadata[]> {
  const unique = [...new Set(tokens.map((t) => t.toLowerCase()))].slice(0, 150);
  const selectors = [
    SELECTORS.decimals,
    SELECTORS.symbol,
    SELECTORS.name,
  ] as Hex[];
  const out: TokenMetadata[] = [];
  const finish = (token: string, raw: (unknown | null)[]) => {
    const symbol = decodeMetadataString(raw[1], 32),
      name = decodeMetadataString(raw[2], 120);
    out.push({
      token,
      decimals: decodeDecimals(raw[0]),
      symbol,
      name,
      ...tokenMetadataFlags(symbol, name),
    });
  };
  if (multicall) {
    for (let i = 0; i < unique.length; i += 50) {
      const chunk = unique.slice(i, i + 50);
      const calls = chunk.flatMap((target) =>
        selectors.map((callData) => ({ target, callData })),
      );
      try {
        const { value } = await pool.call(
          {
            method: "eth_call",
            params: [
              { to: multicall, data: encodeAggregate3(calls) },
              "latest",
            ],
          },
          {
            signal,
            timeoutMs: 8000,
            maxBytes: 2000000,
            policy: { ...pool.policy, multicall, maxInnerCalls: 150 },
          },
        );
        const rows = decodeAggregate3Result(value, calls.length);
        if (!rows) throw new RpcError("INVALID_RESPONSE");
        chunk.forEach((token, j) =>
          finish(
            token,
            rows
              .slice(j * 3, j * 3 + 3)
              .map((r) => (r.success ? r.returnData : null)),
          ),
        );
      } catch {
        chunk.forEach((token) => finish(token, [null, null, null]));
      }
    }
    return out;
  }
  for (const token of unique.slice(0, 20)) {
    const raw: (unknown | null)[] = [];
    for (const callData of selectors) {
      try {
        raw.push(
          (
            await pool.call(
              {
                method: "eth_call",
                params: [{ to: token, data: callData }, "latest"],
              },
              { signal, timeoutMs: 5000, maxBytes: 20000, attempts: 1 },
            )
          ).value,
        );
      } catch {
        raw.push(null);
      }
    }
    finish(token, raw);
  }
  return out;
}
