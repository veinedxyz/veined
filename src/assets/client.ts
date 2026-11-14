// V1.11 browser helper for the asset registry API (lazy picker chunks only). Imported tokens and recent picks are
// stored per chain in localStorage as EXACT addresses with display metadata; they are always re-validated (exact
// address format, length limits) on read and never carry trust: an imported token stays IMPORTED_UNVERIFIED.
import type { AssetView, PreviewStep } from "./registry";
import { SOLANA_CHAIN_ID, isSolanaMint, type RiskFlag } from "./model";

export type { AssetView, PreviewStep };
const cache = new Map<string, { at: number; assets: AssetView[] }>();
async function post<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch("/api/assets", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({ error: "PROVIDER_UNAVAILABLE" }));
  if (!r.ok)
    throw Object.assign(new Error(data.error ?? "PROVIDER_UNAVAILABLE"), {
      code: data.error,
    });
  return data as T;
}
export async function registryList(chain: string, signal?: AbortSignal) {
  const hit = cache.get(chain);
  if (hit && Date.now() - hit.at < 300_000) return hit.assets;
  const { assets } = await post<{ assets: AssetView[] }>(
    { action: "list", chain },
    signal,
  );
  if (cache.size > 30) cache.delete(cache.keys().next().value!);
  cache.set(chain, { at: Date.now(), assets });
  return assets;
}
export function registrySearch(
  chain: string,
  query: string,
  signal?: AbortSignal,
) {
  return post<{ results: AssetView[]; lookup: boolean }>(
    { action: "search", chain, query },
    signal,
  );
}
export function tokenPreview(
  chain: string,
  address: string,
  signal?: AbortSignal,
) {
  return post<{
    asset: AssetView | null;
    steps: PreviewStep[];
    warnings: RiskFlag[];
    importable: boolean;
  }>({ action: "preview", chain, address }, signal);
}

export interface ImportedToken {
  chainId: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logoUrl: string | null;
  importedAt: number;
}
const importKey = (chain: string) => `otherbridge:imported-tokens:${chain}`;
const recentKey = (chain: string) => `otherbridge:recent-tokens:${chain}`;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SAFE_LOGO =
  /^\/(api\/asset-image\/[0-9a-f]{64}|assets\/[A-Za-z0-9_./-]{1,200})$/;
function readJson(key: string): unknown[] {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
export function readImported(chain: string): ImportedToken[] {
  return readJson(importKey(chain))
    .flatMap((x) => {
      const t = x as Partial<ImportedToken>;
      return t &&
        t.chainId === chain &&
        typeof t.address === "string" &&
        (chain === SOLANA_CHAIN_ID
          ? isSolanaMint(t.address)
          : ADDRESS.test(t.address)) &&
        typeof t.symbol === "string" &&
        t.symbol.length <= 32 &&
        typeof t.name === "string" &&
        t.name.length <= 120 &&
        Number.isInteger(t.decimals) &&
        (t.decimals as number) >= 0 &&
        (t.decimals as number) <= 36
        ? [
            {
              chainId: chain,
              address: t.address,
              symbol: t.symbol,
              name: t.name,
              decimals: t.decimals as number,
              logoUrl:
                typeof t.logoUrl === "string" && SAFE_LOGO.test(t.logoUrl)
                  ? t.logoUrl
                  : null,
              importedAt: Number(t.importedAt) || 0,
            },
          ]
        : [];
    })
    .slice(0, 50);
}
export function saveImported(token: ImportedToken) {
  const list = [
    token,
    ...readImported(token.chainId).filter((t) => t.address !== token.address),
  ].slice(0, 50);
  try {
    localStorage.setItem(importKey(token.chainId), JSON.stringify(list));
  } catch {
    /* storage unavailable: the import lasts for this page only */
  }
  return list;
}
export function removeImported(chain: string, address: string) {
  const list = readImported(chain).filter(
    (t) =>
      t.address !==
      (chain === SOLANA_CHAIN_ID ? address : address.toLowerCase()),
  );
  try {
    localStorage.setItem(importKey(chain), JSON.stringify(list));
  } catch {
    /* ignore */
  }
  return list;
}
export function readRecent(chain: string): string[] {
  return readJson(recentKey(chain))
    .filter(
      (a): a is string =>
        typeof a === "string" &&
        (ADDRESS.test(a) || /^[A-Za-z0-9]{1,64}$/.test(a)),
    )
    .slice(0, 8);
}
export function pushRecent(chain: string, address: string) {
  // EVM addresses compare lowercase; other ecosystems (e.g. Solana mints) are case-sensitive identities.
  const id = /^0x[0-9a-fA-F]{40}$/.test(address)
    ? address.toLowerCase()
    : address;
  const list = [id, ...readRecent(chain).filter((a) => a !== id)].slice(0, 8);
  try {
    localStorage.setItem(recentKey(chain), JSON.stringify(list));
  } catch {
    /* ignore */
  }
}
