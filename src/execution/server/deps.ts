// G13: production read-only dependencies of the execution review. Every read goes through an existing reviewed path
// (unchanged): the routing adapter (catalog + quotes), the asset registry, and the Swap server's RPC transport, whose
// method allowlist only permits reads (eth_call, eth_blockNumber …). One RPC origin per chain is configured there,
// so balances come from a SINGLE source: the preflight then keeps the balance check UNKNOWN (two independent sources
// must agree) — an honest gap, listed in the protected change proposal, not papered over.
import {
  encodeFunctionData,
  decodeFunctionResult,
  erc20Abi,
  parseAbi,
  type Hex,
} from "viem";
import { routingCore } from "../../adapters/routing-core";
import { knownAsset } from "../../assets/registry";
import { rpc } from "../../swap/server/transport";
import type { ReviewDeps } from "./review";

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const multicallAbi = parseAbi([
  "function getEthBalance(address) view returns (uint256)",
]);
const ZERO = "0x0000000000000000000000000000000000000000";
type RpcChain = "1" | "56" | "8453";
const RPC_CHAINS: readonly string[] = ["1", "56", "8453"];

async function call(
  chain: string,
  to: string,
  data: Hex,
  signal?: AbortSignal,
): Promise<Hex | null> {
  if (!RPC_CHAINS.includes(chain)) return null;
  const out = await rpc(
    chain as RpcChain,
    "eth_call",
    [{ to, data }, "latest"],
    signal ?? AbortSignal.timeout(8000),
  );
  return typeof out === "string" && /^0x[0-9a-fA-F]*$/.test(out)
    ? (out as Hex)
    : null;
}
export const reviewDeps: ReviewDeps = {
  now: () => Date.now(),
  catalog: (signal) => routingCore.listNetworks(signal),
  quotes: (input, signal) => routingCore.getQuotes(input, signal),
  evidence: (chainId, address, native) => {
    const a = knownAsset(chainId, address, native);
    return a
      ? {
          chainId: a.chainId,
          address: a.address,
          symbol: a.symbol,
          decimals: a.decimals,
          level: a.level,
          risk: a.risk,
          coingeckoId: a.coingeckoId,
        }
      : null;
  },
  balances: async (chainId, account, token, signal) => {
    const native = token.toLowerCase() === ZERO;
    const out = native
      ? await call(
          chainId,
          MULTICALL3,
          encodeFunctionData({
            abi: multicallAbi,
            functionName: "getEthBalance",
            args: [account as Hex],
          }),
          signal,
        )
      : await call(
          chainId,
          token,
          encodeFunctionData({
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [account as Hex],
          }),
          signal,
        );
    if (!out || out === "0x") return [];
    const v = native
      ? decodeFunctionResult({
          abi: multicallAbi,
          functionName: "getEthBalance",
          data: out,
        })
      : decodeFunctionResult({
          abi: erc20Abi,
          functionName: "balanceOf",
          data: out,
        });
    return [String(v)];
  },
  allowance: async (chainId, owner, token, spender, signal) => {
    const out = await call(
      chainId,
      token,
      encodeFunctionData({
        abi: erc20Abi,
        functionName: "allowance",
        args: [owner as Hex, spender as Hex],
      }),
      signal,
    );
    return out && out !== "0x"
      ? String(
          decodeFunctionResult({
            abi: erc20Abi,
            functionName: "allowance",
            data: out,
          }),
        )
      : null;
  },
};
