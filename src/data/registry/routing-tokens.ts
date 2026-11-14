import { z } from "zod";
import { sanitizeText, suspiciousText } from "../core/sanitize";
import { derivedPrice, type PriceEvidence } from "../core/price";
// Routable token universe and derived prices from the existing approved read-only routing adapter.
// It is quote infrastructure already in use, not a paid portfolio/indexer API.
const token = z
  .object({
    address: z.string().min(1).max(128),
    symbol: z.string().max(64),
    name: z.string().max(200).optional(),
    decimals: z.number().int().min(0).max(36),
    priceUSD: z
      .union([z.string().max(40), z.number()])
      .optional()
      .nullable(),
  })
  .passthrough();
export interface UniverseToken {
  chainId: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  suspicious: boolean;
  price: PriceEvidence;
}
export function normalizeRoutingTokens(
  raw: unknown,
  chainId: string,
  observedAt: number,
): UniverseToken[] {
  const list = (raw as { tokens?: Record<string, unknown> })?.tokens?.[chainId];
  const rows = z.array(z.unknown()).max(20000).safeParse(list);
  if (!rows.success) return [];
  const out = new Map<string, UniverseToken>();
  for (const value of rows.data) {
    const p = token.safeParse(value);
    if (!p.success) continue;
    const evm = /^0x[0-9a-fA-F]{40}$/.test(p.data.address);
    const address = evm ? p.data.address.toLowerCase() : p.data.address;
    if (out.has(address)) continue;
    const symbol = sanitizeText(p.data.symbol, 32),
      name = sanitizeText(p.data.name ?? "", 120);
    out.set(address, {
      chainId,
      address,
      symbol: symbol || "?",
      name,
      decimals: p.data.decimals,
      suspicious: !symbol || suspiciousText(symbol, name),
      price: derivedPrice(p.data.priceUSD, observedAt, "routing-token-list"),
    });
  }
  return [...out.values()];
}
type Read = (
  path: string,
  params: Record<string, string>,
  signal?: AbortSignal,
) => Promise<unknown>;
// Bounded multi-chain read through the existing fixed-host routing transport (no new host).
export async function fetchRoutingTokens(
  read: Read,
  chainIds: string[],
  signal?: AbortSignal,
) {
  const out = new Map<string, UniverseToken[]>();
  for (let i = 0; i < chainIds.length; i += 10) {
    const chunk = chainIds.slice(i, i + 10);
    // Conservative observation time: the request start (evidence is at least this old).
    const at = Date.now();
    const raw = await read("tokens", { chains: chunk.join(",") }, signal);
    for (const id of chunk) out.set(id, normalizeRoutingTokens(raw, id, at));
  }
  return out;
}
