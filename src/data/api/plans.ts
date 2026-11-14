// Commercial readiness only. Billing is OFF: no prices, invoices, charges or payment integration.
export const billingEnabled = false as const;
export const SCOPES = [
  "chains:read",
  "portfolio:read",
  "balances:read",
  "activity:read",
  "tokens:read",
] as const;
export type Scope = (typeof SCOPES)[number];
export interface Plan {
  id: "internal" | "developer" | "starter" | "pro";
  requestsPerMinute: number;
  requestsPerDay: number;
  costUnitsPerDay: number;
  concurrentRequests: number;
  maxPortfolioChains: number;
  historyDepthBlocks: number | null;
}
export const PLANS: Record<Plan["id"], Plan> = {
  internal: {
    id: "internal",
    requestsPerMinute: 600,
    requestsPerDay: 500000,
    costUnitsPerDay: 5000000,
    concurrentRequests: 16,
    maxPortfolioChains: 2000,
    historyDepthBlocks: null,
  },
  developer: {
    id: "developer",
    requestsPerMinute: 30,
    requestsPerDay: 5000,
    costUnitsPerDay: 20000,
    concurrentRequests: 2,
    maxPortfolioChains: 50,
    historyDepthBlocks: 100000,
  },
  starter: {
    id: "starter",
    requestsPerMinute: 120,
    requestsPerDay: 50000,
    costUnitsPerDay: 250000,
    concurrentRequests: 4,
    maxPortfolioChains: 150,
    historyDepthBlocks: 1000000,
  },
  pro: {
    id: "pro",
    requestsPerMinute: 600,
    requestsPerDay: 500000,
    costUnitsPerDay: 2500000,
    concurrentRequests: 10,
    maxPortfolioChains: 400,
    historyDepthBlocks: null,
  },
};
export function planOf(id: string): Plan {
  if (!(id in PLANS)) throw Error("UNKNOWN_PLAN");
  return PLANS[id as Plan["id"]];
}
export function validScopes(scopes: string[]): Scope[] {
  const unique = [...new Set(scopes)];
  if (
    !unique.length ||
    unique.some((s) => !(SCOPES as readonly string[]).includes(s))
  )
    throw Error("INVALID_SCOPE");
  return unique as Scope[];
}
// Metering units (not money). Expensive scans are pre-charged by the chains they may check, so
// one cheap request can never buy an unbounded scan.
export const COST = {
  chains: 1,
  chain: 1,
  coverage: 1,
  nativeBalance: 1,
  tokenBalancesPage: 2,
  balances: 3,
  activityPage: 2,
  token: 1,
  metrics: 1,
  catalog: 1,
  portfolio: (chains: number) => 2 + Math.max(1, Math.ceil(chains)),
} as const;
export function latencyBucket(ms: number) {
  return ms < 100
    ? "lt100"
    : ms < 500
      ? "lt500"
      : ms < 2000
        ? "lt2000"
        : ms < 10000
          ? "lt10000"
          : "ge10000";
}
