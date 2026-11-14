export const WAD = 10n ** 18n,
  Q96 = 2n ** 96n;
export const UINT128_MAX = 2n ** 128n - 1n,
  UINT256_MAX = 2n ** 256n - 1n;
export function uint(v: unknown, max = UINT256_MAX): bigint {
  if (typeof v !== "bigint" || v < 0n || v > max) throw Error("MALFORMED_UINT");
  return v;
}
export function mulDiv(a: bigint, b: bigint, d: bigint, up = false) {
  uint(a);
  uint(b);
  if (d <= 0n) throw Error("ZERO_DENOMINATOR");
  const n = a * b;
  return n / d + (up && n % d > 0n ? 1n : 0n);
}
export function decimal(raw: bigint, decimals: number) {
  const sign = raw < 0n ? "-" : "",
    s = (raw < 0n ? -raw : raw).toString().padStart(decimals + 1, "0");
  return (
    sign + (decimals ? s.slice(0, -decimals) + "." + s.slice(-decimals) : s)
  );
}
export function micros(value: string) {
  if (!/^-?\d+(\.\d{1,18})?$/.test(value)) throw Error("INVALID_DECIMAL");
  const neg = value.startsWith("-"),
    [w, f = ""] = (neg ? value.slice(1) : value).split(".");
  return (neg ? -1n : 1n) * BigInt(w + f.padEnd(6, "0").slice(0, 6));
}
export const sumUsd = (values: (string | null | undefined)[]) =>
  decimal(
    values.reduce<bigint>((a, b) => a + (b ? micros(b) : 0n), 0n),
    6,
  );
/** Morpho SharesMathLib: virtual assets=1, virtual shares=1e6; debt rounds UP. */
export function sharesToAssets(
  shares: bigint,
  assets: bigint,
  totalShares: bigint,
  debt = false,
) {
  return mulDiv(shares, assets + 1n, totalShares + 1000000n, debt);
}
/** MorphoBalancesLib expected state including fee shares, using its Taylor compounding. */
export function accrueMorpho(
  m: readonly bigint[],
  rate: bigint,
  timestamp: bigint,
) {
  if (m.length !== 6) throw Error("MALFORMED_MARKET");
  m.forEach((v) => uint(v, UINT128_MAX));
  const [sa, ss, ba, bs, last, fee] = m;
  if (timestamp < last || fee > WAD) throw Error("STALE_MARKET");
  const first = uint(rate) * (timestamp - last),
    second = (first * first) / (2n * WAD),
    third = (second * first) / (3n * WAD),
    interest = (ba * (first + second + third)) / WAD;
  const supply = sa + interest,
    borrow = ba + interest;
  uint(supply, UINT128_MAX);
  uint(borrow, UINT128_MAX);
  const f = (interest * fee) / WAD;
  return {
    supplyAssets: supply,
    supplyShares: ss + mulDiv(f, ss + 1000000n, supply - f + 1n),
    borrowAssets: borrow,
    borrowShares: bs,
  };
}
/** Uniswap TickMath (GPL-2.0), integer port of pinned official getSqrtRatioAtTick. */
const ratios = [
  "fffcb933bd6fad37aa2d162d1a594001",
  "fff97272373d413259a46990580e213a",
  "fff2e50f5f656932ef12357cf3c7fdcc",
  "ffe5caca7e10e4e61c3624eaa0941cd0",
  "ffcb9843d60f6159c9db58835c926644",
  "ff973b41fa98c081472e6896dfb254c0",
  "ff2ea16466c96a3843ec78b326b52861",
  "fe5dee046a99a2a811c461f1969c3053",
  "fcbe86c7900a88aedcffc83b479aa3a4",
  "f987a7253ac413176f2b074cf7815e54",
  "f3392b0822b70005940c7a398e4b70f3",
  "e7159475a2c29b7443b29c7fa6e889d9",
  "d097f3bdfd2022b8845ad8f792aa5825",
  "a9f746462d870fdf8a65dc1f90e061e5",
  "70d869a156d2a1b890bb3df62baf32f7",
  "31be135f97d08fd981231505542fcfa6",
  "9aa508b5b7a84e1c677de54f3e99bc9",
  "5d6af8dedb81196699c329225ee604",
  "2216e584f5fa1ea926041bedfe98",
  "48a170391f7dc42444e8fa2",
];
export function sqrtAtTick(tick: number) {
  if (!Number.isInteger(tick) || Math.abs(tick) > 887272)
    throw Error("INVALID_TICK");
  const a = Math.abs(tick);
  let r = 1n << 128n;
  for (let i = 0; i < 20; i++)
    if (a & (1 << i)) r = (r * BigInt("0x" + ratios[i])) >> 128n;
  if (tick > 0) r = UINT256_MAX / r;
  return (r >> 32n) + (r % (1n << 32n) > 0n ? 1n : 0n);
}
/** LiquidityAmounts.getAmountsForLiquidity rounds each current constituent down. */
export function liquidityAmounts(
  liquidity: bigint,
  sqrt: bigint,
  lower: number,
  upper: number,
) {
  uint(liquidity, UINT128_MAX);
  if (lower >= upper || sqrt <= 0n) throw Error("INVALID_RANGE");
  const a = sqrtAtTick(lower),
    b = sqrtAtTick(upper);
  const amount0 = (x: bigint, y: bigint) =>
    ((liquidity << 96n) * (y - x)) / y / x;
  const amount1 = (x: bigint, y: bigint) => (liquidity * (y - x)) / Q96;
  return sqrt <= a
    ? [amount0(a, b), 0n]
    : sqrt < b
      ? [amount0(sqrt, b), amount1(a, sqrt)]
      : [0n, amount1(a, b)];
}
