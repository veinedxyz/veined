import type { Holding } from "./model";
// Detected USD value of non-spam holdings. Its own dependency-free module so the first-load bundle (home portfolio
// summary) does not pull the portfolio model's address codecs and hash libraries (V1.9 bundle budget).
export function detectedValue(holdings: Holding[]) {
  return holdings.reduce(
    (sum, h) =>
      sum + (h.spam || h.position?.role === "debt" ? 0 : (h.usd ?? 0)),
    0,
  );
}
