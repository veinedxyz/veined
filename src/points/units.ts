// VEINED weekly points: exact fixed-decimal accounting. Every amount is a bigint count of the smallest unit
// (1 unit = 0.000001 point); floating point never touches a balance, weight or allocation.
export const POINT_DECIMALS = 6;
export const UNITS_PER_POINT = 10n ** BigInt(POINT_DECIMALS);
// Owner requirement: exactly 200,000 points per week, referral commissions included. Not configurable.
export const WEEKLY_POOL_POINTS = 200_000n;
export const WEEKLY_POOL_UNITS = WEEKLY_POOL_POINTS * UNITS_PER_POINT;
// Owner requirement: referrers earn exactly 10% of the referred user's final eligible transaction rewards.
export const REFERRAL_COMMISSION_BPS = 1000n;
export const BPS = 10_000n;

const INTEGER = /^-?(0|[1-9]\d{0,38})$/;
export function parseUnits(value: string): bigint {
  if (!INTEGER.test(value)) throw Error("UNITS_INVALID");
  return BigInt(value);
}

/** Integer square root (floor) for non-negative bigints; deterministic, no floating point. */
export function isqrt(value: bigint): bigint {
  if (value < 0n) throw Error("ISQRT_NEGATIVE");
  if (value < 2n) return value;
  let x = BigInt(Math.floor(Math.sqrt(Number(value))));
  // Correct the float seed in both directions so the result is exact for any size.
  while (x * x > value) x--;
  while ((x + 1n) * (x + 1n) <= value) x++;
  return x;
}

export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
