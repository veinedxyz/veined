"use client";
import { useMemo } from "react";
import { useI18n } from "../i18n/provider";
import type { MessageKey } from "../i18n/messages";
import { displayPoints } from "../points/format";
import { formatUsd } from "../i18n/amounts";
import {
  REGISTERED_VOLUME_POLICY,
  computeVolumeLedger,
  ownVolumeView,
  volumeActivation,
} from "../lifetime-points/volume";
import {
  VOLUME_SAMPLE_ACCOUNT,
  VOLUME_SAMPLE_INPUT,
} from "../lifetime-points/volume-sample";
import { Icon, type IconName } from "./icons";
import { Pill } from "./ui";
import styles from "./points-view.module.css";
// gf1 G06 + G12 H05: the user's own cumulative points. The owner's planned rule (G12 H05) is 1 point for every 100 USD
// of verified, settled volume; it is registered as PENDING_OWNER_POLICY (the reading, the start date and the remaining
// details wait for the owner), so this card never shows a number for a real account: it says the program is not active
// yet. A labelled SAMPLE preview (fixture data, computed in this browser by the same pure volume ledger, opened only
// with ?lifetimePreview=sample) shows the layout; it sits outside the "Your points" card, so no crop of that card can
// carry a sample figure. No public ranking, no pool, no token.

const RULES: [IconName, MessageKey][] = [
  ["check", "points.lifetime.rules.fixed"],
  ["close", "points.lifetime.rules.noSignup"],
  ["plus", "points.lifetime.rules.referral"],
  ["eye", "points.lifetime.rules.private"],
  ["info", "points.how.value"],
];

export function LifetimePoints({
  account,
  sample,
}: {
  account: string;
  sample: boolean;
}) {
  const { t, lang } = useI18n();
  const state = volumeActivation(REGISTERED_VOLUME_POLICY).state;
  const preview = useMemo(
    () =>
      sample
        ? ownVolumeView(
            computeVolumeLedger(VOLUME_SAMPLE_INPUT),
            VOLUME_SAMPLE_ACCOUNT,
          )
        : null,
    [sample],
  );
  const usd = (micros: string) => formatUsd(Number(micros) / 1_000_000, lang);
  return (
    <>
      <section
        className={`card ${styles.lifetime}`}
        aria-labelledby="points-lifetime"
        data-testid="points-lifetime"
        data-policy-state={state}
        data-policy="volume"
      >
        <div className="card-top">
          <h2 id="points-lifetime">{t("points.lifetime.title")}</h2>
          <Pill tone="neutral" icon="lock">
            {t("points.lifetime.pending")}
          </Pill>
        </div>
        <dl className={styles.lifetimeTotal}>
          <dt>{t("points.lifetime.total")}</dt>
          {/* Never a number while the owner's policy is pending: not 0, not an estimate. */}
          <dd data-testid="points-lifetime-total">
            {t("points.lifetime.pending")}
          </dd>
        </dl>
        <p className={styles.lifetimeBody}>
          {t("points.lifetime.pendingBody")}
        </p>
        {/* The page's existing wallet button connects; this card only says what connecting will show. */}
        {!account && (
          <p className={styles.lifetimeConnect}>
            {t("points.lifetime.connect")}
          </p>
        )}
        <h3 className={styles.lifetimeRulesTitle}>
          {t("points.lifetime.rules.title")}
        </h3>
        <ul className={styles.lifetimeRules}>
          {RULES.map(([icon, key]) => (
            <li key={key}>
              <Icon name={icon} size={16} />
              <span>{t(key)}</span>
            </li>
          ))}
        </ul>
      </section>
      {preview && preview.state === "COMPUTED" && (
        <aside
          className={styles.lifetimeSample}
          aria-labelledby="points-lifetime-sample"
          data-testid="points-lifetime-sample"
        >
          <h2 id="points-lifetime-sample">
            {/* The pill repeats the title's first word: kept visible, left out of the heading's name. */}
            <span aria-hidden="true">
              <Pill tone="warn">{t("points.lifetime.sample.pill")}</Pill>
            </span>
            {t("points.lifetime.sample.title")}
          </h2>
          <p>{t("points.lifetime.sample.body")}</p>
          <dl className={styles.lifetimeSampleFacts}>
            {(
              [
                [
                  "volume",
                  "points.lifetime.sample.volume",
                  usd(preview.totals.countedUsdMicros),
                ],
                [
                  "points",
                  "points.lifetime.sample.points",
                  displayPoints(
                    (BigInt(preview.totals.points) * 1_000_000n).toString(),
                    lang,
                  ),
                ],
                [
                  "next",
                  "points.lifetime.sample.next",
                  usd(preview.totals.toNextPointUsdMicros),
                ],
                [
                  "referral",
                  "points.lifetime.sample.referral",
                  displayPoints(preview.totals.referralUnits, lang),
                ],
                [
                  "pending",
                  "points.lifetime.sample.pending",
                  usd(preview.totals.pendingUsdMicros),
                ],
                [
                  "total",
                  "points.lifetime.sample.total",
                  displayPoints(preview.totals.totalUnits, lang),
                ],
              ] as const
            ).map(([field, key, value]) => (
              <div key={field} data-field={field}>
                <dt>{t(key)}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </aside>
      )}
    </>
  );
}
