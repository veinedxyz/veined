import { z } from "zod";
import { tierSchema, lowerTier, type Tier } from "../core/coverage";
import type { Ecosystem, Network } from "../../routing/model";
import tiersFile from "./tiers.json" with { type: "json" };
const finalitySchema = z
  .object({
    kind: z.enum(["finalized-tag", "safe-tag", "depth"]),
    depth: z.number().int().min(0).max(100000),
  })
  .strict();
export type FinalityPolicy = z.infer<typeof finalitySchema>;
const chainIdText = z.string().regex(/^\d{1,18}$/);
export const tierConfigSchema = z
  .object({
    version: z.literal(1),
    note: z.string().max(2000).optional(),
    fullIndexed: z.array(chainIdText).max(64),
    fullIndexedStart: z
      .object({
        kind: z.literal("recent-window"),
        blocks: z.number().int().min(1).max(5000000),
      })
      .strict(),
    finality: z
      .record(z.string().regex(/^(default|\d{1,18})$/), finalitySchema)
      .refine((v) => "default" in v),
    disabled: z.array(chainIdText).max(1000),
    nonEvmPortfolio: z.record(chainIdText, tierSchema),
    selection: z.unknown().optional(),
  })
  .strict();
export type TierConfig = z.infer<typeof tierConfigSchema>;
export const defaultTierConfig: TierConfig = tierConfigSchema.parse(tiersFile);
export interface ChainRecord {
  chainId: string;
  canonicalId: string;
  eip155: string | null;
  ecosystem: Ecosystem | "UNKNOWN";
  name: string;
  mainnet: boolean;
  native: { symbol: string; name: string; decimals: number };
  finality: FinalityPolicy;
  configuredTier: Tier;
  indexStartBlocks: number | null;
  tokenEventModel: "erc20-transfer" | "spl-token-accounts" | null;
  enabled: boolean;
  tvlUsd: number | null;
  routable: boolean;
  sources: ("tvl-catalog" | "routing-catalog" | "custom")[];
}
export interface ActiveRow {
  name: string;
  chainId: string | null;
  tvlUsd: number | null;
  symbol?: string | null;
  /** The TVL catalog's gas-token market id ("ethereum" = the network pays gas in ETH). */
  gasToken?: string | null;
}
const canonical: Record<string, string> = {
  "1151111081099710": "solana:mainnet",
  "20000000000001": "bip122:bitcoin",
  "20000000000005": "bip122:zcash",
  "9270000000000000": "sui:mainnet",
  "728126428": "tron:mainnet",
  "1201081091099710": "stellar:pubnet",
};
const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
// Deterministic registry from the accepted TVL catalog, routing catalog and custom networks.
export function buildRegistry(
  routing: Network[],
  active: ActiveRow[],
  config: TierConfig = defaultTierConfig,
): ChainRecord[] {
  const out = new Map<string, ChainRecord>();
  const finality = (id: string) =>
    config.finality[id] ?? config.finality.default;
  const add = (
    id: string,
    name: string,
    source: ChainRecord["sources"][number],
    network?: Network,
    tvl: number | null = null,
    symbol: string | null = null,
    gasToken: string | null = null,
  ) => {
    const previous = out.get(id);
    if (previous) {
      if (!previous.sources.includes(source)) previous.sources.push(source);
      if (tvl !== null) previous.tvlUsd = Math.max(previous.tvlUsd ?? 0, tvl);
      return;
    }
    const numeric = /^\d{1,18}$/.test(id);
    const ecosystem: ChainRecord["ecosystem"] = network
      ? network.ecosystem
      : numeric
        ? canonical[id]
          ? "UNKNOWN"
          : "EVM"
        : "UNKNOWN";
    const evm = ecosystem === "EVM" && numeric;
    const custom = network?.provider === "otherbridge-onebridge";
    const nonEvm = config.nonEvmPortfolio[id];
    let tier: Tier = "CATALOG_ONLY";
    if (config.disabled.includes(id) || custom) tier = "CATALOG_ONLY";
    else if (evm)
      tier = config.fullIndexed.includes(id)
        ? "FULL_INDEXED"
        : "ON_DEMAND_FUNGIBLE";
    else if (nonEvm) tier = nonEvm;
    out.set(id, {
      chainId: id,
      canonicalId: canonical[id] ?? (evm ? `eip155:${id}` : `catalog:${id}`),
      eip155: evm ? id : null,
      ecosystem,
      name,
      mainnet: network?.mainnet ?? true,
      native: network
        ? {
            symbol: network.nativeAsset.symbol,
            name: network.nativeAsset.name,
            decimals: network.nativeAsset.decimals,
          }
        : {
            // TVL catalog gas-token symbol is display metadata only (bounded, plain text). G13 (VBA-P1-05): an EVM
            // network whose catalog gas token is ETH is named ETH, not its governance token (MANTA, ZRC, OP ...).
            symbol:
              evm && gasToken === "ethereum"
                ? "ETH"
                : symbol && /^[A-Za-z0-9.$-]{1,16}$/.test(symbol)
                  ? symbol
                  : "?",
            name: "",
            decimals: 18,
          },
      finality: finality(id),
      configuredTier: tier,
      indexStartBlocks:
        tier === "FULL_INDEXED" ? config.fullIndexedStart.blocks : null,
      tokenEventModel: evm
        ? "erc20-transfer"
        : ecosystem === "SVM"
          ? "spl-token-accounts"
          : null,
      enabled: !config.disabled.includes(id),
      tvlUsd: tvl,
      routable: network?.provider === "routing-core" && network.mainnet,
      sources: [source],
    });
  };
  for (const n of routing.filter((n) => n.mainnet))
    add(
      n.id,
      n.name,
      n.provider === "otherbridge-onebridge" ? "custom" : "routing-catalog",
      n,
    );
  for (const row of active) {
    const network = routing.find((n) => n.id === row.chainId);
    if (row.chainId)
      add(
        row.chainId,
        network?.name ?? row.name,
        "tvl-catalog",
        network,
        row.tvlUsd,
        row.symbol ?? null,
        row.gasToken ?? null,
      );
    else
      add(
        `catalog:${slug(row.name)}`,
        row.name,
        "tvl-catalog",
        undefined,
        row.tvlUsd,
      );
  }
  return [...out.values()]
    .filter((c) => c.chainId !== "catalog:")
    .sort(
      (a, b) =>
        (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1) ||
        a.chainId.localeCompare(b.chainId),
    );
}
// Effective tier: the configured ceiling lowered by what vetted infrastructure can actually serve now.
export function effectiveTier(
  chain: ChainRecord,
  capability: {
    healthyRpc: boolean;
    logs: boolean;
    tokenUniverse: boolean;
    indexStarted: boolean;
  },
): Tier {
  if (!chain.enabled || chain.ecosystem === "UNKNOWN") return "CATALOG_ONLY";
  if (!capability.healthyRpc) return "CATALOG_ONLY";
  let ceiling: Tier = chain.configuredTier;
  if (chain.ecosystem === "EVM") {
    if (
      !capability.tokenUniverse &&
      !(capability.logs && capability.indexStarted)
    )
      ceiling = lowerTier(ceiling, "NATIVE_ONLY");
    if (!(capability.logs && capability.indexStarted))
      ceiling = lowerTier(ceiling, "ON_DEMAND_FUNGIBLE");
  }
  return ceiling;
}
