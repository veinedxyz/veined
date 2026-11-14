// V1.11 unified asset registry model (Bridge, Swap, Portfolio, Activity). Browser-safe: types and pure rules.
//
// Identity is ALWAYS network + exact contract address (EVM addresses compared lowercase); a native asset has an
// explicit native identity. A symbol is display text only — it never identifies, selects, merges or logo-matches
// an asset.
//
// Levels describe EVIDENCE, not safety:
//   CANONICAL            network native asset, or a token of a protocol-canonical route (ONEbridge registered pair)
//   CURATED              exact chain+contract in the Otherbridge curated registry (rule: Trust Wallet's curated
//                        per-chain list AND the routing provider list agree on contract and decimals)
//   MARKET_LISTED        exact platform+contract listed on a market source (CoinGecko). Not "safe", not "audited".
//   DEX_DISCOVERED       exact chain+contract has DEX pair evidence (DEXScreener). Not "verified", not "safe".
//   IMPORTED_UNVERIFIED  the user imported the exact address; no curated evidence
//   BLOCKED              spam/scam/malformed/policy — never selectable for a route
import { base58 } from "@scure/base";
export const SOLANA_CHAIN_ID = "1151111081099710";
export function isSolanaMint(address: string) {
  try {
    return address.length <= 44 && base58.decode(address).length === 32;
  } catch {
    return false;
  }
}
export const ASSET_LEVELS = [
  "CANONICAL",
  "CURATED",
  "MARKET_LISTED",
  "DEX_DISCOVERED",
  "IMPORTED_UNVERIFIED",
  "BLOCKED",
] as const;
export type AssetLevel = (typeof ASSET_LEVELS)[number];
export const NATIVE_ADDRESS = "native";
export type AssetSource =
  | "native"
  | "onebridge"
  | "otherbridge-curated"
  | "trustwallet"
  | "coingecko"
  | "dexscreener"
  | "routing"
  | "onchain"
  | "user-import";
export type RiskFlag =
  | "SYMBOL_IMPERSONATION"
  | "BIDI_OR_INVISIBLE"
  | "MIXED_SCRIPT"
  | "LONG_TEXT"
  | "URL_IN_TEXT"
  | "NO_CODE"
  | "METADATA_MISMATCH"
  | "NO_MARKET_EVIDENCE"
  | "LOW_LIQUIDITY"
  | "TESTNET"
  | "SPAM_LISTED";
export interface AssetLogo {
  /** Same-origin path only. */
  src: string;
  source: "canonical-local" | "trustwallet" | "coingecko" | "dexscreener";
  sha256: string;
}
export interface RegistryAsset {
  chainId: string;
  /** Lowercase EVM address, the chain's native sentinel, or `native`. */
  address: string;
  native: boolean;
  symbol: string;
  name: string;
  decimals: number;
  level: AssetLevel;
  sources: AssetSource[];
  logo: AssetLogo | null;
  coingeckoId?: string;
  risk: RiskFlag[];
  /** Route availability for this asset on this chain (Bridge/Swap). */
  routable?: boolean;
}

export const isEvmAddress = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
/** Canonical identity key: chain + exact address (EVM lowercase); native assets are `chain:native`. */
export function assetKey(chainId: string, address: string, native = false) {
  if (native) return `${chainId}:${NATIVE_ADDRESS}`;
  return `${chainId}:${isEvmAddress(address) ? address.toLowerCase() : address}`;
}
export function sameAsset(
  a: { chainId: string; address: string; native?: boolean },
  b: { chainId: string; address: string; native?: boolean },
) {
  return (
    assetKey(a.chainId, a.address, !!a.native) ===
    assetKey(b.chainId, b.address, !!b.native)
  );
}

const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD\u061C]/;
const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["cherokee", /\p{Script=Cherokee}/u],
];
/** Display-text risk flags (homoglyph/bidi/oversized/URL lures). Applied to every untrusted symbol and name. */
export function textRisk(symbol: string, name: string): RiskFlag[] {
  const flags = new Set<RiskFlag>();
  const text = `${symbol} ${name}`;
  if (BIDI.test(text)) flags.add("BIDI_OR_INVISIBLE");
  // A symbol mixing look-alike scripts (e.g. Latin + Cyrillic "UЅDC") is a classic impersonation.
  if (SCRIPTS.filter(([, re]) => re.test(symbol)).length > 1)
    flags.add("MIXED_SCRIPT");
  if (symbol.length > 16 || name.length > 64) flags.add("LONG_TEXT");
  if (
    /https?:|www\.|\.(com|io|org|net|xyz|app)\b|t\.me|claim|airdrop|reward/i.test(
      text,
    )
  )
    flags.add("URL_IN_TEXT");
  return [...flags];
}
/** Clean display text: strip bidi/invisible characters, normalize, bound length. Never used as identity. */
export function displayText(value: string, limit: number) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(new RegExp(BIDI.source, "g"), "")
    .trim()
    .slice(0, limit);
}

// Level rank (lower = stronger evidence). BLOCKED is never ranked into a selectable list.
const LEVEL_RANK: Record<AssetLevel, number> = {
  CANONICAL: 0,
  CURATED: 1,
  MARKET_LISTED: 2,
  IMPORTED_UNVERIFIED: 3,
  DEX_DISCOVERED: 4,
  BLOCKED: 9,
};
export function levelRank(level: AssetLevel) {
  return LEVEL_RANK[level];
}
/**
 * Picker ranking (Swap and Bridge): wallet-held routable → native canonical → curated → market listed →
 * recent/imported → DEX-discovered search results. Inside a group: USD value held, then symbol.
 */
export function rankAssets<
  T extends RegistryAsset & {
    heldUsd?: number | null;
    held?: boolean;
    recent?: boolean;
  },
>(assets: T[]): T[] {
  const group = (a: T) =>
    a.level === "BLOCKED"
      ? 9
      : a.held && a.routable !== false
        ? 0
        : a.level === "CANONICAL"
          ? 1
          : a.level === "CURATED"
            ? 2
            : a.level === "MARKET_LISTED"
              ? 3
              : a.recent || a.level === "IMPORTED_UNVERIFIED"
                ? 4
                : 5;
  return [...assets].sort(
    (a, b) =>
      group(a) - group(b) ||
      (b.heldUsd ?? -1) - (a.heldUsd ?? -1) ||
      Number(b.native) - Number(a.native) ||
      a.symbol.localeCompare(b.symbol, "en") ||
      a.address.localeCompare(b.address),
  );
}
/**
 * Symbol collision: an asset whose symbol equals a CANONICAL/CURATED asset's symbol on the same chain but with a
 * different contract is flagged as a possible impersonation (it can still be listed, never auto-selected).
 */
export function flagImpersonation<T extends RegistryAsset>(assets: T[]): T[] {
  const trusted = new Map<string, string>();
  for (const a of assets)
    if (a.level === "CANONICAL" || a.level === "CURATED")
      trusted.set(
        `${a.chainId}|${a.symbol.toUpperCase()}`,
        assetKey(a.chainId, a.address, a.native),
      );
  return assets.map((a) => {
    const owner = trusted.get(`${a.chainId}|${a.symbol.toUpperCase()}`);
    return owner &&
      owner !== assetKey(a.chainId, a.address, a.native) &&
      !a.risk.includes("SYMBOL_IMPERSONATION")
      ? { ...a, risk: [...a.risk, "SYMBOL_IMPERSONATION" as const] }
      : a;
  });
}
/** An asset may be auto-selected (e.g. as a default) only with canonical/curated evidence and no risk flag. */
export function autoSelectable(a: RegistryAsset) {
  return (
    (a.level === "CANONICAL" || a.level === "CURATED") && a.risk.length === 0
  );
}
/** Route eligibility: route support is required for every level; imported or DEX tokens never route without it. */
export function routeEligible(a: RegistryAsset) {
  return a.level !== "BLOCKED" && a.routable === true;
}
