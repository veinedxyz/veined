// Server-only NEAR Intents (1Click) reader. Fixed origin (no caller URL), GET /v0/tokens and DRY quotes only, hard
// timeout, no redirects, bounded streaming body, schema-validated output. A dry quote opens no deposit address; VEINED
// never asks for a real one. The quote response is returned exactly as received (`raw`) next to its parsed view, so
// its 1Click signature can be verified on the signed bytes. An optional partner JWT (VEINED_NEAR_INTENTS_JWT) is sent
// only to the fixed 1Click origin.
import {
  INTENTS_ORIGIN,
  intentsQuoteRequestSchema,
  intentsQuoteResponseSchema,
  intentsTokensSchema,
  type IntentsQuoteRequest,
  type IntentsQuoteResponse,
  type IntentsToken,
} from "../intents";
import { BodyTooLarge, readBounded } from "./bounded";

export class IntentsError extends Error {
  constructor(
    public code:
      | "INTENTS_UNAVAILABLE"
      | "INTENTS_REJECTED"
      | "INTENTS_INVALID"
      | "INTENTS_AUTH_REQUIRED",
  ) {
    super(code);
    this.name = "IntentsError";
  }
}
type Fetch = typeof fetch;
// Chains VEINED users arrive from, plus NEAR itself (1Click `blockchain` values).
export const INTENTS_CHAINS = [
  "near",
  "eth",
  "base",
  "arb",
  "bsc",
  "sol",
  "btc",
  "pol",
  "op",
] as const;

async function read(
  fetcher: Fetch,
  path: string,
  init: RequestInit,
  maxBytes: number,
  signal?: AbortSignal,
) {
  const jwt = process.env.VEINED_NEAR_INTENTS_JWT;
  let r: Response;
  try {
    r = await fetcher(`${INTENTS_ORIGIN}${path}`, {
      ...init,
      headers: {
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(jwt && /^[A-Za-z0-9._-]{20,4096}$/.test(jwt)
          ? { Authorization: `Bearer ${jwt}` }
          : {}),
      },
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.any([
        AbortSignal.timeout(8000),
        ...(signal ? [signal] : []),
      ]),
    });
  } catch {
    throw new IntentsError("INTENTS_UNAVAILABLE");
  }
  if (r.status === 401 || r.status === 403) {
    await r.body?.cancel().catch(() => {});
    throw new IntentsError("INTENTS_AUTH_REQUIRED");
  }
  if (r.status >= 400 && r.status < 500) {
    await r.body?.cancel().catch(() => {});
    throw new IntentsError("INTENTS_REJECTED");
  }
  if (!r.ok) {
    await r.body?.cancel().catch(() => {});
    throw new IntentsError("INTENTS_UNAVAILABLE");
  }
  let text: string;
  try {
    text = await readBounded(r, maxBytes);
  } catch (e) {
    throw new IntentsError(
      e instanceof BodyTooLarge ? "INTENTS_INVALID" : "INTENTS_UNAVAILABLE",
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new IntentsError("INTENTS_INVALID");
  }
}

let cache: { at: number; tokens: IntentsToken[] } | undefined;
export function resetIntentsCacheForTests() {
  cache = undefined;
}
/** Public token list, cached for five minutes, limited to the chains VEINED shows. */
export async function intentsTokens(
  fetcher: Fetch = fetch,
  now = Date.now(),
  signal?: AbortSignal,
) {
  if (cache && now - cache.at < 300_000) return cache.tokens;
  const parsed = intentsTokensSchema.safeParse(
    await read(fetcher, "/v0/tokens", { method: "GET" }, 4_000_000, signal),
  );
  if (!parsed.success) throw new IntentsError("INTENTS_INVALID");
  const tokens = parsed.data.filter((t) =>
    (INTENTS_CHAINS as readonly string[]).includes(t.blockchain),
  );
  cache = { at: now, tokens };
  return tokens;
}
/** A dry quote: the schema makes `dry: true` mandatory, so no deposit address can ever be requested. */
export async function intentsDryQuote(
  request: IntentsQuoteRequest,
  fetcher: Fetch = fetch,
  signal?: AbortSignal,
): Promise<{ raw: unknown; parsed: IntentsQuoteResponse }> {
  const body = intentsQuoteRequestSchema.parse(request);
  const raw = await read(
    fetcher,
    "/v0/quote",
    { method: "POST", body: JSON.stringify(body) },
    256_000,
    signal,
  );
  const parsed = intentsQuoteResponseSchema.safeParse(raw);
  if (!parsed.success) throw new IntentsError("INTENTS_INVALID");
  return { raw, parsed: parsed.data };
}
