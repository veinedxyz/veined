// G12 H01: the three kinds of coverage a portfolio scan has, read from the scan's own per-network coverage (presentation
// only; no value, total or classification is computed here). A network that was not read is counted as "not read",
// never as empty; a network whose token read was incomplete is counted apart as "partly read", never as read.
import type { PortfolioResult } from "../portfolio/model";

export interface CoverageTiers {
  /** Native coin balance read on these networks. */
  native: { read: number; notRead: number };
  /** Token balances read from VEINED's reviewed list (or a known-token set) on these networks; index-discovered
   * networks are counted under `discovered` only. */
  reviewed: { read: number; partial: number; notRead: number };
  /** Networks whose tokens were found from on-chain activity (index or enumeration), and DeFi protocol checks as the
   * scan counted them (individual checks, not coverage rows). */
  discovered: { networks: number; defiChecked: number; defiPlanned: number };
}

export function coverageTiers(
  r: Pick<PortfolioResult, "coverage" | "defiCoverage">,
): CoverageTiers {
  const all = r.coverage;
  type Row = (typeof all)[number];
  const count = (f: (c: Row) => boolean) => all.filter(f).length;
  const nativeRead = count((c) => c.native === "CHECKED");
  const listed = (c: Row) =>
    c.tokens === "CURATED" || c.tokens === "KNOWN_TOKENS";
  // An incomplete token read (some reads failed, or a lagging index) is not a full read of the list.
  const incomplete = (c: Row) =>
    c.reason === "TOKEN_READ_INCOMPLETE" || c.reason === "INDEX_LAGGING";
  const read = count((c) => listed(c) && !incomplete(c));
  const partial = count((c) => listed(c) && incomplete(c));
  const indexed = count(
    (c) => c.tokens === "INDEXED" || c.tokens === "ENUMERATED",
  );
  const defi = r.defiCoverage ?? [];
  return {
    native: { read: nativeRead, notRead: all.length - nativeRead },
    reviewed: {
      read,
      partial,
      notRead: all.length - read - partial - indexed,
    },
    discovered: {
      networks: indexed,
      defiChecked: defi.reduce((n, c) => n + c.checked, 0),
      defiPlanned: defi.reduce((n, c) => n + c.planned, 0),
    },
  };
}
