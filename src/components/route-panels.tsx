"use client";
// V1.11 simplified Bridge side panels. Route: networks, tokens, receive, fee and time up front; protocol, contracts,
// chain IDs, quote ID and exact steps behind "Route details". Route health: ONE state (ready / needs refresh /
// temporarily unavailable / sending disabled) and at most three compact rows; runtime pins, authority, reserve,
// RPC consensus, pending/in-flight and last check behind "Safety details". The execution truth is shown here and on
// the CTA — never as a permanent header label. Disclosure bodies are lazy (./route-details) so pin/contract data
// never enters the Bridge first-load bundle.
import { useState, type ReactNode } from "react";
import type { Network } from "../routing/model";
import { ChainBadge } from "./multichain-identity";
import { Icon, type IconName } from "./icons";

export type RouteHealthState = "ready" | "refresh" | "unavailable" | "disabled";
export interface RouteSummary {
  source: Network;
  destination: Network;
  fromSymbol: string;
  toSymbol: string;
  receive: string | null;
  fee: string | null;
  time: string | null;
  details: () => ReactNode;
}
export interface RouteHealth {
  state: RouteHealthState;
  rows: { icon: IconName; label: string; value: string; ok: boolean | null }[];
  safety: () => ReactNode;
}
type T = (key: string, values?: Record<string, string | number>) => string;
const STATE: Record<RouteHealthState, [string, string]> = {
  ready: ["v112.verified", "ok"],
  refresh: ["v112.reviewRequired", "warn"],
  unavailable: ["v111.temporarilyUnavailable", "danger"],
  disabled: ["v111.sendingDisabled", "info"],
};
function Disclosure({ label, body }: { label: string; body: () => ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <details
      className="disclosure"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary onClick={() => setOpen(true)}>{label}</summary>
      {open && <div className="disclosure-body">{body()}</div>}
    </details>
  );
}
export function RouteSummaryCard({ route, t }: { route: RouteSummary; t: T }) {
  const fact = (label: string, value: string | null, fallback: string) => (
    <div className="route-fact">
      <dt>{label}</dt>
      <dd>
        {value ? (
          <bdi dir="ltr">{value}</bdi>
        ) : (
          <span className="muted">{fallback}</span>
        )}
      </dd>
    </div>
  );
  return (
    <section className="card route-card" aria-labelledby="route-summary-title">
      <h2 id="route-summary-title">{t("v111.route")}</h2>
      <div className="route-identity">
        <ChainBadge network={route.source} />
        <Icon name="arrowRight" size={14} className="route-arrow flip-rtl" />
        <ChainBadge network={route.destination} />
      </div>
      <p className="route-line">
        <span>{route.fromSymbol}</span>
        <Icon name="arrowRight" size={14} className="flip-rtl" />
        <span>{route.toSymbol}</span>
      </p>
      {(route.receive || route.fee) && (
        <dl className="route-facts">
          {fact(t("v111.youReceive"), route.receive, t("v110.afterQuote"))}
          {fact(t("v111.fee"), route.fee, t("v110.afterQuote"))}
          {fact(t("ui.estimatedTime"), route.time, t("v111.notReported"))}
        </dl>
      )}
      <Disclosure label={t("v111.routeDetails")} body={route.details} />
    </section>
  );
}
export function RouteHealthCard({ health, t }: { health: RouteHealth; t: T }) {
  const [key, tone] = STATE[health.state];
  return (
    <section className="card health-card" aria-labelledby="route-health-title">
      <div className="card-top">
        <h2 id="route-health-title">{t("v111.routeHealth")}</h2>
        <span className={`pill tone-${tone}`} data-route-state={health.state}>
          <span className="pill-dot" aria-hidden="true" />
          {t(key)}
        </span>
      </div>
      <Disclosure
        label={t("v111.safetyDetails")}
        body={() => (
          <>
            {" "}
            <ul className="status-list">
              {health.rows.slice(0, 3).map((r) => (
                <li key={r.label}>
                  <Icon name={r.icon} size={16} />
                  <span>{r.label}</span>
                  <strong
                    className={
                      r.ok === null ? "muted" : r.ok ? "teal" : "amber"
                    }
                  >
                    {r.value}
                  </strong>
                </li>
              ))}
            </ul>
            {health.safety()}
          </>
        )}
      />
    </section>
  );
}
