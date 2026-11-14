"use client";
// Guardian chat: the conversation surface of VEINED Guardian, on the Guardian page and in the floating assistant.
// The words are understood by the deterministic engine in src/guardian/chat (no language model, no paid AI, no keys);
// every draft is reviewed by Guardian's policy on VEINED's own server (/api/guardian, local data only), and a dry quote
// is requested only when the user presses its button. Nothing here signs, approves, sends or changes a permission: a
// draft can only be opened in the normal Swap or Bridge screen, where the user reviews it and Guardian checks it again.
// The conversation lives in this component's memory only (never stored) and is cleared when the wallet changes.
import { useEffect, useRef, useState, type FormEvent } from "react";
import { useI18n } from "../i18n/provider";
import { formatTokenAmount } from "../i18n/amounts";
import { useFindingText, GuardianPanel } from "./guardian-panel";
import { KingAvatar } from "./guardian-king";
import { NavGlyph, type NavGlyphName } from "./app-nav";
import { Icon } from "./icons";
// The disclosure icon of the technical record is not a core icon: register the code-split set with this view.
import "./icons-extra";
import { useGuardianFacts } from "./guardian-context";
import {
  choose,
  initial,
  levelDecisions,
  repage,
  seen,
  send,
  settle,
  type Block,
  type ChatContext,
  type ChatState,
  type Chip,
  type ChipAction,
  type DraftEntry,
  type Effect,
  type Outcome,
  type PageKey,
  type Text,
  type Turn,
} from "../guardian/chat/engine";
import {
  CHAT_DRAFT_POLICY,
  chainName,
  type ChainKey,
  type ChatDraft,
  type ResolvedToken,
} from "../guardian/chat/model";
import { LIFETIME_REFERRAL_BPS } from "../lifetime-points/policy";
import type { Verdict } from "../guardian/model";

// gf1 G03: when each Guardian answer arrived (local clock), recorded when a turn is applied (never during render) and
// shown as the time of a review in its technical details. Memory only, like the conversation itself.
const answeredAt = new Map<string, number>();
const DECISION_OF = Object.fromEntries(
  levelDecisions.map(([decision, level]) => [level, decision]),
) as Record<Verdict["level"], (typeof levelDecisions)[number][0]>;

async function ask<T>(body: unknown, signal: AbortSignal): Promise<T> {
  const timeout = AbortSignal.timeout(20000);
  const r = await fetch("/api/guardian", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal:
      typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, timeout])
        : signal,
  });
  const value = await r.json().catch(() => ({ error: "UNAVAILABLE" }));
  if (!r.ok)
    throw Object.assign(new Error(value.error ?? "UNAVAILABLE"), {
      code: value.error ?? "UNAVAILABLE",
    });
  return value as T;
}
/** Event time for the engine: read only inside handlers and effect callbacks, never while rendering. */
const clock = () => Date.now();
const codeOf = (e: unknown) => (e as { code?: string })?.code ?? "UNAVAILABLE";
const sessionId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");

/** Run one effect against VEINED's own API and describe what came back (never throws). */
async function execute(
  e: Effect,
  state: ChatState,
  signal: AbortSignal,
): Promise<Outcome> {
  switch (e.e) {
    case "open":
      return { e: "open", id: e.id, ok: false };
    case "draft":
      try {
        return {
          e: "draft",
          id: e.id,
          result: await ask({ action: "chat-draft", draft: e.request }, signal),
        };
      } catch (x) {
        return { e: "draft", id: e.id, error: codeOf(x) };
      }
    case "token":
      try {
        return {
          e: "token",
          symbol: e.symbol,
          chain: e.request.chain,
          result: await ask({ action: "chat-token", check: e.request }, signal),
        };
      } catch (x) {
        return {
          e: "token",
          symbol: e.symbol,
          chain: e.request.chain,
          error: codeOf(x),
        };
      }
    case "inspect":
      try {
        const r = await ask<{ verdict: Verdict }>(
          { action: "address", value: e.value },
          signal,
        );
        return { e: "inspect", value: e.value, verdict: r.verdict };
      } catch (x) {
        return { e: "inspect", value: e.value, error: codeOf(x) };
      }
    case "quote":
    case "recheck": {
      const entry = state.drafts[e.id];
      const d = entry?.result?.draft;
      if (!d || !d.rawAmount || !d.sender || !d.recipient)
        return { e: e.e, id: e.id, error: "INVALID_REQUEST" };
      try {
        type Reviewed = {
          verdict: Verdict;
          quote: { amountOut: string };
          verification: { signature: string; issuedAt: string | null };
          signed?: unknown;
        };
        let request: Record<string, unknown>, r: Reviewed;
        if (e.e === "quote") {
          request = {
            dry: true,
            swapType: "EXACT_INPUT",
            slippageTolerance: 100,
            originAsset: d.pay.assetId,
            depositType: "ORIGIN_CHAIN",
            destinationAsset: d.receive.assetId,
            amount: d.rawAmount,
            refundTo: d.sender,
            refundType: "ORIGIN_CHAIN",
            recipient: d.recipient,
            recipientType: "DESTINATION_CHAIN",
            deadline: new Date(clock() + 600_000).toISOString(),
            quoteWaitingTimeMs: 3000,
          };
          r = await ask<Reviewed>(
            { action: "intents-quote", request, sender: d.sender },
            signal,
          );
        } else {
          const signed = entry.quote?.signed;
          if (!signed) return { e: e.e, id: e.id, error: "INVALID_REQUEST" };
          request = signed.request;
          r = await ask<Reviewed>(
            {
              action: "intents-verify",
              request,
              response: signed.response,
              sender: d.sender,
            },
            signal,
          );
        }
        const issued = r.verification.issuedAt
          ? Date.parse(r.verification.issuedAt)
          : NaN;
        return {
          e: e.e,
          id: e.id,
          quote: {
            verdict: r.verdict,
            amountOut: String(r.quote.amountOut),
            issuedAt: Number.isFinite(issued) ? issued : null,
            signature: r.verification.signature,
            signed: {
              request,
              response:
                e.e === "quote" ? r.signed : entry.quote?.signed?.response,
            },
          },
        };
      } catch (x) {
        return { e: e.e, id: e.id, error: codeOf(x) };
      }
    }
  }
}

export interface GuardianChatProps {
  variant: "page" | "dock";
  page: PageKey;
  wallet: string | null;
  /** Pay-token balance from the user's own Portfolio scan (display units), when known. */
  balanceOf?: (
    chainId: string,
    symbol: string,
    address?: string,
  ) => string | null;
  /** Open a reviewed draft in the normal Swap or Bridge screen (prefilled, never quoted or signed). */
  onOpenDraft?: (draft: ChatDraft) => Promise<boolean>;
  onNavigate?: (to: string) => void;
  titleId?: string;
}

/** One conversation per wallet identity and per "New conversation": a new key starts a new, empty session (nothing
 * from the previous one is kept, and its pending requests are aborted on unmount). */
export default function GuardianChat(props: GuardianChatProps) {
  const [round, setRound] = useState(0);
  return (
    <ChatSession
      key={`${props.wallet ?? "-"}:${round}`}
      {...props}
      onRestart={() => setRound((r) => r + 1)}
    />
  );
}

function ChatSession({
  variant,
  page,
  wallet,
  balanceOf,
  onOpenDraft,
  onNavigate,
  titleId = "guardian-chat-title",
  onRestart,
}: GuardianChatProps & { onRestart: () => void }) {
  const { lang } = useI18n();
  const { t } = useFindingText();
  const facts = useGuardianFacts();
  const ctx: ChatContext = {
    page,
    understood: lang === "en" || lang === "tr",
    facts,
    wallet,
    balance: balanceOf
      ? (chain: ChainKey, symbol: string, address?: string) =>
          balanceOf(chainIdOf(chain), symbol, address)
      : undefined,
    product: {
      referralPercent: new Intl.NumberFormat(lang).format(
        LIFETIME_REFERRAL_BPS / 100,
      ),
    },
  };
  const [state, setState] = useState<ChatState>(() =>
    initial(ctx, clock(), sessionId()),
  );
  const [pending, setPending] = useState(0);
  const [input, setInput] = useState("");
  const live = useRef({ state, ctx });
  const aborts = useRef(new Set<AbortController>());
  const log = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    live.current = { state, ctx };
  });
  // gf1 G04: the floating assistant stays open across pages; its suggestions follow the page the user moves to.
  const shownOn = useRef(page);
  useEffect(() => {
    if (shownOn.current === page) return;
    shownOn.current = page;
    const next = repage(live.current.state, { ...live.current.ctx, page });
    live.current = { ...live.current, state: next };
    setState(next);
  }, [page]);
  useEffect(() => {
    const set = aborts.current;
    // The floating assistant mounts when the user opens it: the message field takes the focus.
    if (variant === "dock") field.current?.focus();
    return () => {
      for (const c of set) c.abort();
    };
  }, [variant]);
  // gf1 G03: until the user says something, the page conversation shows the guided starts, read from the top.
  const guided =
    variant === "page" && !state.messages.some((m) => m.from === "user");
  useEffect(() => {
    const el = log.current;
    if (el) el.scrollTop = guided ? 0 : el.scrollHeight;
  }, [state.seq, pending, guided]);
  // A used guided start leaves the page: keyboard focus moves to Guardian's first suggestion (the log announces the
  // question), or to the message field when there is none.
  const chipsRef = useRef<HTMLDivElement>(null);
  const focusAfterStart = useRef(false);
  useEffect(() => {
    if (!focusAfterStart.current) return;
    focusAfterStart.current = false;
    (
      chipsRef.current?.querySelector<HTMLButtonElement>(".gchat-chip") ??
      field.current
    )?.focus();
  });

  function apply(turn: Turn) {
    const at = clock();
    for (const m of turn.state.messages)
      if (m.from === "guardian" && !answeredAt.has(m.id))
        answeredAt.set(m.id, at);
    // A draft's review arrives after its message: its own time is when the result came back.
    for (const [id, d] of Object.entries(turn.state.drafts))
      if (d.result && !answeredAt.has(id)) answeredAt.set(id, at);
    while (answeredAt.size > 400)
      answeredAt.delete(answeredAt.keys().next().value as string);
    live.current = { ...live.current, state: turn.state };
    setState(turn.state);
    for (const e of turn.effects) void run(e);
  }
  async function run(e: Effect) {
    const controller = new AbortController();
    aborts.current.add(controller);
    setPending((n) => n + 1);
    // Opening fills the normal Swap/Bridge screen (no quote, no signature); the shell reports whether it could.
    const draft =
      e.e === "open"
        ? live.current.state.drafts[e.id]?.result?.draft
        : undefined;
    const outcome: Outcome =
      e.e === "open"
        ? {
            e: "open",
            id: e.id,
            ok: !!draft && !!(await onOpenDraft?.(draft).catch(() => false)),
          }
        : await execute(e, live.current.state, controller.signal);
    aborts.current.delete(controller);
    setPending((n) => n - 1);
    if (controller.signal.aborted) return;
    apply(settle(live.current.state, outcome, live.current.ctx, clock()));
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    apply(send(state, text, ctx, clock()));
  }
  function pick(c: Chip) {
    const label = render(c.label);
    if (c.action.a === "go") onNavigate?.(c.action.to);
    apply(choose(state, c.action, label, ctx, clock()));
  }
  function restart() {
    onRestart();
  }
  // "@key" parameters name other Guardian chat texts (decision names, slot names, evidence levels).
  const render = (x: Text) =>
    t(
      x.key as never,
      Object.fromEntries(
        Object.entries(x.params ?? {}).map(([k, v]) => [
          k,
          typeof v === "string" && v.startsWith("@")
            ? t(`guardian.chat.${v.slice(1)}` as never)
            : v,
        ]),
      ),
    );

  return (
    <section
      className={`gchat is-${variant}${guided ? " is-guided" : ""}`}
      aria-labelledby={titleId}
      data-testid={variant === "page" ? "guardian-chat" : "guardian-dock-chat"}
      data-session={state.session}
    >
      <header className="gchat-head">
        <span className="gchat-identity" aria-hidden="true">
          <KingAvatar size={36} />
        </span>
        <div className="gchat-head-text">
          <h2 id={titleId}>{t("guardian.chat.title" as never)}</h2>
          <p>{t("guardian.chat.subtitle" as never)}</p>
        </div>
        <button
          type="button"
          className="secondary gchat-new"
          onClick={restart}
          data-testid="guardian-chat-new"
        >
          {t("guardian.chat.newChat" as never)}
        </button>
      </header>
      {variant === "dock" && (
        // gf1 G04: what Guardian can see on this page, stated before anything is asked (only facts the page shows).
        <p className="gchat-context" data-testid="guardian-dock-context">
          <span className="gchat-context-label">
            {t("guardian.chat.r.sees.here" as never)}
          </span>{" "}
          {seen(ctx, true).map((x, i) => (
            <span key={x.key} className="gchat-context-item">
              {i > 0 && " · "}
              {render(x)}
            </span>
          ))}
        </p>
      )}
      <div
        ref={log}
        className="gchat-log"
        role="log"
        aria-live="polite"
        aria-label={t("guardian.chat.log" as never)}
        tabIndex={0}
      >
        {state.messages.map((m) =>
          m.from === "user" ? (
            <div key={m.id} className="gchat-msg is-user" data-from="user">
              <span className="sr-only">
                {t("guardian.chat.you" as never)}:
              </span>
              <p dir="auto">{m.text}</p>
            </div>
          ) : (
            <div
              key={m.id}
              className="gchat-msg is-guardian"
              data-from="guardian"
            >
              <span className="gchat-msg-mark" aria-hidden="true">
                <KingAvatar size={28} />
              </span>
              <div className="gchat-msg-body">
                <span className="sr-only">{t("guardian.name" as never)}:</span>
                {m.blocks?.map((b, i) => (
                  <BlockView
                    key={i}
                    block={b}
                    render={render}
                    state={state}
                    at={answeredAt.get(m.id)}
                    onOpen={(entry, ack) => {
                      const kind = entry.result?.draft.kind;
                      apply(
                        choose(
                          state,
                          { a: "open", draft: entry.id, ack },
                          t(
                            `guardian.chat.draft.${kind === "swap" ? "openSwap" : "openBridge"}` as never,
                          ),
                          ctx,
                          clock(),
                        ),
                      );
                    }}
                    onAction={(action, label) =>
                      apply(choose(state, action, label, ctx, clock()))
                    }
                    referral={ctx.product.referralPercent}
                  />
                ))}
              </div>
            </div>
          ),
        )}
        {guided && (
          <GuidedStart
            onStart={(action, label) => {
              focusAfterStart.current = true;
              apply(choose(state, action, label, ctx, clock()));
            }}
          />
        )}
        {pending > 0 && (
          <p className="gchat-thinking" role="status">
            {t("guardian.chat.thinking" as never)}
          </p>
        )}
      </div>
      <div
        ref={chipsRef}
        className="gchat-chips"
        role="group"
        aria-label={t("guardian.chat.suggestions" as never)}
      >
        {state.chips.map((c) => (
          <button
            key={c.id}
            type="button"
            className="gchat-chip"
            data-chip={c.id}
            onClick={() => pick(c)}
          >
            {render(c.label)}
          </button>
        ))}
      </div>
      <form className="gchat-input" onSubmit={submit}>
        <label className="sr-only" htmlFor={`${titleId}-input`}>
          {t("guardian.chat.inputLabel" as never)}
        </label>
        <input
          ref={field}
          id={`${titleId}-input`}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={500}
          autoComplete="off"
          spellCheck={false}
          dir="auto"
          placeholder={t("guardian.chat.placeholder" as never)}
          data-testid="guardian-chat-input"
        />
        <button type="submit" className="primary" disabled={!input.trim()}>
          {t("guardian.chat.send" as never)}
        </button>
      </form>
      <p className="gchat-foot">{t("guardian.chat.privacy" as never)}</p>
    </section>
  );
}

const chainIdOf = (k: ChainKey) =>
  ({
    ethereum: "1",
    base: "8453",
    bsc: "56",
    arbitrum: "42161",
    optimism: "10",
    polygon: "137",
    avalanche: "43114",
    near: "near",
  })[k];

function BlockView({
  block,
  render,
  state,
  at,
  onOpen,
  onAction,
  referral,
}: {
  block: Block;
  render: (x: Text) => string;
  state: ChatState;
  /** When this Guardian answer arrived (local clock). */
  at?: number;
  onOpen: (entry: DraftEntry, ack: boolean) => void;
  onAction: Parameters<typeof DraftCard>[0]["onAction"];
  referral: string;
}) {
  const { t, title } = useFindingText();
  switch (block.t) {
    case "text":
      return <p className="gchat-text">{render(block)}</p>;
    case "note":
      return (
        <p className={`gchat-note tone-${block.tone}`} data-note={block.key}>
          {render(block)}
        </p>
      );
    case "list":
      return (
        <ul className="gchat-list">
          {block.items.map((x) => (
            <li key={x.key}>{render(x)}</li>
          ))}
        </ul>
      );
    case "levels":
      return (
        <dl className="gchat-levels" data-testid="guardian-chat-levels">
          {levelDecisions.map(([decision, level]) => (
            <div key={decision} className={`is-${decision.toLowerCase()}`}>
              <dt>
                <code>{decision}</code>
                <span>{t(`guardian.level.${level}` as never)}</span>
              </dt>
              <dd>{t(`guardian.chat.meaning.${decision}` as never)}</dd>
            </div>
          ))}
        </dl>
      );
    case "points":
      return (
        <div className="gchat-facts" data-testid="guardian-chat-points">
          {/* gf1 G06 + G12 H05: the owner's planned rule (1 point per 100 USD of verified volume); it is not active,
              so no figure for any account but the rule's own numbers and the 10% referral. */}
          <p>
            <strong>
              {t("guardian.chat.pointsLifetime" as never, { rate: referral })}
            </strong>
          </p>
          <p>{t("points.lifetime.rules.referral" as never)}</p>
          <p>{t("points.lifetime.pendingBody" as never)}</p>
          <p>{t("points.how.value" as never)}</p>
        </div>
      );
    case "verdict": {
      // A re-shown draft verdict keeps that draft's review time and policy; a page verdict is the page's own review.
      const shown = block.origin === "draft" ? block.draft : undefined;
      return (
        <div className="gchat-verdict">
          <DecisionSummary decision={DECISION_OF[block.verdict.level]} />
          <GuardianPanel
            verdict={block.verdict}
            compact
            testId={block.testId}
          />
          <TechnicalDetails
            verdict={block.verdict}
            decision={DECISION_OF[block.verdict.level]}
            at={shown ? answeredAt.get(shown) : at}
            origin={block.origin === "page" ? "page" : "server"}
            draftPolicy={
              shown ? state.drafts[shown]?.result?.policy : undefined
            }
          />
          {block.verdict.findings[0] && (
            <span className="sr-only">{title(block.verdict.findings[0])}</span>
          )}
        </div>
      );
    }
    case "draft": {
      const entry = state.drafts[block.id];
      return entry ? (
        <DraftCard
          entry={entry}
          at={answeredAt.get(entry.id)}
          onOpen={onOpen}
          onAction={onAction}
          quotesLeft={CHAT_DRAFT_POLICY.quoteBudget - state.quotes}
          now={state.touched}
        />
      ) : (
        // Older drafts leave the conversation (at most six are kept).
        <p className="gchat-note tone-info">
          {t("guardian.chat.draft.gone" as never)}
        </p>
      );
    }
  }
}

function tokenLine(
  token: ResolvedToken,
  t: (key: never, params?: Record<string, string | number>) => string,
) {
  const where = token.native
    ? t("guardian.chat.draft.native" as never)
    : token.address.length > 14
      ? `${token.address.slice(0, 6)}…${token.address.slice(-4)}`
      : token.address;
  return `${where} · ${t(`guardian.chat.assetLevel.${token.level ?? "NONE"}` as never)}`;
}

function DraftCard({
  entry,
  at,
  onOpen,
  onAction,
  quotesLeft,
  now,
}: {
  entry: DraftEntry;
  /** When Guardian's answer with this draft arrived (local clock). */
  at?: number;
  /** Time of the conversation's last activity: what "expired" is shown against (the engine re-checks on open). */
  now: number;
  onOpen: (entry: DraftEntry, ack: boolean) => void;
  onAction: (action: Parameters<typeof choose>[1], label: string) => void;
  quotesLeft: number;
}) {
  const { t } = useFindingText();
  const { lang } = useI18n();
  const [ack, setAck] = useState(false);
  const r = entry.result;
  if (!r) return null;
  const d = r.draft;
  const expired = now - entry.at > CHAT_DRAFT_POLICY.draftTtlMs;
  const decision = r.decision;
  const decimalsKnown = d.pay.decimals !== null && d.receive.decimals !== null;
  const canOpen =
    d.kind !== "near" &&
    decision !== "BLOCK" &&
    !expired &&
    decimalsKnown &&
    (decision !== "ESCALATE" || ack);
  const q = entry.quote;
  const tone = decision.toLowerCase();
  // gf1 G03: the next step is worded only when nothing else stands in its way (expiry, unknown decimals, the quote
  // budget); those reasons are shown below in their own words.
  const nextShown =
    decision === "BLOCK" ||
    (!expired && (d.kind === "near" ? quotesLeft > 0 : decimalsKnown));
  return (
    <article
      className={`gdraft is-${tone}`}
      data-testid="guardian-draft"
      data-state="ready"
      data-kind={d.kind}
      data-decision={decision}
      data-draft={d.id}
      aria-label={t(`guardian.chat.draft.${d.kind}` as never)}
    >
      <header className="gdraft-head">
        <span className="gdraft-kind">
          {t(`guardian.chat.draft.${d.kind}` as never)}
        </span>
        <span
          className={`gdraft-decision is-${tone}`}
          data-testid="guardian-draft-decision"
        >
          <code>{decision}</code>
          {t(`guardian.chat.decision.${decision}` as never)}
        </span>
      </header>
      <DecisionSummary
        decision={decision}
        kind={nextShown ? d.kind : undefined}
      />
      <dl className="gdraft-rows">
        <div>
          <dt>{t("guardian.chat.draft.pay" as never)}</dt>
          <dd>
            <strong>
              <bdi dir="ltr">
                {d.amount} {d.pay.symbol}
              </bdi>
            </strong>{" "}
            · {chainName(d.source)}
            <small>
              <bdi dir="ltr">{tokenLine(d.pay, t)}</bdi>
            </small>
          </dd>
        </div>
        <div>
          <dt>{t("guardian.chat.draft.receive" as never)}</dt>
          <dd>
            <strong>
              <bdi dir="ltr">{d.receive.symbol}</bdi>
            </strong>{" "}
            · {chainName(d.destination)}
            <small>
              <bdi dir="ltr">{tokenLine(d.receive, t)}</bdi>
            </small>
          </dd>
        </div>
        <div>
          <dt>{t("guardian.chat.draft.recipient" as never)}</dt>
          <dd>
            {d.recipient ? (
              <bdi dir="ltr">
                {d.recipient.length > 24
                  ? `${d.recipient.slice(0, 10)}…${d.recipient.slice(-6)}`
                  : d.recipient}
              </bdi>
            ) : d.sender ? (
              t("guardian.chat.draft.recipientSelf" as never)
            ) : (
              t("guardian.chat.draft.recipientLater" as never)
            )}
          </dd>
        </div>
      </dl>
      <p className="gdraft-exec">
        {t("guardian.chat.draft.notExecutable" as never)}
      </p>
      <GuardianPanel
        verdict={r.verdict}
        compact
        testId="guardian-draft-verdict"
      />
      <TechnicalDetails
        verdict={r.verdict}
        decision={decision}
        at={at}
        draftPolicy={r.policy}
      />
      {q && (
        <div
          className="gdraft-quote"
          data-testid="guardian-draft-quote"
          data-state={q.status}
        >
          {q.status === "loading" && (
            <p>{t("guardian.chat.thinking" as never)}</p>
          )}
          {q.status === "ready" && q.verdict && (
            <>
              <p>
                {t("guardian.chat.draft.quoteOut" as never, {
                  amount: formatTokenAmount(
                    BigInt(q.amountOut ?? "0"),
                    d.receive.decimals ?? 24,
                    lang,
                    6,
                  ),
                  symbol: d.receive.symbol,
                })}
                {q.issuedAt !== null && q.issuedAt !== undefined && (
                  <>
                    {" · "}
                    {t("guardian.chat.draft.quoteAge" as never, {
                      seconds: Math.max(
                        0,
                        Math.round((now - q.issuedAt) / 1000),
                      ),
                    })}
                  </>
                )}
              </p>
              <p className="gdraft-signature" data-signature={q.signature}>
                {t("guardian.console.signature" as never)}{" "}
                {t(
                  `guardian.console.signature${q.signature ?? "MISSING"}` as never,
                )}
              </p>
              <GuardianPanel
                verdict={q.verdict}
                compact
                testId="guardian-draft-quote-verdict"
              />
            </>
          )}
        </div>
      )}
      {expired && (
        <p className="gchat-note tone-warn">
          {t("guardian.chat.draft.expired" as never)}
        </p>
      )}
      {decision === "BLOCK" && (
        <p className="gchat-note tone-danger">
          {t("guardian.chat.draft.blocked" as never)}
        </p>
      )}
      {d.kind !== "near" && !decimalsKnown && decision !== "BLOCK" && (
        <p className="gchat-note tone-warn">
          {t("guardian.chat.draft.unknownDecimals" as never)}
        </p>
      )}
      {decision === "ESCALATE" && d.kind !== "near" && !expired && (
        <label className="gdraft-ack">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          {t("guardian.chat.draft.ack" as never)}
        </label>
      )}
      <div className="gdraft-actions">
        {d.kind === "near" ? (
          <>
            <button
              type="button"
              className="secondary"
              disabled={
                expired ||
                decision === "BLOCK" ||
                q?.status === "loading" ||
                quotesLeft <= 0
              }
              onClick={() =>
                onAction(
                  { a: "quote", draft: entry.id },
                  t("guardian.chat.draft.quote" as never),
                )
              }
            >
              {t("guardian.chat.draft.quote" as never)}
            </button>
            {q?.signed && (
              <button
                type="button"
                className="secondary"
                disabled={q.status === "loading"}
                onClick={() =>
                  onAction(
                    { a: "recheck", draft: entry.id },
                    t("guardian.chat.draft.recheck" as never),
                  )
                }
              >
                {t("guardian.chat.draft.recheck" as never)}
              </button>
            )}
            <span className="gdraft-budget">
              {t("guardian.chat.draft.budget" as never, {
                left: Math.max(0, quotesLeft),
              })}
            </span>
          </>
        ) : (
          <button
            type="button"
            className="primary"
            disabled={!canOpen}
            onClick={() => onOpen(entry, ack)}
            data-testid="guardian-draft-open"
          >
            {t(
              `guardian.chat.draft.${d.kind === "swap" ? "openSwap" : "openBridge"}` as never,
            )}
          </button>
        )}
      </div>
    </article>
  );
}

// ---- gf1 G03: first-time guidance -------------------------------------------------------------------------------
/** The five guided starts. Each runs an existing structured action of the deterministic engine (language-independent,
 * never parsed as text): a draft kind (Guardian then asks for each missing field, step by step) or a built-in example. */
const GUIDED: { id: string; glyph: NavGlyphName; action: ChipAction }[] = [
  { id: "swap", glyph: "swap", action: { a: "kind", kind: "swap" } },
  { id: "bridge", glyph: "bridge", action: { a: "kind", kind: "bridge" } },
  { id: "token", glyph: "guardian", action: { a: "example", id: "token" } },
  {
    id: "address",
    glyph: "portfolio",
    action: { a: "example", id: "address" },
  },
  { id: "quote", glyph: "help", action: { a: "example", id: "quoteGuide" } },
];
function GuidedStart({
  onStart,
}: {
  onStart: (action: ChipAction, label: string) => void;
}) {
  const { t } = useFindingText();
  return (
    <section
      className="gchat-start"
      aria-labelledby="gchat-start-title"
      data-testid="guardian-guided-start"
    >
      <h3 id="gchat-start-title">{t("gf.g3.start.title" as never)}</h3>
      <p>{t("gf.g3.start.lede" as never)}</p>
      <ul>
        {GUIDED.map((g) => {
          const title = t(`gf.g3.start.${g.id}` as never);
          return (
            <li key={g.id}>
              <button
                type="button"
                className="gchat-start-card"
                data-guided-start={g.id}
                aria-label={title}
                aria-describedby={`gchat-start-${g.id}`}
                onClick={() => onStart(g.action, title)}
              >
                <NavGlyph name={g.glyph} />
                <span>
                  <strong>{title}</strong>
                  <small id={`gchat-start-${g.id}`}>
                    {t(`gf.g3.start.${g.id}Body` as never)}
                  </small>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The decision in one plain sentence, and what the user can do next. The decision itself always comes from
 * Guardian's policy on the server; this only words it. */
function DecisionSummary({
  decision,
  kind,
}: {
  decision: string;
  kind?: "swap" | "bridge" | "near";
}) {
  const { t } = useFindingText();
  const next = kind
    ? kind === "near"
      ? `gf.g3.nextNear.${decision}`
      : `gf.g3.next.${decision}`
    : null;
  return (
    <div
      className={`gchat-plain is-${decision.toLowerCase()}`}
      data-testid="guardian-plain"
      data-decision={decision}
    >
      <p>
        <strong>{t(`gf.g3.plain.${decision}` as never)}</strong>
      </p>
      {next && <p>{t(next as never)}</p>}
    </div>
  );
}

/** The technical record of a review, collapsed by default: decision code, level, checks, policy (and the chat-draft
 * policy for drafts), digest, when the answer arrived, what Guardian used and what it did not check. A page verdict is
 * the Swap/Bridge page's own review of its route in this browser, and says so. */
function TechnicalDetails({
  verdict,
  decision,
  at,
  origin = "server",
  draftPolicy,
}: {
  verdict: Verdict;
  decision: string;
  at?: number;
  origin?: "server" | "page";
  draftPolicy?: string;
}) {
  const { t } = useFindingText();
  const { lang } = useI18n();
  const page = origin === "page";
  return (
    <details
      className="gchat-tech"
      data-testid="guardian-tech"
      data-origin={origin}
    >
      <summary>
        <Icon name="plus" size={14} />
        {t("gf.g3.tech.title" as never)}
      </summary>
      <dl>
        <div>
          <dt>{t("gf.g3.tech.decision" as never)}</dt>
          <dd>
            <code>{decision}</code> ·{" "}
            {t(`guardian.level.${verdict.level}` as never)}
          </dd>
        </div>
        <div>
          <dt>{t("gf.g3.tech.checks" as never)}</dt>
          <dd>{verdict.checks}</dd>
        </div>
        <div>
          <dt>{t("gf.g3.tech.policy" as never)}</dt>
          <dd>
            <code dir="ltr">{verdict.policy}</code>
          </dd>
        </div>
        {draftPolicy && (
          <div>
            <dt>{t("gf.g3.tech.draftPolicy" as never)}</dt>
            <dd>
              <code dir="ltr">{draftPolicy}</code>
            </dd>
          </div>
        )}
        <div>
          <dt>{t("gf.g3.tech.digest" as never)}</dt>
          <dd>
            <code dir="ltr" className="gchat-tech-digest">
              {verdict.digest}
            </code>
          </dd>
        </div>
        {at !== undefined && (
          <div>
            <dt>
              {t((page ? "gf.g3.tech.shown" : "gf.g3.tech.answered") as never)}
            </dt>
            <dd>
              <time dateTime={new Date(at).toISOString()}>
                {new Intl.DateTimeFormat(lang, {
                  hour: "2-digit",
                  minute: "2-digit",
                  second: "2-digit",
                }).format(at)}
              </time>
            </dd>
          </div>
        )}
      </dl>
      <p>
        {t((page ? "gf.g3.tech.sourcesPage" : "gf.g3.tech.sources") as never)}
      </p>
      <p>
        {t((page ? "gf.g3.tech.limitsPage" : "gf.g3.tech.limits") as never)}
      </p>
    </details>
  );
}
