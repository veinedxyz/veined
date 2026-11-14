// G13 (VBA-P1-05): EVM networks whose gas token is ETH although the TVL catalog's `tokenSymbol` names another coin
// (the network's governance token: MANTA on Manta Pacific, ZRC on Zircuit, OP on OP Mainnet ...). The protected
// registry (src/data/registry/chains.ts) uses that symbol for networks outside the routing catalog, so a native ETH
// balance on Manta Pacific was shown as "MANTA". This table corrects the NAME shown on screen only; it never prices,
// converts or routes anything (pricing stays with the protected portfolio layer; the root fix is proposed in
// PROTECTED_CHANGE_PROPOSAL_TR.md).
//
// Evidence (both sources must agree, or a chain is not listed): src/catalog/snapshot.json `gasTokenGeckoId ===
// "ethereum"` AND ethereum-lists (https://chainid.network/chains.json, fetched 2026-11-11, sha256 f0786851…)
// `nativeCurrency.symbol === "ETH"`; 40 of 40 candidates agreed, 0 disagreed (G13 evidence p1-05-ethereum-lists).
// Value: the TVL catalog's own tokenSymbol for that chain (null when it has none). tests/unit/g13-p1.test.ts re-derives
// the TVL half from the snapshot, so the table cannot silently drift from the data the registry reads.
export const ETH_GAS_TVL_SYMBOL: Readonly<Record<string, string | null>> =
  Object.freeze({
    "10": "OP",
    "130": "-",
    "169": "MANTA",
    "254": "SWAN",
    "288": "BOBA",
    "324": "ZK",
    "360": "SHAPE",
    "480": "WLD",
    "1101": null,
    "1135": "LSK",
    "1729": "REYA",
    "1868": null,
    "1890": null,
    "2355": "-",
    "2410": null,
    "2741": null,
    "3776": null,
    "4326": "MEGA",
    "4663": null,
    "5330": "SUPR",
    "7560": null,
    "8008": null,
    "8453": null,
    "25363": "BLEND",
    "34443": "MODE",
    "42161": "ARB",
    "42170": null,
    "43111": "HEMI",
    "48900": "ZRC",
    "57073": null,
    "59144": "LINEA",
    "60808": "BOB",
    "81457": "BLAST",
    "97477": null,
    "167000": "TAIKO",
    "534352": "SCR",
    "747474": "KAT",
    "810180": "ZKL",
    "7777777": null,
    "1313161554": "AURORA",
  });

/**
 * The symbol to show for a NATIVE balance on `chainId`. Only a symbol that came from the TVL catalog's token field
 * (that exact symbol, or the registry's "?" / "-" fallbacks when the catalog had none) is replaced by "ETH"; a symbol
 * from any other source (e.g. the routing catalog) is never overridden.
 */
export function displayNativeSymbol(chainId: string, reported: string): string {
  if (reported === "ETH" || !Object.hasOwn(ETH_GAS_TVL_SYMBOL, chainId))
    return reported;
  const tvl = ETH_GAS_TVL_SYMBOL[chainId];
  return reported === tvl || reported === "?" || reported === "-"
    ? "ETH"
    : reported;
}
