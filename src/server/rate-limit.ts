import type { DataStore } from "../data/store/types";
// Distributed-ready rate limiting. Memory is a deterministic dev/test limiter; the datastore limiter
// uses an atomic Postgres upsert so concurrent instances share one counter per bucket/window.
export interface RateLimitPolicy {
  limit: number;
  windowSeconds: number;
  cost?: number;
}
export interface RateLimitResult {
  allowed: boolean;
  count: number;
  remaining: number;
  resetAt: number;
  backend: "memory" | "postgres";
}
export interface RateLimiter {
  readonly backend: "memory" | "postgres";
  consume(key: string, policy: RateLimitPolicy): Promise<RateLimitResult>;
}
export class RateLimitUnavailable extends Error {
  constructor() {
    super("RATE_LIMIT_UNAVAILABLE");
    this.name = "RateLimitUnavailable";
  }
}
const windowOf = (now: number, seconds: number) =>
  Math.floor(now / (seconds * 1000)) * seconds * 1000;
function validate(key: string, p: RateLimitPolicy) {
  if (!/^[a-z0-9:._-]{1,190}$/i.test(key))
    throw Error("RATE_LIMIT_KEY_INVALID");
  if (
    !Number.isInteger(p.limit) ||
    p.limit < 1 ||
    !Number.isInteger(p.windowSeconds) ||
    p.windowSeconds < 1
  )
    throw Error("RATE_LIMIT_POLICY_INVALID");
  const cost = p.cost ?? 1;
  if (!Number.isInteger(cost) || cost < 1 || cost > 10000)
    throw Error("RATE_LIMIT_COST_INVALID");
  return cost;
}
export class MemoryRateLimiter implements RateLimiter {
  readonly backend = "memory" as const;
  private buckets = new Map<string, { start: number; count: number }>();
  constructor(
    private now: () => number = Date.now,
    private maxKeys = 50000,
  ) {}
  async consume(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    const cost = validate(key, policy);
    const now = this.now(),
      start = windowOf(now, policy.windowSeconds),
      id = `${key}|${policy.windowSeconds}`;
    let bucket = this.buckets.get(id);
    if (!bucket || bucket.start !== start) {
      if (this.buckets.size >= this.maxKeys)
        for (const [k, b] of this.buckets)
          if (b.start < start) this.buckets.delete(k);
      if (this.buckets.size >= this.maxKeys) throw new RateLimitUnavailable();
      bucket = { start, count: 0 };
      this.buckets.set(id, bucket);
    }
    bucket.count += cost;
    return {
      allowed: bucket.count <= policy.limit,
      count: bucket.count,
      remaining: Math.max(0, policy.limit - bucket.count),
      resetAt: start + policy.windowSeconds * 1000,
      backend: "memory",
    };
  }
}
export class StoreRateLimiter implements RateLimiter {
  readonly backend = "postgres" as const;
  constructor(
    private store: DataStore,
    private now: () => number = Date.now,
  ) {}
  async consume(
    key: string,
    policy: RateLimitPolicy,
  ): Promise<RateLimitResult> {
    const cost = validate(key, policy);
    const start = windowOf(this.now(), policy.windowSeconds);
    let count: number;
    try {
      count = await this.store.consumeBucket(
        `${key}|${policy.windowSeconds}`,
        start,
        policy.windowSeconds,
        cost,
      );
    } catch {
      throw new RateLimitUnavailable();
    }
    return {
      allowed: count <= policy.limit,
      count,
      remaining: Math.max(0, policy.limit - count),
      resetAt: start + policy.windowSeconds * 1000,
      backend: "postgres",
    };
  }
}
// Fallback only where durable protection is not required; otherwise the durable limiter fails closed.
export class FallbackRateLimiter implements RateLimiter {
  readonly backend: "memory" | "postgres";
  constructor(
    private primary: RateLimiter,
    private fallback: RateLimiter,
    private failClosed: boolean,
  ) {
    this.backend = primary.backend;
  }
  async consume(key: string, policy: RateLimitPolicy) {
    try {
      return await this.primary.consume(key, policy);
    } catch (error) {
      if (this.failClosed || !(error instanceof RateLimitUnavailable))
        throw error;
      return this.fallback.consume(key, policy);
    }
  }
}
