// V1.11 DEXScreener evidence (server-side only). DEX pair evidence for an EXACT chain + token address: liquidity,
// price, pair count, optional image URL (ingested only through the sanitizer). A DEXScreener listing, boost, profile
// or "verified" badge is NEVER treated as safe/verified — it only places a token at level DEX_DISCOVERED.
// Public API limit: 300 requests/min for token endpoints; we stay far below with a cache and a process budget.
import { safeGet, safeJsonParse } from "../safe-fetch";

/** Routing chain id → DEXScreener chain slug (exact; a chain absent here gets no DEX lookups). */
export const DEXSCREENER_CHAINS: Record<string, string> = {
  "1": "ethereum",
  "10": "optimism",
  "25": "cronos",
  "56": "bsc",
  "100": "gnosischain",
  "130": "unichain",
  "137": "polygon",
  "146": "sonic",
  "204": "opbnb",
  "250": "fantom",
  "288": "boba",
  "324": "zksync",
  "1088": "metis",
  "1284": "moonbeam",
  "1329": "seiv2",
  "2741": "abstract",
  "5000": "mantle",
  "8453": "base",
  "34443": "mode",
  "42161": "arbitrum",
  "42220": "celo",
  "43114": "avalanche",
  "57073": "ink",
  "59144": "linea",
  "80094": "berachain",
  "81457": "blast",
  "534352": "scroll",
  "999": "hyperevm",
  "480": "worldchain",
  "1868": "soneium",
  "2020": "ronin",
  "33139": "apechain",
  "14": "flare",
  "8217": "kaia",
  "1151111081099710": "solana",
};
export interface DexEvidence {
  chainId: string;
  address: string;
  pairs: number;
  liquidityUsd: number;
  priceUsd: string | null;
  symbol: string | null;
  name: string | null;
  imageUrl: string | null;
  observedAt: number;
  source: "dexscreener";
}
type Pair = {
  chainId?: string;
  baseToken?: { address?: string; symbol?: string; name?: string };
  liquidity?: { usd?: number };
  priceUsd?: string;
  info?: { imageUrl?: string };
};
const cache = new Map<string, { at: number; value: DexEvidence | null }>();
let budget = { windowStart: 0, used: 0 };
const BUDGET_PER_MINUTE = 60;
const TTL = 5 * 60_000;

export async function dexEvidence(
  chainId: string,
  address: string,
  signal?: AbortSignal,
  fetcher = safeGet,
): Promise<DexEvidence | null> {
  const slug = DEXSCREENER_CHAINS[chainId];
  if (!slug || !/^0x[0-9a-fA-F]{40}$/.test(address)) return null;
  const a = address.toLowerCase();
  const key = `${chainId}:${a}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const now = Date.now();
  if (now - budget.windowStart > 60_000) budget = { windowStart: now, used: 0 };
  if (budget.used >= BUDGET_PER_MINUTE) throw new Error("DEX_BUDGET_EXHAUSTED");
  budget.used++;
  const r = await fetcher(
    `https://api.dexscreener.com/tokens/v1/${slug}/${a}`,
    {
      allowedHosts: ["api.dexscreener.com"],
      maxBytes: 2_000_000,
      timeoutMs: 8000,
      accept: "application/json",
      signal,
    },
  );
  const pairs = (safeJsonParse(r.body.toString("utf8")) as Pair[] | null) ?? [];
  // Only pairs on the EXACT chain whose base token is the EXACT address count as evidence.
  const exact = Array.isArray(pairs)
    ? pairs.filter(
        (p) =>
          p.chainId === slug &&
          String(p.baseToken?.address ?? "").toLowerCase() === a,
      )
    : [];
  const value: DexEvidence | null = exact.length
    ? {
        chainId,
        address: a,
        pairs: exact.length,
        liquidityUsd: exact.reduce(
          (s, p) => s + (Number(p.liquidity?.usd ?? 0) || 0),
          0,
        ),
        priceUsd:
          typeof exact[0].priceUsd === "string" &&
          /^\d+(\.\d+)?$/.test(exact[0].priceUsd)
            ? exact[0].priceUsd.slice(0, 32)
            : null,
        symbol:
          typeof exact[0].baseToken?.symbol === "string"
            ? exact[0].baseToken.symbol.slice(0, 64)
            : null,
        name:
          typeof exact[0].baseToken?.name === "string"
            ? exact[0].baseToken.name.slice(0, 160)
            : null,
        imageUrl:
          exact
            .map((p) => p.info?.imageUrl)
            .find((u) => typeof u === "string" && /^https:\/\//.test(u)) ??
          null,
        observedAt: Date.now(),
        source: "dexscreener",
      }
    : null;
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: Date.now(), value });
  return value;
}
export function resetDexCacheForTests() {
  cache.clear();
  budget = { windowStart: 0, used: 0 };
}
