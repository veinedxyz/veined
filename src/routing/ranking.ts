import type { RoutingQuote } from "./model";
import { platformFee } from "./fee-policy";
export type RankMode = "value" | "cost" | "time";
function usd(value?: string): bigint | null {
  if (!value || !/^\d{1,30}(\.\d{1,18})?$/.test(value)) return null;
  const [a, b = ""] = value.split(".");
  return BigInt(a) * 10n ** 18n + BigInt(b.padEnd(18, "0"));
}
export function routeCost(q: RoutingQuote): bigint | null {
  const amounts = q.fees.map((f) => usd(f.usd));
  return amounts.some((a) => a === null)
    ? null
    : amounts.reduce<bigint>((a, b) => a + b!, 0n);
}
export function userNet(q: RoutingQuote): bigint | null {
  const output = usd(q.outputUsd);
  if (output === null) return null;
  const extra = q.fees.filter((f) => !f.included).map((f) => usd(f.usd));
  if (extra.some((v) => v === null)) return null;
  return output - extra.reduce<bigint>((a, b) => a + b!, 0n);
}
export function rankRoutes(
  quotes: RoutingQuote[],
  mode: RankMode,
  now = Date.now(),
): RoutingQuote[] {
  const valid = quotes.filter(
    (q) =>
      q.observedAt <= now &&
      q.expiresAt > now &&
      (q.priceImpact === null || q.priceImpact <= 0.15),
  );
  const seen = new Set<string>();
  return valid
    .filter((q) => {
      const key = JSON.stringify([
        q.binding,
        q.expected,
        q.minimum,
        q.outputUsd,
        q.duration,
        q.fees,
        q.steps.map((s) => [
          s.tool,
          s.sourceAsset.address,
          s.destinationAsset.address,
        ]),
      ]);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      if (mode === "time" && a.duration !== b.duration)
        return a.duration - b.duration;
      const x = mode === "cost" ? routeCost(a) : userNet(a),
        y = mode === "cost" ? routeCost(b) : userNet(b);
      if (x !== null && y !== null && x !== y)
        return mode === "cost" ? (x < y ? -1 : 1) : x > y ? -1 : 1;
      if ((x === null) !== (y === null)) return x === null ? 1 : -1;
      const an = BigInt(a.expected) - BigInt(platformFee(a.expected)),
        bn = BigInt(b.expected) - BigInt(platformFee(b.expected));
      return an !== bn ? (an > bn ? -1 : 1) : a.id.localeCompare(b.id);
    });
}
