import { keccak256, type Hex } from "viem";
import type { RpcPool } from "../rpc/pool";
// Canonical Multicall3 deterministic deployment. Runtime keccak observed identical on chains
// 1/10/56/8453/42161 on 2026-10-04 (evidence rpc/multicall3-codehash.json). Any other code => unused.
export const MULTICALL3 = "0xca11bde05977b3631167028862be2a173976ca11";
export const MULTICALL3_CODEHASH =
  "0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891";
export interface MulticallVerification {
  address: string | null;
  codeHash: string | null;
  verified: boolean;
  observedAt: number;
}
export async function verifyMulticall(
  pool: RpcPool,
  signal?: AbortSignal,
): Promise<MulticallVerification> {
  const observedAt = Date.now();
  try {
    const { value } = await pool.call(
      { method: "eth_getCode", params: [MULTICALL3, "latest"] },
      { signal, timeoutMs: 6000, maxBytes: 200000 },
    );
    if (
      typeof value !== "string" ||
      !/^0x([0-9a-fA-F]{2})*$/.test(value) ||
      value === "0x"
    )
      return { address: null, codeHash: null, verified: false, observedAt };
    const codeHash = keccak256(value as Hex);
    const verified = codeHash === MULTICALL3_CODEHASH;
    return {
      address: verified ? MULTICALL3 : null,
      codeHash,
      verified,
      observedAt,
    };
  } catch {
    return { address: null, codeHash: null, verified: false, observedAt };
  }
}
