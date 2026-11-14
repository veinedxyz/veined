import { BridgeError } from "../core/model";
import { numberLocale, type Locale } from "./config";
// G13 (VBA-P1-01): a thousands separator always follows a head of one to three digits without a leading zero
// ("1.234", "12,345"). Only such a head makes "x.ddd" / "x,ddd" readable as a grouped integer; "0,002" or "1234.567"
// can only be decimals and are no longer refused. "4,995" stays refused (it really can be 4995 or 4.995).
const groupingHead = (integer: string) => /^[1-9]\d{0,2}$/.test(integer);
// Only canonical decimals enter token math. Grouping and whitespace are rejected.
export function normalizeAmountInput(
  raw: string,
  locale: Locale,
  decimals: number,
): string {
  if (
    raw.length > 80 ||
    !Number.isInteger(decimals) ||
    decimals < 0 ||
    decimals > 36 ||
    /[\s\u00a0\u202f\u200e\u200f\u2066-\u2069]/u.test(raw)
  )
    throw new BridgeError("AMBIGUOUS_LOCALE");
  let normalized = raw
    .replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  const decimal =
    new Intl.NumberFormat(numberLocale(locale), { useGrouping: false })
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  // G13 review fix: es / it / pl write 1000 without a separator (minimum grouping) but group 12.345, so the separator
  // is read from a seven-digit number — otherwise "12.345" typed in Spanish was read as 12.345 instead of refused.
  const group = new Intl.NumberFormat(numberLocale(locale))
    .formatToParts(1234567)
    .find((part) => part.type === "group")?.value;
  if (
    group === "." &&
    /^\d+\.\d{3}$/.test(normalized) &&
    groupingHead(normalized.split(".")[0])
  )
    throw new BridgeError("AMBIGUOUS_LOCALE");
  if (/[٬']/u.test(normalized)) throw new BridgeError("AMBIGUOUS_LOCALE");
  if (decimal !== "." && normalized.includes(decimal)) {
    if (normalized.includes(".") || normalized.split(decimal).length !== 2)
      throw new BridgeError("AMBIGUOUS_LOCALE");
    const fraction = normalized.split(decimal)[1];
    // A three-digit suffix after comma can be a pasted grouping separator (only after a grouping head).
    if (
      decimal === "," &&
      fraction.length === 3 &&
      groupingHead(normalized.split(decimal)[0])
    )
      throw new BridgeError("AMBIGUOUS_LOCALE");
    normalized = normalized.replace(decimal, ".");
  }
  if (normalized.includes(",") || normalized.includes("٫"))
    throw new BridgeError("AMBIGUOUS_LOCALE");
  if (
    !/^(0|[1-9]\d*)(\.\d+)?$/.test(normalized) ||
    (normalized.split(".")[1] ?? "").length > decimals
  )
    throw new BridgeError("INVALID_AMOUNT");
  return normalized;
}
/**
 * G13 (VBA-P1-01): the two readings of a typed amount that the field refuses as ambiguous ("4,995" in Turkish: the
 * whole number 4995 or the decimal 4.995), written so that no locale can misread them: the whole number without a
 * separator and the decimal with one more zero in the locale's own decimal separator. Null for every other input
 * (it parses, or it is refused for another reason) and when the token cannot hold a fourth fraction digit. Pure; the
 * amount rule itself is unchanged — the field still never guesses which reading was meant.
 */
export function ambiguousAmountReadings(
  raw: string,
  locale: Locale,
  decimals: number,
): { whole: string; decimal: string } | null {
  const ascii = raw
    .trim()
    .replace(/[０-９]/g, (d) => String(d.charCodeAt(0) - 0xff10))
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0));
  const match = /^([1-9]\d{0,2})[.,](\d{3})$/.exec(ascii);
  if (!match || !Number.isInteger(decimals) || decimals < 4) return null;
  try {
    normalizeAmountInput(raw.trim(), locale, decimals);
    return null;
  } catch (e) {
    if ((e as { code?: string }).code !== "AMBIGUOUS_LOCALE") return null;
  }
  const separator =
    new Intl.NumberFormat(numberLocale(locale), { useGrouping: false })
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const whole = `${match[1]}${match[2]}`,
    decimal = `${match[1]}${separator}${match[2]}0`;
  // Both readings must parse to exactly what they say, or nothing is suggested.
  try {
    if (
      normalizeAmountInput(whole, locale, decimals) !== whole ||
      normalizeAmountInput(decimal, locale, decimals) !==
        `${match[1]}.${match[2]}0`
    )
      return null;
  } catch {
    return null;
  }
  return { whole, decimal };
}
export function formatTokenAmount(
  value: bigint,
  decimals: number,
  locale: Locale,
  places = decimals,
): string {
  const scale = 10n ** BigInt(decimals),
    whole = value / scale;
  const fraction = (value % scale)
    .toString()
    .padStart(decimals, "0")
    .slice(0, places)
    .replace(/0+$/, "");
  const parts = new Intl.NumberFormat(numberLocale(locale), {
    useGrouping: true,
    maximumFractionDigits: 0,
  }).format(whole);
  const decimal =
    new Intl.NumberFormat(numberLocale(locale))
      .formatToParts(1.1)
      .find((part) => part.type === "decimal")?.value ?? ".";
  const digits = Array.from({ length: 10 }, (_, i) =>
    new Intl.NumberFormat(numberLocale(locale), { useGrouping: false }).format(
      i,
    ),
  );
  return (
    parts +
    (fraction
      ? decimal + fraction.replace(/\d/g, (d) => digits[Number(d)])
      : "")
  );
}
export function formatFiat(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}
// V1.10 display money: whole cents for ordinary balances, up to four significant digits below one dollar so dust
// never rounds to a misleading $0.00. formatFiat keeps its exact four-decimal contract for review surfaces.
export function formatUsd(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    ...(value !== 0 && Math.abs(value) < 1
      ? { maximumSignificantDigits: 4 }
      : { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  }).format(value);
}
// Market-size figures (TVL) read better compact ("54.4B") than as eleven grouped digits.
export function formatUsdCompact(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
export function formatPercent(value: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(value);
}
export function formatRelative(value: number, locale: Locale) {
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(
    value,
    "minute",
  );
}
