import { z } from "zod";
import type { Catalog, Network } from "../routing/model";

export const chainCapabilitySchema = z.object({
  catalogVisible: z.literal(true),
  portfolio: z.enum(["full", "native-only", "unsupported"]),
  bridge: z.enum(["quoteable", "custom-gated", "unsupported"]),
  swap: z.enum(["quoteable", "unsupported"]),
  wallet: z.enum(["available", "missing"]),
  tvlUsd: z.number().finite().nonnegative().nullable(),
  observedAt: z.number().nonnegative(),
});
export type ChainCapability = z.infer<typeof chainCapabilitySchema>;
export interface ActiveChain {
  id: string;
  name: string;
  chainId: string | null;
  network?: Network;
  capability: ChainCapability;
}
export interface ActiveCatalog {
  chains: ActiveChain[];
  observedAt: number;
  stale: boolean;
  hash: string;
  rejected: number;
  livePositive: number;
}
const row = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[\p{L}\p{N} ._()-]+$/u),
  chainId: z
    .union([
      z.number().int().nonnegative().safe(),
      z.string().regex(/^\d{1,18}$/),
    ])
    .nullable()
    .optional(),
  tvl: z.number().finite(),
  testnet: z.boolean().optional(),
});
const nativeChains = new Set(["1", "56", "8453", "1151111081099710"]);
const aliases: Record<string, string> = {
  binance: "56",
  bsc: "56",
  "binance smart chain": "56",
  ethereum: "1",
  base: "8453",
  solana: "1151111081099710",
  arbitrum: "42161",
  "arbitrum one": "42161",
  polygon: "137",
  "polygon pos": "137",
  optimism: "10",
  bitcoin: "20000000000001",
  sui: "9270000000000000",
  tron: "728126428",
  stellar: "148",
};
// portfolioTiers (V1.4): capability derived from the self-hosted data plane; when absent the
// accepted V1.3 direct-native mapping is used.
export function normalizeActive(
  raw: unknown,
  routes: Catalog,
  observedAt: number,
  hash = "unhashed",
  portfolioTiers?: Map<string, ChainCapability["portfolio"]>,
): ActiveCatalog {
  const rows = z.array(z.unknown()).max(5000).parse(raw),
    map = new Map<string, ActiveChain>();
  let rejected = 0,
    livePositive = 0;
  for (const value of rows) {
    const p = row.safeParse(value);
    if (
      !p.success ||
      p.data.tvl <= 0 ||
      p.data.testnet ||
      /testnet|test net|sepolia|devnet|goerli|holesky/i.test(p.data.name)
    ) {
      rejected++;
      continue;
    }
    livePositive++;
    const c = p.data,
      chainId =
        c.chainId == null
          ? (aliases[c.name.toLowerCase()] ?? null)
          : String(c.chainId);
    const n = routes.networks.find(
      (n) =>
        n.mainnet &&
        (n.id === chainId || n.name.toLowerCase() === c.name.toLowerCase()),
    );
    const canonical = n?.id ?? chainId;
    const id = canonical
      ? `chain:${canonical}`
      : `catalog:${c.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    // A slug that loses its identity is rejected; name collisions never silently select a financial network.
    if (id === "catalog:-" || id === "catalog:") {
      rejected++;
      continue;
    }
    const previous = map.get(id);
    if (previous) {
      previous.capability.tvlUsd = Math.max(
        previous.capability.tvlUsd ?? 0,
        c.tvl,
      );
      continue;
    }
    map.set(id, {
      id,
      name: n?.name ?? c.name,
      chainId: canonical,
      network: n,
      capability: {
        catalogVisible: true,
        portfolio: portfolioTiers
          ? (portfolioTiers.get(canonical ?? "") ?? "unsupported")
          : nativeChains.has(canonical ?? "")
            ? "native-only"
            : "unsupported",
        bridge:
          n && !routes.stale
            ? n.provider === "otherbridge-onebridge"
              ? "custom-gated"
              : "quoteable"
            : "unsupported",
        swap:
          n && !routes.stale && n.provider === "routing-core"
            ? "quoteable"
            : "unsupported",
        wallet: n ? "available" : "missing",
        tvlUsd: c.tvl,
        observedAt,
      },
    });
  }
  for (const n of routes.networks.filter(
    (n) => n.provider === "otherbridge-onebridge",
  )) {
    map.set(`chain:${n.id}`, {
      id: `chain:${n.id}`,
      name: n.name,
      chainId: n.id,
      network: n,
      capability: {
        catalogVisible: true,
        portfolio: "unsupported",
        bridge: "custom-gated",
        swap: "unsupported",
        wallet: "available",
        tvlUsd: map.get(`chain:${n.id}`)?.capability.tvlUsd ?? null,
        observedAt,
      },
    });
  }
  return {
    chains: [...map.values()].sort(
      (a, b) =>
        (b.capability.tvlUsd ?? -1) - (a.capability.tvlUsd ?? -1) ||
        a.id.localeCompare(b.id),
    ),
    observedAt,
    stale: routes.stale,
    hash,
    rejected,
    livePositive,
  };
}
export function catalogDiff(before: ActiveCatalog, after: ActiveCatalog) {
  const a = new Map(before.chains.map((c) => [c.id, c])),
    b = new Map(after.chains.map((c) => [c.id, c]));
  return {
    added: [...b.keys()].filter((id) => !a.has(id)).sort(),
    removedFromFeed: [...a.keys()].filter((id) => !b.has(id)).sort(),
    changed: [...b.keys()]
      .filter(
        (id) =>
          a.has(id) &&
          a.get(id)!.capability.tvlUsd !== b.get(id)!.capability.tvlUsd,
      )
      .sort(),
  };
}
