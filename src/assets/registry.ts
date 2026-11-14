// V1.11 asset registry service (SERVER ONLY: imported by API routes, never by client components). Combines the
// generated registry (canonical + curated, sanitized local logos), the CoinGecko exact-contract snapshot, ONEbridge
// registered pairs, the live routing provider list (route support) and, for an exact address, on-chain metadata and
// DEXScreener evidence. Identity is chain + exact contract; symbols are display text.
import registryFile from "./registry.generated.json" with { type: "json" };
import coingeckoFile from "./sources/coingecko.generated.json" with { type: "json" };
import pairsFile from "./onebridge-pairs.generated.json" with { type: "json" };
import trustWalletFile from "./sources/trustwallet.generated.json" with { type: "json" };
import {
  assetKey,
  displayText,
  isEvmAddress,
  isSolanaMint,
  SOLANA_CHAIN_ID,
  textRisk,
  type AssetLevel,
  type RegistryAsset,
  type RiskFlag,
} from "./model";
import {
  dexEvidence,
  DEXSCREENER_CHAINS,
  type DexEvidence,
} from "./sources/dexscreener";
import { ingestRemoteLogo } from "./image-cache";
import { getAddress } from "viem";

export interface AssetView extends RegistryAsset {
  logoUrl: string | null;
  evidence: {
    curated: boolean;
    trustWallet: boolean;
    marketListed: { source: "coingecko"; id: string } | null;
    dex: Pick<
      DexEvidence,
      "pairs" | "liquidityUsd" | "priceUsd" | "observedAt"
    > | null;
    onebridge: { pairId: string; status: string } | null;
  };
  routeStatus: "ROUTABLE" | "NO_VERIFIED_ROUTE" | "UNKNOWN";
}
type RouteAsset = {
  address: string;
  decimals: number;
  symbol: string;
  name: string;
};
/** Market-listed route tokens returned for one symbol/name query (search results, not a chain cap). */
const MAX_MARKET_MATCHES = 48;
const registry = (registryFile as { assets: RegistryAsset[] }).assets;
const listed = (
  coingeckoFile as { listed: Record<string, Record<string, string>> }
).listed;
const pairs = (
  pairsFile as {
    pairs: {
      id: string;
      status: string;
      local: { chainId: string; address: string };
      remote: { chainId: string; address: string };
    }[];
  }
).pairs;
const byKey = new Map(
  registry.map((a) => [assetKey(a.chainId, a.address, a.native), a]),
);
const byChain = new Map<string, RegistryAsset[]>();
for (const a of registry)
  byChain.set(a.chainId, [...(byChain.get(a.chainId) ?? []), a]);
const lc = (s: string) => (isEvmAddress(s) ? s.toLowerCase() : s);
const pairOf = (chainId: string, address: string) =>
  pairs.find(
    (p) =>
      (p.local.chainId === chainId && p.local.address === lc(address)) ||
      (p.remote.chainId === chainId && p.remote.address === lc(address)),
  );
const trustedSymbols = (chainId: string) =>
  new Map(
    (byChain.get(chainId) ?? [])
      .filter((a) => a.level === "CANONICAL" || a.level === "CURATED")
      .map((a) => [
        a.symbol.toUpperCase(),
        assetKey(a.chainId, a.address, a.native),
      ]),
  );

const twFolders = new Map(
  Object.entries(
    (trustWalletFile as { chains: Record<string, { twId: string }> }).chains,
  ).map(([k, v]) => [k, v.twId]),
);
/** Trust Wallet assets folder of an exact chain id (registry-mapped, never guessed by name). */
export function trustWalletFolder(chainId: string) {
  return twFolders.get(chainId) ?? null;
}
export function registryFor(chainId: string) {
  return byChain.get(chainId) ?? [];
}
export function knownAsset(chainId: string, address: string, native = false) {
  return byKey.get(assetKey(chainId, address, native)) ?? null;
}
export function marketListing(chainId: string, address: string) {
  const id = listed[chainId]?.[lc(address)];
  return id ? { source: "coingecko" as const, id } : null;
}
function view(
  a: RegistryAsset,
  route: Map<string, RouteAsset> | null,
  extra: Partial<AssetView["evidence"]> = {},
): AssetView {
  const pair = pairOf(a.chainId, a.address);
  const routed = a.native
    ? route
      ? true
      : null
    : route
      ? route.has(lc(a.address))
      : null;
  const routeStatus: AssetView["routeStatus"] =
    a.level === "BLOCKED"
      ? "NO_VERIFIED_ROUTE"
      : routed === null
        ? "UNKNOWN"
        : routed
          ? "ROUTABLE"
          : "NO_VERIFIED_ROUTE";
  return {
    ...a,
    routable: routeStatus === "ROUTABLE",
    logoUrl: a.logo?.src ?? null,
    evidence: {
      curated: a.level === "CURATED",
      trustWallet: a.sources.includes("trustwallet"),
      marketListed: marketListing(a.chainId, a.address),
      dex: null,
      onebridge: pair ? { pairId: pair.id, status: pair.status } : null,
      ...extra,
    },
    routeStatus,
  };
}
/** Default picker list for a chain: canonical + curated (+ registry market-listed). Never a raw provider dump. */
export function listAssets(chainId: string, routeAssets: RouteAsset[] | null) {
  const route = routeAssets
    ? new Map(routeAssets.map((r) => [lc(r.address), r]))
    : null;
  return registryFor(chainId)
    .filter((a) => a.level !== "BLOCKED")
    .map((a) => view(a, route));
}
/**
 * Search: symbol/name over the registry first, then route-supported tokens with an exact market listing. An exact
 * address returns that single identity (registry, market snapshot or route list) — or `lookup: true` when only the
 * import preview can say more. Never selects by symbol; never returns unlisted route tokens for a symbol query.
 */
export function searchAssets(
  chainId: string,
  query: string,
  routeAssets: RouteAsset[] | null,
) {
  const exact = query.trim();
  const q = displayText(query, 80).toLowerCase();
  const route = routeAssets
    ? new Map(routeAssets.map((r) => [lc(r.address), r]))
    : null;
  if (chainId === SOLANA_CHAIN_ID && isSolanaMint(exact)) {
    const known = knownAsset(chainId, exact);
    return { results: known ? [view(known, null)] : [], lookup: !known };
  }
  if (isEvmAddress(q)) {
    const known = knownAsset(chainId, q);
    if (known) return { results: [view(known, route)], lookup: false };
    const r = route?.get(q);
    const market = marketListing(chainId, q);
    if (r && market)
      return {
        results: [view(asRouteAsset(chainId, r, "MARKET_LISTED"), route)],
        lookup: false,
      };
    return { results: [], lookup: true };
  }
  if (!q) return { results: listAssets(chainId, routeAssets), lookup: false };
  const match = (s: string, n: string) =>
    s.toLowerCase().includes(q) || n.toLowerCase().includes(q);
  const fromRegistry = registryFor(chainId).filter(
    (a) => a.level !== "BLOCKED" && match(a.symbol, a.name),
  );
  const seen = new Set(
    fromRegistry.map((a) => assetKey(a.chainId, a.address, a.native)),
  );
  const trusted = trustedSymbols(chainId);
  const fromMarket = [...(route?.values() ?? [])]
    .filter(
      (r) =>
        !seen.has(assetKey(chainId, r.address)) &&
        marketListing(chainId, r.address) &&
        match(r.symbol, r.name),
    )
    .slice(0, MAX_MARKET_MATCHES)
    .map((r) => {
      const a = asRouteAsset(chainId, r, "MARKET_LISTED");
      const owner = trusted.get(a.symbol.toUpperCase());
      if (owner && owner !== assetKey(chainId, a.address))
        a.risk = [...a.risk, "SYMBOL_IMPERSONATION"];
      return a;
    });
  return {
    results: [...fromRegistry, ...fromMarket]
      .slice(0, 60)
      .map((a) => view(a, route)),
    lookup: false,
  };
}
function asRouteAsset(
  chainId: string,
  r: RouteAsset,
  level: AssetLevel,
): RegistryAsset {
  const symbol = displayText(r.symbol, 32) || "?",
    name = displayText(r.name, 120);
  return {
    chainId,
    address: lc(r.address),
    native: false,
    symbol,
    name,
    decimals: r.decimals,
    level,
    sources: [
      "routing",
      ...(marketListing(chainId, r.address) ? (["coingecko"] as const) : []),
    ],
    logo: null,
    coingeckoId: marketListing(chainId, r.address)?.id,
    risk: textRisk(symbol, name),
  };
}

/**
 * DEX-discovered search result: an EXACT address that the route list supports, that is neither in the registry nor
 * market listed, and for which DEXScreener reports a pair for that exact chain + token. DEX evidence is a label,
 * never a safety claim; the result is never auto-selected and stays selectable only where a route supports it.
 */
export function dexDiscoveredView(
  chainId: string,
  r: RouteAsset,
  dex: DexEvidence,
  routeAssets: RouteAsset[],
): AssetView {
  const a = asRouteAsset(chainId, r, "DEX_DISCOVERED");
  a.sources = [...a.sources, "dexscreener"];
  const owner = trustedSymbols(chainId).get(a.symbol.toUpperCase());
  if (owner && owner !== assetKey(chainId, a.address))
    a.risk = [...a.risk, "SYMBOL_IMPERSONATION"];
  if (dex.liquidityUsd < 10_000) a.risk = [...a.risk, "LOW_LIQUIDITY"];
  if (
    dex.symbol &&
    displayText(dex.symbol, 32).toUpperCase() !== a.symbol.toUpperCase()
  )
    a.risk = [...a.risk, "METADATA_MISMATCH"];
  return view(a, new Map(routeAssets.map((x) => [lc(x.address), x])), {
    dex: {
      pairs: dex.pairs,
      liquidityUsd: dex.liquidityUsd,
      priceUsd: dex.priceUsd,
      observedAt: dex.observedAt,
    },
  });
}

// ------------------------------------------------------------------------------------------------ import preview
export interface PreviewDeps {
  /** eth_getCode at the safe/latest head through the vetted data-plane pool. */
  code: (chainId: string, address: string) => Promise<string>;
  /** ERC20 decimals/symbol/name through the vetted data-plane pool. */
  metadata: (
    chainId: string,
    address: string,
  ) => Promise<{ decimals: number | null; symbol: string; name: string }>;
  dex?: typeof dexEvidence;
  logo?: typeof ingestRemoteLogo;
  twFolder?: (chainId: string) => string | null;
}
export interface PreviewStep {
  step:
    | "address"
    | "code"
    | "metadata"
    | "curated"
    | "market"
    | "dex"
    | "logo"
    | "route";
  ok: boolean;
  detail: string;
}
export async function previewImport(
  chainId: string,
  address: string,
  routeAssets: RouteAsset[] | null,
  deps: PreviewDeps,
): Promise<{
  asset: AssetView | null;
  steps: PreviewStep[];
  warnings: RiskFlag[];
  importable: boolean;
}> {
  const steps: PreviewStep[] = [];
  const warnings = new Set<RiskFlag>();
  if (!isEvmAddress(address)) {
    steps.push({ step: "address", ok: false, detail: "INVALID_ADDRESS" });
    return { asset: null, steps, warnings: [], importable: false };
  }
  const a = address.toLowerCase();
  steps.push({ step: "address", ok: true, detail: getAddress(a) });
  const known = knownAsset(chainId, a);
  const route = routeAssets
    ? new Map(routeAssets.map((r) => [lc(r.address), r]))
    : null;
  let code = "0x";
  try {
    code = await deps.code(chainId, a);
  } catch {
    steps.push({ step: "code", ok: false, detail: "RPC_UNAVAILABLE" });
    return { asset: null, steps, warnings: [], importable: false };
  }
  if (!/^0x[0-9a-f]*$/i.test(code) || code === "0x") {
    steps.push({ step: "code", ok: false, detail: "NO_CONTRACT_CODE" });
    warnings.add("NO_CODE");
    return { asset: null, steps, warnings: [...warnings], importable: false };
  }
  steps.push({
    step: "code",
    ok: true,
    detail: `${(code.length - 2) / 2} bytes`,
  });
  let meta: { decimals: number | null; symbol: string; name: string };
  try {
    meta = await deps.metadata(chainId, a);
  } catch {
    steps.push({ step: "metadata", ok: false, detail: "RPC_UNAVAILABLE" });
    return { asset: null, steps, warnings: [...warnings], importable: false };
  }
  const symbol = displayText(meta.symbol, 32),
    name = displayText(meta.name, 120);
  if (meta.decimals === null || meta.decimals > 36 || !symbol) {
    steps.push({ step: "metadata", ok: false, detail: "NOT_AN_ERC20_TOKEN" });
    return { asset: null, steps, warnings: [...warnings], importable: false };
  }
  steps.push({
    step: "metadata",
    ok: true,
    detail: `${symbol} · ${meta.decimals} decimals`,
  });
  for (const f of textRisk(meta.symbol, meta.name)) warnings.add(f);
  if (meta.symbol.length > 32 || meta.name.length > 120)
    warnings.add("LONG_TEXT");
  const curated =
    !!known && (known.level === "CURATED" || known.level === "CANONICAL");
  steps.push({
    step: "curated",
    ok: curated,
    detail: curated ? known!.level : "NOT_IN_CURATED_REGISTRY",
  });
  if (known && known.decimals !== meta.decimals)
    warnings.add("METADATA_MISMATCH");
  const market = marketListing(chainId, a);
  steps.push({
    step: "market",
    ok: !!market,
    detail: market ? `coingecko:${market.id}` : "NO_EXACT_MARKET_LISTING",
  });
  let dex: DexEvidence | null = null;
  if (DEXSCREENER_CHAINS[chainId]) {
    try {
      dex = await (deps.dex ?? dexEvidence)(chainId, a);
      steps.push({
        step: "dex",
        ok: !!dex,
        detail: dex
          ? `${dex.pairs} pair(s), liquidity ≈ $${Math.round(dex.liquidityUsd)}`
          : "NO_DEX_PAIR",
      });
    } catch {
      steps.push({ step: "dex", ok: false, detail: "DEX_LOOKUP_UNAVAILABLE" });
    }
  } else
    steps.push({
      step: "dex",
      ok: false,
      detail: "DEX_SOURCE_NOT_AVAILABLE_FOR_CHAIN",
    });
  if (dex && dex.liquidityUsd < 10_000) warnings.add("LOW_LIQUIDITY");
  if (!market && !dex) warnings.add("NO_MARKET_EVIDENCE");
  if (
    dex?.symbol &&
    displayText(dex.symbol, 32).toUpperCase() !== symbol.toUpperCase()
  )
    warnings.add("METADATA_MISMATCH");
  const owner = trustedSymbols(chainId).get(symbol.toUpperCase());
  if (owner && owner !== assetKey(chainId, a))
    warnings.add("SYMBOL_IMPERSONATION");
  // Logo priority for a non-registry token: Trust Wallet exact contract → DEXScreener exact pair → monogram.
  // (CoinGecko images need its API for the coin id; used only when a key/budget allows — not in this path.)
  let logoUrl = known?.logo?.src ?? null;
  const ingest = deps.logo ?? ingestRemoteLogo;
  const tw = deps.twFolder?.(chainId) ?? null;
  if (!logoUrl && tw)
    logoUrl = await ingest(
      `${chainId}:${a}:tw`,
      `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${tw}/assets/${getAddress(a)}/logo.png`,
      "trustwallet",
    );
  if (!logoUrl && dex?.imageUrl)
    logoUrl = await ingest(`${chainId}:${a}:dex`, dex.imageUrl, "dexscreener");
  steps.push({
    step: "logo",
    ok: !!logoUrl,
    detail: logoUrl ? "SANITIZED_LOCAL_COPY" : "MONOGRAM",
  });
  const routed = route ? route.has(a) : null;
  steps.push({
    step: "route",
    ok: routed === true,
    detail:
      routed === null
        ? "ROUTE_LIST_UNAVAILABLE"
        : routed
          ? "ROUTE_SUPPORTED"
          : "NO_VERIFIED_ROUTE",
  });
  const blocked =
    warnings.has("BIDI_OR_INVISIBLE") || warnings.has("MIXED_SCRIPT");
  const level: AssetLevel = blocked
    ? "BLOCKED"
    : curated
      ? known!.level
      : "IMPORTED_UNVERIFIED"; // market/DEX evidence is shown as evidence, never as an upgrade on import
  const asset: AssetView = {
    chainId,
    address: a,
    native: false,
    symbol: symbol || "?",
    name,
    decimals: meta.decimals,
    level,
    sources: [
      "onchain",
      "user-import",
      ...(market ? (["coingecko"] as const) : []),
      ...(dex ? (["dexscreener"] as const) : []),
    ],
    logo: null,
    coingeckoId: market?.id,
    risk: [...warnings],
    routable: routed === true && level !== "BLOCKED",
    logoUrl,
    evidence: {
      curated,
      trustWallet: !!known?.sources.includes("trustwallet"),
      marketListed: market,
      dex: dex
        ? {
            pairs: dex.pairs,
            liquidityUsd: dex.liquidityUsd,
            priceUsd: dex.priceUsd,
            observedAt: dex.observedAt,
          }
        : null,
      onebridge: null,
    },
    routeStatus:
      level === "BLOCKED"
        ? "NO_VERIFIED_ROUTE"
        : routed === null
          ? "UNKNOWN"
          : routed
            ? "ROUTABLE"
            : "NO_VERIFIED_ROUTE",
  };
  return {
    asset,
    steps,
    warnings: [...warnings],
    importable: level !== "BLOCKED",
  };
}
