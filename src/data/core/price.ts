import { z } from "zod";
// Provider-neutral price evidence. Presentation only: never enters transaction amounts.
export const priceEvidenceSchema = z
  .object({
    priceUsd: z
      .string()
      .regex(/^(0|[1-9]\d{0,14})(\.\d{1,18})?$/)
      .nullable(),
    observedAt: z.number().int().nonnegative().nullable(),
    confidence: z.enum(["verified", "derived", "unknown"]),
    method: z.string().regex(/^[a-z0-9-]{1,48}$/),
  })
  .strict();
export type PriceEvidence = z.infer<typeof priceEvidenceSchema>;
export const PRICE_MAX_AGE_MS = 300000;
export function unknownPrice(method = "none"): PriceEvidence {
  return { priceUsd: null, observedAt: null, confidence: "unknown", method };
}
// Routing token lists are existing read-only quote infrastructure; their prices are derived evidence.
export function derivedPrice(
  raw: unknown,
  observedAt: number,
  method: string,
): PriceEvidence {
  const text = typeof raw === "number" ? String(raw) : raw;
  const parsed = priceEvidenceSchema.shape.priceUsd.safeParse(text);
  if (!parsed.success || parsed.data === null) return unknownPrice(method);
  return {
    priceUsd: parsed.data,
    observedAt,
    confidence: "derived",
    method,
  };
}
export function freshPrice(
  price: PriceEvidence | undefined,
  now = Date.now(),
  maxAge = PRICE_MAX_AGE_MS,
): string | null {
  if (
    !price ||
    price.confidence === "unknown" ||
    price.priceUsd === null ||
    price.observedAt === null ||
    price.observedAt > now ||
    now - price.observedAt > maxAge
  )
    return null;
  return price.priceUsd;
}
const SCALE = 18;
function scaled(decimal: string): bigint {
  const [whole, fraction = ""] = decimal.split(".");
  return BigInt(whole + fraction.padEnd(SCALE, "0").slice(0, SCALE));
}
// Fixed-point USD value as a decimal string with 6 fractional digits; null when unknown.
export function usdValue(
  balance: bigint,
  decimals: number,
  priceUsd: string | null,
): string | null {
  if (priceUsd === null || balance < 0n || decimals < 0 || decimals > 36)
    return null;
  const value = (balance * scaled(priceUsd)) / 10n ** BigInt(decimals);
  const micro = value / 10n ** BigInt(SCALE - 6);
  const whole = micro / 1000000n,
    fraction = (micro % 1000000n).toString().padStart(6, "0");
  return `${whole}.${fraction}`;
}
