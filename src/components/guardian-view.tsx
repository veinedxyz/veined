"use client";
// The Guardian page (/guardian): VEINED's protection layer as an assistant. Two modes: Chat (the deterministic
// conversation engine — no language model, no paid AI — that prepares non-executable drafts and explains Guardian's
// decisions) and Inspect (structured review of any address, NEAR account, NEAR transaction or NEP-413 message). The
// advanced demonstrations stay one click away: Agent Gate replays a compromised AI agent against the owner's policy, and
// Route toward NEAR asks NEAR Intents for a DRY quote — its live asset list is read only when that section is opened.
// Every review comes from /api/guardian (the same deterministic rules as the in-app panels). Nothing on this page
// signs, sends or deposits.
import { useEffect, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { parseUnits } from "viem";
import { useI18n } from "../i18n/provider";
import { formatTokenAmount } from "../i18n/amounts";
import type { Verdict } from "../guardian/model";
import type { AgentGateResult } from "../guardian/agent";
import {
  INTENTS_KNOWN_ASSETS,
  intentsNearContract,
  type IntentsToken,
} from "../guardian/intents";
import { knownNearAccount } from "../guardian/near";
import { review } from "../guardian/verdict";
import { prepareSigningEnvelope } from "../guardian/signing";
import {
  COMPROMISED_RUN,
  DEMO_POLICY,
  DEMO_WALLET,
  INSPECT_SCENARIOS,
  RECORDED_QUOTE,
  type InspectScenario,
} from "../guardian/scenarios";
import { GuardianMark, GuardianPanel, useFindingText } from "./guardian-panel";
import { KingHero } from "./guardian-king";
import { setDockPreference, useDockPreference } from "./guardian-dock";
import type { GuardianChatProps } from "./guardian-chat";
import { levelDecisions } from "../guardian/chat/engine";
import { PageHeader, Pill } from "./ui";
import { Icon } from "./icons";

const GuardianChat = dynamic(() => import("./guardian-chat"), { ssr: false });
async function ask<T>(body: unknown): Promise<T> {
  const r = await fetch("/api/guardian", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const value = await r.json().catch(() => ({ error: "UNAVAILABLE" }));
  if (!r.ok)
    throw Object.assign(new Error(value.error ?? "UNAVAILABLE"), {
      code: value.error,
    });
  return value as T;
}
const NEAR = (yocto: string) => formatTokenAmount(BigInt(yocto), 24, "en", 3);

function AgentGate() {
  const { t, why, title } = useFindingText();
  const [results, setResults] = useState<AgentGateResult[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function replay() {
    setBusy(true);
    setError(false);
    try {
      const r = await ask<{ results: AgentGateResult[] }>({
        action: "agent-run",
        policyId: "demo-trader",
        proposals: COMPROMISED_RUN,
      });
      setResults(r.results);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  const count = (d: AgentGateResult["decision"]) =>
    results?.filter((r) => r.decision === d).length ?? 0;
  return (
    <section
      className="card guardian-card guardian-agent"
      aria-labelledby="guardian-agent-title"
      data-testid="guardian-agent"
    >
      <div className="guardian-card-head">
        <h2 id="guardian-agent-title">
          {t("guardian.console.agentTitle" as never)}
        </h2>
        <Pill tone="accent">{t("guardian.console.simulation" as never)}</Pill>
      </div>
      <p className="guardian-card-lede">
        {t("guardian.console.agentBody" as never)}
      </p>
      <dl className="guardian-policy">
        <div>
          <dt>{t("guardian.console.agent" as never)}</dt>
          <dd>
            <bdi dir="ltr">{DEMO_POLICY.agent}</bdi>
          </dd>
        </div>
        <div>
          <dt>{t("guardian.console.limits" as never)}</dt>
          <dd>
            {t("guardian.console.limitsValue" as never, {
              perAction: NEAR(DEMO_POLICY.perActionLimit),
              daily: NEAR(DEMO_POLICY.dailyLimit),
            })}
          </dd>
        </div>
        <div>
          <dt>{t("guardian.console.allowlist" as never)}</dt>
          <dd>
            {t("guardian.console.allowlistValue" as never, {
              count: DEMO_POLICY.allowReceivers.length + 1,
            })}
          </dd>
        </div>
      </dl>
      <button
        className="primary"
        onClick={() => void replay()}
        disabled={busy}
        aria-busy={busy || undefined}
      >
        {busy ? (
          <Icon name="refresh" size={16} className="spin" />
        ) : (
          <GuardianMark size={18} />
        )}
        {t("guardian.console.agentReplay" as never)}
      </button>
      {error && (
        <p className="notice tone-danger">
          {t("guardian.console.unavailable" as never)}
        </p>
      )}
      {results && (
        <>
          <p className="guardian-tally" data-testid="guardian-agent-tally">
            {t("guardian.console.agentTally" as never, {
              blocked: count("BLOCK"),
              escalated: count("ESCALATE"),
              allowed: count("ALLOW") + count("WARN"),
            })}
          </p>
          <ol className="guardian-timeline">
            {results.map((r) => {
              const proposal = COMPROMISED_RUN.find(
                (p) => p.id === r.proposal,
              )!;
              const top =
                r.verdict.findings.find(
                  (f) => f.severity !== "PASS" && f.severity !== "INFO",
                ) ?? r.verdict.findings[0];
              return (
                <li
                  key={r.proposal}
                  className={`guardian-step is-${r.decision.toLowerCase()}`}
                  data-decision={r.decision}
                >
                  <span className="guardian-decision">
                    {t(`guardian.decision.${r.decision}` as never)}
                    <small className="guardian-authorization">
                      {t(`guardian.authorization.${r.authorization}` as never)}
                    </small>
                  </span>
                  <div className="guardian-step-body">
                    <p className="guardian-agent-says">
                      <span>{t("guardian.console.agentSays" as never)}</span>{" "}
                      <q>{proposal.reason}</q>
                    </p>
                    {top && (
                      <p className="guardian-step-why">
                        <strong>{title(top)}</strong> {why(top)}
                      </p>
                    )}
                    <details className="guardian-step-detail">
                      <summary>
                        {t("guardian.console.details" as never)}
                      </summary>
                      <GuardianPanel
                        verdict={r.verdict}
                        testId={`guardian-agent-${r.proposal}`}
                      />
                    </details>
                  </div>
                </li>
              );
            })}
          </ol>
        </>
      )}
    </section>
  );
}

function scenarioText(s: InspectScenario) {
  return s.kind === "address" ? s.value : JSON.stringify(s.value, null, 2);
}
// Inspect explains with Guardian's own localized templates only: no model is ever asked to explain a verdict.
function Inspect() {
  const { t } = useFindingText();
  const [input, setInput] = useState("");
  const [known, setKnown] = useState<string[]>([]);
  const [verdict, setVerdict] = useState<Verdict>();
  const [signer, setSigner] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  async function run(value: string, knownAccounts: string[]) {
    setBusy(true);
    setError(false);
    setVerdict(undefined);
    try {
      const text = value.trim();
      let v: Verdict;
      let predecessor = "alice.near";
      if (text.startsWith("{")) {
        const json = JSON.parse(text);
        if (json && json.kind === "swap") v = review(json);
        else if (json && typeof json.message === "string") {
          const r = await ask<{ verdict: Verdict }>({
            action: "near-message",
            message: json,
            known: knownAccounts,
          });
          v = r.verdict;
        } else {
          if (typeof json?.signerId === "string") predecessor = json.signerId;
          const r = await ask<{ verdict: Verdict }>({
            action: "near-transaction",
            tx: json,
            known: knownAccounts,
          });
          v = r.verdict;
        }
      } else {
        const r = await ask<{ verdict: Verdict }>({
          action: "address",
          value: text,
          known: knownAccounts,
        });
        v = r.verdict;
      }
      setVerdict(v);
      // Chain Signatures: a signing request would only exist after Guardian allows the action.
      const gate = prepareSigningEnvelope(v, {
        predecessor,
        path: "ethereum-1",
        payloadHash: v.digest,
        network: "testnet",
      });
      setSigner(
        gate.state === "PREPARED_NOT_SUBMITTED"
          ? t("guardian.console.signerPrepared" as never, {
              contract: gate.receiverId,
            })
          : gate.state === "NEEDS_HUMAN_CONFIRMATION"
            ? t("guardian.console.signerHuman" as never)
            : gate.state === "NEEDS_ACKNOWLEDGEMENT"
              ? t("guardian.console.signerAck" as never)
              : t("guardian.console.signerRefused" as never),
      );
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="card guardian-card guardian-inspect"
      aria-labelledby="guardian-inspect-title"
      data-testid="guardian-inspect"
    >
      <h2 id="guardian-inspect-title">
        {t("guardian.console.inspectTitle" as never)}
      </h2>
      <p className="guardian-card-lede">
        {t("guardian.console.inspectBody" as never)}
      </p>
      <div
        className="guardian-scenarios"
        role="group"
        aria-label={t("guardian.console.scenarios" as never)}
      >
        {INSPECT_SCENARIOS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="secondary guardian-scenario"
            data-scenario={s.id}
            onClick={() => {
              const value = scenarioText(s);
              const k = s.kind === "address" ? (s.known ?? []) : [];
              setInput(value);
              setKnown(k);
              void run(value, k);
            }}
          >
            {t(`guardian.scenario.${s.id}` as never)}
          </button>
        ))}
      </div>
      <label className="field-stack guardian-input">
        {t("guardian.console.inspectLabel" as never)}
        <textarea
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            setKnown([]);
          }}
          rows={6}
          dir="ltr"
          spellCheck={false}
          autoComplete="off"
          placeholder={'alice.near · 0x… · { "receiverId": … }'}
        />
      </label>
      <button
        className="primary"
        disabled={busy || !input.trim()}
        aria-busy={busy || undefined}
        onClick={() => void run(input, known)}
      >
        {busy && <Icon name="refresh" size={16} className="spin" />}
        {t("guardian.console.inspect" as never)}
      </button>
      {error && (
        <p className="notice tone-danger">
          {t("guardian.console.invalid" as never)}
        </p>
      )}
      {verdict && (
        <GuardianPanel
          verdict={verdict}
          testId="guardian-inspect-result"
          extra={
            signer && (
              <p className="guardian-signer" data-testid="guardian-signer">
                <span>{t("guardian.console.signer" as never)}</span> {signer}
              </p>
            )
          }
        />
      )}
    </section>
  );
}

const ORIGINS = ["base", "eth", "arb", "bsc", "sol"] as const;
const MAJORS = new Set([
  "ETH",
  "WETH",
  "USDC",
  "USDT",
  "BNB",
  "SOL",
  "WBTC",
  "cbBTC",
  "BTC",
  "DAI",
  "ARB",
]);
function IntentsRoute() {
  const { t } = useFindingText();
  const { lang } = useI18n();
  const [tokens, setTokens] = useState<IntentsToken[]>();
  const [chain, setChain] = useState<(typeof ORIGINS)[number]>("base");
  const [origin, setOrigin] = useState("nep141:base.omft.near");
  const [destination, setDestination] = useState("nep141:wrap.near");
  const [amount, setAmount] = useState("0.01");
  const [recipient, setRecipient] = useState("alice.near");
  const [refund, setRefund] = useState(DEMO_WALLET);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<QuoteReview & { source: Source }>();
  const [signed, setSigned] = useState<SignedQuote>();
  const [live, setLive] = useState(true);
  useEffect(() => {
    ask<{ tokens: IntentsToken[] }>({ action: "intents-tokens" })
      .then((r) => setTokens(r.tokens))
      .catch(() => {
        // Offline: the reviewed static asset list keeps the form usable; the recorded quote still reviews.
        setTokens([...INTENTS_KNOWN_ASSETS]);
        setLive(false);
      });
  }, []);
  // Majors on the source network; on NEAR only tokens whose exact contract Guardian knows (never matched by symbol).
  const from =
    tokens?.filter((x) => x.blockchain === chain && MAJORS.has(x.symbol)) ?? [];
  const to =
    tokens?.filter((x) => {
      const c = intentsNearContract(x);
      return !!c && !!knownNearAccount(c);
    }) ?? [];
  const o = tokens?.find((x) => x.assetId === origin),
    d = tokens?.find((x) => x.assetId === destination);
  async function quote() {
    if (!o || !d) return;
    setBusy(true);
    setError("");
    setResult(undefined);
    try {
      const request = {
        dry: true,
        swapType: "EXACT_INPUT",
        slippageTolerance: 100,
        originAsset: o.assetId,
        depositType: "ORIGIN_CHAIN",
        destinationAsset: d.assetId,
        amount: parseUnits(amount.replace(",", "."), o.decimals).toString(),
        refundTo: refund.trim(),
        refundType: "ORIGIN_CHAIN",
        recipient: recipient.trim(),
        recipientType: "DESTINATION_CHAIN",
        deadline: new Date(Date.now() + 600000).toISOString(),
        quoteWaitingTimeMs: 3000,
      };
      const r = await ask<QuoteReview & { signed: Record<string, unknown> }>({
        action: "intents-quote",
        sender: refund.trim(),
        locale: lang,
        request,
      });
      setResult({ ...r, source: "live" });
      setSigned({ request, response: r.signed, sender: refund.trim() });
    } catch (e) {
      setError((e as { code?: string }).code ?? "INTENTS_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  /** Re-review a signed quote exactly as received, or after one deliberate change (tampering demo). */
  async function verify(
    source: Source,
    base: SignedQuote,
    mutate?: (response: Record<string, unknown>) => void,
  ) {
    setBusy(true);
    setError("");
    try {
      const response = structuredClone(base.response);
      mutate?.(response);
      const r = await ask<QuoteReview>({
        action: "intents-verify",
        request: base.request,
        response,
        sender: base.sender,
      });
      setResult({ ...r, source });
      if (source === "recorded") setSigned(base);
    } catch (e) {
      setError((e as { code?: string }).code ?? "INTENTS_UNAVAILABLE");
    } finally {
      setBusy(false);
    }
  }
  const recorded: SignedQuote = {
    request: RECORDED_QUOTE.request,
    response: RECORDED_QUOTE.response,
    sender: String(RECORDED_QUOTE.request.refundTo),
  };
  const shownAsset = result
    ? String((signed ?? recorded).request.destinationAsset)
    : "";
  const out = [...INTENTS_KNOWN_ASSETS, ...(tokens ?? [])].find(
    (x) => x.assetId === shownAsset,
  );
  return (
    <section
      className="card guardian-card guardian-intents"
      aria-labelledby="guardian-intents-title"
      data-testid="guardian-intents"
    >
      <div className="guardian-card-head">
        <h2 id="guardian-intents-title">
          {t("guardian.console.intentsTitle" as never)}
        </h2>
        <Pill tone="info">NEAR Intents</Pill>
      </div>
      <p className="guardian-card-lede">
        {t("guardian.console.intentsBody" as never)}
      </p>
      <div className="guardian-intents-grid">
        <label className="field-stack">
          {t("guardian.console.network" as never)}
          <select
            value={chain}
            onChange={(e) => {
              const c = e.target.value as (typeof ORIGINS)[number];
              setChain(c);
              setOrigin(tokens?.find((x) => x.blockchain === c)?.assetId ?? "");
            }}
          >
            {ORIGINS.map((c) => (
              <option key={c} value={c}>
                {t(`guardian.chain.${c}` as never)}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          {t("guardian.console.from" as never)}
          <select
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
            disabled={!from.length}
          >
            {from.map((x) => (
              <option key={x.assetId} value={x.assetId}>
                {x.symbol}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack">
          {t("guardian.console.amount" as never)}
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            dir="ltr"
            autoComplete="off"
          />
        </label>
        <label className="field-stack">
          {t("guardian.console.to" as never)}
          <select
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            disabled={!to.length}
          >
            {to.map((x) => (
              <option key={x.assetId} value={x.assetId}>
                {x.symbol} ·{" "}
                {x.contractAddress && x.contractAddress.length > 24
                  ? `${x.contractAddress.slice(0, 8)}…`
                  : x.contractAddress}
              </option>
            ))}
          </select>
        </label>
        <label className="field-stack is-wide">
          {t("guardian.console.recipient" as never)}
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
        <label className="field-stack is-wide">
          {t("guardian.console.refund" as never)}
          <input
            value={refund}
            onChange={(e) => setRefund(e.target.value)}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
          />
        </label>
      </div>
      <button
        className="primary"
        disabled={busy || !o || !d || !amount || !recipient}
        aria-busy={busy || undefined}
        onClick={() => void quote()}
      >
        {busy && <Icon name="refresh" size={16} className="spin" />}
        {t("guardian.console.quote" as never)}
      </button>
      {error && (
        <p className="notice tone-warn">
          {t(
            `guardian.console.error.${error in ERRORS ? error : "INTENTS_UNAVAILABLE"}` as never,
          )}
        </p>
      )}
      <div
        className="guardian-scenarios"
        role="group"
        aria-label={t("guardian.console.verifyTools" as never)}
      >
        <button
          type="button"
          className="secondary guardian-scenario"
          disabled={busy}
          onClick={() => void verify("recorded", recorded)}
        >
          {t("guardian.console.recorded" as never)}
        </button>
        <button
          type="button"
          className="secondary guardian-scenario"
          disabled={busy || !signed}
          onClick={() =>
            signed &&
            void verify("tampered", signed, (r) => {
              const q = r.quote as Record<string, unknown>;
              q.amountOut = (BigInt(String(q.amountOut)) * 2n).toString();
            })
          }
        >
          {t("guardian.console.tamperAmount" as never)}
        </button>
        <button
          type="button"
          className="secondary guardian-scenario"
          disabled={busy || !signed}
          onClick={() =>
            signed &&
            void verify("tampered", signed, (r) => {
              const q = r.quoteRequest as Record<string, unknown>;
              q.destinationAsset = "nep141:usdt.tether-token.near";
            })
          }
        >
          {t("guardian.console.tamperAsset" as never)}
        </button>
      </div>
      {!live && (
        <p className="notice tone-warn">
          {t("guardian.console.offline" as never)}
        </p>
      )}
      {result && (
        <>
          {out && (
            <p
              className="guardian-quote-out"
              data-testid="guardian-intents-out"
            >
              {t("guardian.console.quoteOut" as never, {
                amount: formatTokenAmount(
                  BigInt(String(result.quote.amountOut)),
                  out.decimals,
                  lang,
                  6,
                ),
                symbol: out.symbol,
              })}
              {typeof result.quote.timeEstimate === "number" &&
                ` · ${t("guardian.console.eta" as never, { seconds: Math.round(result.quote.timeEstimate) })}`}
            </p>
          )}
          <p
            className="guardian-signer"
            data-testid="guardian-intents-signature"
            data-signature={result.verification.signature}
            data-source={result.source}
          >
            <span>{t("guardian.console.signature" as never)}</span>{" "}
            {t(
              `guardian.console.signature${result.verification.signature}` as never,
            )}{" "}
            <code>{result.verification.managerKey.slice(0, 16)}…</code>
          </p>
          <GuardianPanel
            verdict={result.verdict}
            testId="guardian-intents-result"
          />
        </>
      )}
    </section>
  );
}
type Source = "live" | "recorded" | "tampered";
interface SignedQuote {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
  sender: string;
}
interface QuoteReview {
  verdict: Verdict;
  quote: { amountOut: string; timeEstimate?: number };
  verification: {
    signature: "VALID" | "INVALID" | "MISSING";
    managerKey: string;
    issuedAt: string | null;
    mismatch: string[];
  };
}
const ERRORS = {
  INTENTS_UNAVAILABLE: 1,
  INTENTS_REJECTED: 1,
  INTENTS_AUTH_REQUIRED: 1,
  INVALID_REQUEST: 1,
};

/** How Guardian decides: the four levels and what each means for an action or a chat draft. */
function DecisionLegend() {
  const { t } = useFindingText();
  return (
    <section
      className="card guardian-card guardian-legend"
      aria-labelledby="guardian-legend-title"
      data-testid="guardian-legend"
    >
      <h2 id="guardian-legend-title">
        {t("guardian.chat.legendTitle" as never)}
      </h2>
      <dl className="gchat-levels">
        {levelDecisions.map(([decision, level]) => (
          <div key={decision} className={`is-${decision.toLowerCase()}`}>
            <dt>
              <code>{decision}</code>
              <span>{t(`guardian.level.${level}` as never)}</span>
            </dt>
            <dd>
              {t(`guardian.levelBody.${level}` as never)}{" "}
              {t(`guardian.chat.meaning.${decision}` as never)}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

export default function GuardianView({
  wallet,
  balanceOf,
  onOpenDraft,
  onNavigate,
}: Pick<
  GuardianChatProps,
  "wallet" | "balanceOf" | "onOpenDraft" | "onNavigate"
>) {
  const { t } = useFindingText();
  const [mode, setMode] = useState<"chat" | "inspect">("chat");
  // The NEAR route demo reads the live NEAR Intents asset list: only once its section is opened, never on page load.
  const [advanced, setAdvanced] = useState(false);
  const dock = useDockPreference();
  const tab = (id: "chat" | "inspect") => ({
    role: "tab" as const,
    id: `guardian-tab-${id}`,
    "aria-selected": mode === id,
    "aria-controls": `guardian-panel-${id}`,
    tabIndex: mode === id ? 0 : -1,
    className: `guardian-mode${mode === id ? " is-active" : ""}`,
    onClick: () => setMode(id),
    onKeyDown: (e: KeyboardEvent) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      const next = mode === "chat" ? "inspect" : "chat";
      setMode(next);
      document.getElementById(`guardian-tab-${next}`)?.focus();
    },
  });
  return (
    <section className="guardian-page" data-testid="guardian-console">
      <PageHeader
        title={
          <>
            <span className="guardian-title-mark" aria-hidden="true">
              <GuardianMark size={48} />
            </span>
            {t("guardian.name" as never)}
          </>
        }
        lede={t("guardian.console.lede" as never)}
        meta={
          <>
            <Pill tone="ok" dot>
              {t("guardian.console.deterministic" as never)}
            </Pill>
            <Pill tone="info" icon="shield">
              {t("guardian.chat.noPaidAi" as never)}
            </Pill>
            <Pill tone="neutral" icon="lock">
              {t("guardian.console.closed" as never)}
            </Pill>
          </>
        }
      />
      <div
        className="guardian-modes"
        role="tablist"
        aria-label={t("guardian.chat.modes" as never)}
      >
        <button type="button" {...tab("chat")}>
          {t("guardian.chat.title" as never)}
        </button>
        <button type="button" {...tab("inspect")}>
          {t("guardian.chat.modeInspect" as never)}{" "}
          <span className="guardian-mode-tag">
            {t("gf.g3.advanced" as never)}
          </span>
        </button>
      </div>
      <div
        role="tabpanel"
        id="guardian-panel-chat"
        aria-labelledby="guardian-tab-chat"
        hidden={mode !== "chat"}
        className="guardian-mode-panel"
      >
        <GuardianChat
          variant="page"
          page="guardian"
          wallet={wallet}
          balanceOf={balanceOf}
          onOpenDraft={onOpenDraft}
          onNavigate={onNavigate}
        />
      </div>
      <div
        role="tabpanel"
        id="guardian-panel-inspect"
        aria-labelledby="guardian-tab-inspect"
        hidden={mode !== "inspect"}
        className="guardian-mode-panel"
      >
        <Inspect />
      </div>
      {/* gf1 G03: first-time users start in the conversation; the King Octopus and the "about" copy follow it. */}
      <div className="guardian-hero is-about" data-testid="guardian-hero">
        <div className="guardian-hero-art" aria-hidden="true">
          <KingHero />
        </div>
        <div className="guardian-hero-copy">
          <p className="guardian-hero-kicker">
            {t("guardian.chat.heroKicker" as never)}
          </p>
          <h2>{t("guardian.chat.heroTitle" as never)}</h2>
          <p>{t("guardian.chat.heroBody" as never)}</p>
          <ul className="guardian-hero-points">
            {(["One", "Two", "Three"] as const).map((k) => (
              <li key={k}>
                <Icon name="check" size={14} />
                {t(`guardian.chat.heroPoint${k}` as never)}
              </li>
            ))}
          </ul>
          {dock === "hidden" && (
            <button
              type="button"
              className="secondary"
              onClick={() => setDockPreference("shown")}
            >
              {t("guardian.chat.dock.show" as never)}
            </button>
          )}
        </div>
      </div>
      <DecisionLegend />
      <details
        className="guardian-advanced"
        data-testid="guardian-advanced"
        onToggle={(e) => {
          if ((e.currentTarget as HTMLDetailsElement).open) setAdvanced(true);
        }}
      >
        <summary>
          <span>{t("guardian.chat.advancedTitle" as never)}</span>
          <small>{t("guardian.chat.advancedBody" as never)}</small>
        </summary>
        <div className="guardian-grid">
          <AgentGate />
          {advanced && <IntentsRoute />}
          <section
            className="card guardian-card guardian-built"
            aria-labelledby="guardian-built-title"
          >
            <h2 id="guardian-built-title">
              {t("guardian.console.builtTitle" as never)}
            </h2>
            <ul>
              {(["Intents", "Accounts", "Signer"] as const).map((k) => (
                <li key={k}>
                  <strong>{t(`guardian.console.built${k}` as never)}</strong>
                  <span>{t(`guardian.console.built${k}Body` as never)}</span>
                </li>
              ))}
              <li>
                <strong>{t("guardian.chat.builtNoAi" as never)}</strong>
                <span>{t("guardian.chat.builtNoAiBody" as never)}</span>
              </li>
            </ul>
          </section>
        </div>
      </details>
    </section>
  );
}
