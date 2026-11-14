"use client";
// G12 H04: 25 / 50 / 75 / 100 % of the READ balance, as an exact amount typed into the amount field of Swap or Bridge.
// The balance is the one the user's own read-only portfolio scan returned FOR THE SENDING ADDRESS; without it (not
// scanned, scanned for another address) the buttons are disabled with the reason, never an invented 0. A scan older
// than the product's own freshness window is named with its time and cannot give 100 %. For a network's native coin,
// 100 % needs the network fee of a read route and leaves it, plus a stated margin, in the wallet. Pressing a button
// only fills the field of a read-only preview: nothing is approved, signed or sent.
import { useId } from "react";
import { useI18n } from "../i18n/provider";
import { PERCENTS, percentAmount, type PercentReason } from "../quotes/percent";

/** As the portfolio's own rule (portfolioStale): a read older than this is not fresh. */
const FRESH_MS = 60_000;
const REASON = {
  BALANCE_UNKNOWN: "g12.pc.balanceUnknown",
  BALANCE_ZERO: "g12.pc.balanceZero",
  FEE_UNKNOWN: "g12.pc.feeUnknown",
  FEE_EXCEEDS_BALANCE: "g12.pc.feeExceeds",
  TOO_SMALL: "g12.pc.tooSmall",
} as const satisfies Record<PercentReason, string>;
const short = (a: string) =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;

export function PercentButtons({
  balance,
  decimals,
  native,
  networkFee,
  feeFromRoute,
  scannedFor,
  matchesSender,
  readAt,
  now,
  onPick,
  testId = "percent-buttons",
}: {
  /** Raw balance as read for this exact asset (decimal string, "0" included), or undefined/null when not read. */
  balance: string | null | undefined;
  decimals: number;
  native: boolean;
  /** Everything a read route says must be paid in the native coin on top of the amount, in raw units, when known. */
  networkFee: bigint | null;
  /** This screen can learn the network fee by reading a route (Bridge); false where it cannot (Swap). */
  feeFromRoute: boolean;
  /** The address the portfolio scan was read for on this network's ecosystem, if any. */
  scannedFor: string | undefined;
  /** That address is the one this preview sends from. */
  matchesSender: boolean;
  /** When the balance was read (epoch ms). */
  readAt: number | undefined;
  /** The screen's clock (epoch ms; 0 before the first tick). */
  now: number;
  onPick: (amount: string) => void;
  testId?: string;
}) {
  const { t, lang } = useI18n();
  const reasonId = useId();
  const other = !!scannedFor && !matchesSender;
  const usable =
    !other &&
    matchesSender &&
    typeof balance === "string" &&
    /^(0|[1-9]\d{0,77})$/.test(balance);
  const raw = usable ? BigInt(balance) : null;
  const stale =
    raw !== null &&
    readAt !== undefined &&
    now > 0 &&
    (now - readAt >= FRESH_MS || now < readAt);
  const results = PERCENTS.map((percent) => ({
    percent,
    result: percentAmount({
      balance: raw,
      decimals,
      percent,
      native,
      networkFee,
    }),
  }));
  const full = results.find((r) => r.percent === 100)!.result;
  // One reason line: a balance read for another address first; then the first button that cannot be offered.
  const blocked = results.find((r) => !r.result.ok);
  const reason =
    blocked && !blocked.result.ok ? blocked.result.reason : undefined;
  const message = other
    ? t("g12.pc.otherAddress", { address: short(scannedFor) })
    : reason
      ? t(
          reason === "FEE_UNKNOWN" && !feeFromRoute
            ? "g12.pc.feeUnknownNoRoute"
            : REASON[reason],
        )
      : stale
        ? t("g12.pc.stale", {
            time: new Intl.DateTimeFormat(lang, { timeStyle: "short" }).format(
              readAt,
            ),
          })
        : native && full.ok && full.reserved > 0n
          ? t("g12.pc.reserveNote")
          : undefined;
  const label = new Intl.NumberFormat(lang, {
    style: "percent",
    maximumFractionDigits: 0,
  });
  return (
    <div
      className="percent-buttons"
      data-testid={testId}
      data-stale={stale || undefined}
    >
      <div
        role="group"
        aria-label={t("g12.pc.label")}
        aria-describedby={message ? reasonId : undefined}
      >
        {results.map(({ percent, result }) => {
          // The whole balance is offered only from a fresh read.
          const ok = result.ok && !(percent === 100 && stale);
          return (
            <button
              key={percent}
              type="button"
              className="percent-button"
              data-percent={percent}
              disabled={!ok}
              onClick={() => {
                if (ok && result.ok) onPick(result.input);
              }}
            >
              {label.format(percent / 100)}
            </button>
          );
        })}
      </div>
      {message && (
        <small
          id={reasonId}
          className="percent-reason"
          data-reason={
            other
              ? "OTHER_ADDRESS"
              : (reason ?? (stale ? "STALE" : "RESERVE_NOTE"))
          }
          role="status"
        >
          {message}
        </small>
      )}
    </div>
  );
}
