import type { Universe } from "./model";
import type { UniverseDiff } from "./diff";
// A candidate sync replaces the last-good catalog only when every blocking check passes. A failed check keeps the
// last-good catalog serving, records the rejected attempt, and needs a human decision. Thresholds are relative to the
// last-good catalog; no protocol or chain total is hardcoded.
export interface AnomalyCheck {
  code: string;
  pass: boolean;
  blocking: boolean;
  /** A reviewer may accept a specific overridable code explicitly (recorded in the receipt). */
  overridable: boolean;
  detail: string;
}
export const ANOMALY_LIMITS = {
  minRetainedProtocols: 0.85,
  minRetainedChainRows: 0.85,
  massRemovalShare: 0.03,
  massRemovalFloor: 25,
  massRenameShare: 0.03,
  massRenameFloor: 50,
  unmappedSpikeFloor: 50,
} as const;
export function anomalyChecks(
  prev: Universe | undefined,
  next: Universe,
  diff: UniverseDiff,
  parity: {
    pass: boolean;
    missingChains: string[];
    missingProtocols: number[];
  },
  accepted: ReadonlySet<string> = new Set(),
  limits = ANOMALY_LIMITS,
): AnomalyCheck[] {
  const s = next.stats,
    p = prev?.stats;
  const checks: AnomalyCheck[] = [
    {
      code: "SILENT_OMISSION",
      pass: parity.pass,
      blocking: true,
      overridable: false,
      detail: `missingChains=${parity.missingChains.length} missingProtocols=${parity.missingProtocols.length}`,
    },
    {
      code: "NONEMPTY_SOURCES",
      pass: s.protocolsSeen > 0 && s.chainCatalogRows > 0,
      blocking: true,
      overridable: false,
      detail: `protocols=${s.protocolsSeen} chainRows=${s.chainCatalogRows}`,
    },
  ];
  if (p) {
    checks.push(
      {
        code: "PROTOCOL_COUNT_DROP",
        pass:
          s.protocolsSeen >=
          Math.floor(p.protocolsSeen * limits.minRetainedProtocols),
        blocking: true,
        overridable: true,
        detail: `${p.protocolsSeen} -> ${s.protocolsSeen}`,
      },
      {
        code: "CHAIN_CATALOG_DROP",
        pass:
          s.chainCatalogRows >=
          Math.floor(p.chainCatalogRows * limits.minRetainedChainRows),
        blocking: true,
        overridable: true,
        detail: `${p.chainCatalogRows} -> ${s.chainCatalogRows}`,
      },
      {
        code: "MASS_REMOVAL",
        pass:
          diff.protocols.removed.length <=
          Math.max(
            limits.massRemovalFloor,
            Math.ceil(p.protocolsSeen * limits.massRemovalShare),
          ),
        blocking: true,
        overridable: true,
        detail: `removed=${diff.protocols.removed.length}`,
      },
      {
        code: "MASS_RENAME",
        pass:
          diff.protocols.renamed.length + diff.protocols.slugChanged.length <=
          Math.max(
            limits.massRenameFloor,
            Math.ceil(p.protocolsSeen * limits.massRenameShare),
          ),
        blocking: true,
        overridable: true,
        detail: `renamed=${diff.protocols.renamed.length} slugChanged=${diff.protocols.slugChanged.length}`,
      },
      {
        code: "CHAIN_IDENTITY_CHANGE",
        pass:
          diff.chains.chainIdChanged.length === 0 &&
          diff.chains.vmChanged.length === 0,
        blocking: true,
        overridable: true,
        detail: `chainIdChanged=${diff.chains.chainIdChanged.length} vmChanged=${diff.chains.vmChanged.length}`,
      },
      {
        code: "UNMAPPED_SPIKE",
        pass:
          s.protocolsUnmapped <=
          Math.max(limits.unmappedSpikeFloor, p.protocolsUnmapped * 2 + 20),
        blocking: true,
        overridable: true,
        detail: `${p.protocolsUnmapped} -> ${s.protocolsUnmapped}`,
      },
    );
  }
  return checks.map((c) =>
    c.pass || !c.overridable || !accepted.has(c.code)
      ? c
      : { ...c, pass: true, detail: c.detail + " (ACCEPTED_BY_REVIEWER)" },
  );
}
export const syncAccepted = (checks: AnomalyCheck[]) =>
  checks.every((c) => c.pass || !c.blocking);
