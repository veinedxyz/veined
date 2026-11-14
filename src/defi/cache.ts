// V1.14.1 process-wide DeFi metadata cache. Only static, non-user facts proven on-chain are stored here (contract
// code proofs, the verified Multicall3, token decimals/symbol, reviewed reserve/market/vault identities and protocol
// configuration hints). Wallet state, positions, prices and risk are never stored: they are read at the scan's pinned
// block every time (the 30 s scan result cache in the scanner is the only, wallet-scoped, short-lived store).
// Keys always carry the chain and the protocol/deployment scope (and the adapter version where adapter semantics
// apply); a failure is never cached (a rejected load is dropped, the next scan reads again).
export const TTL = {
  /** Deployment identity, contract code, token decimals: immutable for the reviewed deployment. */
  LONG: 6 * 3600_000,
  /** Protocol configuration used only as a speculative read plan (always re-verified at the pinned block). */
  MEDIUM: 10 * 60_000,
  /** Position, price, risk and rewards state: the scan result cache only, never this module. */
  SHORT: 30_000,
} as const;
export type TtlClass = keyof typeof TTL;
export type CacheKind =
  | "code"
  | "multicall"
  | "token"
  | "aave-reserve"
  | "aave-reserves"
  | "morpho-market"
  | "metamorpho-vault"
  | "comet-assets"
  | "univ3-pool"
  | "univ2-pair";
const MAX_ENTRIES = 50_000;
interface Entry {
  at: number;
  ttl: number;
  value: unknown;
}
const entries = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();
const stats = { hits: 0, misses: 0, loads: 0, joins: 0, evictions: 0 };
const ADDRESS = /^0x[0-9a-f]{40}$/;
/** Canonical key: kind | chainId | scope (deployment id or "chain") | subject (contract / market id). */
export function cacheKey(
  kind: CacheKind,
  chainId: string,
  scope: string,
  subject: string,
) {
  if (!/^\d{1,18}$/.test(chainId)) throw Error("CACHE_KEY_CHAIN");
  if (!/^[a-z0-9-]{1,120}(@[0-9.]{5,8})?$/.test(scope))
    throw Error("CACHE_KEY_SCOPE");
  if (
    !ADDRESS.test(subject) &&
    !/^0x[0-9a-f]{64}$/.test(subject) &&
    subject !== "*"
  )
    throw Error("CACHE_KEY_SUBJECT");
  return `${kind}|${chainId}|${scope}|${subject}`;
}
export function cacheGet<T>(key: string, now = Date.now()): T | undefined {
  const e = entries.get(key);
  if (!e) return (stats.misses++, undefined);
  if (now - e.at >= e.ttl) {
    entries.delete(key);
    stats.misses++;
    return undefined;
  }
  stats.hits++;
  return e.value as T;
}
export function cacheSet(key: string, value: unknown, ttl: TtlClass) {
  if (ttl === "SHORT") throw Error("SHORT_STATE_NOT_CACHED_HERE");
  if (value === undefined || value === null) return;
  if (entries.size >= MAX_ENTRIES) {
    entries.delete(entries.keys().next().value!);
    stats.evictions++;
  }
  entries.set(key, { at: Date.now(), ttl: TTL[ttl], value });
}
/**
 * Single-flight load of one static fact: concurrent scans needing the same key share one read; the value is cached
 * only after it resolved. `hit` tells the caller whether the value came from the cache (for the request census).
 */
export async function cached<T>(
  key: string,
  ttl: TtlClass,
  load: () => Promise<T>,
): Promise<{ value: T; hit: boolean }> {
  const value = cacheGet<T>(key);
  if (value !== undefined) return { value, hit: true };
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) {
    stats.joins++;
    try {
      return { value: await running, hit: true };
    } catch {
      /* The other scan's load failed (e.g. its deadline): read with this scan's own budget. */
    }
  }
  stats.loads++;
  const p = load();
  inflight.set(key, p);
  try {
    const v = await p;
    cacheSet(key, v, ttl);
    return { value: v, hit: false };
  } finally {
    if (inflight.get(key) === p) inflight.delete(key);
  }
}
export function metadataCacheStats() {
  const kinds: Record<string, number> = {};
  for (const k of entries.keys()) {
    const kind = k.split("|")[0];
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return { entries: entries.size, kinds, ...stats };
}
/** Every cached key (tests assert that no wallet-scoped value ever enters this cache). */
export function metadataCacheKeys() {
  return [...entries.keys()];
}
export function metadataCacheValuesForTests() {
  return [...entries.values()].map((e) => e.value);
}
export function clearDefiMetadataCacheForTests() {
  entries.clear();
  inflight.clear();
  for (const k of Object.keys(stats) as (keyof typeof stats)[]) stats[k] = 0;
}
