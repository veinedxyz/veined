import type { DataPlane } from "../data/plane";
import { deployments } from "./registry";
import { DefiReader, pinChain } from "./reader";
import { prewarmDeployment } from "./adapters";
import { metadataCacheStats } from "./cache";
// V1.14.1 startup / sync-time metadata prewarm (§23). Per reviewed position chain: one pin, the verified Multicall3,
// the code proofs of every reviewed contract and the deployment-level static identities (prewarmDeployment). Wallet
// state is never read (the reader's wallet is the zero address and no user view is issued). Bounded by a deadline;
// any failure only leaves that fact uncached (the scan proves it again).
const PREWARM_WALLET = "0x0000000000000000000000000000000000000000";
export interface PrewarmReport {
  chains: number;
  deployments: number;
  failed: number;
  elapsedMs: number;
  cache: ReturnType<typeof metadataCacheStats>;
}
export async function prewarmDefiMetadata(
  plane: DataPlane,
  options: {
    chains?: string[];
    deadlineMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<PrewarmReport> {
  const started = Date.now();
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.deadlineMs ?? 60000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const state = await plane.state();
  const chains = [...new Set(deployments.map((d) => d.chainId))].filter(
    (c) => !options.chains || options.chains.includes(c),
  );
  let done = 0,
    failed = 0;
  // Chains in parallel (independent endpoints); deployments of one chain in sequence (bounded load per endpoint).
  await Promise.all(
    chains.map(async (chainId) => {
      const pool = plane.pool(state, chainId);
      if (!pool || pool.available() === 0) return;
      try {
        const pin = await pinChain(pool, signal);
        for (const d of deployments.filter((x) => x.chainId === chainId)) {
          if (signal.aborted) return;
          const reader = new DefiReader(d, PREWARM_WALLET, pin, signal, pool);
          try {
            await reader.codeMany([...new Set(Object.values(d.contracts))]);
            await prewarmDeployment(reader);
            done++;
          } catch {
            failed++;
          }
        }
      } catch {
        failed++;
      }
    }),
  );
  return {
    chains: chains.length,
    deployments: done,
    failed,
    elapsedMs: Date.now() - started,
    cache: metadataCacheStats(),
  };
}
