// Endpoint health is advisory selection state. Failures lower the score; they never mutate chain data.
export interface EndpointHealth {
  ok: number;
  errors: number;
  consecutiveFailures: number;
  latencyMs: number | null;
  errorRate: number;
  latestBlock: bigint | null;
  checkedAt: number;
  quarantinedUntil: number | null;
  quarantineReason: string | null;
}
export const freshHealth = (): EndpointHealth => ({
  ok: 0,
  errors: 0,
  consecutiveFailures: 0,
  latencyMs: null,
  errorRate: 0,
  latestBlock: null,
  checkedAt: 0,
  quarantinedUntil: null,
  quarantineReason: null,
});
const EWMA = 0.3;
// Integrity quarantines (wrong chain, unsafe DNS, rejected URL, outvoted log set) are not lifted by a
// later successful call such as a health probe: an endpoint that lied keeps its penalty until expiry.
const STICKY_REASONS = new Set([
  "CHAIN_MISMATCH",
  "UNSAFE_DNS",
  "URL_REJECTED",
  "LOG_SET_MISMATCH",
]);
export function recordSuccess(
  h: EndpointHealth,
  latencyMs: number,
  now: number,
  block?: bigint,
): EndpointHealth {
  const sticky =
    h.quarantineReason !== null &&
    STICKY_REASONS.has(h.quarantineReason) &&
    quarantined(h, now);
  return {
    ...h,
    ok: h.ok + 1,
    consecutiveFailures: 0,
    latencyMs:
      h.latencyMs === null
        ? latencyMs
        : Math.round(h.latencyMs * (1 - EWMA) + latencyMs * EWMA),
    errorRate: h.errorRate * (1 - EWMA),
    latestBlock:
      block !== undefined && (h.latestBlock === null || block > h.latestBlock)
        ? block
        : h.latestBlock,
    checkedAt: now,
    quarantinedUntil: sticky ? h.quarantinedUntil : null,
    quarantineReason: sticky ? h.quarantineReason : null,
  };
}
export function recordFailure(
  h: EndpointHealth,
  code: string,
  now: number,
): EndpointHealth {
  const consecutive = h.consecutiveFailures + 1;
  let until: number | null = h.quarantinedUntil;
  let reason = h.quarantineReason;
  if (
    code === "CHAIN_MISMATCH" ||
    code === "UNSAFE_DNS" ||
    code === "URL_REJECTED"
  ) {
    until = now + 24 * 3600000;
    reason = code;
  } else if (code === "LOG_SET_MISMATCH") {
    // Outvoted by two independent operators on a window's log set (V1.5 witness tiebreak).
    until = now + 3600000;
    reason = code;
  } else if (code === "RATE_LIMITED") {
    until = now + 30000;
    reason = code;
  } else if (consecutive >= 3) {
    until = now + Math.min(3600000, 60000 * 2 ** (consecutive - 3));
    reason = code;
  }
  return {
    ...h,
    errors: h.errors + 1,
    consecutiveFailures: consecutive,
    errorRate: h.errorRate * (1 - EWMA) + EWMA,
    checkedAt: now,
    quarantinedUntil: until,
    quarantineReason: reason,
  };
}
export const quarantined = (h: EndpointHealth, now: number) =>
  h.quarantinedUntil !== null && h.quarantinedUntil > now;
// Head lag beyond tolerance means the endpoint is stale; absence from a stale node is never absence on-chain.
export function lagging(
  h: EndpointHealth,
  bestHead: bigint | null,
  tolerance = 64n,
) {
  return (
    bestHead !== null &&
    h.latestBlock !== null &&
    bestHead - h.latestBlock > tolerance
  );
}
export function score(
  h: EndpointHealth,
  now: number,
  bestHead: bigint | null = null,
): number {
  if (quarantined(h, now) || lagging(h, bestHead)) return 0;
  const latency = h.latencyMs === null ? 0.5 : 1 / (1 + h.latencyMs / 500);
  return Math.max(0.01, (1 - h.errorRate) * (0.5 + latency / 2));
}
