import { z } from "zod";
import { RoutingError, type Network } from "../../src/routing/model";
import {
  normalizeHoldings,
  type PortfolioIdentity,
  type PortfolioProvider,
} from "../../src/portfolio/model";
// DEPRECATED, TEST-ONLY compatibility copy of the retired V1.3 paid-indexer adapter (historical
// regression of its address/chain binding). No default transport and no environment credential:
// callers must inject both explicitly; the production host allowlist no longer contains its host.
export class IndexerPortfolioProvider implements PortfolioProvider {
  constructor(
    private key: string | undefined,
    private read: (
      url: string,
      options: { token?: string; signal?: AbortSignal },
    ) => Promise<unknown> = async () => {
      throw new RoutingError("LEGACY_TRANSPORT_DISABLED");
    },
  ) {}
  capabilities() {
    return {
      ecosystems: ["EVM"],
      fungible: true,
      native: true,
      discovery: true,
    };
  }
  private async call(path: string, signal?: AbortSignal) {
    if (!this.key) throw new RoutingError("CREDENTIAL_REQUIRED");
    const raw = z.object({ error: z.boolean(), data: z.unknown() }).parse(
      await this.read(`https://api.covalenthq.com/v1/${path}`, {
        token: this.key,
        signal,
      }),
    );
    if (raw.error) throw new RoutingError("PROVIDER_UNAVAILABLE");
    return raw.data;
  }
  async discoverActivity(identity: PortfolioIdentity, signal?: AbortSignal) {
    if (!identity.evm) return [];
    const result = z
      .object({
        address: z.string(),
        items: z
          .array(
            z.object({
              chain_id: z
                .union([
                  z.number().int().safe(),
                  z.string().regex(/^\d{1,18}$/),
                ])
                .transform(String),
              is_testnet: z.boolean().optional(),
            }),
          )
          .max(1000),
      })
      .parse(await this.call(`address/${identity.evm}/activity/`, signal));
    if (result.address.toLowerCase() !== identity.evm.toLowerCase())
      throw new RoutingError("ADDRESS_MISMATCH");
    return [
      ...new Set(
        result.items.filter((c) => !c.is_testnet).map((c) => c.chain_id),
      ),
    ];
  }
  async getNativeBalance(
    n: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ) {
    return (await this.getBalances(n, identity, signal)).filter(
      (h) => h.native,
    );
  }
  async getBalances(
    n: Network,
    identity: PortfolioIdentity,
    signal?: AbortSignal,
  ) {
    if (!identity.evm || n.ecosystem !== "EVM")
      throw new RoutingError("ADDRESS_MISSING");
    const token = z.object({
      contract_address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
      contract_decimals: z.number().int().min(0).max(36),
      contract_name: z.string().max(120).nullable(),
      contract_ticker_symbol: z.string().max(32).nullable(),
      balance: z.string().regex(/^\d{1,78}$/),
      is_native_token: z.boolean(),
      is_spam: z.boolean().optional(),
      quote: z.number().finite().nonnegative().nullable(),
      last_transferred_at: z.string().nullable().optional(),
      type: z.string().optional(),
    });
    const raw = z
      .object({
        address: z.string(),
        chain_id: z
          .union([z.number().int().safe(), z.string()])
          .transform(String),
        updated_at: z.string().datetime(),
        items: z.array(token).max(6000),
      })
      .parse(
        await this.call(
          `${n.id}/address/${identity.evm}/balances_v2/?quote-currency=USD&nft=false&no-spam=false`,
          signal,
        ),
      );
    if (
      raw.address.toLowerCase() !== identity.evm.toLowerCase() ||
      raw.chain_id !== n.id
    )
      throw new RoutingError("PORTFOLIO_BINDING_MISMATCH");
    const at = Date.now(),
      priceAt = Date.parse(raw.updated_at);
    return normalizeHoldings(
      raw.items
        .filter((t) => !/nft|erc721|erc1155/i.test(t.type ?? ""))
        .map((t) => ({
          chainId: n.id,
          address: t.is_native_token
            ? n.nativeAsset.address
            : t.contract_address,
          decimals: t.contract_decimals,
          name: t.contract_name ?? "",
          symbol: t.contract_ticker_symbol ?? "?",
          balance: BigInt(t.balance).toString(),
          native: t.is_native_token,
          spam: t.is_spam ?? false,
          suspicious: !t.contract_name || !t.contract_ticker_symbol,
          usd: t.quote,
          priceAt,
          observedAt: at,
          logo: "/networks/neutral.svg",
          lastActivity:
            t.last_transferred_at &&
            Number.isFinite(Date.parse(t.last_transferred_at))
              ? Date.parse(t.last_transferred_at)
              : null,
        })),
    );
  }
}
