"use client";
// V1.11 lazy bodies of the "Route details" and "Safety details" disclosures (loaded only when opened).
import { G5_ROUTE_PINS } from "../g5/route-pins";
import type { Health, Quote } from "../core/model";
import type { Network, RoutingQuote } from "../routing/model";
import { publicToolLabel, publicStepKindLabel } from "../content/public-labels";
import type { Locale } from "../i18n/config";
import { formatTokenAmount } from "../i18n/amounts";

type T = (key: string, values?: Record<string, string | number>) => string;
const short = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`;
const Row = ({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) => (
  <div>
    <dt>{label}</dt>
    <dd>{children}</dd>
  </div>
);
const Code = ({ v }: { v: string }) => (
  <code dir="ltr" title={v}>
    {short(v)}
  </code>
);

export function LegacyRouteDetails({
  t,
  quote,
  pair,
}: {
  t: T;
  quote?: Quote;
  pair: { fromSymbol: string; toSymbol: string; verified: boolean };
}) {
  const src = G5_ROUTE_PINS.source,
    dst = G5_ROUTE_PINS.destination;
  return (
    <>
      <dl>
        <Row label={t("v111.protocol")}>ONEbridge</Row>
        <Row label={t("v111.contracts")}>
          <Code v={src.proxy} /> → <Code v={dst.proxy} />
        </Row>
        <Row label={t("v111.chainIds")}>
          <bdi dir="ltr">
            {src.chainId} → {dst.chainId}
          </bdi>
        </Row>
        <Row label={t("v111.quoteId")}>
          {quote ? <code dir="ltr">{quote.id}</code> : "—"}
        </Row>
        <Row label={t("v111.routeStatus")}>
          {pair.verified ? t("v111.verifiedRoute") : t("v111.noVerifiedRoute")}
        </Row>
      </dl>
      <ol className="route-steps">
        <li>{t("v111.stepLock", { token: pair.fromSymbol })}</li>
        <li>{t("v111.stepValidators")}</li>
        <li>{t("v111.stepRelease", { token: pair.toSymbol })}</li>
      </ol>
    </>
  );
}
export function LegacySafetyDetails({
  t,
  lang,
  health,
  onRefresh,
  refreshing,
}: {
  t: T;
  lang: Locale;
  health?: Health;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const src = G5_ROUTE_PINS.source,
    dst = G5_ROUTE_PINS.destination,
    l = health?.limits;
  const amount = (v: string) => formatTokenAmount(BigInt(v), 18, lang, 2);
  return (
    <>
      <dl>
        <Row label={t("v111.runtimePins")}>
          <span>
            ONE <Code v={src.implementationCodeHash} /> · BSC{" "}
            <Code v={dst.implementationCodeHash} />
          </span>
        </Row>
        <Row label={t("v111.authority")}>
          {t("v111.authorityValue", {
            threshold: src.settlement.threshold,
            validators: src.settlement.validators.length,
          })}
        </Row>
        {l && (
          <>
            <Row
              label={t("product.observedMinimum")}
            >{`${amount(l.minimum)} ONE`}</Row>
            <Row
              label={t("product.observedBound")}
            >{`${amount(l.maximumBound)} ONE`}</Row>
          </>
        )}
        <Row label={t("product.reserve")}>
          {l
            ? `${l.reserveVerified ? t("v110.verified") : t("product.unverified")} · ${amount(l.conservativeReserveBound)} CROSS`
            : t("product.unknown")}
        </Row>
        <Row label={t("v111.rpcConsensus")}>
          {l ? t("v111.rpcConsensusValue") : t("product.unknown")}
        </Row>
        <Row label={t("v111.pendingInFlight")}>
          {t("v111.pendingInFlightValue")}
        </Row>
        <Row label={t("v111.lastChecked")}>
          {health ? new Date(health.observedAt).toLocaleTimeString(lang) : "—"}
        </Row>
      </dl>
      {l && <p className="micro">{t("product.boundNote")}</p>}
      <button className="small" disabled={refreshing} onClick={onRefresh}>
        {refreshing ? "…" : t("product.refresh")}
      </button>
    </>
  );
}
export function MultiRouteDetails({
  t,
  lang,
  quote,
  source,
  destination,
}: {
  t: T;
  lang: Locale;
  quote?: RoutingQuote;
  source: Network;
  destination: Network;
}) {
  return (
    <>
      <dl>
        <Row label={t("v111.protocol")}>
          {quote
            ? [
                ...new Set(
                  quote.steps.map((s) => publicToolLabel(s.toolName, lang)),
                ),
              ].join(" → ")
            : "—"}
        </Row>
        <Row label={t("v111.chainIds")}>
          <bdi dir="ltr">
            {source.id} → {destination.id}
          </bdi>
        </Row>
        <Row label={t("v111.quoteId")}>
          {quote ? <code dir="ltr">{short(quote.id)}</code> : "—"}
        </Row>
        {quote && (
          <Row label={t("v110.minimumReceived")}>
            <bdi dir="ltr">
              {formatTokenAmount(
                BigInt(quote.minimum),
                quote.steps.at(-1)?.destinationAsset.decimals ?? 18,
                lang,
                6,
              )}{" "}
              {quote.steps.at(-1)?.destinationAsset.symbol}
            </bdi>
          </Row>
        )}
      </dl>
      {quote && (
        <ol className="route-steps">
          {quote.steps.map((s) => (
            <li key={s.id}>
              {publicToolLabel(s.toolName, lang)} · {s.sourceAsset.symbol} →{" "}
              {s.destinationAsset.symbol} ({publicStepKindLabel(s.type, lang)})
              {s.approvalAddress && (
                <>
                  {" "}
                  · {t("ui.approvalContract")}{" "}
                  <code dir="ltr">{short(s.approvalAddress)}</code>
                </>
              )}
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
export function MultiSafetyDetails({
  t,
  lang,
  quote,
  checkedAt,
}: {
  t: T;
  lang: Locale;
  quote?: RoutingQuote;
  checkedAt: number | null;
}) {
  return (
    <dl>
      <Row label={t("v111.routeVerification")}>
        {quote ? t("v111.catalogBoundSteps") : t("v110.quoteMissing")}
      </Row>
      <Row label={t("v111.approvals")}>
        {quote ? String(quote.requirements.approvals) : "—"}
      </Row>
      <Row label={t("v111.execution")}>{t("v111.sendingDisabled")}</Row>
      <Row label={t("v111.lastChecked")}>
        {checkedAt ? new Date(checkedAt).toLocaleTimeString(lang) : "—"}
      </Row>
    </dl>
  );
}
