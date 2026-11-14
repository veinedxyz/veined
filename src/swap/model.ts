import { z } from "zod";
import { base58 } from "@scure/base";

export const MODES = [
  "UNISWAP",
  "UNISWAPX",
  "PANCAKESWAP_SMART",
  "PANCAKESWAP_X_INTENT",
  "AERODROME_CLASSIC",
  "AERODROME_SLIPSTREAM",
  "JUPITER_META",
  "JUPITER_ROUTER",
  "TITAN",
] as const;
export type ProviderMode = (typeof MODES)[number];
export type Provider =
  | "Uniswap"
  | "PancakeSwap"
  | "PancakeSwap X"
  | "Aerodrome"
  | "Jupiter"
  | "Titan";
export const ERRORS = [
  "INVALID_REQUEST",
  "NO_LIQUIDITY",
  "UNSUPPORTED_TOKEN",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_TIMEOUT",
  "CREDENTIAL_REQUIRED",
  "QUOTE_STALE",
  "HIGH_PRICE_IMPACT",
  "SIMULATION_FAILED",
  "BUILD_REVIEW_REQUIRED",
  "EXECUTION_CLOSED",
  "REVIEW_REQUIRED",
  "RATE_LIMITED",
  "INVALID_SCHEMA",
  "HTTP_4XX",
  "HTTP_5XX",
  "CANCELLED",
] as const;
export type SwapCode = (typeof ERRORS)[number];
export class SwapError extends Error {
  constructor(public code: SwapCode) {
    super(code);
    this.name = "SwapError";
  }
}
export const ZERO = "0x0000000000000000000000000000000000000000";
export const SOL = "So11111111111111111111111111111111111111112";
export const POLICY = Object.freeze({
  maxSlippageBps: 300,
  autoSlippageBps: 50,
  maxImpactBps: 1500,
  ttlMs: 20_000,
  timeoutMs: 8_000,
  cacheMs: 2_000,
  concurrency: 2,
  maxEntries: 128,
  coalesceMs: 100,
});
export const EXECUTION = Object.freeze({
  state: "CLOSED" as const,
  enabled: false as const,
  sign: null,
  approve: null,
  permit: null,
  broadcast: null,
  deploy: null,
  collectFee: null,
});
export function executeSwap(): never {
  throw new SwapError("EXECUTION_CLOSED");
}
export const rawUnits = z
  .union([
    z.bigint(),
    z
      .string()
      .regex(/^(0|[1-9]\d{0,77})$/)
      .transform(BigInt),
  ])
  .refine((x) => x >= 0n && x < 2n ** 256n);
export const tokenSchema = z
  .object({
    chain: z.string().min(1).max(20),
    address: z.string().min(1).max(64),
    decimals: z.number().int().min(0).max(36),
    symbol: z.string().max(32),
    native: z.boolean(),
  })
  .strict();
export type SwapToken = z.infer<typeof tokenSchema>;
export const intentSchema = z
  .object({
    ecosystem: z.enum(["EVM", "SVM"]),
    chain: z.enum(["1", "56", "8453", "solana"]),
    taker: z.string().max(64),
    recipient: z.string().max(64),
    tokenIn: tokenSchema,
    tokenOut: tokenSchema,
    kind: z.enum(["EXACT_IN", "EXACT_OUT"]),
    amount: rawUnits.refine((x) => x > 0n),
    slippage: z
      .object({
        mode: z.enum(["AUTO", "MANUAL"]),
        bps: z.number().int().min(1).max(POLICY.maxSlippageBps),
      })
      .strict(),
    preference: z.enum(["RECOMMENDED", "OUTPUT", "FASTEST", "DIRECT"]),
    walletEpoch: z.number().int().nonnegative(),
    portfolioRevision: z.string().max(100),
    expiresAt: z.number().int().positive(),
  })
  .strict()
  .superRefine((i, ctx) => {
    const valid = (a: string) => validIdentity(a, i.ecosystem);
    if (
      (i.chain === "solana") !== (i.ecosystem === "SVM") ||
      !valid(i.taker) ||
      !valid(i.recipient) ||
      i.taker === ZERO ||
      i.recipient === ZERO ||
      i.amount >= (i.ecosystem === "SVM" ? 2n ** 64n : 2n ** 256n)
    )
      ctx.addIssue({ code: "custom", message: "identity" });
    for (const t of [i.tokenIn, i.tokenOut])
      if (
        t.chain !== i.chain ||
        !valid(t.address) ||
        (t.native && t.address !== (i.ecosystem === "SVM" ? SOL : ZERO))
      )
        ctx.addIssue({ code: "custom", message: "token identity" });
    if (identity(i.tokenIn.address) === identity(i.tokenOut.address))
      ctx.addIssue({ code: "custom", message: "same token" });
  });
export type SwapIntent = z.infer<typeof intentSchema>;
export function validIdentity(a: string, ecosystem: "EVM" | "SVM") {
  if (ecosystem === "EVM") return /^0x[0-9a-f]{40}$/i.test(a);
  try {
    return base58.decode(a).length === 32;
  } catch {
    return false;
  }
}
export const identity = (s: string) =>
  /^0x[0-9a-f]{40}$/i.test(s) ? s.toLowerCase() : s;
export function canonical(value: unknown): string {
  if (typeof value === "bigint") return JSON.stringify(value.toString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
    .join(",")}}`;
}
export const wire = (value: unknown) =>
  JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));
export function parseIntent(value: unknown, now = Date.now()): SwapIntent {
  const r = intentSchema.safeParse(value);
  if (!r.success || r.data.expiresAt <= now || r.data.expiresAt > now + 300_000)
    throw new SwapError("INVALID_REQUEST");
  return r.data;
}
const costSchema = z
  .object({
    kind: z.enum([
      "PROVIDER",
      "PROTOCOL",
      "PLATFORM",
      "NETWORK",
      "PRIORITY",
      "RENT",
      "TIP",
    ]),
    amount: rawUnits.nullable(),
    token: z.string(),
    included: z.boolean(),
    usdMicros: rawUnits.nullable(),
    evidence: z.enum(["UNKNOWN", "PROVIDER", "INDEPENDENT"]),
  })
  .strict();
export type SwapCost = z.infer<typeof costSchema>;
export const legSchema = z
  .object({
    venue: z.string().min(1).max(80),
    poolType: z.enum([
      "V2",
      "V3",
      "V4",
      "INFINITY_CL",
      "INFINITY_BIN",
      "STABLE",
      "VOLATILE",
      "SLIPSTREAM",
      "SOLANA",
      "INTENT",
    ]),
    pool: z.string().min(1).max(128),
    tokenIn: z.string(),
    tokenOut: z.string(),
    shareBps: z.number().int().min(1).max(10000),
    fee: z.number().int().nonnegative().optional(),
    factory: z.string().optional(),
    hook: z.string().optional(),
    branch: z.number().int().min(0).max(7).optional(),
    amountIn: rawUnits.optional(),
    amountOut: rawUnits.optional(),
    tickSpacing: z.number().int().positive().max(32767).optional(),
    parameters: z
      .string()
      .regex(/^0x[0-9a-f]{64}$/i)
      .optional(),
  })
  .strict();
export type RouteLeg = z.infer<typeof legSchema>;
export const quoteSchema = z
  .object({
    id: z.string().min(1).max(128),
    intentDigest: z.string().min(1),
    provider: z.enum([
      "Uniswap",
      "PancakeSwap",
      "PancakeSwap X",
      "Aerodrome",
      "Jupiter",
      "Titan",
    ]),
    mode: z.enum(MODES),
    chain: z.string(),
    ecosystem: z.enum(["EVM", "SVM"]),
    amountIn: rawUnits,
    amountOut: rawUnits,
    minAmountOut: rawUnits,
    maxAmountIn: rawUnits,
    costs: z.array(costSchema).max(32),
    priceImpactBps: z.number().finite().nullable(),
    slippageBps: z.number().int().min(1).max(POLICY.maxSlippageBps),
    route: z.array(legSchema).min(1).max(64),
    hops: z.number().int().min(1).max(32),
    splitCount: z.number().int().min(1).max(16),
    quotedAt: z.number(),
    expiresAt: z.number(),
    sourceBlock: z.string().nullable(),
    latencyMs: z.number().nonnegative(),
    simulation: z.literal("NOT_RUN"),
    build: z.enum(["UNSIGNED_BUILD", "QUOTE_ONLY"]),
    review: z.literal("BUILD_REVIEW_REQUIRED"),
    outputUsdMicros: rawUnits.nullable(),
    inputUsdMicros: rawUnits.nullable(),
    valuation: z.enum(["UNKNOWN", "PROVIDER", "INDEPENDENT"]),
  })
  .strict();
export type SwapQuote = z.infer<typeof quoteSchema>;
export function assertQuote(
  q: SwapQuote,
  i: SwapIntent,
  binding: string,
  now = Date.now(),
) {
  if (
    !quoteSchema.safeParse(q).success ||
    q.chain !== i.chain ||
    q.ecosystem !== i.ecosystem ||
    q.intentDigest !== binding ||
    q.amountIn <= 0n ||
    q.amountOut <= 0n ||
    q.minAmountOut <= 0n ||
    q.minAmountOut > q.amountOut ||
    q.maxAmountIn < q.amountIn ||
    q.slippageBps > i.slippage.bps ||
    q.quotedAt > now + 1000 ||
    q.expiresAt > Math.min(i.expiresAt, q.quotedAt + POLICY.ttlMs)
  )
    throw new SwapError("INVALID_SCHEMA");
  if (q.expiresAt <= now) throw new SwapError("QUOTE_STALE");
  if (
    i.kind === "EXACT_IN" &&
    (q.amountIn !== i.amount ||
      q.maxAmountIn !== i.amount ||
      q.minAmountOut < (q.amountOut * BigInt(10000 - i.slippage.bps)) / 10000n)
  )
    throw new SwapError("INVALID_SCHEMA");
  if (
    i.kind === "EXACT_OUT" &&
    (q.amountOut !== i.amount ||
      q.minAmountOut !== i.amount ||
      q.maxAmountIn >
        (q.amountIn * BigInt(10000 + i.slippage.bps) + 9999n) / 10000n)
  )
    throw new SwapError("INVALID_SCHEMA");
  if (
    !q.costs.some((c) => c.kind === "PLATFORM" && c.amount === 0n) ||
    q.costs.some((c) => c.kind === "PLATFORM" && c.amount !== 0n)
  )
    throw new SwapError("INVALID_SCHEMA");
}
export function quoteEligible(q: SwapQuote, now = Date.now()) {
  return (
    q.expiresAt > now &&
    (q.priceImpactBps === null ||
      Math.abs(q.priceImpactBps) < POLICY.maxImpactBps)
  );
}
export function impactBps(
  value: unknown,
  unit: "FRACTION" | "PERCENT",
): number | null {
  if (value === undefined || value === null) return null;
  if (
    (typeof value !== "number" && typeof value !== "string") ||
    !/^-?\d+(\.\d+)?$/.test(String(value))
  )
    throw new SwapError("INVALID_SCHEMA");
  const n = Number(value) * (unit === "FRACTION" ? 10000 : 100);
  if (!Number.isFinite(n)) throw new SwapError("INVALID_SCHEMA");
  return n;
}
export interface ProviderHealth {
  mode: ProviderMode;
  status: "PENDING" | "OK" | SwapCode;
  latencyMs: number | null;
  quoteCount: number;
}
export type QuoteEvent =
  | { type: "providers"; providers: ProviderHealth[] }
  | { type: "quote"; quote: SwapQuote }
  | { type: "health"; health: ProviderHealth }
  | { type: "settled"; elapsedMs: number };
