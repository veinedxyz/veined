export interface PriceObservation {
  usd: number | null;
  observedAt: number;
  source: string;
}
// Fiat is presentation only. Base-unit transaction amounts never enter this layer.
export function currentPrice(
  observations: PriceObservation[],
  now = Date.now(),
  maxAge = 300000,
): number | null {
  const current = observations.filter(
    (p) =>
      p.usd !== null &&
      Number.isFinite(p.usd) &&
      p.usd >= 0 &&
      p.observedAt <= now &&
      now - p.observedAt <= maxAge,
  );
  if (!current.length) return null;
  const values = current.map((p) => p.usd!),
    min = Math.min(...values),
    max = Math.max(...values);
  if (max !== min && (min === 0 || (max - min) / min > 0.05)) return null;
  return current[0].usd;
}
