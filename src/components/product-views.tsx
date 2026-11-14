"use client";
import Link from "next/link";
import {
  useEffect,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from "react";
import {
  CROSS,
  type Health,
  type Mode,
  type TransferRecord,
} from "../core/model";
import type { Locale } from "../i18n/config";
import type { MessageKey } from "../i18n/messages";
import type { TextKey } from "../content/messages";
import { networkIdentity } from "../content/networks";
import { networkThemeClass } from "../content/network-themes";
import { NetworkBadge, NetworkLogo, RouteIdentity } from "./network-identity";
import { LanguageSelector } from "./language-selector";
import { Icon } from "./icons";
import { EmptyState, PageHeader } from "./ui";
import { publishGuardianFacts } from "./guardian-context";
// V1.10: the non-Bridge product views are code-split from the first-load bundle. Records, history tracking,
// recovery, diagnostics and every wallet call stay in Product; these views only render what Product passes in.
export interface ViewKit {
  t: (key: TextKey | MessageKey) => string;
  lang: Locale;
  row: (label: string, value: ReactNode, className?: string) => ReactNode;
  address: (value: string) => ReactNode;
  short: (value: string) => string;
  formatAmount: (value: bigint, places?: number) => string;
  explain: (code: string) => string;
  stateName: (state: string) => string;
  stateTone: (state: string) => string;
}
const matches = (filter: string, r: TransferRecord) =>
  filter === "all" ||
  (filter === "completed" ? r.state === "COMPLETED" : r.state !== "COMPLETED");

export function ActivityView({
  kit: { t, lang, formatAmount, short, stateName, stateTone },
  records,
  filter,
  onFilter,
  onExport,
  onImport,
}: {
  kit: ViewKit;
  records: TransferRecord[];
  filter: string;
  onFilter: (value: string) => void;
  onExport: () => void;
  onImport: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  // gf1 G04: the Guardian assistant reads the three counts the filters show (records stay in this browser).
  const transfers = records.length,
    completed = records.filter((r) => matches("completed", r)).length,
    pending = records.filter((r) => matches("pending", r)).length;
  useEffect(() => {
    publishGuardianFacts("activity", { transfers, pending, completed });
  }, [transfers, pending, completed]);
  useEffect(() => () => publishGuardianFacts("activity", undefined), []);
  return (
    <>
      <PageHeader
        title={t("activity")}
        lede={t("empty")}
        actions={
          <>
            <button className="secondary" onClick={onExport}>
              <Icon name="download" size={16} />
              {t("historyExport")}
            </button>
            <label className="file-button secondary">
              <Icon name="upload" size={16} />
              {t("historyImport")}
              <input
                aria-label={t("historyImport")}
                type="file"
                accept="application/json"
                onChange={onImport}
              />
            </label>
          </>
        }
      />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label={t("filter")}>
          {(["all", "pending", "completed"] as const).map((value) => (
            <button
              key={value}
              aria-pressed={filter === value}
              onClick={() => onFilter(value)}
            >
              {t(value)}
              <span className="segment-count">
                {records.filter((r) => matches(value, r)).length}
              </span>
            </button>
          ))}
        </div>
        <p className="toolbar-note">
          <Icon name="info" size={14} />
          {t("importNote")}
        </p>
      </div>
      {records.length === 0 ? (
        <section className="card empty">
          <EmptyState
            icon="pulse"
            title={t("emptyTitle")}
            actions={
              <>
                <Link className="button-link primary-link" href="/bridge">
                  {t("bridge")}
                  <Icon name="arrowRight" size={15} className="flip-rtl" />
                </Link>
                <Link className="button-link" href="/swap">
                  {t("v13.swap")}
                </Link>
              </>
            }
          >
            <p>{t("v110.activityEmptyBody")}</p>
          </EmptyState>
          <ul className="empty-facts">
            {(
              [
                ["lock", "v110.factLocal"],
                ["refresh", "v110.factTracking"],
                ["shield", "v110.factNoResubmit"],
              ] as const
            ).map(([icon, key]) => (
              <li key={key}>
                <Icon name={icon} size={16} />
                {t(key)}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="activity-list">
          {records
            .filter((r) => matches(filter, r))
            .map((r) => (
              <Link
                className="card activity-item"
                key={r.id}
                href={`/activity/${r.id}`}
              >
                <span className="activity-glyph" aria-hidden="true">
                  <NetworkLogo id="onechain" size="sm" />
                  <NetworkLogo id="bsc" size="sm" />
                </span>
                <div className="activity-summary">
                  <strong>{formatAmount(BigInt(r.amount))} ONE → CROSS</strong>
                  <RouteIdentity compact />
                  <small>
                    {short(r.account)} ·{" "}
                    {new Date(r.updatedAt).toLocaleString(lang)}
                  </small>
                </div>
                {/* V1.11: execution state lives in the CTA, route status and Safety details — no persistent
                    "Read only" label; only local test records are marked. */}
                {r.mode === "local-test" && (
                  <span className="badge">{t("local")}</span>
                )}
                <span className={`state-pill tone-${stateTone(r.state)}`}>
                  {stateName(r.state)}
                  <Icon name="chevronRight" size={14} className="flip-rtl" />
                </span>
              </Link>
            ))}
        </div>
      )}
    </>
  );
}

export function ActivityDetailView({
  kit: { t, row, address, formatAmount, explain, stateName },
  record,
  recoveryBusy,
  onRecover,
  includePublic,
  onIncludePublic,
  onDiagnostics,
  onWatch,
}: {
  kit: ViewKit;
  record: TransferRecord;
  recoveryBusy: boolean;
  onRecover: (event: FormEvent<HTMLFormElement>) => void;
  includePublic: boolean;
  onIncludePublic: (value: boolean) => void;
  onDiagnostics: () => void;
  /** Present only for a mainnet record with a connected wallet. */
  onWatch?: () => void;
}) {
  return (
    <>
      <PageHeader
        title={stateName(record.state)}
        lede={
          record.mode === "local-test" ? t("localNote") : t("sourceSuccess")
        }
      />
      <section className="card detail-card">
        <div className="card-top">
          <h2>{formatAmount(BigInt(record.amount))} ONE → CROSS</h2>
          {record.mode === "local-test" && (
            <span className="badge">{t("local")}</span>
          )}
        </div>
        <RouteIdentity />
        <ol className="timeline">
          {[t("sourceStep"), t("settlementStep"), t("destinationStep")].map(
            (label, i) => (
              <li
                key={label}
                className={
                  record.state === "COMPLETED" ||
                  (i === 0 &&
                    ["SETTLEMENT_PENDING", "DESTINATION_CONFIRMING"].includes(
                      record.state,
                    ))
                    ? "done"
                    : ""
                }
              >
                <span>{i + 1}</span>
                <div>
                  <strong>{label}</strong>
                  {i === 1 ? (
                    <small>ONEbridge</small>
                  ) : (
                    <NetworkBadge id={i === 0 ? "onechain" : "bsc"} compact />
                  )}
                </div>
              </li>
            ),
          )}
        </ol>
        {record.mode === "mainnet-readonly" && !record.sourceHash && (
          <form className="recovery-form" onSubmit={onRecover}>
            <p className="notice" role="status">
              {explain("MANUAL_ACTION_REQUIRED")}
            </p>
            <label>
              {t("sourceHash")}
              <input
                name="sourceHash"
                dir="ltr"
                required
                pattern="0x[0-9a-fA-F]{64}"
                maxLength={66}
                placeholder="0x…"
                autoComplete="off"
              />
            </label>
            <button className="secondary" type="submit" disabled={recoveryBusy}>
              {t("resumeTracking")}
            </button>
          </form>
        )}
        {record.error === "DESTINATION_DISCOVERY_BOUNDED" && (
          <p className="notice" role="status">
            {explain(record.error)}
          </p>
        )}
        <div className="detail-facts">
          {row(
            t("receive"),
            `${formatAmount(BigInt(record.expected))} CROSS`,
            "is-strong",
          )}
          <div className="hash-row">
            <p className="micro">{t("recipient")}</p>
            {address(record.recipient)}
          </div>
          {(
            [
              [
                "sourceHash",
                record.sourceHash,
                "https://explorer.onechain.nexus/612055/transactions/",
              ],
              ["destHash", record.destinationHash, "https://bscscan.com/tx/"],
            ] as const
          ).map(
            ([key, hash, base]) =>
              hash && (
                <div key={key} className="hash-row">
                  <p className="micro">{t(key)}</p>
                  {address(hash)}
                  {record.mode === "mainnet-readonly" ? (
                    <a
                      className="text-link"
                      href={`${base}${hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {t("ui.explorer")}
                      <Icon name="external" size={13} />
                    </a>
                  ) : (
                    <small>{t("localExplorer")}</small>
                  )}
                </div>
              ),
          )}
        </div>
        {record.state !== "COMPLETED" && (
          <p className="notice">{t("waiting")}</p>
        )}
        <div className="detail-export">
          <label className="check">
            <input
              type="checkbox"
              checked={includePublic}
              onChange={(e) => onIncludePublic(e.target.checked)}
            />
            {t("publicExport")}
          </label>
          <button className="secondary" onClick={onDiagnostics}>
            <Icon name="download" size={16} />
            {t("export")}
          </button>
        </div>
      </section>
      {record.state === "COMPLETED" && (
        <section className="card post">
          <h2>{t("postTitle")}</h2>
          <p>{t("post")}</p>
          <p className="notice">{t("bnb")}</p>
          <p className="micro">{t("token")}</p>
          {address(CROSS)}
          {onWatch && (
            <button className="secondary" onClick={onWatch}>
              {t("watch")}
            </button>
          )}
          <Link className="text-link" href="/help">
            {t("dex")}
            <Icon name="arrowRight" size={13} className="flip-rtl" />
          </Link>
        </section>
      )}
    </>
  );
}

export function ActivityNotFound({ kit: { t } }: { kit: ViewKit }) {
  return (
    <section className="card empty">
      <div className="empty-state">
        <span className="empty-icon" aria-hidden="true">
          <Icon name="search" size={22} />
        </span>
        <div className="empty-text">
          <h1>{t("notFound")}</h1>
        </div>
        <div className="empty-actions">
          <Link
            className="button-link"
            href="/activity"
            aria-label={`${t("activity")} · ${t("timeline")}`}
          >
            {t("activity")}
            <Icon name="arrowRight" size={15} className="flip-rtl" />
          </Link>
        </div>
      </div>
    </section>
  );
}

export function NetworksView({
  kit: { t, lang, row, formatAmount, explain },
  mode,
  health,
  healthBusy,
  onRefresh,
  routeVerified,
  modeBadge,
  catalog,
}: {
  kit: ViewKit;
  mode: Mode;
  health?: Health;
  healthBusy: boolean;
  onRefresh: () => void;
  routeVerified: boolean;
  modeBadge: ReactNode;
  catalog: ReactNode;
}) {
  return (
    <>
      <PageHeader
        title={t("netTitle")}
        lede={t("netSubtitle")}
        meta={
          <>
            <span className="pill tone-accent">
              <Icon name="route" size={14} />
              V1 · {t("direction")}
            </span>
            {modeBadge}
          </>
        }
      />
      <div className="route-overview">
        {(
          [
            {
              id: "onechain",
              chainId: mode === "local-test" ? 31337 : 612055,
              snapshot: health?.source,
            },
            {
              id: "bsc",
              chainId: mode === "local-test" ? 31338 : 56,
              snapshot: health?.destination,
            },
          ] as const
        ).map(({ id, chainId, snapshot }, index) => (
          <section
            className={`card network-tinted network-card ${networkThemeClass(id)}`}
            key={id}
            data-network={id}
          >
            <div className="network-card-heading">
              <NetworkLogo id={id} size="lg" />
              <div>
                <p className="micro network-role">
                  {index === 0 ? t("from") : t("to")}
                </p>
                <h2>{networkIdentity[id].name}</h2>
              </div>
            </div>
            {row(t("chainId"), String(chainId))}
            {row(t("block"), snapshot?.block ?? "—")}
            {row(t("health"), t("notVerified"))}
            <p className="input-hint">
              {t("updated")}:{" "}
              {health ? new Date(health.observedAt).toLocaleString(lang) : "—"}
            </p>
          </section>
        ))}
        <span className="route-connector" aria-hidden="true">
          <Icon name="arrowRight" size={18} className="flip-rtl" />
        </span>
      </div>
      <section className="card route-status">
        <div className="card-top">
          <h2>{t("routeDetails")}</h2>
          <button className="small" disabled={healthBusy} onClick={onRefresh}>
            <Icon
              name="refresh"
              size={14}
              className={healthBusy ? "spin" : undefined}
            />
            {t("refresh")}
          </button>
        </div>
        <div className="route-status-grid">
          <div>
            {row(t("provider"), "ONEbridge")}
            {row(
              t("reserve"),
              health?.limits?.reserveVerified
                ? `${formatAmount(BigInt(health.limits.maximumBound))} CROSS`
                : t("unverified"),
            )}
            {health?.token &&
              row(
                t("token"),
                `${health.token.name} / ${health.token.symbol} · ${health.token.decimals}`,
              )}
          </div>
          <ul className="status-list">
            <li>
              <Icon name="shield" size={16} />
              <span>{t("v110.verification")}</span>
              <strong className={routeVerified ? "teal" : "amber"}>
                {routeVerified ? t("v110.g5Verified") : t("notVerified")}
              </strong>
            </li>
            <li>
              <Icon name="lock" size={16} />
              <span>{t("v110.sending")}</span>
              <strong className="amber">{t("v110.closed")}</strong>
            </li>
            <li>
              <Icon name="clock" size={16} />
              <span>{t("updated")}</span>
              <strong>
                {health
                  ? new Date(health.observedAt).toLocaleTimeString(lang)
                  : "—"}
              </strong>
            </li>
          </ul>
        </div>
        {mode === "mainnet-readonly" &&
          health?.reasons.map((reason) => (
            <p className="notice" key={reason}>
              {explain(reason)}
            </p>
          ))}
      </section>
      {catalog}
    </>
  );
}

export function AboutView({ kit: { t } }: { kit: ViewKit }) {
  return (
    <>
      <PageHeader title={t("aboutTitle")} lede={t("safety")} />
      <section className="card prose">
        <h2>{t("about")}</h2>
        <p>{t("aboutText")}</p>
        <h2>{t("privacy")}</h2>
        <p>{t("privacyText")}</p>
        <h2>{t("future")}</h2>
        <p>{t("v13.swapNote")}</p>
        <p>{t("v13.securityNote")}</p>
      </section>
    </>
  );
}

export function SettingsView({
  kit: { t },
  theme,
  onTheme,
}: {
  kit: ViewKit;
  theme: string;
  onTheme: (value: string) => void;
}) {
  return (
    <>
      <PageHeader title={t("settingsTitle")} />
      <section className="card preferences">
        <div className="preference-row">
          <span className="preference-label">
            <Icon name="globe" size={18} />
            {t("language")}
          </span>
          <LanguageSelector expanded />
        </div>
        <label className="preference-row">
          <span className="preference-label">
            <Icon name={theme === "dark" ? "moon" : "sun"} size={18} />
            {t("theme")}
          </span>
          <select value={theme} onChange={(e) => onTheme(e.target.value)}>
            <option value="dark">{t("dark")}</option>
            <option value="light">{t("light")}</option>
          </select>
        </label>
        <p className="preferences-note">
          <Icon name="shield" size={16} />
          {t("privacyText")}
        </p>
      </section>
    </>
  );
}
