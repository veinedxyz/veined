"use client";
import { useCallback, useState, type FormEvent, type ReactNode } from "react";
import { useI18n } from "../i18n/provider";
import { adminCopy } from "../points/admin-copy";
import { displayPoints, exactPoints } from "../points/format";
import { BrandLogo } from "./brand-logo";
import { LifetimePolicyInspector } from "./lifetime-policy-inspector";
import { VolumePolicyInspector } from "./volume-policy-inspector";
import { Icon } from "./icons";
import { Pill } from "./ui";
import styles from "./points-admin.module.css";
// Internal points admin dashboard. The bearer token lives in component memory only (never storage, never a cookie);
// every number here is an admin-only provisional or settled figure from /api/admin/points.

type Json = Record<string, unknown>;
interface Account {
  account: string;
  activities: number;
  activityWeight: string;
  taskWeight: string;
  referrer: string | null;
  rank: number | null;
  activityUnits: string;
  taskUnits: string;
  referralUnits: string;
  totalUnits: string;
  correctionUnits: string;
  flags: string[];
}
interface Dashboard {
  principal: { id: string; roles: string[] };
  config: {
    operational: boolean;
    errors: string[];
    simulation: boolean;
    configHash?: string;
    policyVersion?: string;
    policyHash?: string;
    store?: string;
    trustedVerifiers?: string[];
    schedule?: { seasonOneStartsAt: string; activatedAt: string };
  };
  now?: string;
  currentSeason?: number;
  selectedSeason?: number;
  season?: {
    state: string;
    startsAt: string;
    endsAt: string;
    calculation?: {
      id: string;
      inputHash: string;
      resultHash: string;
      calculatedBy: string;
      calculatedAt: string;
      summary: Json;
    };
    finalizedBy?: string;
    publishedAt?: string;
    undistributed?: { units: string; decision: string };
    rejectedCalculations: string[];
  };
  basis?: "SETTLED" | "PROVISIONAL";
  provisional?: {
    calculationId: string;
    inputHash: string;
    resultHash: string;
    summary: Record<string, string>;
  };
  accounts?: Account[];
  activity?: {
    eligible: number;
    pendingFinality: number;
    rejected: number;
    reversed: number;
    recentIneligible: {
      eventId: string;
      account: string;
      category: string;
      status: string;
      reason?: string;
      afterFinalization: boolean;
    }[];
  };
  referrals?: {
    commissionLines: {
      parent: string;
      child: string;
      sourceRef: string;
      amountUnits: string;
    }[];
  };
  tasks?: (Json & {
    id: string;
    title: string;
    status: string;
    weight: string;
    createdBy: string;
    completions: number;
  })[];
  pendingReview?: {
    id: string;
    account: string;
    taskId: string;
    completedAt: string;
  }[];
  signals?: { account: string; signal: string }[];
  seasons?: {
    season: number;
    state: string;
    calculatedBy: string | null;
    finalizedBy: string | null;
    publishedAt: string | null;
    allocatedUnits: string | null;
    undistributed: { units: string; decision: string } | null;
    corrections: number;
  }[];
  corrections?: {
    id: string;
    season: number;
    eventId: string;
    status: string;
    proposedBy: string;
    entries: { amountUnits: string }[];
  }[];
  audit?: {
    seq: number;
    at: string;
    actor: string;
    action: string;
    target: string;
  }[];
}
interface Explain {
  denominator: string;
  lines: {
    lineId: string;
    kind: string;
    category?: string;
    occurredAt: string;
    volumeUsdMicros?: string;
    boundedVolumeUsdMicros?: string;
    rawWeight: string;
    effectiveWeight: string;
    referralParent: string | null;
    notes: string[];
    account: string;
  }[];
  provisionalEntries: {
    id: string;
    kind: string;
    account: string;
    amountUnits: string;
  }[];
  ledger: { id: string; kind: string; amountUnits: string }[];
}

const short = (a: string) =>
  a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-6)}` : a;
const usd = (micros?: string) =>
  micros ? (BigInt(micros) / 1_000_000n).toLocaleString("en-US") : "—";
const STEPS = [
  "OPEN",
  "CALCULATING",
  "REVIEW_PENDING",
  "FINALIZED",
  "PUBLISHED",
];

export function PointsAdmin() {
  const { lang } = useI18n();
  const c = adminCopy(lang);
  const [token, setToken] = useState("");
  const [draft, setDraft] = useState("");
  const [data, setData] = useState<Dashboard | null>(null);
  const [season, setSeason] = useState<number | undefined>(undefined);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(
    null,
  );
  const [explain, setExplain] = useState<{
    account: string;
    data: Explain;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState("");
  const pts = (u?: string | null) => (u ? displayPoints(u, lang) : "—");
  const when = (iso?: string | null) =>
    iso
      ? new Intl.DateTimeFormat(lang, {
          timeZone: "Europe/Istanbul",
          dateStyle: "short",
          timeStyle: "short",
        }).format(new Date(iso))
      : "—";

  const api = useCallback(
    async (body: Json, key = token) => {
      const res = await fetch("/api/admin/points", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${key}`,
        },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok)
        throw Object.assign(Error(String(json.error ?? res.status)), {
          status: res.status,
        });
      return json;
    },
    [token],
  );
  const refresh = useCallback(
    async (key = token, s = season) => {
      const next = (await api(
        { action: "dashboard", ...(s ? { season: s } : {}) },
        key,
      )) as Dashboard;
      setData(next);
      return next;
    },
    [api, token, season],
  );

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setMessage(null);
    try {
      await refresh(draft.trim(), undefined);
      setToken(draft.trim());
      setDraft("");
    } catch (error) {
      const code = (error as Error).message;
      setMessage({
        ok: false,
        text:
          code === "ADMIN_NOT_CONFIGURED" ? c.notConfigured : c.invalidToken,
      });
    }
  }
  async function act(body: Json) {
    setBusy(true);
    setMessage(null);
    try {
      await api(body);
      setMessage({ ok: true, text: `${c.done}: ${String(body.action)}` });
      await refresh();
    } catch (error) {
      setMessage({
        ok: false,
        text: `${c.failed}: ${(error as Error).message}`,
      });
    } finally {
      setBusy(false);
    }
  }
  async function open(account: string) {
    try {
      setExplain({
        account,
        data: (await api({
          action: "explain",
          account,
          season: data?.selectedSeason ?? 1,
        })) as Explain,
      });
    } catch (error) {
      setMessage({
        ok: false,
        text: `${c.failed}: ${(error as Error).message}`,
      });
    }
  }
  // Actions that need a justification read it from the explicit reason field (never a blocking browser prompt).
  const ask = () => {
    const value = reason.trim();
    if (value.length < 3) setMessage({ ok: false, text: c.reasonRequired });
    return value.length >= 3 ? value : "";
  };

  if (!token || !data)
    return (
      <main className={styles.shell}>
        <Header c={c} />
        <form className={`card ${styles.signIn}`} onSubmit={signIn}>
          <h1>{c.signInTitle}</h1>
          <p className="muted">{c.signInBody}</p>
          <label className={styles.field}>
            <span>{c.token}</span>
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button className="primary" disabled={!draft.trim()}>
            <Icon name="lock" size={16} />
            {c.signIn}
          </button>
          {message && (
            <p className={message.ok ? styles.ok : styles.bad}>
              {message.text}
            </p>
          )}
        </form>
      </main>
    );

  const roles = new Set(data.principal.roles);
  const can = (role: string) => roles.has(role);
  const s = data.season;
  const summary = data.provisional?.summary;
  const totalWeight = (data.accounts ?? []).reduce(
    (sum, a) => sum + BigInt(a.activityWeight) + BigInt(a.taskWeight),
    0n,
  );
  const seasonsList = Array.from(
    { length: Math.max(data.currentSeason ?? 1, 1) },
    (_, i) => i + 1,
  ).reverse();

  return (
    <main className={styles.shell}>
      <Header c={c}>
        <Pill tone="info" icon="shield">
          {data.principal.id} · {data.principal.roles.join(", ")}
        </Pill>
        {data.config.simulation && (
          <Pill tone="warn" dot>
            {c.simulation}
          </Pill>
        )}
        <button
          className="small"
          onClick={() => {
            setToken("");
            setData(null);
          }}
        >
          {c.signOut}
        </button>
      </Header>
      {message && (
        <p className={message.ok ? styles.ok : styles.bad} role="status">
          {message.text}
        </p>
      )}
      {!data.config.operational ? (
        <section className="card">
          <h2>{c.programClosed}</h2>
          <p className="muted">{data.config.errors.join(", ")}</p>
        </section>
      ) : (
        <>
          <div className={styles.toolbar}>
            <label className={styles.inline}>
              <span>{c.season}</span>
              <select
                value={data.selectedSeason}
                onChange={(e) => {
                  const next = Number(e.target.value);
                  setSeason(next);
                  refresh(token, next).catch(() => {});
                }}
              >
                {seasonsList.map((n) => (
                  <option key={n} value={n}>
                    {n}
                    {n === data.currentSeason ? ` (${c.live})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <Pill
              tone={
                s?.state === "PUBLISHED"
                  ? "ok"
                  : s?.state === "OPEN"
                    ? "neutral"
                    : "warn"
              }
            >
              {s?.state}
            </Pill>
            <span className="micro">
              {when(s?.startsAt)} → {when(s?.endsAt)} · {c.timeZone}
            </span>
            <button className="small" onClick={() => void refresh()}>
              <Icon name="refresh" size={14} />
              {c.refresh}
            </button>
            <label className={styles.inline}>
              <span>{c.reason}</span>
              <input
                value={reason}
                maxLength={200}
                onChange={(e) => setReason(e.target.value)}
                placeholder={c.reasonHint}
              />
            </label>
          </div>
          {data.config.simulation && (
            <p className="notice">
              {c.simulationNote} {data.now ? `· ${when(data.now)}` : ""}
            </p>
          )}

          <LifetimePolicyInspector lang={lang} />
          <VolumePolicyInspector lang={lang} />
          <section className={styles.stats}>
            <Stat label={c.pool} value={pts(summary?.poolUnits)} />
            <Stat
              label={c.totalWeight}
              value={totalWeight.toLocaleString("en-US")}
            />
            <Stat
              label={c.allocated}
              value={pts(summary?.allocatedUnits)}
              hint={summary ? exactPoints(summary.allocatedUnits) : ""}
            />
            <Stat label={c.commission} value={pts(summary?.commissionUnits)} />
            <Stat
              label={c.undistributed}
              value={pts(summary?.undistributedUnits)}
              hint={summary ? exactPoints(summary.undistributedUnits) : ""}
            />
            <Stat
              label={c.participants}
              value={String(summary?.accounts ?? "—")}
            />
          </section>
          <p className="micro">
            {c.provisionalNote} {c.denominator}: {summary?.denominator} ·{" "}
            {c.resultHash}: {data.provisional?.resultHash.slice(0, 16)}…
          </p>

          <section className="card">
            <h2>{c.settlement}</h2>
            <ol className={styles.steps}>
              {STEPS.map((step) => (
                <li
                  key={step}
                  className={
                    step === s?.state
                      ? styles.current
                      : STEPS.indexOf(step) < STEPS.indexOf(s?.state ?? "")
                        ? styles.past
                        : ""
                  }
                >
                  {step}
                </li>
              ))}
            </ol>
            {s?.calculation && (
              <dl className={styles.kv}>
                <dt>{c.calculation}</dt>
                <dd>{s.calculation.id}</dd>
                <dt>{c.inputHash}</dt>
                <dd>{s.calculation.inputHash}</dd>
                <dt>{c.resultHash}</dt>
                <dd>{s.calculation.resultHash}</dd>
                <dt>{c.calculatedBy}</dt>
                <dd>
                  {s.calculation.calculatedBy} ·{" "}
                  {when(s.calculation.calculatedAt)}
                </dd>
                {s.finalizedBy && (
                  <>
                    <dt>{c.finalizedBy}</dt>
                    <dd>{s.finalizedBy}</dd>
                  </>
                )}
                {s.publishedAt && (
                  <>
                    <dt>{c.publishedAt}</dt>
                    <dd>{when(s.publishedAt)}</dd>
                  </>
                )}
                {s.undistributed && (
                  <>
                    <dt>{c.undistributed}</dt>
                    <dd>
                      {pts(s.undistributed.units)} · {s.undistributed.decision}
                    </dd>
                  </>
                )}
              </dl>
            )}
            <div className={styles.actions}>
              {can("operator") && s?.state === "OPEN" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void act({
                      action: "calculate",
                      season: data.selectedSeason,
                    })
                  }
                >
                  {c.calculate}
                </button>
              )}
              {can("approver") &&
                s?.state === "REVIEW_PENDING" &&
                s.calculation && (
                  <>
                    <button
                      className="primary"
                      disabled={
                        busy || s.calculation.calculatedBy === data.principal.id
                      }
                      title={c.fourEyes}
                      onClick={() =>
                        void act({
                          action: "finalize",
                          season: data.selectedSeason,
                          calculationId: s.calculation!.id,
                        })
                      }
                    >
                      {c.finalize}
                    </button>
                    <button
                      className="secondary"
                      disabled={busy}
                      onClick={() => {
                        const why = ask();
                        if (why)
                          void act({
                            action: "reject",
                            season: data.selectedSeason,
                            reason: why,
                          });
                      }}
                    >
                      {c.reject}
                    </button>
                  </>
                )}
              {can("approver") && s?.state === "FINALIZED" && (
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    void act({ action: "publish", season: data.selectedSeason })
                  }
                >
                  {c.publish}
                </button>
              )}
              {can("approver") &&
                s?.undistributed?.decision === "PENDING_OWNER_DECISION" &&
                ["FINALIZED", "PUBLISHED"].includes(s.state) && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      const note = ask();
                      if (note)
                        void act({
                          action: "retain-undistributed",
                          season: data.selectedSeason,
                          note,
                        });
                    }}
                  >
                    {c.retain}
                  </button>
                )}
            </div>
            <p className="micro">{c.fourEyes}</p>
          </section>

          <section className="card">
            <div className="card-top">
              <h2>{c.accounts}</h2>
              <Pill tone={data.basis === "SETTLED" ? "ok" : "warn"}>
                {data.basis === "SETTLED" ? c.settledBasis : c.provisionalBasis}
              </Pill>
            </div>
            <Table
              head={[
                c.rank,
                c.account,
                c.activities,
                c.activityWeight,
                c.taskWeight,
                c.referrer,
                c.activityPts,
                c.taskPts,
                c.referralPts,
                c.total,
                c.correctionsCol,
                c.flags,
                "",
              ]}
              rows={(data.accounts ?? []).map((a) => [
                a.rank ?? "—",
                <code key="a" title={a.account}>
                  {short(a.account)}
                </code>,
                a.activities,
                a.activityWeight,
                a.taskWeight,
                a.referrer ? (
                  <code title={a.referrer}>{short(a.referrer)}</code>
                ) : (
                  "—"
                ),
                pts(a.activityUnits),
                pts(a.taskUnits),
                pts(a.referralUnits),
                <strong key="t" title={exactPoints(a.totalUnits)}>
                  {pts(a.totalUnits)}
                </strong>,
                a.correctionUnits === "0" ? "—" : pts(a.correctionUnits),
                a.flags.join(", ") || "—",
                <span key="x" className={styles.rowActions}>
                  <button
                    className="small"
                    onClick={() => void open(a.account)}
                  >
                    {c.explain}
                  </button>
                  {can("operator") && (
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() => {
                        const excluded = a.flags.includes("EXCLUDED");
                        const why = ask();
                        if (why)
                          void act({
                            action: "flag",
                            account: a.account,
                            kind: "EXCLUDED",
                            active: !excluded,
                            reason: why,
                          });
                      }}
                    >
                      {a.flags.includes("EXCLUDED") ? c.include : c.exclude}
                    </button>
                  )}
                </span>,
              ])}
            />
          </section>

          {explain && (
            <section
              className={`card ${styles.explain}`}
              aria-label={c.explainTitle}
            >
              <div className="card-top">
                <h2>
                  {c.explainTitle}: <code>{short(explain.account)}</code>
                </h2>
                <button className="small" onClick={() => setExplain(null)}>
                  {c.close}
                </button>
              </div>
              <p className="micro">
                {c.denominator}: {explain.data.denominator}
              </p>
              <Table
                head={[
                  c.line,
                  c.category,
                  c.occurred,
                  c.volume,
                  c.bounded,
                  c.rawWeight,
                  c.effectiveWeight,
                  c.parent,
                  c.notes,
                ]}
                rows={explain.data.lines.map((l) => [
                  <code key="l">{l.lineId}</code>,
                  l.category ?? l.kind,
                  when(l.occurredAt),
                  usd(l.volumeUsdMicros),
                  usd(l.boundedVolumeUsdMicros),
                  l.rawWeight,
                  l.effectiveWeight,
                  l.referralParent ? short(l.referralParent) : "—",
                  l.account === explain.account
                    ? l.notes.join(", ") || "—"
                    : `↳ ${short(l.account)}`,
                ])}
              />
              <Table
                head={[c.line, c.category, c.amount]}
                rows={explain.data.provisionalEntries.map((e) => [
                  <code key="e">{e.id}</code>,
                  e.kind,
                  pts(e.amountUnits),
                ])}
              />
              {explain.data.ledger.length > 0 && (
                <>
                  <h3>{c.ledger}</h3>
                  <Table
                    head={[c.line, c.category, c.amount]}
                    rows={explain.data.ledger.map((e) => [
                      <code key="e">{e.id}</code>,
                      e.kind,
                      pts(e.amountUnits),
                    ])}
                  />
                </>
              )}
            </section>
          )}

          <div className={styles.grid}>
            <section className="card">
              <h2>{c.referrals}</h2>
              <Table
                head={[c.referrer, c.child, c.line, c.amount]}
                rows={(data.referrals?.commissionLines ?? []).map((r) => [
                  short(r.parent),
                  short(r.child),
                  <code key="s">{r.sourceRef}</code>,
                  pts(r.amountUnits),
                ])}
              />
            </section>
            <section className="card">
              <h2>{c.signals}</h2>
              {data.signals?.length ? (
                <Table
                  head={[c.account, c.status]}
                  rows={data.signals.map((x) => [
                    <code key="a">{short(x.account)}</code>,
                    x.signal,
                  ])}
                />
              ) : (
                <p className="muted">{c.noSignals}</p>
              )}
            </section>
          </div>

          <section className="card">
            <h2>{c.activity}</h2>
            <dl className={styles.counts}>
              <div>
                <dt>{c.eligible}</dt>
                <dd>{data.activity?.eligible}</dd>
              </div>
              <div>
                <dt>{c.pending}</dt>
                <dd>{data.activity?.pendingFinality}</dd>
              </div>
              <div>
                <dt>{c.rejected}</dt>
                <dd>{data.activity?.rejected}</dd>
              </div>
              <div>
                <dt>{c.reversed}</dt>
                <dd>{data.activity?.reversed}</dd>
              </div>
            </dl>
            <h3>{c.ineligible}</h3>
            <Table
              head={[c.eventId, c.account, c.category, c.status, c.reason, ""]}
              rows={(data.activity?.recentIneligible ?? []).map((r) => [
                <code key="e">{r.eventId}</code>,
                short(r.account),
                r.category,
                r.status,
                r.reason ?? "—",
                r.afterFinalization && can("operator") ? (
                  <button
                    key="p"
                    className="small"
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "correction-propose",
                        season: data.selectedSeason,
                        eventId: r.eventId,
                      })
                    }
                  >
                    {c.propose}
                  </button>
                ) : (
                  ""
                ),
              ])}
            />
          </section>

          <section className="card">
            <h2>{c.corrections}</h2>
            <Table
              head={[c.taskId, c.season, c.eventId, c.status, c.amount, ""]}
              rows={(data.corrections ?? []).map((x) => [
                <code key="i">{x.id}</code>,
                x.season,
                <code key="e">{x.eventId}</code>,
                x.status,
                pts(
                  x.entries
                    .reduce((sum, e) => sum + BigInt(e.amountUnits), 0n)
                    .toString(),
                ),
                x.status === "PROPOSED" && can("approver") ? (
                  <span key="a" className={styles.rowActions}>
                    <button
                      className="small"
                      disabled={busy || x.proposedBy === data.principal.id}
                      onClick={() =>
                        void act({
                          action: "correction-decide",
                          id: x.id,
                          apply: true,
                        })
                      }
                    >
                      {c.apply}
                    </button>
                    <button
                      className="small"
                      disabled={busy}
                      onClick={() =>
                        void act({
                          action: "correction-decide",
                          id: x.id,
                          apply: false,
                        })
                      }
                    >
                      {c.decline}
                    </button>
                  </span>
                ) : (
                  ""
                ),
              ])}
            />
          </section>

          <TaskPanel
            c={c}
            data={data}
            busy={busy}
            can={can}
            act={act}
            when={when}
            ask={ask}
          />

          <section className="card">
            <h2>{c.history}</h2>
            <Table
              head={[
                c.season,
                c.state,
                c.calculatedBy,
                c.finalizedBy,
                c.publishedAt,
                c.allocated,
                c.undistributed,
                c.corrections,
              ]}
              rows={(data.seasons ?? []).map((x) => [
                x.season,
                x.state,
                x.calculatedBy ?? "—",
                x.finalizedBy ?? "—",
                when(x.publishedAt),
                pts(x.allocatedUnits),
                x.undistributed
                  ? `${pts(x.undistributed.units)} · ${x.undistributed.decision}`
                  : "—",
                x.corrections,
              ])}
            />
          </section>

          {data.config.simulation && can("operator") && (
            <SimPanel c={c} busy={busy} act={act} />
          )}

          <section className="card">
            <h2>{c.config}</h2>
            <dl className={styles.kv}>
              <dt>{c.policy}</dt>
              <dd>
                {data.config.policyVersion} · {data.config.policyHash}
              </dd>
              <dt>{c.configHash}</dt>
              <dd>{data.config.configHash}</dd>
              <dt>{c.season} 1</dt>
              <dd>{when(data.config.schedule?.seasonOneStartsAt)}</dd>
              <dt>{c.store}</dt>
              <dd>{data.config.store}</dd>
              <dt>{c.verifiers}</dt>
              <dd>{data.config.trustedVerifiers?.join(", ") || c.none}</dd>
            </dl>
          </section>

          <section className="card">
            <h2>{c.audit}</h2>
            <Table
              head={["#", c.at, c.actor, c.action, c.target]}
              rows={(data.audit ?? []).map((a) => [
                a.seq,
                when(a.at),
                a.actor,
                a.action,
                <code key="t">
                  {a.target.length > 40 ? short(a.target) : a.target}
                </code>,
              ])}
            />
          </section>
        </>
      )}
    </main>
  );
}

function Header({
  c,
  children,
}: {
  c: ReturnType<typeof adminCopy>;
  children?: ReactNode;
}) {
  return (
    <header className={styles.header}>
      <div className={styles.brand}>
        <BrandLogo decorative />
        <div>
          <p className="visual-eyebrow">{c.eyebrow}</p>
          <h1>{c.title}</h1>
        </div>
      </div>
      <div className={styles.headerActions}>{children}</div>
    </header>
  );
}
function Stat({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className={styles.stat} title={hint}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
function Table({ head, rows }: { head: ReactNode[]; rows: ReactNode[][] }) {
  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TaskPanel({
  c,
  data,
  busy,
  can,
  act,
  when,
  ask,
}: {
  c: ReturnType<typeof adminCopy>;
  data: Dashboard;
  busy: boolean;
  can: (role: string) => boolean;
  act: (body: Json) => Promise<void>;
  when: (iso?: string | null) => string;
  ask: () => string;
}) {
  const [form, setForm] = useState({
    id: "",
    title: "",
    description: "",
    category: "",
    minCount: "1",
    weight: "500",
    perUserLimit: "1",
    globalLimit: "1000",
    startsAt: "",
    endsAt: "",
    requiresReview: false,
  });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <section className="card">
      <h2>{c.tasks}</h2>
      <Table
        head={[c.taskId, c.taskTitle, c.status, c.weight, c.completions, ""]}
        rows={(data.tasks ?? []).map((t) => [
          <code key="i">{t.id}</code>,
          t.title,
          t.status,
          t.weight,
          t.completions,
          <span key="a" className={styles.rowActions}>
            {t.status === "DRAFT" && can("approver") && (
              <button
                className="small"
                disabled={busy || t.createdBy === data.principal.id}
                onClick={() => void act({ action: "task-approve", id: t.id })}
              >
                {c.approve}
              </button>
            )}
            {t.status !== "CANCELLED" && can("operator") && (
              <button
                className="small"
                disabled={busy}
                onClick={() => {
                  const why = ask();
                  if (why)
                    void act({ action: "task-cancel", id: t.id, reason: why });
                }}
              >
                {c.cancel}
              </button>
            )}
          </span>,
        ])}
      />
      {(data.pendingReview?.length ?? 0) > 0 && (
        <>
          <h3>{c.pendingReview}</h3>
          <Table
            head={[c.taskId, c.account, c.occurred, ""]}
            rows={data.pendingReview!.map((p) => [
              <code key="i">{p.id}</code>,
              p.account.slice(0, 10),
              when(p.completedAt),
              can("approver") ? (
                <span key="a" className={styles.rowActions}>
                  <button
                    className="small"
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "completion-review",
                        id: p.id,
                        approve: true,
                        reason: "reviewed",
                      })
                    }
                  >
                    {c.accept}
                  </button>
                  <button
                    className="small"
                    disabled={busy}
                    onClick={() =>
                      void act({
                        action: "completion-review",
                        id: p.id,
                        approve: false,
                        reason: "declined",
                      })
                    }
                  >
                    {c.decline}
                  </button>
                </span>
              ) : (
                ""
              ),
            ])}
          />
        </>
      )}
      {can("operator") && (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            void act({
              action: "task-create",
              task: {
                id: form.id,
                title: form.title,
                description: form.description,
                criteria: {
                  ...(form.category ? { category: form.category } : {}),
                  minCount: Number(form.minCount),
                },
                weight: form.weight,
                perUserLimit: Number(form.perUserLimit),
                globalLimit: Number(form.globalLimit),
                startsAt: form.startsAt,
                endsAt: form.endsAt,
                requiresReview: form.requiresReview,
              },
            });
          }}
        >
          <h3>{c.createTask}</h3>
          <label className={styles.field}>
            <span>{c.taskId}</span>
            <input
              value={form.id}
              onChange={set("id")}
              pattern="[a-z0-9][a-z0-9-]{2,47}"
              required
            />
          </label>
          <label className={styles.field}>
            <span>{c.taskTitle}</span>
            <input
              value={form.title}
              onChange={set("title")}
              required
              minLength={3}
              maxLength={80}
            />
          </label>
          <label className={styles.field}>
            <span>{c.taskDescription}</span>
            <input
              value={form.description}
              onChange={set("description")}
              maxLength={400}
            />
          </label>
          <label className={styles.field}>
            <span>{c.taskCategory}</span>
            <select value={form.category} onChange={set("category")}>
              <option value="">—</option>
              <option value="SWAP">SWAP</option>
              <option value="TRADE">TRADE</option>
              <option value="BRIDGE">BRIDGE</option>
            </select>
          </label>
          {(
            [
              ["minCount", c.minCount],
              ["weight", c.weight],
              ["perUserLimit", c.perUser],
              ["globalLimit", c.global],
            ] as const
          ).map(([key, label]) => (
            <label key={key} className={styles.field}>
              <span>{label}</span>
              <input
                inputMode="numeric"
                value={form[key]}
                onChange={set(key)}
                pattern="[0-9]+"
                required
              />
            </label>
          ))}
          <label className={styles.field}>
            <span>{c.startsAt}</span>
            <input
              value={form.startsAt}
              onChange={set("startsAt")}
              placeholder="2026-11-16T21:00:00.000Z"
              required
            />
          </label>
          <label className={styles.field}>
            <span>{c.endsAt}</span>
            <input
              value={form.endsAt}
              onChange={set("endsAt")}
              placeholder="2026-11-23T21:00:00.000Z"
              required
            />
          </label>
          <label className={styles.check}>
            <input
              type="checkbox"
              checked={form.requiresReview}
              onChange={(e) =>
                setForm({ ...form, requiresReview: e.target.checked })
              }
            />
            <span>{c.requiresReview}</span>
          </label>
          <button className="secondary" disabled={busy}>
            {c.createTask}
          </button>
        </form>
      )}
    </section>
  );
}

function SimPanel({
  c,
  busy,
  act,
}: {
  c: ReturnType<typeof adminCopy>;
  busy: boolean;
  act: (body: Json) => Promise<void>;
}) {
  const [form, setForm] = useState({
    account: "",
    category: "SWAP",
    usd: "1000",
    outcome: "",
    referralCode: "",
    confirmations: "",
  });
  const [eventId, setEventId] = useState("");
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm({ ...form, [k]: e.target.value });
  return (
    <section className={`card ${styles.sim}`}>
      <h2>{c.simulation}</h2>
      <p className="micro">{c.simulationNote}</p>
      <div className={styles.actions}>
        <span>{c.simClock}</span>
        {(
          [
            [3600, c.hour],
            [86_400, c.day],
            [604_800, c.week],
          ] as const
        ).map(([seconds, label]) => (
          <button
            key={seconds}
            className="small"
            disabled={busy}
            onClick={() =>
              void act({ action: "sim-clock", advanceSeconds: seconds })
            }
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void act({
            action: "sim-ingest",
            account: form.account.trim(),
            category: form.category,
            usd: Number(form.usd),
            ...(form.outcome ? { outcome: form.outcome } : {}),
            ...(form.referralCode.trim()
              ? { referralCode: form.referralCode.trim() }
              : {}),
            ...(form.confirmations
              ? { confirmations: Number(form.confirmations) }
              : {}),
          });
        }}
      >
        <h3>{c.simIngest}</h3>
        <label className={styles.field}>
          <span>{c.account}</span>
          <input
            value={form.account}
            onChange={set("account")}
            placeholder="0x…"
            required
          />
        </label>
        <label className={styles.field}>
          <span>{c.category}</span>
          <select value={form.category} onChange={set("category")}>
            <option>SWAP</option>
            <option>TRADE</option>
            <option>BRIDGE</option>
          </select>
        </label>
        <label className={styles.field}>
          <span>{c.usd}</span>
          <input
            inputMode="decimal"
            value={form.usd}
            onChange={set("usd")}
            required
          />
        </label>
        <label className={styles.field}>
          <span>{c.outcome}</span>
          <select value={form.outcome} onChange={set("outcome")}>
            <option value="">SETTLED / COMPLETED</option>
            {[
              "FAILED",
              "REVERTED",
              "PENDING",
              "CANCELLED",
              "QUOTE",
              "UNSIGNED_INTENT",
            ].map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span>{c.referralCode}</span>
          <input value={form.referralCode} onChange={set("referralCode")} />
        </label>
        <label className={styles.field}>
          <span>{c.confirmations}</span>
          <input
            inputMode="numeric"
            value={form.confirmations}
            onChange={set("confirmations")}
          />
        </label>
        <button className="secondary" disabled={busy}>
          {c.ingest}
        </button>
      </form>
      <form
        className={styles.inlineForm}
        onSubmit={(e) => {
          e.preventDefault();
          if (eventId.trim())
            void act({ action: "sim-reverse", eventId: eventId.trim() });
        }}
      >
        <label className={styles.field}>
          <span>{c.eventId}</span>
          <input value={eventId} onChange={(e) => setEventId(e.target.value)} />
        </label>
        <button className="secondary" disabled={busy}>
          {c.reverse}
        </button>
      </form>
    </section>
  );
}
