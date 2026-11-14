"use client";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useI18n } from "../i18n/provider";
import type { MessageKey } from "../i18n/messages";
import { displayPoints, exactPoints } from "../points/format";
import { Icon } from "./icons";
import { EmptyState, PageHeader, Pill, Skeleton, useCopy } from "./ui";
import styles from "./points-view.module.css";
import { LifetimePoints } from "./lifetime-points";
// V1.22 weekly points. Everything shown comes from /api/points public projections: the live season is a countdown
// only; numbers exist solely for seasons the owner has finalized and published.
// gf1 G06 (owner's new direction): the page leads with the user's own lifetime points (policy pending the owner's
// numbers, so no figure is shown) and keeps the weekly seasons as their own, distinguishable section. New journeys no
// longer show the weekly 200,000 pool, other accounts' rankings or participant counts; nothing is deleted: published
// seasons, the user's own results and the server API are unchanged.

type Window = { season: number; startsAt: string; endsAt: string };
interface Overview {
  program: { status: "CLOSED" | "NOT_STARTED" | "LIVE"; serverTime: string };
  upcoming?: Window | null;
  current?: (Window & { resultsHidden: true }) | null;
  archive?: (Window & { publishedAt: string })[];
  latestPublished?: number | null;
  awaitingResults?: number[];
  account?: {
    referral: {
      code: string | null;
      codeAvailable: boolean;
      invitedBy: string | null;
      boundAt: string | null;
      referrals: { account: string; boundAt: string }[];
    };
  };
}
interface Row {
  rank: number;
  account: string;
  activityUnits: string;
  taskUnits: string;
  referralUnits: string;
  totalUnits: string;
  correctionUnits: string;
  netUnits: string;
}
interface Task {
  id: string;
  title: string;
  description: string;
  state: "UPCOMING" | "ACTIVE" | "ENDED" | "CANCELLED";
  startsAt: string;
  endsAt: string;
  criteria: {
    category?: "SWAP" | "TRADE" | "BRIDGE";
    chainIds?: string[];
    minEventVolumeUsdMicros?: string;
    minCount: number;
  };
  perUserLimit: number;
  requiresReview: boolean;
  completions?: {
    ordinal: number;
    status: "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "VOIDED";
  }[];
}
type HistoryRow = Row & { season: number; publishedAt: string };

const INVITE_KEY = "veined.points.invite";
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
async function call<T>(body: object): Promise<T> {
  const res = await fetch("/api/points", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok)
    throw Object.assign(Error(String(json.error ?? "POINTS_UNAVAILABLE")), {
      status: res.status,
    });
  return json as T;
}
const pad = (n: number) => String(n).padStart(2, "0");

function Countdown({
  target,
  skew,
  label,
  onDone,
}: {
  target: string;
  skew: number;
  label: string;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now() + skew);
  const done = useRef(false);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now() + skew), 1000);
    return () => clearInterval(id);
  }, [skew]);
  const left = Math.max(0, Date.parse(target) - now);
  useEffect(() => {
    if (left === 0 && !done.current) {
      done.current = true;
      onDone();
    }
  }, [left, onDone]);
  const s = Math.floor(left / 1000);
  const parts = [
    [Math.floor(s / 86400), "points.countdown.days"],
    [Math.floor((s % 86400) / 3600), "points.countdown.hours"],
    [Math.floor((s % 3600) / 60), "points.countdown.minutes"],
    [s % 60, "points.countdown.seconds"],
  ] as const;
  return (
    <div className={styles.countdown}>
      <p className="micro">{label}</p>
      <div
        className={styles.segments}
        role="timer"
        aria-label={t("points.countdown.timer", {
          days: parts[0][0],
          hours: parts[1][0],
          minutes: parts[2][0],
        })}
      >
        {parts.map(([value, key]) => (
          <span key={key} className={styles.segment} aria-hidden="true">
            <strong>{pad(value)}</strong>
            <small>{t(key)}</small>
          </span>
        ))}
      </div>
    </div>
  );
}

export default function PointsView({
  account,
  onConnect,
}: {
  account: string;
  onConnect: () => void;
}) {
  const { t, lang } = useI18n();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [skew, setSkew] = useState(0);
  const [error, setError] = useState(false);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [history, setHistory] = useState<HistoryRow[]>([]);
  // The wallet whose own history is on screen; nothing of a wallet's own results shows before it (review-3 MN1).
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [invite, setInvite] = useState("");
  const [busy, setBusy] = useState(false);
  const [codeError, setCodeError] = useState(false);
  // gf1 G06: the labelled SAMPLE preview of lifetime points opens only with ?lifetimePreview=sample (this view renders
  // in the browser only, so the address is available on first render).
  const [sample] = useState(
    () =>
      new URLSearchParams(window.location.search).get("lifetimePreview") ===
      "sample",
  );
  // G12 H05: the earlier weekly program is closed and no longer part of the public page. Its published results stay
  // readable, unchanged, as an archive opened only with ?weekly=archive (not linked from the page); without it the
  // weekly projections are not even requested.
  const [archive] = useState(
    () =>
      new URLSearchParams(window.location.search).get("weekly") === "archive",
  );
  const { copied, copy } = useCopy();
  const date = useCallback(
    (iso: string, time = true) =>
      new Intl.DateTimeFormat(lang, {
        timeZone: "Europe/Istanbul",
        dateStyle: "medium",
        ...(time ? { timeStyle: "short" } : {}),
      }).format(new Date(iso)),
    [lang],
  );
  const points = (units: string) => displayPoints(units, lang);

  // gf1 G06 (review-2 mn6, review-3 MN1/MN4): a load applies only while its wallet is the current one and it is the
  // latest load for that wallet, so a late answer for another wallet (for example a code request still in flight
  // when the wallet changed) can neither show nor discard anything; a wallet switch clears the previous wallet's
  // overview, tasks and results before anything of the new wallet arrives.
  const loadSeq = useRef(0);
  const latestFor = useRef(new Map<string, number>());
  const currentAccount = useRef(account);
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    currentAccount.current = account;
  }, [account]);
  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    latestFor.current.set(account, seq);
    const live = () =>
      currentAccount.current === account &&
      latestFor.current.get(account) === seq;
    if (!live()) return;
    setError(false);
    if (shownFor.current !== account) {
      shownFor.current = account;
      setOverview(null);
      setTasks([]);
      setHistory([]);
      setHistoryFor(null);
    }
    try {
      const requested = Date.now();
      const next = await call<Overview>({
        action: "overview",
        ...(account ? { account } : {}),
      });
      if (!live()) return;
      setSkew(
        Date.parse(next.program.serverTime) -
          Math.round((requested + Date.now()) / 2),
      );
      setOverview(next);
      if (next.program.status === "CLOSED") return;
      const [taskList, rows] = await Promise.all([
        call<{ tasks: Task[] }>({
          action: "tasks",
          ...(account ? { account } : {}),
        }),
        account
          ? call<{ seasons: HistoryRow[] }>({ action: "history", account })
          : Promise.resolve({ seasons: [] }),
      ]);
      if (!live()) return;
      setTasks(taskList.tasks);
      setHistory(rows.seasons);
      setHistoryFor(account);
    } catch {
      if (live()) setError(true);
    }
  }, [account]);
  useEffect(() => {
    // Initial and per-account load of the public projections.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch-driven state, as in the other product views
    if (archive) void load();
  }, [load, archive]);

  // gf1 G06 (review M6): the public leaderboard is no longer downloaded. A published season shows its publication date
  // from the overview archive and, for a connected wallet, the account's own result from its own history.
  const season = selected ?? overview?.latestPublished ?? null;
  const published =
    (season && overview?.archive?.find((s) => s.season === season)) || null;
  const ownLoaded = !!account && historyFor === account;
  const own =
    (ownLoaded && season && history.find((r) => r.season === season)) || null;

  // Invitation links (/points?ref=CODE) are remembered in this browser only; the code becomes effective solely
  // through the invited wallet's own first verified activity.
  useEffect(() => {
    try {
      const url = new URL(window.location.href);
      const ref = url.searchParams.get("ref")?.toUpperCase() ?? "";
      if (CODE.test(ref)) {
        localStorage.setItem(INVITE_KEY, ref);
        url.searchParams.delete("ref");
        window.history.replaceState(
          window.history.state,
          "",
          url.pathname + url.search + url.hash,
        );
      }
      const saved = localStorage.getItem(INVITE_KEY) ?? "";
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reads browser-only storage after hydration
      setInvite(CODE.test(saved) ? saved : "");
    } catch {
      setInvite("");
    }
  }, []);

  async function createCode() {
    setBusy(true);
    setCodeError(false);
    try {
      await call({ action: "referral-code", account });
      await load();
    } catch {
      setCodeError(true);
    } finally {
      setBusy(false);
    }
  }

  // Every state renders the same tree shape: the header, your lifetime points, then the weekly seasons as their own
  // labelled section (review-2 mn9). The heading band and the lifetime card are the same nodes from loading to loaded
  // (no remount, no change of width: review-2 n2), and the card needs no server data, so it shows while loading, on an
  // error and when the weekly program is closed (review m6).
  const shell = (
    weekly: ReactNode,
    opts: { pills?: ReactNode; after?: ReactNode } = {},
  ) => (
    <div className={styles.page}>
      <PageHeader
        title={t("points.nav")}
        lede={t("points.lifetime.lede")}
        meta={<span className="visual-eyebrow">{t("points.eyebrow")}</span>}
      />
      <div className={styles.stack}>
        <LifetimePoints account={account} sample={sample} />
        {archive && (
          <section
            className={styles.weekly}
            aria-labelledby="points-weekly-title"
            data-testid="points-weekly"
          >
            <div className={styles.weeklyHead}>
              <h2 id="points-weekly-title">{t("points.weekly.title")}</h2>
              <p className="muted" data-testid="points-weekly-archived">
                {t("points.weekly.archived")}
              </p>
              <p className="muted">{t("points.weekly.body")}</p>
              {opts.pills}
            </div>
            {weekly}
          </section>
        )}
      </div>
      {archive && opts.after}
    </div>
  );
  // The public page: your own points only.
  if (!archive) return shell(null);
  if (error && !overview)
    return shell(
      <section className="card">
        <EmptyState
          icon="alert"
          title={t("points.error")}
          actions={
            <button className="secondary" onClick={() => void load()}>
              <Icon name="refresh" size={16} />
              {t("points.retry")}
            </button>
          }
        />
      </section>,
    );
  if (!overview)
    return shell(
      <section
        className="card"
        aria-busy="true"
        aria-label={t("points.loading")}
      >
        <Skeleton lines={4} />
      </section>,
    );
  if (overview.program.status === "CLOSED")
    return shell(
      <section className="card">
        <EmptyState icon="lock" title={t("points.closed.title")}>
          <p>{t("points.closed.body")}</p>
        </EmptyState>
      </section>,
      { after: <Rules /> },
    );

  const current = overview.current;
  const referral = overview.account?.referral;
  const inviteLink = referral?.code
    ? `${window.location.origin}/points?ref=${referral.code}`
    : "";
  const awaiting = overview.awaitingResults ?? [];

  return shell(
    <>
      {/* A reload that failed is said, never shown as stale results (review-2 mn6). */}
      {error && (
        <p className="notice" role="status">
          <Icon name="alert" size={16} />
          {t("points.error")}
          <button className="secondary small" onClick={() => void load()}>
            <Icon name="refresh" size={16} />
            {t("points.retry")}
          </button>
        </p>
      )}
      <div className={styles.layout}>
        <div className={styles.primary}>
          <section
            className={`card ${styles.live}`}
            aria-labelledby="points-live"
          >
            <h2 id="points-live" className="sr-only">
              {current
                ? t("points.countdown.closesIn", { season: current.season })
                : t("points.countdown.startsIn")}
            </h2>
            {current ? (
              <Countdown
                key={current.endsAt}
                target={current.endsAt}
                skew={skew}
                label={t("points.countdown.closesIn", {
                  season: current.season,
                })}
                onDone={() => void load()}
              />
            ) : overview.upcoming ? (
              <Countdown
                key={overview.upcoming.startsAt}
                target={overview.upcoming.startsAt}
                skew={skew}
                label={t("points.countdown.startsIn")}
                onDone={() => void load()}
              />
            ) : null}
            <p className={styles.when}>
              <Icon name="clock" size={14} />
              {current
                ? t("points.countdown.closesAt", { date: date(current.endsAt) })
                : overview.upcoming
                  ? t("points.countdown.startsAt", {
                      date: date(overview.upcoming.startsAt),
                    })
                  : ""}
              <span className={styles.zone}>{t("points.timeZone")}</span>
            </p>
            <div className={styles.hidden}>
              <Icon name="eye" size={18} />
              <div>
                <h3>{t("points.hidden.title")}</h3>
                <p>{t("points.weekly.hiddenBody")}</p>
              </div>
            </div>
          </section>

          <section className="card" aria-labelledby="points-board">
            <div className="card-top">
              <h2 id="points-board">
                {published
                  ? t("points.board.title", { season: published.season })
                  : t("points.weekly.results")}
              </h2>
              {(overview.archive?.length ?? 0) > 1 && (
                <label className={styles.archive}>
                  <span className="sr-only">{t("points.board.archive")}</span>
                  <select
                    value={season ?? ""}
                    onChange={(e) => setSelected(Number(e.target.value))}
                  >
                    {[...(overview.archive ?? [])].reverse().map((s) => (
                      <option key={s.season} value={s.season}>
                        {t("points.board.season", { season: s.season })}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            {awaiting.length > 0 && (
              <p className="notice">
                <Icon name="info" size={16} />
                {t("points.board.awaiting", { season: awaiting.at(-1)! })}
              </p>
            )}
            {!published ? (
              <EmptyState icon="layers" title={t("points.board.empty")}>
                <p>{t("points.board.firstWeek")}</p>
              </EmptyState>
            ) : (
              <>
                <dl className={styles.facts}>
                  <div>
                    <dt>{t("points.board.published")}</dt>
                    <dd>{date(published.publishedAt, false)}</dd>
                  </div>
                </dl>
                {own && own.correctionUnits !== "0" && (
                  <p className="notice">
                    <Icon name="info" size={16} />
                    {t("points.board.amended")}
                  </p>
                )}
                {ownLoaded && (
                  <p className={styles.yourPosition}>
                    <Icon name="wallet" size={16} />
                    {own
                      ? `${t("points.weekly.yourResult")}: ${points(own.netUnits)}`
                      : t("points.board.notRanked")}
                  </p>
                )}
              </>
            )}
          </section>

          <section className="card" aria-labelledby="points-tasks">
            <h2 id="points-tasks">{t("points.tasks.title")}</h2>
            {tasks.length === 0 ? (
              <p className="muted">{t("points.tasks.empty")}</p>
            ) : (
              <ul className={styles.tasks}>
                {tasks.map((task) => {
                  const done =
                    task.completions?.filter(
                      (c) => c.status !== "VOIDED" && c.status !== "REJECTED",
                    ) ?? [];
                  const last = task.completions?.at(-1);
                  return (
                    <li key={task.id} className={styles.task}>
                      <div className={styles.taskTop}>
                        <h3>{task.title}</h3>
                        <Pill
                          tone={
                            task.state === "ACTIVE"
                              ? "ok"
                              : task.state === "CANCELLED"
                                ? "danger"
                                : "neutral"
                          }
                        >
                          {t(`points.tasks.state.${task.state}` as MessageKey)}
                        </Pill>
                      </div>
                      {task.description && <p>{task.description}</p>}
                      <ul className={styles.criteria}>
                        <li>
                          {t("points.tasks.requirement", {
                            category: task.criteria.category
                              ? t(
                                  `points.category.${task.criteria.category}` as MessageKey,
                                )
                              : t("points.tasks.anyCategory"),
                            count: task.criteria.minCount,
                          })}
                        </li>
                        {task.criteria.minEventVolumeUsdMicros && (
                          <li>
                            {t("points.tasks.minVolume", {
                              amount: new Intl.NumberFormat(lang, {
                                style: "currency",
                                currency: "USD",
                                maximumFractionDigits: 0,
                              }).format(
                                Number(
                                  BigInt(
                                    task.criteria.minEventVolumeUsdMicros,
                                  ) / 1_000_000n,
                                ),
                              ),
                            })}
                          </li>
                        )}
                        {task.criteria.chainIds && (
                          <li>
                            {t("points.tasks.networks", {
                              list: task.criteria.chainIds.join(", "),
                            })}
                          </li>
                        )}
                        <li>
                          {t("points.tasks.limit", {
                            count: task.perUserLimit,
                          })}
                        </li>
                        {task.requiresReview && (
                          <li>{t("points.tasks.review")}</li>
                        )}
                        <li>
                          {t("points.tasks.window", {
                            start: date(task.startsAt),
                            end: date(task.endsAt),
                          })}
                        </li>
                      </ul>
                      {account && (
                        <p className={styles.taskStatus}>
                          <Icon
                            name={done.length ? "check" : "dot"}
                            size={14}
                          />
                          {last
                            ? t(
                                `points.tasks.status.${last.status}` as MessageKey,
                              )
                            : t("points.tasks.notCompleted")}
                          {done.length > 0 &&
                            ` · ${done.length}/${task.perUserLimit}`}
                        </p>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </section>
        </div>

        <aside className={styles.side}>
          <section className="card" aria-labelledby="points-you">
            <h2 id="points-you">{t("points.you.title")}</h2>
            {!account ? (
              <>
                <p className="muted">{t("points.you.connect")}</p>
                <button className="primary" onClick={onConnect}>
                  <Icon name="wallet" size={16} />
                  {t("points.you.connectButton")}
                </button>
              </>
            ) : (
              <ul className={styles.history}>
                {current && (
                  <li className={styles.liveRow}>
                    <Icon name="lock" size={14} />
                    {t("points.you.liveRow", { season: current.season })}
                  </li>
                )}
                {!ownLoaded && !error && (
                  <li className="muted" aria-busy="true">
                    {t("points.loading")}
                  </li>
                )}
                {ownLoaded && history.length === 0 && (
                  <li className="muted">{t("points.you.empty")}</li>
                )}
                {(ownLoaded ? [...history] : []).reverse().map((row) => (
                  <li key={row.season}>
                    <div className={styles.historyTop}>
                      <strong>
                        {t("points.board.season", { season: row.season })}
                      </strong>
                      <span title={exactPoints(row.netUnits)}>
                        {points(row.netUnits)}
                      </span>
                    </div>
                    <dl className={styles.split}>
                      <div>
                        <dt>{t("points.you.activity")}</dt>
                        <dd>{points(row.activityUnits)}</dd>
                      </div>
                      <div>
                        <dt>{t("points.you.tasks")}</dt>
                        <dd>{points(row.taskUnits)}</dd>
                      </div>
                      <div>
                        <dt>{t("points.you.referral")}</dt>
                        <dd>{points(row.referralUnits)}</dd>
                      </div>
                      {row.correctionUnits !== "0" && (
                        <div>
                          <dt>{t("points.you.corrections")}</dt>
                          <dd>{points(row.correctionUnits)}</dd>
                        </div>
                      )}
                    </dl>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="points-referral">
            <h2 id="points-referral">{t("points.referral.title")}</h2>
            <p className="muted">{t("points.referral.body")}</p>
            {account && referral?.code && (
              <div className={styles.code}>
                <span className="micro">{t("points.referral.code")}</span>
                <strong dir="ltr">{referral.code}</strong>
                <span className="micro">{t("points.referral.link")}</span>
                <div className={styles.linkRow}>
                  <bdi dir="ltr" className={styles.link}>
                    {inviteLink}
                  </bdi>
                  <button
                    className="small copy-button"
                    onClick={() => void copy(inviteLink)}
                  >
                    <Icon
                      name={copied === inviteLink ? "check" : "copy"}
                      size={14}
                    />
                    {copied === inviteLink
                      ? t("points.referral.copied")
                      : t("points.referral.copy")}
                  </button>
                </div>
              </div>
            )}
            {account && !referral?.code && referral?.codeAvailable && (
              <button
                className="secondary"
                disabled={busy}
                onClick={() => void createCode()}
              >
                <Icon name="plus" size={16} />
                {t("points.referral.generate")}
              </button>
            )}
            {account && !referral?.code && !referral?.codeAvailable && (
              <p className="input-hint">{t("points.referral.notEligible")}</p>
            )}
            {codeError && <p className="field-error">{t("points.error")}</p>}
            {referral?.invitedBy ? (
              <p className={styles.invited}>
                <Icon name="check" size={14} />
                {t("points.referral.invitedBy", {
                  account: referral.invitedBy,
                })}
              </p>
            ) : (
              invite &&
              invite !== referral?.code && (
                <p className={styles.invited}>
                  <Icon name="info" size={14} />
                  {t("points.referral.pending", { code: invite })}
                </p>
              )
            )}
            {account && (
              <>
                <h3 className={styles.subhead}>{t("points.referral.list")}</h3>
                {referral?.referrals.length ? (
                  <ul className={styles.referrals}>
                    {referral.referrals.map((r) => (
                      <li key={`${r.account}-${r.boundAt}`}>
                        <bdi dir="ltr">{r.account}</bdi>
                        <span className="micro">
                          {t("points.referral.since", {
                            date: date(r.boundAt, false),
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">{t("points.referral.none")}</p>
                )}
              </>
            )}
            <p className="input-hint">{t("points.referral.rules")}</p>
          </section>
        </aside>
      </div>
    </>,
    {
      pills: (
        <div className={styles.weeklyPills}>
          {current && (
            <Pill tone="accent" dot>
              {t("points.livePill", { season: current.season })}
            </Pill>
          )}
          <Pill tone="neutral" icon="lock">
            {t("points.hiddenPill")}
          </Pill>
        </div>
      ),
      after: <Rules />,
    },
  );
}

function Rules() {
  const { t } = useI18n();
  return (
    <section className={`card ${styles.rules}`} aria-labelledby="points-how">
      <h2 id="points-how">{t("points.how.title")}</h2>
      <ul>
        {(
          [
            ["check", "points.how.counted"],
            ["close", "points.how.notCounted"],
            ["shield", "points.how.finality"],
            ["info", "points.how.value"],
          ] as const
        ).map(([icon, key]) => (
          <li key={key}>
            <Icon name={icon} size={16} />
            <span>{t(key)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
