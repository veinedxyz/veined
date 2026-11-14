import { SwapError } from "../model";
import { CANARY_RPC_POOL, RPC_ORIGINS } from "./config";

const APIs: Readonly<Record<string, readonly string[]>> = Object.freeze({
  "https://trade-api.gateway.uniswap.org": ["/v1/quote"],
  "https://x.pancakeswap.com": ["/order-price/get-price"],
  "https://api.jup.ag": ["/swap/v2/order", "/swap/v2/build"],
});
// G14 protected proposal B4: the canary's read-only RPC pool. Exact URL strings only — no trailing-slash variant,
// no other path, port, credential, fragment or scheme, and nothing derived from a request.
export const CANARY_RPC_URLS: readonly string[] = Object.freeze(
  Object.values(CANARY_RPC_POOL).flatMap((pool) => pool.map((s) => s.url)),
);
export function assertSwapEgress(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SwapError("REVIEW_REQUIRED");
  }
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    u.hash ||
    (!APIs[u.origin]?.includes(u.pathname) &&
      !Object.values(RPC_ORIGINS).some((v) => raw === v || raw === v + "/") &&
      !CANARY_RPC_URLS.includes(raw))
  )
    throw new SwapError("REVIEW_REQUIRED");
  return u.origin;
}

/** Shared by Uniswap classic and X. Refuse excess work; never queue or retry storms. */
export class ProviderQuota {
  private windows = new Map<string, { calls: number[]; until: number }>();
  take(origin: string, now = Date.now()) {
    const limit =
      origin === "https://trade-api.gateway.uniswap.org"
        ? 5
        : origin === "https://x.pancakeswap.com"
          ? 5
          : origin === "https://api.jup.ag"
            ? 1
            : null;
    if (limit === null) return;
    const state = this.windows.get(origin) ?? { calls: [], until: 0 };
    state.calls = state.calls.filter((at) => at > now - 1000);
    this.windows.set(origin, state);
    if (state.until > now || state.calls.length >= limit)
      throw new SwapError("RATE_LIMITED");
    state.calls.push(now);
  }
  throttle(origin: string, now = Date.now()) {
    if (!APIs[origin]) return;
    const state = this.windows.get(origin) ?? { calls: [], until: 0 };
    state.until = Math.max(state.until, now + 60000);
    this.windows.set(origin, state);
  }
}
const globals = globalThis as typeof globalThis & {
  __otherbridgeProviderQuota?: ProviderQuota;
};
export const providerQuota = (globals.__otherbridgeProviderQuota ??=
  new ProviderQuota());
