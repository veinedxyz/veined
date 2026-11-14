import { RoutingError } from "../routing/model";
import { checkOrigin, clientKey, originPolicy } from "./origin-policy";
import {
  FallbackRateLimiter,
  MemoryRateLimiter,
  RateLimitUnavailable,
  StoreRateLimiter,
  type RateLimiter,
} from "./rate-limit";
import { dataConfig } from "../data/config";
import { getDataPlane } from "../data/plane";
import { registry } from "../data/observability/metrics";
let limiter: RateLimiter | undefined;
const memory = new MemoryRateLimiter();
// App limiter: datastore-backed when configured; production deployments that require durable
// protection fail closed instead of silently falling back to process memory.
export async function appLimiter(): Promise<RateLimiter> {
  if (limiter) return limiter;
  const config = dataConfig();
  if (config.errors.length) throw new RoutingError("CONFIG_INVALID");
  if (config.rateLimitBackend === "postgres") {
    const plane = await getDataPlane();
    if (!plane.store) throw new RoutingError("CONFIG_INVALID");
    limiter = new FallbackRateLimiter(
      new StoreRateLimiter(plane.store),
      memory,
      config.requireDurableRateLimit,
    );
  } else limiter = memory;
  return limiter;
}
export function setAppLimiterForTests(value: RateLimiter | undefined) {
  limiter = value;
}
export function originGuard(req: Request) {
  const verdict = checkOrigin(req);
  if (verdict === "CONFIG_INVALID")
    throw new RoutingError("CONFIG_INVALID", 503);
  if (verdict !== "OK") throw new RoutingError("ORIGIN_REJECTED", 403);
}
export async function rateGuard(
  req: Request,
  scope: string,
  max: number,
  windowSeconds = 60,
) {
  let rate: RateLimiter;
  try {
    rate = await appLimiter();
  } catch {
    throw new RoutingError("RATE_LIMIT_UNAVAILABLE", 503);
  }
  const client = clientKey(req, originPolicy());
  try {
    // Without trusted-proxy attribution the scope-wide ceiling equals the V1.3 limit.
    const global = await rate.consume(`app:${scope}:all`, {
      limit: client ? max * 20 : max,
      windowSeconds,
    });
    if (!global.allowed) throw new RoutingError("RATE_LIMITED", 429);
    if (client) {
      const own = await rate.consume(`app:${scope}:c:${client}`, {
        limit: max,
        windowSeconds,
      });
      if (!own.allowed) throw new RoutingError("RATE_LIMITED", 429);
    }
  } catch (error) {
    if (error instanceof RateLimitUnavailable)
      throw new RoutingError("RATE_LIMIT_UNAVAILABLE", 503);
    throw error;
  }
}
// Client-requested upstream refreshes share a small global allowance so they cannot drain
// external quotas for everyone; beyond it the cached catalog is served.
export async function refreshAllowed(scope: string) {
  try {
    return (
      await (
        await appLimiter()
      ).consume(`app:${scope}:refresh`, { limit: 2, windowSeconds: 60 })
    ).allowed;
  } catch {
    return false;
  }
}
export async function apiGuard(req: Request, scope: string, max = 30) {
  originGuard(req);
  if (!req.headers.get("content-type")?.startsWith("application/json"))
    throw new RoutingError("INVALID_REQUEST");
  await rateGuard(req, scope, max);
}
// V1.5: every app API error path passes here, so bounded error-code counters are recorded once.
export function guardStatus(code: string) {
  const reason = /^[A-Z][A-Z0-9_]{0,39}$/.test(code) ? code : "OTHER";
  registry().inc(
    "app_api_errors_total",
    { code: reason },
    1,
    "App API error responses by safe code.",
  );
  if (code === "ORIGIN_REJECTED")
    registry().inc(
      "app_origin_rejections_total",
      {},
      1,
      "Requests refused by the exact-origin policy.",
    );
  if (
    ["WRITE_DISABLED", "EXECUTION_PAUSED", "MAINNET_WRITE_DISABLED"].includes(
      code,
    )
  )
    registry().inc(
      "security_kill_switch_blocks_total",
      { code },
      1,
      "Execution attempts refused by the frozen gate/kill switch.",
    );
  return code === "RATE_LIMITED"
    ? 429
    : code === "ORIGIN_REJECTED"
      ? 403
      : code === "CONFIG_INVALID" || code === "RATE_LIMIT_UNAVAILABLE"
        ? 503
        : 422;
}
