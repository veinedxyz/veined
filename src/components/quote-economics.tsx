"use client";
// G12 H03: what a read-only quote's own numbers imply, said in plain words next to the quote (F2: an estimate above the
// amount sent; F3: costs out of proportion to the amount). Display only: the quote, its ranking and Guardian's decision
// are not changed here. Nothing is shown when there is nothing to say.
import { useI18n } from "../i18n/provider";
import { formatPercent } from "../i18n/amounts";
import type { Economics } from "../quotes/economics";

export function QuoteEconomicsNotice({
  economics,
  testId = "quote-economics",
}: {
  economics: Economics | null;
  testId?: string;
}) {
  const { t, lang } = useI18n();
  if (!economics) return null;
  const { surplus, cost } = economics;
  const costly = cost.level === "UNECONOMIC" || cost.level === "SEVERE";
  if (!surplus && !costly) return null;
  const pct = (bps: number) => formatPercent(bps / 10000, lang);
  return (
    <div
      className={`quote-economics notice ${surplus?.level === "IMPLAUSIBLE" || cost.level === "SEVERE" ? "tone-danger" : "tone-warn"}`}
      data-testid={testId}
      data-surplus={surplus?.level ?? "NONE"}
      data-cost={cost.level}
      role="note"
    >
      <strong>{t("g12.qe.title")}</strong>
      {surplus && (
        <p data-testid={`${testId}-surplus`}>
          {t(
            surplus.level === "IMPLAUSIBLE"
              ? "g12.qe.implausible"
              : "g12.qe.surplus",
            { percent: pct(surplus.bps) },
          )}{" "}
          {surplus.level === "NOTICE" &&
            t(
              surplus.minimumAbove
                ? "g12.qe.surplusMinAbove"
                : "g12.qe.surplusMinBelow",
            )}
        </p>
      )}
      {costly && (
        <p data-testid={`${testId}-cost`}>
          {cost.shareBps !== null && cost.shareBps >= 10000
            ? t("g12.qe.costExceeds")
            : t(
                cost.level === "SEVERE" ? "g12.qe.severe" : "g12.qe.uneconomic",
                { percent: pct(cost.shareBps ?? 0) },
              )}{" "}
          {!cost.complete && t("g12.qe.costPartial")}
        </p>
      )}
    </div>
  );
}
