// V1.14.2 process-level wallet-scan state. Three classes, each bounded:
//  * wallet chain result — one exact successful chain read for one wallet, chain, read set and data-plane generation;
//    shared by concurrent identical reads (single-flight, e.g. two tabs) and reused for WALLET_CHAIN_TTL_MS only.
//    Keys carry the keyed wallet pseudonym, never an address. Failures, partial reads and FAILED coverage are never
//    stored, so a cached entry can never turn a failure or a timeout into a zero.
//  * slow-chain memory — chain-only (no wallet data): networks that repeatedly exceeded the first-page budget are
//    deferred to the background wave of later scans. Scheduling only; never a support or coverage state.
//  * read slots — a process-wide hard maximum of concurrently running chain reads across every wallet scan, granted
//    in priority order (first-result reads, then first-page reads, then background coverage).
import type { ChainCoverage, Holding } from "../../portfolio/model";
import type { DefiCoverage } from "../../portfolio/positions";
export const WALLET_CHAIN_TTL_MS = 15_000;
export const SLOW_CHAIN_WINDOW_MS = 30 * 60_000;
export const SLOW_CHAIN_STRIKES = 2;
export const READ_SLOTS = 48;
const MAX_ENTRIES = 5000;
export interface ChainScanValue {
  holdings: Holding[];
  coverage: ChainCoverage;
  defiCoverage?: DefiCoverage[];
}
export interface ChainScanHooks {
  /** Native fast path: a confirmed nonzero native balance, before the token reads of the same chain finish. */
  onNative?: (holding: Holding) => void;
}
interface Shared {
  promise: Promise<ChainScanValue>;
  native: Holding | null;
  listeners: Set<(h: Holding) => void>;
}
// Owner-scoped (one data plane = one set of endpoints / one store): entries never cross planes.
const results = new WeakMap<
  object,
  Map<string, { at: number; value: ChainScanValue }>
>();
const inflight = new WeakMap<object, Map<string, Shared>>();
const stats = { hits: 0, joins: 0, reads: 0, stored: 0, skipped: 0 };
const cacheable = (v: ChainScanValue) =>
  v.coverage.state !== "FAILED" &&
  v.coverage.state !== "PENDING" &&
  v.coverage.reason === "NONE" &&
  v.coverage.tokens !== "FAILED";
const tableOf = <V>(map: WeakMap<object, Map<string, V>>, owner: object) => {
  let t = map.get(owner);
  if (!t) map.set(owner, (t = new Map()));
  return t;
};
/**
 * Runs (or joins) one chain read. The shared read is bounded by its own `timeoutMs` and never by one caller's
 * signal: a caller that aborts (account switch, closed tab) only stops waiting; another caller of the same key is
 * unaffected. `fresh` skips the result cache (explicit refresh) but still joins an identical read already running.
 */
export async function sharedChainScan(
  owner: object,
  key: string,
  run: (signal: AbortSignal, hooks: ChainScanHooks) => Promise<ChainScanValue>,
  options: {
    timeoutMs: number;
    signal?: AbortSignal;
    hooks?: ChainScanHooks;
    fresh?: boolean;
    now?: () => number;
  },
): Promise<ChainScanValue & { cache: "HIT" | "JOINED" | "READ" }> {
  const now = options.now ?? Date.now;
  const table = tableOf(results, owner);
  const hit = table.get(key);
  if (hit && !options.fresh && now() - hit.at < WALLET_CHAIN_TTL_MS) {
    stats.hits++;
    return { ...hit.value, cache: "HIT" };
  }
  const running = tableOf(inflight, owner);
  let shared = running.get(key);
  let joined = true;
  if (!shared) {
    joined = false;
    stats.reads++;
    const entry: Shared = {
      promise: undefined as unknown as Promise<ChainScanValue>,
      native: null,
      listeners: new Set(),
    };
    entry.promise = run(AbortSignal.timeout(Math.max(1, options.timeoutMs)), {
      onNative: (h) => {
        entry.native = h;
        for (const l of entry.listeners)
          try {
            l(h);
          } catch {
            /* A listener never breaks the shared read. */
          }
      },
    })
      .then((value) => {
        if (cacheable(value)) {
          table.set(key, { at: now(), value });
          stats.stored++;
          if (table.size > MAX_ENTRIES)
            table.delete(table.keys().next().value!);
        } else stats.skipped++;
        return value;
      })
      .finally(() => running.delete(key));
    // Observed even when every caller has gone away (no unhandled rejection).
    entry.promise.catch(() => {});
    running.set(key, entry);
    shared = entry;
  } else stats.joins++;
  const onNative = options.hooks?.onNative;
  if (onNative) {
    if (shared.native) onNative(shared.native);
    else shared.listeners.add(onNative);
  }
  try {
    const value = await abortable(shared.promise, options.signal);
    return { ...value, cache: joined ? "JOINED" : "READ" };
  } finally {
    if (onNative) shared.listeners.delete(onNative);
  }
}
function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason ?? Error("ABORTED"));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function walletCacheStats() {
  return { ...stats, ttlMs: WALLET_CHAIN_TTL_MS };
}
// ---------------------------------------------------------------------------------------------------------------
// Slow-chain memory (chain-only).
const strikes = new Map<string, number[]>();
export function recordChainDuration(
  chainId: string,
  durationMs: number,
  budgetMs: number,
  now = Date.now(),
) {
  if (durationMs > budgetMs) {
    const list = (strikes.get(chainId) ?? []).filter(
      (t) => now - t < SLOW_CHAIN_WINDOW_MS,
    );
    list.push(now);
    strikes.set(chainId, list.slice(-SLOW_CHAIN_STRIKES * 2));
    if (strikes.size > MAX_ENTRIES)
      strikes.delete(strikes.keys().next().value!);
  } else strikes.delete(chainId);
}
export function slowChains(now = Date.now()): Set<string> {
  const out = new Set<string>();
  for (const [id, list] of strikes)
    if (
      list.filter((t) => now - t < SLOW_CHAIN_WINDOW_MS).length >=
      SLOW_CHAIN_STRIKES
    )
      out.add(id);
  return out;
}
// ---------------------------------------------------------------------------------------------------------------
// Process-wide read slots (hard maximum across every wallet scan; priority 0 is served first).
export class ReadSlots {
  private active = 0;
  private peak = 0;
  private queue: {
    priority: number;
    seq: number;
    grant: () => void;
  }[] = [];
  private seq = 0;
  constructor(readonly max: number) {}
  get inUse() {
    return this.active;
  }
  get peakInUse() {
    return this.peak;
  }
  get waiting() {
    return this.queue.length;
  }
  acquire(priority: number, signal?: AbortSignal): Promise<() => void> {
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.active--;
      this.next();
    };
    if (this.active < this.max && !this.queue.length) {
      this.active++;
      this.peak = Math.max(this.peak, this.active);
      return Promise.resolve(release);
    }
    return new Promise((resolve, reject) => {
      const item = {
        priority,
        seq: this.seq++,
        grant: () => {
          signal?.removeEventListener("abort", abort);
          this.active++;
          this.peak = Math.max(this.peak, this.active);
          resolve(release);
        },
      };
      const abort = () => {
        const i = this.queue.indexOf(item);
        if (i >= 0) this.queue.splice(i, 1);
        reject(signal?.reason ?? Error("ABORTED"));
      };
      if (signal?.aborted) return abort();
      signal?.addEventListener("abort", abort, { once: true });
      this.queue.push(item);
      this.queue.sort((a, b) => a.priority - b.priority || a.seq - b.seq);
    });
  }
  private next() {
    while (this.active < this.max && this.queue.length)
      this.queue.shift()!.grant();
  }
}
export const walletReadSlots = new ReadSlots(READ_SLOTS);
// ---------------------------------------------------------------------------------------------------------------
/** Test / measurement hooks: the result TTL cache only (warm runs keep proofs, prices and health warm). */
export function clearWalletResultCacheForTests() {
  // WeakMap tables cannot be enumerated; a fresh generation per data plane is forced through the epoch below.
  resultEpoch++;
}
let resultEpoch = 0;
/** Cache-key epoch (bumped by tests / the harness to start from an empty result cache). */
export const walletResultEpoch = () => resultEpoch;
export function clearWalletCachesForTests() {
  resultEpoch++;
  strikes.clear();
  for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;
}
