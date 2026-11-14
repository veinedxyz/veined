import { z } from "zod";
import { neutralToolName } from "../content/public-labels";
import { sanitizeText } from "../data/core/sanitize";
import assets from "./generated-assets.json" with { type: "json" };
import {
  RoutingError,
  type Asset,
  type Catalog,
  type Network,
  type ThemeTokens,
  type Tool,
} from "./model";
const id = z
  .union([
    z.string().regex(/^\d{1,18}$/),
    z.number().nonnegative().refine(Number.isInteger),
  ])
  .transform(String);
// Upstream display text is bounded plain text: bidi/zero-width/control characters are removed so
// a compromised list cannot visually spoof another token (React already prevents HTML).
const display = (limit: number, fallback: string) =>
  z
    .string()
    .max(limit)
    .transform((v) => sanitizeText(v, limit) || fallback);
export const assetSchema = z.object({
  chainId: id,
  address: z.string().min(1).max(128),
  symbol: z.string().min(1).max(32).pipe(display(32, "?")),
  name: z.string().max(120).default("").pipe(display(120, "")),
  decimals: z.number().int().min(0).max(36),
});
const chainSchema = z.object({
  id,
  key: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  name: z.string().min(1).max(120).pipe(display(120, "?")),
  chainType: z.enum(["EVM", "SVM", "UTXO", "MVM", "TVM", "STL"]),
  mainnet: z.boolean(),
  nativeToken: assetSchema,
});
export { oneNetwork, initialBsc } from "./custom";
import { oneNetwork, initialBsc } from "./custom";
export const neutralTheme: ThemeTokens = {
  logo: "/networks/neutral.svg",
  primary: "#90938d",
  accent: "#b7baaf",
  glow: "144 147 141",
  badgeDark: "#d0d1cc",
  badgeLight: "#43453f",
  logoSurface: "transparent",
  provenance: "Neutral geometry; reviewed asset unavailable",
};
export function normalizeChains(raw: unknown): Network[] {
  const parsed = z
    .object({ chains: z.array(chainSchema).min(1).max(400) })
    .parse(raw);
  const map = new Map<string, Network>();
  for (const c of parsed.chains) {
    if (map.has(c.id) || c.nativeToken.chainId !== c.id)
      throw new RoutingError("INVALID_CATALOG");
    const theme = (assets as Record<string, ThemeTokens>)[c.id] ?? neutralTheme;
    map.set(c.id, {
      id: c.id,
      key: c.key,
      name: c.name,
      ecosystem: c.chainType,
      mainnet: c.mainnet,
      nativeAsset: c.nativeToken,
      provider: "routing-core",
      theme: c.key === "bsc" ? initialBsc.theme : theme,
    });
  }
  // Explicit custom registry overrides collisions, never masquerades as upstream.
  map.set(oneNetwork.id, oneNetwork);
  return [...map.values()];
}
export function normalizeTools(raw: unknown): Tool[] {
  const schema = z
    .array(
      z.object({
        key: z.string().min(1).max(120),
        name: z.string().min(1).max(120),
      }),
    )
    .max(1000);
  const p = z.object({ bridges: schema, exchanges: schema }).parse(raw);
  return [
    ...p.bridges.map((t) => ({
      id: t.key,
      name: neutralToolName(t.name),
      kind: "bridge" as const,
    })),
    ...p.exchanges.map((t) => ({
      id: t.key,
      name: neutralToolName(t.name),
      kind: "exchange" as const,
    })),
  ];
}
export function requirePair(
  catalog: Catalog,
  source: string,
  destination: string,
  mode: "bridge" | "swap" = "bridge",
) {
  if (catalog.stale) throw new RoutingError("STALE_CATALOG");
  const from = catalog.networks.find((n) => n.id === source),
    to = catalog.networks.find((n) => n.id === destination);
  if (!from || !to) throw new RoutingError("UNSUPPORTED_NETWORK");
  if (source === destination && mode !== "swap")
    throw new RoutingError("SAME_CHAIN_DISABLED");
  if (mode === "swap" && source !== destination)
    throw new RoutingError("INVALID_SWAP_CHAIN");
  if (
    from.provider === "otherbridge-onebridge" ||
    to.provider === "otherbridge-onebridge"
  )
    throw new RoutingError("CUSTOM_ROUTE_NOT_EXECUTABLE_G5");
  if (!from.mainnet || !to.mainnet)
    throw new RoutingError("TESTNET_ROUTING_DISABLED");
  return { from, to };
}
export function normalizeAssets(raw: unknown, chainId: string): Asset[] {
  return z
    .array(z.unknown())
    .max(15000)
    .parse(raw)
    .flatMap((value) => {
      const parsed = assetSchema.safeParse(value);
      return parsed.success && parsed.data.chainId === chainId
        ? [parsed.data]
        : [];
    });
}
