"use client";
import { useI18n } from "../i18n/provider";
import { formatUsd } from "../i18n/amounts";
import type { PortfolioResult, Holding } from "../portfolio/model";
import type { PositionCategory } from "../portfolio/positions";
import { detectedValue } from "../portfolio/value";
import { Icon } from "./icons";
import "./icons-extra";

export default function PortfolioPositions({
  result,
  chainName,
  isCounted,
}: {
  result: PortfolioResult;
  chainName: (id: string) => string;
  isCounted: (id: string) => boolean;
}) {
  const { t, lang } = useI18n();
  const positions = result.holdings.filter(
    (h) =>
      h.position &&
      isCounted(h.chainId) &&
      !h.spam &&
      !h.suspicious &&
      BigInt(h.balance) > 0n,
  );
  const debt = positions.filter((h) => h.position?.role === "debt");
  const value = (rows: Holding[]) => formatUsd(detectedValue(rows), lang);
  const wallet = result.holdings.filter(
    (h) => !h.position && isCounted(h.chainId),
  );
  const coverage = result.defiCoverage ?? [];
  const checked = coverage.filter((c) => c.state === "CHECKED").length;
  return (
    <section
      className="card portfolio-positions"
      aria-labelledby="position-title"
    >
      <div className="card-top">
        <h2 id="position-title">{t("v1122.positions")}</h2>
        <span className="pill tone-info">
          {positions.length} · {t("v1122.receiptBalances")}
        </span>
      </div>
      <dl className="position-value-split">
        <div>
          <dt>{t("v1122.wallet")}</dt>
          <dd>{value(wallet)}</dd>
        </div>
        <div>
          <dt>{t("v1122.defi")}</dt>
          <dd>{value(positions)}</dd>
        </div>
        <div>
          <dt>{t("v1122.debt")}</dt>
          <dd>
            {debt.length
              ? debt.some((h) => h.usd === null)
                ? t("ui.unknown")
                : formatUsd(
                    debt.reduce((sum, h) => sum + (h.usd ?? 0), 0),
                    lang,
                  )
              : "—"}
          </dd>
        </div>
      </dl>
      <p className="input-hint">{t("v1122.positionScope")}</p>
      {debt.length > 0 && (
        <p className="notice tone-warn" role="status">
          {t("v1122.debtExcluded")}
        </p>
      )}
      <details className="disclosure">
        <summary>
          {t("v1122.defiCoverage")} · {checked}/{coverage.length || "—"}
        </summary>
        <ul className="defi-coverage-list">
          {coverage.map((c) => (
            <li key={`${c.chainId}:${c.protocol}:${c.category}`}>
              <span>
                <strong>{c.protocol}</strong>
                <small>
                  {chainName(c.chainId)} · {t(`v1122.${c.category}`)}
                </small>
              </span>
              <span
                className={`pill tone-${c.state === "CHECKED" ? "ok" : c.state === "FAILED" ? "danger" : "warn"}`}
              >
                {t(`v1122.${c.state}`)} · {c.checked}/{c.planned}
              </span>
            </li>
          ))}
        </ul>
        {!coverage.length && (
          <p className="input-hint">{t("v1122.NOT_CHECKED")}</p>
        )}
        <div className="position-unsupported">
          {(["lp", "restaking", "rewards"] as PositionCategory[]).map(
            (category) => (
              <p key={category}>
                <Icon name="minus" size={13} />
                {t(`v1122.${category}`)} · {t("v1122.NOT_CHECKED")}
              </p>
            ),
          )}
        </div>
      </details>
    </section>
  );
}
