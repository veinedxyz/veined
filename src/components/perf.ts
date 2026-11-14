// V1.14.1 machine-readable latency receipts through the standard User Timing API (no globals, no network):
// otherbridge:walletFirstResultMs, otherbridge:firstDefiResultMs and otherbridge:fullDefiScanMs. They are scoped to one
// scan of one identity: a new scan (explicit, refresh or account switch) clears every mark and measure first.
// V1.14.2 adds the four wallet timings (shell ready, first meaningful asset, first page complete, full coverage) and
// one `otherbridge:walletFlush` mark per coalesced progressive render (render census).
const P = "otherbridge:";
export type PerfMeasure =
  | "walletShellReadyMs"
  | "firstMeaningfulAssetMs"
  | "firstPageCompleteMs"
  | "fullWalletCoverageMs"
  | "walletFirstResultMs"
  | "firstDefiResultMs"
  | "fullDefiScanMs";
const MEASURES: PerfMeasure[] = [
  "walletShellReadyMs",
  "firstMeaningfulAssetMs",
  "firstPageCompleteMs",
  "fullWalletCoverageMs",
  "walletFirstResultMs",
  "firstDefiResultMs",
  "fullDefiScanMs",
];
const safe = (f: () => void) => {
  try {
    if (typeof performance !== "undefined") f();
  } catch {
    /* Timing receipts are diagnostics only; they never affect the scan. */
  }
};
const has = (name: string, type: "mark" | "measure") =>
  typeof performance !== "undefined" &&
  performance.getEntriesByName(P + name, type).length > 0;
export const perf = {
  /** A new wallet scan: every receipt of a previous scan / identity is discarded. */
  scanStart() {
    safe(() => {
      for (const m of ["scan:start", "defi:start", "walletFlush"])
        performance.clearMarks(P + m);
      for (const m of MEASURES) performance.clearMeasures(P + m);
      performance.mark(P + "scan:start");
    });
  },
  /** A (re)started DeFi scan of the current identity; the first DeFi result of this wallet scan is kept. */
  defiStart() {
    safe(() => {
      performance.clearMarks(P + "defi:start");
      performance.clearMeasures(P + "fullDefiScanMs");
      performance.mark(P + "defi:start");
    });
  },
  /** One coalesced progressive wallet render. */
  flush() {
    safe(() => performance.mark(P + "walletFlush"));
  },
  /** Records the measure once per scan: from the wallet scan start (or the DeFi start when there is none). */
  once(name: PerfMeasure) {
    safe(() => {
      if (has(name, "measure")) return;
      const from =
        name === "fullDefiScanMs" || !has("scan:start", "mark")
          ? "defi:start"
          : "scan:start";
      if (!has(from, "mark")) return;
      performance.measure(P + name, P + from);
    });
  },
};
