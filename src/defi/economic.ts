import type { DefiPosition } from "./model";
/** Aave-family (Aave V3, SparkLend) collateral is a subset of supplied. Other protocols report it as a separate deposit. */
export function economicAssets(p: DefiPosition) {
  return p.underlying.length
    ? p.underlying
    : p.protocolId === "aave-v3" || p.protocolId === "sparklend"
      ? p.supplied
      : [...p.supplied, ...p.collateral];
}
