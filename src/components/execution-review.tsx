"use client";
// G13: the owner-signed execution check inside the Bridge review dialog. Read-only: on first open it asks the server
// (/api/execution "review") to re-read this route and check everything a signature would commit to, then shows that
// review in plain words. G14 closure: below it, the owner canary panel (CanaryPanel) — in this build it shows the
// canary's real state (implementation present, activation disabled, no owner record) and renders no step control,
// because the server reports the canary CLOSED; a step control exists only while the server reports it armed.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { walletStore, EMPTY_SESSION } from "../features/wallet/store";
import { useI18n } from "../i18n/provider";
import { formatTokenAmount } from "../i18n/amounts";
import { Icon } from "./icons";
// Non-core icons (check / close / info / lock) are registered with this code-split view (V1.10 icon hygiene).
import "./icons-extra";
import type { QuoteInput } from "../routing/model";
import type { MessageKey } from "../i18n/messages";
import { canaryReadiness } from "../execution/canary/readiness";

// G14: the canary release matrix is static (no request): what is implemented, and what the live canary still needs.
const CANARY = canaryReadiness();

interface ReviewWire {
  plan: {
    pay: { symbol: string; decimals: number; address: string };
    receive: { symbol: string; decimals: number; address: string };
    amountIn: string;
    minimumOut: string;
    recipient: string;
    account: string;
    approval: { token: string; spender: string; amount: string } | null;
    platformFeeBps: number;
    fees: {
      name: string;
      amount: string;
      asset: { symbol: string; decimals: number };
    }[];
  };
  preflight: {
    checks: { id: string; status: "PASS" | "FAIL" | "UNKNOWN"; code: string }[];
    ready: boolean;
  };
  gate: { state: string; reasons: string[] };
  review: string;
}
const short = (a: string) =>
  /^0x[0-9a-fA-F]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

export function ExecutionReview({
  input,
  account,
  walletChain,
}: {
  input: QuoteInput;
  account: string;
  walletChain?: number;
}) {
  const { t, lang } = useI18n();
  const [state, setState] = useState<"idle" | "loading" | "done" | "failed">(
    "idle",
  );
  const [data, setData] = useState<ReviewWire | null>(null);
  const amount = (v: string, d: number) =>
    /^\d{1,78}$/.test(v) ? formatTokenAmount(BigInt(v), d, lang, 6) : "—";
  async function load() {
    setState("loading");
    try {
      const wallet = /^0x[0-9a-fA-F]{40}$/.test(account)
        ? {
            wallet: {
              account,
              ...(walletChain ? { chainId: String(walletChain) } : {}),
            },
          }
        : {};
      const r = await fetch("/api/execution", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "review", input, ...wallet }),
        signal: AbortSignal.timeout(30000),
      });
      const json = (await r.json()) as ReviewWire;
      if (!r.ok || !json?.preflight?.checks || !json.plan)
        throw Error("FAILED");
      setData(json);
      setState("done");
    } catch {
      setState("failed");
    }
  }
  const approvalCheck = data?.preflight.checks.find((c) => c.id === "APPROVAL");
  return (
    <details
      className="disclosure execution-review"
      data-testid="execution-review"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open && state === "idle")
          void load();
      }}
    >
      <summary>
        <Icon name="lock" size={14} /> {t("g13.x.title")}{" "}
        <span className="pill tone-warn">{t("g13.x.closed")}</span>
      </summary>
      <p className="input-hint">{t("g13.x.intro")}</p>
      {state === "loading" && <p role="status">{t("g13.x.loading")}</p>}
      {state === "failed" && (
        <p role="alert" className="notice tone-warn">
          {t("g13.x.failed")}
        </p>
      )}
      {state === "done" && data && (
        <>
          <dl className="execution-lines">
            <div>
              <dt>{t("g13.x.send")}</dt>
              <dd>
                <bdi dir="ltr">
                  {amount(data.plan.amountIn, data.plan.pay.decimals)}{" "}
                  {data.plan.pay.symbol}
                </bdi>{" "}
                <code>{short(data.plan.pay.address)}</code>
              </dd>
            </div>
            <div>
              <dt>{t("g13.x.receive")}</dt>
              <dd>
                <bdi dir="ltr">
                  {amount(data.plan.minimumOut, data.plan.receive.decimals)}{" "}
                  {data.plan.receive.symbol}
                </bdi>{" "}
                <code>{short(data.plan.receive.address)}</code>
              </dd>
            </div>
            <div>
              <dt>{t("g13.x.recipient")}</dt>
              <dd data-testid="execution-recipient">
                <code>{short(data.plan.recipient)}</code>
                {same(data.plan.recipient, data.plan.account) && (
                  <> · {t("g13.x.self")}</>
                )}
              </dd>
            </div>
            <div>
              <dt>{t("g13.x.approval")}</dt>
              <dd data-testid="execution-approval">
                {data.plan.approval ? (
                  t("g13.x.approvalExact", {
                    amount: amount(
                      data.plan.approval.amount,
                      data.plan.pay.decimals,
                    ),
                    symbol: data.plan.pay.symbol,
                    spender: short(data.plan.approval.spender),
                  })
                ) : approvalCheck && approvalCheck.status !== "PASS" ? (
                  // Round 4 (S3): e.g. ALLOWANCE_ABOVE_AMOUNT — an existing allowance must be revoked first.
                  <code>{approvalCheck.code}</code>
                ) : (
                  t("g13.x.noApproval")
                )}
              </dd>
            </div>
            <div>
              <dt>{t("g13.x.fees")}</dt>
              <dd>
                <bdi dir="ltr">
                  {data.plan.fees
                    .map(
                      (f) =>
                        `${f.name}: ${amount(f.amount, f.asset.decimals)} ${f.asset.symbol}`,
                    )
                    .join(" · ") || "—"}
                </bdi>
              </dd>
            </div>
            <div>
              <dt>VEINED</dt>
              {/* From the server's plan (review F23), not a static claim. */}
              <dd data-testid="execution-veined-fee">
                {data.plan.platformFeeBps === 0
                  ? t("g13.x.veinedFee")
                  : `${data.plan.platformFeeBps} bps`}
              </dd>
            </div>
          </dl>
          <p>
            <strong>{t("g13.x.checks")}</strong>
          </p>
          <ol className="execution-checks" data-testid="execution-checks">
            {data.preflight.checks.map((c) => (
              <li key={c.id} data-check={c.id} data-status={c.status}>
                <Icon
                  name={
                    c.status === "PASS"
                      ? "check"
                      : c.status === "FAIL"
                        ? "close"
                        : "info"
                  }
                  size={14}
                />{" "}
                <span>{t(`g13.x.check.${c.id}` as never)}</span>
                {" · "}
                <small>{t(`g13.x.status.${c.status}` as never)}</small>{" "}
                <code>{c.code}</code>
              </li>
            ))}
          </ol>
          <p className="input-hint">{t("g13.x.notProvenNote")}</p>
          <p className="notice tone-warn" data-testid="execution-gate">
            {t("g13.x.gateClosed")} <code>{data.gate.reasons.join(" · ")}</code>
          </p>
          <p className="input-hint">
            {t("g13.x.fingerprint")}: <code>{data.review.slice(0, 16)}</code>
          </p>
        </>
      )}
      <CanaryPanel />
    </details>
  );
}

// ------------------------------------------------------------------------------------------------------------------
// G14 closure: the owner's canary panel. It shows what the server says the canary is (implementation present,
// activation disabled, owner record absent — in this build) and, ONLY when the server reports the canary armed, the
// server's review and one step button at a time. In this build there is no button: nothing here can reach a wallet.
// When armed: every step needs the owner's own trusted click; an account, network or session change clears the
// review at once (and vetoes a step in flight); one click = one step (the button is disabled while it runs); the
// outcome is shown as the server tracks it, and only RECONCILED reads completed.
interface CanaryStatusWire {
  amount: string | null;
  implementation: string;
  activation: string;
  ownerRecord: string;
  gate: { state: string; reasons: string[] };
}
interface CanaryReviewWire {
  record: string;
  session: string;
  ready: boolean;
  state: string;
  needsApproval: boolean;
  planDigest: string | null;
  plan: {
    account: string;
    sourceChainId: string;
    destinationChainId: string;
    amountIn: string;
    expectedOut: string;
    minimumOut: string;
    ownerMinimumOut: string;
    target: string;
    spender: string;
    fees: { name: string; amount: string }[];
  } | null;
  gas: {
    budgetWei: string;
    spentWei: string | null;
    remainingStepsWei: string | null;
    l1FeeWei: string | null;
  };
  checks: { id: string; status: string; code: string }[];
  gate: { state: string; reasons: string[] };
  /** Handed out once, by the review that started the record (review 2 N2). */
  resumeKey?: string | null;
}
export interface CanaryViewWire {
  state: string;
  label: string;
  completed: boolean;
  needsAttention: boolean;
  notDurable?: boolean;
  hashes: { approval: string | null; main: string | null };
  attempts?: {
    action: string;
    recovery: string;
    hash: string | null;
    nonceConsumed?: boolean;
    search?: {
      cursor: string | null;
      undecidedSince: number | null;
      reason: string | null;
      checkedCandidates: number;
    } | null;
  }[];
  notes?: string[];
  store?: { status: string; writable: boolean };
  terminal?: boolean;
  /** G14 follow-up F3: known zero / known non-zero / unknown (never assumed zero), from the server's own read. */
  allowance?: {
    status: string;
    value: string | null;
    block: string | null;
  };
}
async function canaryPost<T>(body: unknown): Promise<T> {
  const r = await fetch("/api/execution", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const json = (await r.json()) as T & { error?: string };
  if (!r.ok)
    throw Object.assign(new Error("CANARY"), {
      code: json?.error ?? "FAILED",
      body: json,
    });
  return json;
}
const codeOf = (e: unknown) =>
  (e as { reason?: string; code?: string })?.reason ??
  (e as { code?: string })?.code ??
  "FAILED";
/** The resume key of the record this browser started (review 2 N2): per origin, never sent anywhere else. */
const RESUME_SLOT = "veined.canary.resume.v1";
function savedResume(): { record: string; key: string } | null {
  try {
    const v = JSON.parse(localStorage.getItem(RESUME_SLOT) ?? "null") as {
      record?: unknown;
      key?: unknown;
    } | null;
    return v &&
      typeof v.record === "string" &&
      /^[A-Za-z0-9_-]{8,80}$/.test(v.record) &&
      typeof v.key === "string" &&
      /^[0-9a-f]{64}$/.test(v.key)
      ? { record: v.record, key: v.key }
      : null;
  } catch {
    return null;
  }
}
function saveResume(record: string, key: string) {
  try {
    localStorage.setItem(RESUME_SLOT, JSON.stringify({ record, key }));
  } catch {
    // Without storage a later resume can only observe; nothing else changes.
  }
}
function clearResume() {
  try {
    localStorage.removeItem(RESUME_SLOT);
  } catch {
    // Nothing to clear.
  }
}
/** Everything about a record the owner must look at (review 2 N1): never folded into a quiet "pending". */
export function canaryAttentionCodes(view: CanaryViewWire): string[] {
  const codes = [
    ...(view.notDurable ? ["NOT_DURABLE"] : []),
    ...(view.store && !view.store.writable
      ? [`STORE_${view.store.status}`]
      : []),
    ...(view.attempts ?? [])
      .filter((a) =>
        [
          "UNCERTAIN",
          "HASH_REJECTED",
          "HASH_AFTER_END",
          "PREPARED_BEFORE_RESTART",
          "REPLACED",
          "NONCE_CONSUMED_UNIDENTIFIED",
        ].includes(a.recovery),
      )
      .map((a) => `${a.action}:${a.recovery}`),
    ...(view.attempts ?? [])
      .filter((a) => a.nonceConsumed)
      .map(
        (a) =>
          `${a.action}:NONCE_CONSUMED${a.search?.reason ? ":" + a.search.reason : ""}`,
      ),
    ...(view.allowance &&
    ["NONZERO", "UNKNOWN", "MAY_STAND_UNREAD"].includes(view.allowance.status)
      ? [`ALLOWANCE:${view.allowance.status}`]
      : []),
    ...(view.notes ?? []),
  ];
  return [...new Set(codes)];
}
/**
 * G14 follow-up F4 (i18n / success label): the ONE place the panel decides that a record reads "completed": the
 * server says completed, nothing needs attention and the store is durable. Every other state — pending, unknown,
 * needs attention, not durable — shows the state line, never the completed text.
 */
/** Review 7 R7-4: the allowance line's text; only a read (ZERO / NONZERO), UNKNOWN or MAY_STAND_UNREAD has one. */
export function allowanceText(
  a: CanaryViewWire["allowance"],
  t: (key: MessageKey, values?: Record<string, string | number>) => string,
  ended = true,
): string | null {
  if (!a) return null;
  if ((a.status === "ZERO" || a.status === "NONZERO") && a.value && a.block)
    return t("g14.c.allowance", { value: a.value, block: a.block });
  if (a.status === "UNKNOWN") return t("g14.c.allowanceUnknown");
  // Review 11 R11-5: "not read yet after the end" is said only of a record that has ended.
  if (a.status === "MAY_STAND_UNREAD" && ended)
    return t("g14.c.allowanceMayStand");
  return null;
}
export function canaryShowsCompleted(view: CanaryViewWire): boolean {
  return (
    view.completed === true &&
    view.state === "RECONCILED" &&
    view.needsAttention !== true &&
    !view.notDurable
  );
}
/** The record's state line plus, whenever the server says so, an explicit attention message with its reasons. */
export function CanaryViewNotice({
  view,
  t,
}: {
  view: CanaryViewWire;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
}) {
  const attention = view.needsAttention || !!view.notDurable;
  const done = canaryShowsCompleted(view);
  return (
    <>
      <p
        className={`notice ${done ? "tone-ok" : "tone-warn"}`}
        data-testid="canary-state"
        data-state={view.state}
        data-completed={String(done)}
      >
        {done
          ? t("g14.c.completed")
          : t("g14.c.state", {
              state: view.notDurable
                ? `NOT_DURABLE · ${view.state}`
                : `${view.label} · ${view.state}`,
            })}
      </p>
      {attention && (
        <p
          role="alert"
          className="notice tone-warn"
          data-testid="canary-attention"
          data-codes={canaryAttentionCodes(view).join(" ")}
        >
          {t("g14.c.attention", {
            codes: canaryAttentionCodes(view).join(" · ") || view.label,
          })}
          {(view.hashes.approval || view.hashes.main) && (
            <>
              {" "}
              <code>
                {[view.hashes.approval, view.hashes.main]
                  .filter(Boolean)
                  .map((h) => short(h!))
                  .join(" / ")}
              </code>
            </>
          )}
        </p>
      )}
      {/* Review 7 R7-4: an ended record's allowance as the server READ it (two operators, one block), or that it is
          unknown, or that it may stand while unread; nothing for an active record or a state no read stands behind.
          Review 10 R10-1: an UNCERTAIN record shows it too (read once its account nonce moved). */}
      {(view.terminal === true || view.state === "UNCERTAIN") &&
        allowanceText(view.allowance, t, view.terminal === true) && (
          <p
            className="input-hint"
            data-testid="canary-allowance"
            data-status={view.allowance!.status}
          >
            {allowanceText(view.allowance, t, view.terminal === true)}
          </p>
        )}
    </>
  );
}

function CanaryPanel() {
  const { t, lang } = useI18n();
  const session = useSyncExternalStore(
    walletStore.subscribe,
    walletStore.get,
    () => EMPTY_SESSION,
  );
  // Without an owner record in the bundle (this build) the panel's state is static and the server is not asked at
  // all: implementation present, activation disabled, no owner record — and no step control.
  const [status, setStatus] = useState<CanaryStatusWire | null>(
    CANARY.ownerRecord === "ABSENT"
      ? {
          amount: null,
          implementation: CANARY.implementation,
          activation: CANARY.activation,
          ownerRecord: CANARY.ownerRecord,
          gate: { state: "CLOSED", reasons: ["NO_OWNER_APPROVED_CANARY"] },
        }
      : null,
  );
  const [review, setReview] = useState<CanaryReviewWire | null>(null);
  const [view, setView] = useState<CanaryViewWire | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const bound = useRef<{
    epoch: number;
    address: string;
    chain: number | undefined;
  } | null>(null);
  const abort = useRef<AbortController | null>(null);
  const resumed = useRef<{
    record: string;
    session: string;
    mode: "STEP" | "OBSERVE";
  } | null>(null);
  const [observeOnly, setObserveOnly] = useState(false);
  /** The owner's own canary key (review 3 N12): typed by the owner, sent only with a review, never stored. */
  const [ownerKey, setOwnerKey] = useState("");
  /** The resumed binding, as render state (the ref above serves the event handlers). */
  const [resumedStep, setResumedStep] = useState<{
    record: string;
    session: string;
  } | null>(null);
  const [storeNote, setStoreNote] = useState<string | null>(null);
  /** A newer record of the same account than the one bound (review 3 N16): named, observable with one click. */
  const [newer, setNewer] = useState<string | null>(null);
  const usdc = (v: string) =>
    /^\d{1,78}$/.test(v)
      ? `${formatTokenAmount(BigInt(v), 6, lang, 6)} USDC`
      : "—";
  useEffect(() => {
    if (CANARY.ownerRecord === "ABSENT") return;
    let live = true;
    canaryPost<CanaryStatusWire>({ action: "canary-status" })
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, []);
  // Any identity change (account, network, disconnect, another wallet) invalidates the review and vetoes a step.
  useEffect(() => {
    const b = bound.current;
    if (
      b &&
      (b.epoch !== session.epoch ||
        b.address.toLowerCase() !== session.address.toLowerCase() ||
        b.chain !== session.chainId)
    ) {
      abort.current?.abort();
      bound.current = null;
      setReview(null);
      // Review 2 N8: a resumed binding and its view belong to the identity that resumed them.
      resumed.current = null;
      setResumedStep(null);
      setView(null);
      setObserveOnly(false);
      setStoreNote(null);
      setOwnerKey("");
      setOutcome("INVALIDATED");
    }
  }, [session.epoch, session.address, session.chainId]);
  const armed = status?.activation === "ENABLED";
  const current = () => {
    const b = bound.current,
      s = walletStore.get();
    return (
      !!b &&
      b.epoch === s.epoch &&
      b.address.toLowerCase() === s.address.toLowerCase() &&
      b.chain === s.chainId
    );
  };
  async function doReview(record?: string, token?: string) {
    if (!armed || session.status !== "connected") return;
    setBusy(true);
    setOutcome(null);
    try {
      const r = await canaryPost<CanaryReviewWire>({
        action: "canary-review",
        account: session.address,
        chainId: String(session.chainId ?? 0),
        // The exact amount of the owner record, as the server states it (never chosen here).
        amount: status?.amount ?? "",
        ...(record ? { record } : {}),
        ...(token ? { session: token } : {}),
        // Only a review that starts (or takes up) a record carries the owner's key.
        ...(!record && ownerKey ? { ownerKey } : {}),
      });
      setOwnerKey("");
      bound.current = {
        epoch: session.epoch,
        address: session.address,
        chain: session.chainId,
      };
      // The record's resume key exists once, in this answer: kept by this browser only (review 2 N2).
      if (r.resumeKey) saveResume(r.record, r.resumeKey);
      setReview(r);
    } catch (e) {
      setOutcome(codeOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function step(e: { isTrusted: boolean; timeStamp: number }) {
    const r = review,
      provider = walletStore.get().provider;
    if (!r?.ready || !r.plan || busy || !provider || !current()) return;
    // The owner's own click for THIS step. Its time is the event's own time stamp (not when this code runs), never
    // later than now (review 1 F10).
    const clicked = Math.round(performance.timeOrigin + e.timeStamp);
    const gesture = {
      trusted: e.isTrusted === true,
      at: Number.isFinite(clicked) ? Math.min(clicked, Date.now()) : Date.now(),
    };
    const trusted = gesture.trusted;
    setBusy(true);
    setOutcome(null);
    const controller = new AbortController();
    abort.current = controller;
    try {
      const { token } = await canaryPost<{ token: unknown }>({
        action: "canary-authorize",
        session: r.session,
        record: r.record,
        trustedGesture: trusted,
      });
      const { preparation } = await canaryPost<{ preparation: never }>({
        action: "canary-prepare",
        session: r.session,
        record: r.record,
        token,
      });
      const { submitCanary } = await import("../features/bridge/submission");
      const write = (kind: string, ref: unknown, hash?: string) =>
        canaryPost<{ ok: boolean }>({
          action: "canary-record",
          session: r.session,
          kind,
          ref,
          ...(hash ? { hash } : {}),
        }).then((x) => x.ok === true);
      const result = await submitCanary(provider, preparation, {
        session: r.session,
        gesture,
        persistNotRequested: (ref) => write("not-requested", ref),
        persistHash: (hash, _a, ref) => write("hash", ref, hash),
        persistLateHash: async (hash, _a, ref) => {
          await write("late-hash", ref, hash);
        },
        persistRejected: async (ref) => {
          await write("rejected", ref);
        },
        current,
        signal: controller.signal,
      });
      setOutcome(result.recorded ? "SUBMITTED" : "SUBMITTED_NOT_RECORDED");
    } catch (e) {
      const code = codeOf(e);
      setOutcome(code);
      // Review 3 N11: a review that ran out before the step is over; the owner reviews again (the server ends the
      // stale record EXPIRED, or takes up the record whose approval is confirmed).
      if (
        [
          "AUTHORIZATION_EXPIRED",
          "QUOTE_EXPIRED",
          "QUOTE_TOO_CLOSE_TO_EXPIRY",
          "NOT_REVIEWED",
          "REVIEW_NOT_READY",
        ].includes(code)
      )
        setReview(null);
    } finally {
      setBusy(false);
      abort.current = null;
      if (review) void refresh();
    }
  }
  /** What the server says about a store it cannot write or open (shown, never hidden: review 2 N1 / R2). */
  function noteStore(x: {
    store?: { status?: string; writable?: boolean } | null;
    restoreProblem?: string | null;
    inspection?: {
      store?: { status?: string };
      records?: {
        record: string;
        lastEvent: string;
        lastEventAgeMs?: number | null;
        allowance?: { status?: string } | null;
      }[];
      attempts?: {
        state: string;
        hash: string | null;
        nonceConsumed?: boolean;
        search?: { reason?: string | null } | null;
      }[];
    } | null;
    code?: string;
  }) {
    const s =
      x.inspection?.store?.status ??
      (x.store && x.store.writable === false ? x.store.status : null) ??
      x.restoreProblem ??
      null;
    // Review 3 N15: what the journal holds is shown too — each record's last event, each attempt's state and hash.
    const held = x.inspection
      ? [
          ...(x.inspection.records ?? []).map(
            (r) =>
              `${r.record}:${r.lastEvent}${typeof r.lastEventAgeMs === "number" && r.lastEventAgeMs >= 30 * 60_000 ? ":NO_NEW_EVENT_FOR_" + Math.floor(r.lastEventAgeMs / 60_000) + "_MIN" : ""}${r.allowance?.status ? ":ALLOWANCE_" + r.allowance.status : ""}`,
          ),
          // Review 7 R7-9: why a search is undecided is part of what the journal holds.
          ...(x.inspection.attempts ?? []).map(
            (a) =>
              `${a.state}${a.nonceConsumed ? "+NONCE_CONSUMED" : ""}${a.search?.reason ? ":SEARCH_UNDECIDED_" + a.search.reason : ""}${a.hash ? ":" + short(a.hash) : ""}`,
          ),
        ].join(" · ")
      : "";
    setStoreNote(
      s ? `${x.code ? x.code + ":" : ""}${s}${held ? " — " + held : ""}` : null,
    );
  }
  /**
   * Review 1 F1 / review 2 N2: re-binding to the approved account's record (after a reload or a restart). With the
   * record's resume key this browser kept, the page may continue the canary (the main step's fresh review); without
   * it the binding only observes.
   */
  async function resume(opts: { newest?: boolean } = {}) {
    if (!armed || session.status !== "connected") return;
    setBusy(true);
    setOutcome(null);
    // Review 7 R7-8: "observe the newer record" asks without the slot's key and leaves the slot untouched (its record
    // may still be active; the resume button binds it again). Only an ENDED slot record is cleared (below).
    const saved = opts.newest === true ? null : savedResume();
    type Resumed = {
      session: string | null;
      record: string | null;
      mode: "STEP" | "OBSERVE" | null;
      newer?: string | null;
      view?: CanaryViewWire & { terminal?: boolean };
      store?: { status: string; writable: boolean };
      restoreProblem?: string | null;
    };
    const ask = (keyed: boolean) =>
      canaryPost<Resumed>({
        action: "canary-resume",
        account: session.address,
        amount: status?.amount ?? "",
        ...(keyed && saved
          ? { record: saved.record, resumeKey: saved.key }
          : {}),
      });
    try {
      let r: Resumed;
      try {
        r = await ask(true);
      } catch (e) {
        // Review 3 N16: a slot the server no longer knows (another store, an invalid key) is dropped and the latest
        // record is observed instead.
        if (
          !saved ||
          !["UNKNOWN_RECORD", "RESUME_KEY_INVALID"].includes(codeOf(e))
        )
          throw e;
        clearResume();
        r = await ask(false);
      }
      if (saved && r.record === saved.record && r.view?.terminal) {
        // G14 follow-up F4 (review 3 N16): the slot's record has ended; the newest record is observed instead.
        clearResume();
        if (r.newer) r = await ask(false);
      }
      setNewer(r.newer ?? null);
      noteStore(r);
      if (r.session && r.record) {
        resumed.current = {
          record: r.record,
          session: r.session,
          mode: r.mode === "STEP" ? "STEP" : "OBSERVE",
        };
        bound.current = {
          epoch: session.epoch,
          address: session.address,
          chain: session.chainId,
        };
        setObserveOnly(r.mode !== "STEP");
        setResumedStep(
          r.mode === "STEP" ? { record: r.record, session: r.session } : null,
        );
        if (r.view) setView(r.view);
      } else setOutcome("NOTHING_TO_RESUME");
    } catch (e) {
      noteStore((e as { body?: never }).body ?? {});
      setOutcome(codeOf(e));
    } finally {
      setBusy(false);
    }
  }
  async function refresh() {
    const r = review ?? resumed.current;
    if (!r) return;
    // Review 13 R13-2: one refresh at a time (the button is disabled while busy).
    setBusy(true);
    try {
      const v = await canaryPost<CanaryViewWire>({
        action: "canary-track",
        session: r.session,
        record: r.record,
      });
      noteStore({ store: v.store ?? null });
      setView(v);
    } catch (e) {
      noteStore((e as { body?: never }).body ?? {});
      setOutcome(codeOf(e));
      if (codeOf(e) === "STORE_UNAVAILABLE") {
        // G14 follow-up F4 (review 3 N15 side effect): the journal is still shown, read only.
        try {
          await canaryPost({
            action: "canary-resume",
            account: session.address,
            amount: status?.amount ?? "",
          });
        } catch (x) {
          noteStore((x as { body?: never }).body ?? {});
        }
      }
    } finally {
      setBusy(false);
    }
  }
  /** The main step's fresh review continues the record this page reviewed or resumed with its key (review 2 R1). */
  const continuing = review ?? resumedStep;
  return (
    <div className="execution-canary" data-testid="execution-canary">
      <p className="input-hint">
        <strong>{t("g14.c.title")}</strong> · {t("g14.c.scope")}
      </p>
      <p className="input-hint">
        {t("g14.c.summary", {
          done: String(CANARY.implemented),
          total: String(CANARY.total),
          needs: CANARY.liveNeeds.join(", "),
        })}
      </p>
      <ul className="execution-checks" data-testid="canary-status">
        <li
          data-canary="implementation"
          data-value={status?.implementation ?? "UNKNOWN"}
        >
          {t("g14.c.implemented")}
        </li>
        <li
          data-canary="activation"
          data-value={status?.activation ?? "UNKNOWN"}
        >
          {armed ? t("g14.c.armed") : t("g14.c.inactive")}
        </li>
        <li
          data-canary="owner-record"
          data-value={status?.ownerRecord ?? "UNKNOWN"}
        >
          {status?.ownerRecord === "PRESENT"
            ? t("g14.c.record")
            : t("g14.c.noRecord")}
        </li>
      </ul>
      {!armed && <p className="input-hint">{t("g14.c.closed")}</p>}
      {armed && session.status === "connected" && !review && (
        <label className="input-hint" data-testid="canary-owner-key">
          {t("g14.c.ownerKey")}{" "}
          <input
            type="password"
            autoComplete="one-time-code"
            pattern="[0-9a-f]{64}"
            spellCheck={false}
            value={ownerKey}
            maxLength={64}
            onChange={(e) => setOwnerKey(e.target.value.trim().toLowerCase())}
          />
        </label>
      )}
      {armed && session.status === "connected" && !review && (
        <button
          className="secondary"
          data-testid="canary-review-button"
          disabled={busy || !/^[0-9a-f]{64}$/.test(ownerKey)}
          onClick={() => void doReview()}
        >
          {t("g14.c.review")}
        </button>
      )}
      {armed && session.status === "connected" && !review && (
        <button
          className="secondary"
          data-testid="canary-resume-button"
          disabled={busy}
          onClick={() => void resume()}
        >
          {t("g14.c.resume")}
        </button>
      )}
      {armed && review?.plan && (
        <dl className="execution-lines" data-testid="canary-review">
          <div>
            <dt>{t("g13.x.send")}</dt>
            <dd>
              <bdi dir="ltr">{usdc(review.plan.amountIn)}</bdi> · Base →
              Arbitrum
            </dd>
          </div>
          <div>
            <dt>{t("g14.c.minOut")}</dt>
            <dd data-testid="canary-min-out">
              <bdi dir="ltr">{usdc(review.plan.minimumOut)}</bdi>
            </dd>
          </div>
          <div>
            <dt>{t("g13.x.fees")}</dt>
            <dd>
              <bdi dir="ltr">
                {review.plan.fees
                  .map((f) => `${f.name}: ${usdc(f.amount)}`)
                  .join(" · ") || "—"}
              </bdi>
            </dd>
          </div>
          <div>
            <dt>{t("g14.c.target")}</dt>
            <dd>
              <code>{short(review.plan.target)}</code> /{" "}
              <code>{short(review.plan.spender)}</code>
            </dd>
          </div>
          <div>
            <dt>{t("g14.c.gas")}</dt>
            <dd data-testid="canary-gas">
              <bdi dir="ltr">
                {review.gas.spentWei ?? "?"} +{" "}
                {review.gas.remainingStepsWei ?? "?"} + L1{" "}
                {review.gas.l1FeeWei ?? "?"} ≤ {review.gas.budgetWei} wei
              </bdi>
            </dd>
          </div>
          <div>
            <dt>{t("g13.x.fingerprint")}</dt>
            <dd>
              <code>{(review.planDigest ?? "").slice(0, 16)}</code>
            </dd>
          </div>
        </dl>
      )}
      {armed && review && !review.ready && (
        <p className="notice tone-warn" data-testid="canary-not-ready">
          <code>
            {review.checks
              .filter((c) => c.status !== "PASS")
              .map((c) => `${c.id}:${c.code}`)
              .join(" · ")}
          </code>
        </p>
      )}
      {armed && review?.ready && !view?.hashes?.main && (
        <button
          className="primary"
          data-testid="canary-step-button"
          disabled={busy}
          onClick={(e) => void step(e.nativeEvent)}
        >
          {busy
            ? t("g14.c.busy")
            : review.needsApproval
              ? t("g14.c.approve", { amount: usdc(review.plan!.amountIn) })
              : t("g14.c.send", { amount: usdc(review.plan!.amountIn) })}
        </button>
      )}
      {armed && view?.state === "APPROVAL_CONFIRMED" && continuing && (
        <button
          className="secondary"
          data-testid="canary-rereview-button"
          disabled={busy}
          onClick={() => void doReview(continuing.record, continuing.session)}
        >
          {t("g14.c.review")}
        </button>
      )}
      {armed && (review || view) && (
        <button
          className="secondary"
          data-testid="canary-refresh"
          disabled={busy}
          onClick={() => void refresh()}
        >
          {t("g14.c.refresh")}
        </button>
      )}
      {view && <CanaryViewNotice view={view} t={t} />}
      {armed && newer && (
        <p
          role="alert"
          className="notice tone-warn"
          data-testid="canary-newer-record"
          data-record={newer}
        >
          {t("g14.c.newerRecord", { record: newer })}{" "}
          <button
            className="secondary"
            data-testid="canary-observe-newer"
            disabled={busy}
            onClick={() => void resume({ newest: true })}
          >
            {t("g14.c.resume")}
          </button>
        </p>
      )}
      {armed && observeOnly && (
        <p className="input-hint" data-testid="canary-observe-only">
          {t("g14.c.observeOnly")}
        </p>
      )}
      {armed && storeNote && (
        <p
          role="alert"
          className="notice tone-warn"
          data-testid="canary-store-problem"
          data-code={storeNote}
        >
          {t("g14.c.storeProblem", { status: storeNote })}
        </p>
      )}
      {outcome && (
        <p
          role="alert"
          className="notice tone-warn"
          data-testid="canary-outcome"
          data-code={outcome}
        >
          {outcome === "INVALIDATED"
            ? t("g14.c.invalidated")
            : outcome === "SUBMISSION_UNCERTAIN"
              ? t("g14.c.uncertain")
              : outcome === "OWNER_REJECTED"
                ? t("g14.c.rejected")
                : t("g14.c.refused", { code: outcome })}
        </p>
      )}
    </div>
  );
}
