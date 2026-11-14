// G12 H04: 25 / 50 / 75 / 100 % of a READ balance as an exact amount to type into Swap or Bridge. Pure (bigint only,
// no float, no I/O). Fail-closed: without a read balance nothing is offered (never an invented 0); for a network's
// native coin, 100 % is offered only when the network fee of the current route is known, and it leaves that fee (plus a
// margin) in the wallet; if the fee does not fit, the reason is returned instead of an amount.
// The result only pre-fills the amount field of a read-only preview: nothing is approved, signed or sent.

export const PERCENTS = [25, 50, 75, 100] as const;
export type Percent = (typeof PERCENTS)[number];
/** The network-fee estimate is multiplied by this before it is reserved (fees move between quote and send). */
export const GAS_RESERVE_MARGIN_BPS = 12000;

export type PercentReason =
  /** No balance was read for this asset (not scanned, pending, stale or failed). */
  | "BALANCE_UNKNOWN"
  | "BALANCE_ZERO"
  /** Native coin, 100 %: the network fee is not known yet (no route read for this pair). */
  | "FEE_UNKNOWN"
  /** Native coin: the balance does not cover the network fee reserve. */
  | "FEE_EXCEEDS_BALANCE"
  /** The share rounds down to nothing at this token's precision. */
  | "TOO_SMALL";
export type PercentResult =
  | {
      ok: true;
      raw: bigint;
      /** Exact decimal text of `raw`. */
      text: string;
      /** The text to type into an amount field (see amountInput). */
      input: string;
      reserved: bigint;
    }
  | { ok: false; reason: PercentReason };

export interface PercentInput {
  /** Raw balance as read, or null when it was not read. */
  balance: bigint | null;
  decimals: number;
  percent: Percent;
  /** The asset is the source network's native coin (it also pays the network fee). */
  native: boolean;
  /** Network fee of the current route in the native coin's raw units, when a read route reported it. */
  networkFee: bigint | null;
}

/** Exact decimal text of raw units ("1.5", "0.000001", "12"): no grouping, no exponent, no trailing zeros. */
export function unitsText(raw: bigint, decimals: number): string {
  if (raw < 0n || !Number.isInteger(decimals) || decimals < 0 || decimals > 36)
    throw new RangeError("UNITS");
  const s = raw.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/**
 * The same amount as typed text for VEINED's amount fields. Those fields refuse exactly three fraction digits in
 * locales that group thousands with "." (0.125 could be a pasted 125): one trailing zero keeps the value exact and
 * unambiguous in every locale. A token with exactly three decimals cannot take a fourth digit, so its text is left as
 * it is (the field then refuses it in those locales: fail-closed, never a different amount).
 */
export function amountInput(text: string, decimals: number): string {
  return /^\d+\.\d{3}$/.test(text) && decimals > 3 ? `${text}0` : text;
}

export function percentAmount(i: PercentInput): PercentResult {
  if (
    i.balance === null ||
    i.balance < 0n ||
    !PERCENTS.includes(i.percent) ||
    !Number.isInteger(i.decimals) ||
    i.decimals < 0 ||
    i.decimals > 36 ||
    (i.networkFee !== null && i.networkFee < 0n)
  )
    return { ok: false, reason: "BALANCE_UNKNOWN" };
  if (i.balance === 0n) return { ok: false, reason: "BALANCE_ZERO" };
  let raw = (i.balance * BigInt(i.percent)) / 100n;
  let reserved = 0n;
  if (i.native) {
    if (i.networkFee === null) {
      // Below 100 % the remainder stays in the wallet for the fee; at 100 % nothing would be left to pay it.
      if (i.percent === 100) return { ok: false, reason: "FEE_UNKNOWN" };
    } else {
      // Round the reserve UP: never leave less than the estimate plus its margin.
      reserved =
        (i.networkFee * BigInt(GAS_RESERVE_MARGIN_BPS) + 9999n) / 10000n;
      if (reserved >= i.balance)
        return { ok: false, reason: "FEE_EXCEEDS_BALANCE" };
      const spendable = i.balance - reserved;
      if (raw > spendable) raw = spendable;
    }
  }
  if (raw <= 0n) return { ok: false, reason: "TOO_SMALL" };
  const text = unitsText(raw, i.decimals);
  return {
    ok: true,
    raw,
    text,
    input: amountInput(text, i.decimals),
    reserved,
  };
}
