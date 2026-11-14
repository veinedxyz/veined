// Client-safe display helpers for exact point amounts (strings of smallest units). No node imports.
const DECIMALS = 6;

/** Splits a unit string into whole points and a 6-digit fraction without floating point. */
function split(units: string) {
  if (!/^-?\d{1,40}$/.test(units)) throw Error("UNITS_INVALID");
  const negative = units.startsWith("-");
  const digits = (negative ? units.slice(1) : units).padStart(
    DECIMALS + 1,
    "0",
  );
  return {
    negative,
    whole: digits.slice(0, -DECIMALS).replace(/^0+(?=\d)/, ""),
    fraction: digits.slice(-DECIMALS),
  };
}

/** Exact decimal string, e.g. "1234.500000" -> "1234.5". */
export function exactPoints(units: string): string {
  const { negative, whole, fraction } = split(units);
  const trimmed = fraction.replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${trimmed ? `.${trimmed}` : ""}`;
}

/** Locale display truncated (never rounded up) to two decimals; the exact value stays available separately. */
export function displayPoints(units: string, locale: string): string {
  const { negative, whole, fraction } = split(units);
  const grouped = new Intl.NumberFormat(locale, {
    maximumFractionDigits: 0,
  }).format(BigInt(whole));
  const cents = fraction.slice(0, 2);
  const decimal =
    new Intl.NumberFormat(locale, { minimumFractionDigits: 1 })
      .formatToParts(1.5)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const body = cents === "00" ? grouped : `${grouped}${decimal}${cents}`;
  return negative ? `-${body}` : body;
}
