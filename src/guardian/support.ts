// Guardian's only shared helpers, kept inside the module so the Guardian core has no dependency on the rest of VEINED
// (the same files run inside VEINED and in the standalone hackathon demo). Each helper mirrors a VEINED primitive
// exactly; tests/unit/guardian-adversarial.test.ts pins the equivalence so the two can never drift apart:
//   - ASSET_LEVELS / RISK_FLAGS     ≡ src/assets/model.ts (registry evidence vocabulary)
//   - displayText                   ≡ src/assets/model.ts displayText (sanitized, bounded display text)
//   - canonical                     ≡ src/swap/model.ts canonical (deterministic JSON for digests)
//   - validIdentity                 ≡ src/swap/model.ts validIdentity (EVM 20-byte hex / Solana 32-byte base58)
import { base58 } from "@scure/base";

export const ASSET_LEVELS = [
  "CANONICAL",
  "CURATED",
  "MARKET_LISTED",
  "DEX_DISCOVERED",
  "IMPORTED_UNVERIFIED",
  "BLOCKED",
] as const;
export type AssetLevel = (typeof ASSET_LEVELS)[number];
export const RISK_FLAGS = [
  "SYMBOL_IMPERSONATION",
  "BIDI_OR_INVISIBLE",
  "MIXED_SCRIPT",
  "LONG_TEXT",
  "URL_IN_TEXT",
  "NO_CODE",
  "METADATA_MISMATCH",
  "NO_MARKET_EVIDENCE",
  "LOW_LIQUIDITY",
  "TESTNET",
  "SPAM_LISTED",
] as const;
export type RiskFlag = (typeof RISK_FLAGS)[number];

const BIDI = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD\u061C]/;
/** Clean display text: strip bidi/invisible characters, normalize, bound length. Never used as identity. */
export function displayText(value: string, limit: number) {
  return value
    .normalize("NFKC")
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(new RegExp(BIDI.source, "g"), "")
    .trim()
    .slice(0, limit);
}

/** Deterministic JSON: object keys sorted, undefined dropped, bigint as a decimal string. */
export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}

export function validIdentity(a: string, ecosystem: "EVM" | "SVM") {
  if (ecosystem === "EVM") return /^0x[0-9a-f]{40}$/i.test(a);
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
}
