// V1.11 runtime logo cache (server-side). Only SANITIZED bytes enter it (src/assets/image-sanitize.ts), keyed by the
// SHA-256 of those bytes; the browser loads them same-origin from /api/asset-image/<sha256> (CSP img-src 'self').
// Cache-poisoning posture: a key is content-addressed (bytes cannot be swapped under an id), and the binding from
// an exact chain + contract to an image id is only made by the registry service from a URL derived from that exact
// identity (Trust Wallet exact path, CoinGecko exact contract, DEXScreener exact pair base token).
import { safeGet } from "./safe-fetch";
import { sanitizeImage } from "./image-sanitize";

export interface CachedImage {
  id: string;
  format: "png" | "webp";
  bytes: Buffer;
  source: string;
  at: number;
}
const MAX_ENTRIES = 400;
const MAX_BYTES = 24 * 1024 * 1024;
const images = new Map<string, CachedImage>();
const bindings = new Map<string, { id: string | null; at: number }>();
let total = 0;
let budget = { windowStart: 0, used: 0 };
const FETCHES_PER_MINUTE = 40;

export const IMAGE_HOSTS: Record<string, readonly string[]> = {
  trustwallet: ["raw.githubusercontent.com"],
  coingecko: ["coin-images.coingecko.com", "assets.coingecko.com"],
  dexscreener: ["dd.dexscreener.com", "cdn.dexscreener.com"],
};
export function getCachedImage(id: string) {
  return /^[0-9a-f]{64}$/.test(id) ? (images.get(id) ?? null) : null;
}
function put(img: CachedImage) {
  if (images.has(img.id)) return;
  while (images.size >= MAX_ENTRIES || total + img.bytes.length > MAX_BYTES) {
    const first = images.keys().next().value;
    if (first === undefined) break;
    total -= images.get(first)!.bytes.length;
    images.delete(first);
  }
  images.set(img.id, img);
  total += img.bytes.length;
}
/**
 * Ingest a logo for an exact identity key. Returns the same-origin URL or null (monogram). Failures are cached
 * briefly so a hostile/missing upstream cannot be hammered through us.
 */
export async function ingestRemoteLogo(
  identityKey: string,
  url: string,
  source: keyof typeof IMAGE_HOSTS,
  fetcher = safeGet,
): Promise<string | null> {
  const bound = bindings.get(identityKey);
  if (bound && Date.now() - bound.at < (bound.id ? 6 * 3600_000 : 10 * 60_000))
    return bound.id ? `/api/asset-image/${bound.id}` : null;
  const now = Date.now();
  if (now - budget.windowStart > 60_000) budget = { windowStart: now, used: 0 };
  if (budget.used >= FETCHES_PER_MINUTE) return null;
  budget.used++;
  let id: string | null = null;
  try {
    const r = await fetcher(url, {
      allowedHosts: IMAGE_HOSTS[source],
      maxBytes: 600_000,
      timeoutMs: 8000,
      accept: "image/png,image/webp",
    });
    const s = sanitizeImage(r.body, { outputSize: 64 });
    if (s.ok) {
      put({
        id: s.sha256,
        format: s.format,
        bytes: s.bytes,
        source,
        at: Date.now(),
      });
      id = s.sha256;
    }
  } catch {
    id = null;
  }
  if (bindings.size > 5000) bindings.delete(bindings.keys().next().value!);
  bindings.set(identityKey, { id, at: Date.now() });
  return id ? `/api/asset-image/${id}` : null;
}
export function resetImageCacheForTests() {
  images.clear();
  bindings.clear();
  total = 0;
  budget = { windowStart: 0, used: 0 };
}
