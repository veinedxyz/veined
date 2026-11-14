"use client";
// VEINED Guardian presentation: the brand octopus mark, the verdict panel (crested by the King Octopus, Guardian's
// character) embedded in Swap, Bridge, Portfolio, the Guardian page and the assistant. Presentation only: every verdict comes from src/guardian (deterministic rules); this file
// never computes risk. Finding parameters are display text that Guardian already sanitized; React escapes them.
// CSP: no style attributes; tones are classes (guardian-system.css).
import type { ReactNode } from "react";
import { useI18n } from "../i18n/provider";
import { OctopusSymbol } from "./brand-logo";
import { KingAvatar } from "./guardian-king";
import { getDictionary, parameters } from "../i18n/messages";
import type { Finding, Level, Verdict } from "../guardian/model";

/** Guardian is VEINED's own octopus (one brand): the approved symbol, decorative. */
export function GuardianMark({
  size = 22,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return <OctopusSymbol size={size} className={`guardian-mark ${className}`} />;
}

type Translate = (
  key: never,
  params?: Record<string, string | number>,
) => string;
/** Localized title and explanation of one finding. The translator is strict (a template's placeholders and the
 * values must match exactly), so each string receives only the finding parameters its own template uses. */
export function useFindingText() {
  const { t, lang } = useI18n();
  const strict = t as unknown as Translate;
  const tr: Translate = (key, params = {}) => {
    let template: unknown = getDictionary(lang);
    for (const part of (key as string).split("."))
      template = (template as Record<string, unknown> | undefined)?.[part];
    const needed = typeof template === "string" ? parameters(template) : [];
    return strict(
      key,
      Object.fromEntries(needed.map((name) => [name, params[name] ?? ""])),
    );
  };
  return {
    title: (f: Finding) => tr(`guardian.f.${f.code}` as never, f.params),
    why: (f: Finding) =>
      f.severity === "PASS" || f.severity === "INFO"
        ? ""
        : tr(`guardian.w.${f.code}` as never, f.params),
    t: tr,
  };
}
const MARK: Record<Finding["severity"], string> = {
  PASS: "pass",
  INFO: "info",
  CAUTION: "caution",
  WARNING: "warning",
  CRITICAL: "critical",
};
export function levelTone(level: Level) {
  return level === "BLOCK"
    ? "critical"
    : level === "HOLD"
      ? "warning"
      : level === "CAUTION"
        ? "caution"
        : "clear";
}

export function GuardianPanel({
  verdict,
  compact = false,
  title,
  testId = "guardian-panel",
  extra,
}: {
  verdict: Verdict;
  compact?: boolean;
  title?: string;
  testId?: string;
  extra?: ReactNode;
}) {
  const { title: titleOf, why, t } = useFindingText();
  const issues = verdict.findings.filter((f) => f.severity !== "PASS");
  const passed = verdict.findings.filter((f) => f.severity === "PASS");
  const shown = compact ? issues.slice(0, 3) : issues;
  const tone = levelTone(verdict.level);
  return (
    <div
      className={`guardian-panel is-${tone}${compact ? " is-compact" : ""}`}
      role="group"
      aria-label={title ?? t("guardian.brand" as never)}
      data-testid={testId}
      data-level={verdict.level}
      data-digest={verdict.digest}
    >
      <div className="guardian-head">
        <span className="guardian-crest" aria-hidden="true">
          <KingAvatar size={30} />
        </span>
        <div className="guardian-head-text">
          <p className="guardian-kicker">
            {title ?? t("guardian.brand" as never)}
          </p>
          <p className="guardian-level">
            {t(`guardian.level.${verdict.level}` as never)}
          </p>
        </div>
        <span className="guardian-count">
          {t("guardian.summary" as never, {
            checks: verdict.checks,
            issues: issues.length,
          })}
        </span>
      </div>
      <p className="guardian-lede">
        {t(`guardian.levelBody.${verdict.level}` as never)}
      </p>
      {shown.length > 0 && (
        <ul className="guardian-findings">
          {shown.map((f, i) => (
            <li
              key={`${f.code}:${i}`}
              className={`guardian-finding is-${MARK[f.severity]}`}
              data-code={f.code}
            >
              <span className="guardian-dot" aria-hidden="true" />
              <span className="guardian-finding-text">
                <strong>{titleOf(f)}</strong>
                {why(f) && <span>{why(f)}</span>}
              </span>
              <span className="sr-only">
                {t(`guardian.sev.${f.severity}` as never)}
              </span>
            </li>
          ))}
        </ul>
      )}
      {compact && issues.length > shown.length && (
        <p className="guardian-more">
          {t("guardian.more" as never, { count: issues.length - shown.length })}
        </p>
      )}
      {verdict.steps.length > 0 && (
        <div className="guardian-steps">
          <p className="guardian-steps-title">
            {t("guardian.safePath" as never)}
          </p>
          <ol>
            {(compact ? verdict.steps.slice(0, 2) : verdict.steps).map((s) => (
              <li key={s}>{t(`guardian.s.${s}` as never)}</li>
            ))}
          </ol>
        </div>
      )}
      {!compact && passed.length > 0 && (
        <details className="guardian-passed">
          <summary>
            {t("guardian.passed" as never, { count: passed.length })}
          </summary>
          <ul>
            {passed.map((f, i) => (
              <li key={`${f.code}:${i}`} data-code={f.code}>
                {titleOf(f)}
              </li>
            ))}
          </ul>
        </details>
      )}
      {extra}
      <p className="guardian-foot">
        <span>{t("guardian.policy" as never, { policy: verdict.policy })}</span>
        <code title={t("guardian.digest" as never)}>
          {verdict.digest.slice(0, 12)}
        </code>
      </p>
    </div>
  );
}
