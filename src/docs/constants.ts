import { brand } from "../content/brand";
// V1.11 live documentation constants. Markdown uses {{NAME}} tokens that are replaced at render time from the code
// and the committed registries, so product facts in /docs cannot drift from the running product. An unknown token
// is an error (tests/unit/v111-docs.test.ts).
import { platformFeePolicy } from "../routing/fee-policy";
import { G5_STATUS } from "../g5/status";
import { GLOBAL_EXECUTION_ENABLED } from "../g5/route-pins";
import { locales } from "../i18n/config";
import chainFile from "../registry/chain-identities.generated.json" with { type: "json" };
import registryFile from "../assets/registry.generated.json" with { type: "json" };
import pairsFile from "../assets/onebridge-pairs.generated.json" with { type: "json" };
import routingSnapshot from "../routing/catalog-snapshot.json" with { type: "json" };

/** Mirrors the G7 pilot BSC pin policy (equality asserted by tests; the app never imports G7 modules). */
export const BSC_PIN_MAX_AGE_SEC = 30;
export function docConstants(locale: string): Record<string, string> {
  const chains = (
    chainFile as { chains: { environment: string; logoSource: string }[] }
  ).chains;
  const assets = (registryFile as { assets: { level: string }[] }).assets;
  const pairs = (pairsFile as { pairs: { g5Verified: boolean }[] }).pairs;
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const pct = (v: number) =>
    new Intl.NumberFormat(locale, {
      style: "percent",
      maximumFractionDigits: 2,
    }).format(v);
  return {
    BRAND: brand.name,
    FEE_PERCENT: pct(platformFeePolicy.bps / 10_000),
    FEE_BPS: String(platformFeePolicy.bps),
    G5_STATUS,
    SENDING:
      locale === "tr"
        ? GLOBAL_EXECUTION_ENABLED
          ? "açık"
          : "kapalı"
        : GLOBAL_EXECUTION_ENABLED
          ? "enabled"
          : "disabled",
    LOCALES: n(locales.length),
    MAINNETS: n(chains.filter((c) => c.environment === "mainnet").length),
    TESTNETS: n(chains.filter((c) => c.environment === "testnet").length),
    CHAINS: n(chains.length),
    CHAIN_LOGOS: n(chains.filter((c) => c.logoSource !== "monogram").length),
    ROUTE_NETWORKS: n(
      (
        routingSnapshot as { chains: { chains: { mainnet: boolean }[] } }
      ).chains.chains.filter((c) => c.mainnet).length + 1,
    ),
    CURATED: n(assets.filter((a) => a.level === "CURATED").length),
    CANONICAL: n(assets.filter((a) => a.level === "CANONICAL").length),
    ONEBRIDGE_PAIRS: n(pairs.length),
    ONEBRIDGE_VERIFIED: n(pairs.filter((p) => p.g5Verified).length),
    BSC_PIN_MAX_AGE: String(BSC_PIN_MAX_AGE_SEC),
  };
}
export function substitute(
  markdown: string,
  constants: Record<string, string>,
) {
  return markdown.replace(/\{\{([A-Z0-9_]{2,40})\}\}/g, (_m, name: string) => {
    if (!(name in constants)) throw new Error(`UNKNOWN_DOC_CONSTANT:${name}`);
    return constants[name];
  });
}
