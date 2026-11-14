import { FakeChain, approved, type FakeLog } from "./fake-chain";
import { MemoryStore } from "../../src/data/store/memory";
import { DataPlane } from "../../src/data/plane";
import { RpcPool } from "../../src/data/rpc/pool";
import { RpcError, type RpcTransport } from "../../src/data/rpc/transport";
import type { ChainRecord } from "../../src/data/registry/chains";
import type { EndpointProvenance } from "../../src/data/registry/rpc-provenance";
import type { DataStore } from "../../src/data/store/types";
// SYNTHETIC_TEST_ONLY: multi-operator RPC harness for log-witness consensus tests. Each host can be
// backed by its own chain view (fork) and can mutate/omit/duplicate/fail its eth_getLogs answers.
export const CHAIN_ID = "910001";
export const wallet = "0x28136a77ec8ba3d918114712a588b4095ba12a6b";
export const other = "0x2222222222222222222222222222222222222222";
export const tokenA = "0xaaaa000000000000000000000000000000000001";
export const tokenB = "0xbbbb000000000000000000000000000000000002";
export interface HostHook {
  chain?: FakeChain;
  logs?: (logs: Record<string, unknown>[], from: bigint, to: bigint) => unknown;
  getLogsError?: (from: bigint, to: bigint) => RpcError | null;
  wrongChainId?: boolean;
  timeout?: boolean;
}
export function chainRecord(id = CHAIN_ID): ChainRecord {
  return {
    chainId: id,
    canonicalId: `eip155:${id}`,
    eip155: id,
    ecosystem: "EVM",
    name: `Synthetic ${id}`,
    mainnet: true,
    native: { symbol: "SYN", name: "Synthetic", decimals: 18 },
    finality: { kind: "finalized-tag", depth: 20 },
    configuredTier: "FULL_INDEXED",
    indexStartBlocks: 120,
    tokenEventModel: "erc20-transfer",
    enabled: true,
    tvlUsd: 1000,
    routable: false,
    sources: ["tvl-catalog"],
  };
}
export const defaultLogs = (n: bigint): FakeLog[] =>
  n % 7n === 0n
    ? [
        { token: tokenA, from: other, to: wallet, value: 5n },
        { token: tokenB, from: wallet, to: other, value: 1n },
      ]
    : [{ token: tokenA, from: other, to: other, value: n }];
export function makeChain(blocks = 200, salt = "a", logs = defaultLogs) {
  const c = new FakeChain(CHAIN_ID, salt);
  c.mine(blocks, logs);
  return c;
}
export async function witnessHarness(input: {
  hosts: {
    host: string;
    operator: string | null;
    maxLogRange?: number;
    eligible?: boolean;
  }[];
  chain?: FakeChain;
  store?: DataStore;
}) {
  const main = input.chain ?? makeChain();
  const hooks = new Map<string, HostHook>();
  const calls = new Map<string, number>();
  const transport: RpcTransport = async (endpoint, body, options) => {
    const host = new URL(endpoint.url).host;
    calls.set(host, (calls.get(host) ?? 0) + 1);
    const hook = hooks.get(host) ?? {};
    if (options.signal?.aborted) throw new RpcError("TIMEOUT");
    if (hook.timeout) throw new RpcError("TIMEOUT");
    const chain = hook.chain ?? main;
    const one = (req: { id: number; method: string; params: unknown[] }) => {
      if (req.method === "eth_chainId" && hook.wrongChainId)
        return { jsonrpc: "2.0", id: req.id, result: "0x1" };
      if (req.method === "eth_getLogs") {
        const f = req.params[0] as { fromBlock: string; toBlock: string };
        const from = BigInt(f.fromBlock),
          to = BigInt(f.toBlock);
        const err = hook.getLogsError?.(from, to);
        if (err) throw err;
        let result: unknown = chain.handle(req.method, req.params, {
          maxRange: undefined,
        });
        if (hook.logs)
          result = hook.logs(
            (result as Record<string, unknown>[]).map((l) => ({ ...l })),
            from,
            to,
          );
        return { jsonrpc: "2.0", id: req.id, result };
      }
      try {
        return {
          jsonrpc: "2.0",
          id: req.id,
          result: chain.handle(req.method, req.params, {}),
        };
      } catch (error) {
        return { jsonrpc: "2.0", id: req.id, error };
      }
    };
    if (Array.isArray(body)) return body.map(one);
    return one(body as { id: number; method: string; params: unknown[] });
  };
  const store = input.store ?? new MemoryStore();
  await store.upsertChains([chainRecord()]);
  let priority = 10;
  const operators = new Map<
    string,
    { operator: string | null; eligible: boolean }
  >();
  for (const h of input.hosts) {
    await store.upsertEndpoint(
      approved(CHAIN_ID, h.host, { maxLogRange: h.maxLogRange ?? 1000 }),
      priority,
    );
    priority += 10;
    operators.set(h.host, {
      operator: h.operator,
      eligible: h.eligible ?? true,
    });
  }
  const resolve = (url: string): EndpointProvenance => {
    const o = operators.get(new URL(url).host);
    return {
      operatorGroup: o?.operator ?? null,
      reviewStatus: "UNKNOWN",
      witnessEligible: !!o?.operator && (o?.eligible ?? false),
      releaseAllowed: false,
    };
  };
  const plane = new DataPlane(
    store,
    transport,
    0,
    undefined,
    resolve,
    "development",
  );
  const state = await plane.state();
  return {
    main,
    hooks,
    calls,
    store,
    plane,
    state,
    // Fixed clock: deterministic ranking (primary = first host, witness = second, tiebreak = third).
    pool: new RpcPool(
      CHAIN_ID,
      { ecosystem: "EVM", multicall: null, maxLogRange: 10001 },
      state.endpoints.get(CHAIN_ID) ?? [],
      transport,
      new Map(),
      () => 1_700_000_000_000,
    ),
    record: state.chains.find((c) => c.chainId === CHAIN_ID)!,
  };
}
// A fork of `base` from block `from` with different hashes (and optionally different logs).
export function forkOf(base: FakeChain, from: bigint, salt = "fork") {
  const fork = new FakeChain(CHAIN_ID, "a");
  fork.blocks = base.blocks.map((b) => ({ ...b, logs: [...b.logs] }));
  fork.reorg(from, salt, (n) => base.blocks[Number(n)]?.logs ?? []);
  return fork;
}
