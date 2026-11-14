import { z } from "zod";
import { publicData } from "../server/public-data";
import { RoutingError, type Network } from "../routing/model";
import {
  type PortfolioIdentity,
  type PortfolioProvider,
  type Holding,
} from "./model";
const endpoints: Record<string, string> = {
  "1": "https://ethereum-rpc.publicnode.com",
  "56": "https://bsc-dataseed.bnbchain.org",
  "8453": "https://base-rpc.publicnode.com",
  "1151111081099710": "https://solana-rpc.publicnode.com",
};
export const nativeCoverage = Object.keys(endpoints);
export class NativePortfolioProvider implements PortfolioProvider {
  capabilities() {
    return {
      ecosystems: ["EVM", "SVM"],
      fungible: false,
      native: true,
      discovery: false,
    };
  }
  async discoverActivity(identity: PortfolioIdentity) {
    return nativeCoverage.filter((id) =>
      id === "1151111081099710" ? !!identity.solana : !!identity.evm,
    );
  }
  async getBalances(
    n: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ) {
    return this.getNativeBalance(n, identity, signal);
  }
  async getNativeBalance(
    n: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ): Promise<Holding[]> {
    const endpoint = endpoints[n.id],
      address =
        n.ecosystem === "EVM"
          ? identity.evm
          : n.ecosystem === "SVM"
            ? identity.solana
            : undefined;
    if (!endpoint || !address) throw new RoutingError("ADDRESS_MISSING");
    const rpc = async (method: string, params: unknown[]) =>
      z
        .object({
          jsonrpc: z.literal("2.0"),
          id: z.literal(1),
          result: z.unknown(),
        })
        .parse(
          await publicData(endpoint, {
            body: { jsonrpc: "2.0", id: 1, method, params },
            signal,
          }),
        ).result;
    let balance: string;
    if (n.ecosystem === "EVM") {
      const hex = z.string().regex(/^0x[0-9a-f]{1,64}$/i);
      if (BigInt(hex.parse(await rpc("eth_chainId", []))) !== BigInt(n.id))
        throw new RoutingError("CHAIN_MISMATCH");
      balance = BigInt(
        hex.parse(await rpc("eth_getBalance", [address, "latest"])),
      ).toString();
    } else {
      const response = z
        .object({ value: z.number().int().nonnegative().safe() })
        .parse(await rpc("getBalance", [address, { commitment: "finalized" }]));
      balance = String(response.value);
    }
    const at = Date.now();
    return [
      {
        ...n.nativeAsset,
        balance,
        native: true,
        spam: false,
        suspicious: false,
        usd: null,
        priceAt: null,
        observedAt: at,
        logo: "/networks/neutral.svg",
        lastActivity: null,
      },
    ];
  }
}
// V1.4: the paid broad-portfolio indexer adapter was retired from the application. Its truthful
// provenance stays in docs/INTERNAL/V13_PROVIDERS.md; a test-only compatibility copy lives in
// tests/fixtures/legacy-indexer-provider.ts and has no network transport or credential source.
