"use client";
// G12 "To NEAR" route inside Swap and Bridge: a reviewed source asset → a NEAR token through NEAR Intents (1Click).
// The server (/api/guardian, action intents-quote) asks 1Click for a DRY quote, verifies its signature and has Guardian
// review it; this screen only shows what came back. Nothing here can create a deposit address, sign, approve or send:
// the request type fixes `dry: true` and the only send control is permanently disabled. Expiry is fail-closed: when
// the preview window ends the signed quote is re-reviewed by the server (stale), never silently kept as current.
import { useEffect, useRef, useState } from "react";
import { parseUnits } from "viem";
import { useI18n } from "../i18n/provider";
import {
  ambiguousAmountReadings,
  formatPercent,
  formatTokenAmount,
  formatUsd,
  normalizeAmountInput,
} from "../i18n/amounts";
import type { Verdict } from "../guardian/model";
import { decisionOf } from "../guardian/chat/model";
import { validNearAccount } from "../guardian/near";
import {
  MAX_QUOTE_AGE_MS,
  type IntentsQuoteRequest,
  type IntentsToken,
} from "../guardian/intents";
import {
  NEAR_ROUTE_CHAINS,
  NEAR_ROUTE_SLIPPAGE_BPS,
  nearQuoteRequest,
  nearRouteChainOf,
  nearRouteDestinations,
  nearRouteEcosystem,
  nearRouteOrigins,
  nearRouteReceipt,
  quoteMatchesRequest,
  validRefundAddress,
  type NearRouteChain,
  type NearRouteReceipt,
} from "../guardian/near-route";
import { GuardianPanel, levelTone } from "./guardian-panel";
import { LogoImage } from "./logo-image";
import { Icon } from "./icons";
import { Pill, TokenAvatar, shortAddress } from "./ui";

const LOGO: Record<NearRouteChain | "near", string> = {
  base: "/networks/catalog/8453-de343bd68771b135.svg",
  eth: "/networks/catalog/1-bd61892db3cff958.svg",
  arb: "/networks/catalog/42161-35cebc7f281a5f68.svg",
  op: "/networks/catalog/10-31521544221c055c.svg",
  pol: "/networks/catalog/137-342be777ec4567ce.svg",
  bsc: "/networks/catalog/56-8a253298c617d227.svg",
  avax: "/networks/catalog/43114-8da7dbe3aa9e897e.svg",
  sol: "/networks/catalog/1151111081099710-26b1c40fab6f6947.svg",
  near: "/assets/chains/chain-catalog-near-4ad2bc4d934eaf2f.png",
};
const ERRORS = [
  "INTENTS_UNAVAILABLE",
  "INTENTS_REJECTED",
  "INTENTS_AUTH_REQUIRED",
  "INTENTS_INVALID",
  "RATE_LIMITED",
  "INVALID_REQUEST",
  "RECIPIENT_BLOCKED",
  "GUARDIAN_UNAVAILABLE",
] as const;
type Signed = Record<string, unknown>;
interface Reviewed {
  verdict: Verdict;
  verification: {
    signature: "VALID" | "INVALID" | "MISSING";
    mismatch?: string[];
  };
}
interface Result extends Reviewed {
  request: IntentsQuoteRequest;
  signed: Signed;
  receipt: NearRouteReceipt;
  origin: IntentsToken;
  destination: IntentsToken & { kind: string };
  /** "live" = fresh from NEAR Intents; "stale" = the preview window ended (the server was asked to re-review). */
  state: "live" | "stale";
  /** Browser time the quote arrived: caps the preview window whatever the clocks say. */
  receivedAt: number;
  /** The server's re-review actually reported the quote as stale (never claimed otherwise). */
  staleConfirmed: boolean;
}

/** Wall-clock time for event handlers and timers (never read during render). */
const clock = () => Date.now();
async function ask<T>(body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch("/api/guardian", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(20000),
  });
  const value = await r.json().catch(() => ({ error: "INTENTS_UNAVAILABLE" }));
  if (!r.ok)
    throw Object.assign(new Error(String(value.error)), { code: value.error });
  return value as T;
}

function ChainMark({ chain }: { chain: NearRouteChain | "near" }) {
  return (
    <span className="near-route-chain-mark" aria-hidden="true">
      <LogoImage src={LOGO[chain]} size={20} />
    </span>
  );
}

export default function NearRoute({
  account,
  walletChain,
  mode,
  onConnect,
}: {
  /** The connected EVM wallet (public address), or "" when none is connected. */
  account: string;
  walletChain?: number;
  mode: "bridge" | "swap";
  onConnect?: () => void;
}) {
  const { t, lang } = useI18n();
  const [chain, setChain] = useState<NearRouteChain>(
    () => nearRouteChainOf(walletChain) ?? "base",
  );
  const origins = nearRouteOrigins(chain);
  const destinations = nearRouteDestinations();
  const [originId, setOriginId] = useState(origins[0].assetId);
  const [destinationId, setDestinationId] = useState<string>();
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [typedSender, setTypedSender] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<Result>();
  // Guardian's review of the NEAR recipient, kept only when it blocked the route before any quote was requested.
  const [recipientBlock, setRecipientBlock] = useState<Verdict>();
  const [now, setNow] = useState(() => Date.now());
  const sequence = useRef(0);
  // The user's own network choice wins; until then a wallet connected later moves the route to its network.
  const chainTouched = useRef(false);
  const origin = origins.find((o) => o.assetId === originId) ?? origins[0];
  // Same kind of asset by default (USDC → USDC on NEAR, USDT → USDT on NEAR, otherwise wNEAR) until the user picks.
  const defaultDestination =
    origin.symbol === "USDC"
      ? destinations[1]
      : /^USDT/.test(origin.symbol)
        ? destinations[2]
        : destinations[0];
  const destination =
    destinations.find((d) => d.assetId === destinationId) ?? defaultDestination;
  const ecosystem = nearRouteEcosystem(chain);
  // A connected EVM wallet is the sender (and refund address) on EVM chains; Solana needs a typed public address.
  const walletSender = ecosystem === "EVM" && account ? account : "";
  const sender = walletSender || typedSender.trim();
  const senderValid = !!sender && validRefundAddress(chain, sender);
  const recipientValid = validNearAccount(recipient.trim());
  let units: bigint | null = null;
  try {
    units = parseUnits(
      normalizeAmountInput(amount.trim(), lang, origin.decimals),
      origin.decimals,
    );
  } catch {}
  const amountValid = units !== null && units > 0n;
  // G13 (VBA-P1-01): "4,995" is refused because it can be read two ways; the hint says so instead of "enter an amount".
  const amountReadings =
    units === null
      ? ambiguousAmountReadings(amount, lang, origin.decimals)
      : null;
  const ready = amountValid && senderValid && recipientValid && !busy;
  const chainName = (c: NearRouteChain | "near") =>
    t(`g12.nr.chain.${c}` as never);
  const walletRouteChain = nearRouteChainOf(walletChain);
  useEffect(() => {
    if (
      chainTouched.current ||
      !walletRouteChain ||
      !account ||
      walletRouteChain === chain
    )
      return;
    const timer = setTimeout(() => {
      setChain(walletRouteChain);
      setOriginId(nearRouteOrigins(walletRouteChain)[0].assetId);
    }, 0);
    return () => clearTimeout(timer);
  }, [walletRouteChain, account, chain]);

  // Any change to the route invalidates the shown quote (it was signed for other inputs).
  const binding = `${chain}|${origin.assetId}|${destination.assetId}|${amount}|${recipient}|${sender}|${lang}`;
  const shownBinding = useRef(binding);
  useEffect(() => {
    if (shownBinding.current === binding) return;
    shownBinding.current = binding;
    sequence.current++;
    const timer = setTimeout(() => {
      setResult(undefined);
      setRecipientBlock(undefined);
      setError("");
      setBusy(false);
    }, 0);
    return () => clearTimeout(timer);
  }, [binding]);
  useEffect(() => {
    if (!result || result.state !== "live") return;
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, [result]);
  const until =
    result && result.receipt.previewUntil !== null
      ? Math.min(
          result.receipt.previewUntil,
          result.receivedAt + MAX_QUOTE_AGE_MS,
        )
      : null;
  const remaining =
    result?.state === "live" && until !== null
      ? Math.max(0, Math.ceil((until - now) / 1000))
      : 0;
  const expired =
    !!result && (result.state === "stale" || until === null || remaining <= 0);
  // Fail closed at expiry: the decision is shown as expired whatever happens next; the server re-reads the signed quote
  // and its review is shown only when it really reports the quote as stale (a skewed clock or a failed request never
  // brings back an earlier "Clear").
  const recheckFor = useRef("");
  useEffect(() => {
    if (!result || result.state !== "live" || !expired) return;
    const key = String(result.signed.signature ?? "") + result.request.amount;
    if (recheckFor.current === key) return;
    recheckFor.current = key;
    const seq = sequence.current;
    ask<Reviewed>({
      action: "intents-verify",
      request: result.request,
      response: result.signed,
      sender: result.request.refundTo,
    })
      .then((r) => {
        if (seq !== sequence.current) return;
        const stale = r.verdict.findings.some((f) => f.code === "ROUTE_STALE");
        setResult((x) =>
          x
            ? stale
              ? { ...x, ...r, state: "stale", staleConfirmed: true }
              : { ...x, state: "stale", staleConfirmed: false }
            : x,
        );
      })
      .catch(() => {
        if (seq === sequence.current)
          setResult((x) =>
            x ? { ...x, state: "stale", staleConfirmed: false } : x,
          );
      });
  }, [result, expired]);

  async function quote() {
    if (!ready || units === null) return;
    const seq = ++sequence.current;
    setBusy(true);
    setError("");
    setResult(undefined);
    setRecipientBlock(undefined);
    try {
      // Guardian reads the recipient first (format, look-alike, lure, on-chain existence): a blocked recipient never
      // reaches the quote provider.
      const check = await ask<{ verdict: Verdict }>({
        action: "address",
        value: recipient.trim(),
      }).catch((e: { code?: string }) => {
        throw Object.assign(new Error(), {
          code: e.code === "RATE_LIMITED" ? e.code : "GUARDIAN_UNAVAILABLE",
        });
      });
      if (seq !== sequence.current) return;
      if (check.verdict.level === "BLOCK") {
        setRecipientBlock(check.verdict);
        throw Object.assign(new Error(), { code: "RECIPIENT_BLOCKED" });
      }
      const request = nearQuoteRequest({
        origin,
        destination,
        amount: units,
        sender,
        recipient,
        now: clock(),
      });
      const r = await ask<Reviewed & { signed: Signed }>({
        action: "intents-quote",
        sender,
        locale: lang,
        request,
      });
      const receipt = nearRouteReceipt(r.signed);
      if (seq !== sequence.current) return;
      if (!receipt)
        throw Object.assign(new Error(), { code: "INTENTS_INVALID" });
      const at = clock();
      setNow(at);
      setResult({
        receivedAt: at,
        staleConfirmed: false,
        verdict: r.verdict,
        verification: r.verification,
        request,
        signed: r.signed,
        receipt,
        origin,
        destination,
        state: "live",
      });
    } catch (e) {
      if (seq !== sequence.current) return;
      const code = (e as { code?: string }).code ?? "";
      setError(
        (ERRORS as readonly string[]).includes(code)
          ? code
          : "INTENTS_UNAVAILABLE",
      );
    } finally {
      if (seq === sequence.current) setBusy(false);
    }
  }

  // Six places reads well; a non-zero amount below that precision is shown in full (never as "0").
  const amountOf = (v: bigint, token: IntentsToken) => {
    const places = Math.min(token.decimals, 6);
    const tiny = v > 0n && v < 10n ** BigInt(token.decimals - places);
    return `${formatTokenAmount(v, token.decimals, lang, tiny ? token.decimals : places)} ${token.symbol}`;
  };
  const receipt = result?.receipt;
  const loss =
    receipt?.amountInUsd && receipt.amountOutUsd !== null
      ? (receipt.amountInUsd - receipt.amountOutUsd) / receipt.amountInUsd
      : null;
  const decision = result ? decisionOf(result.verdict.level) : undefined;
  const levelText = result
    ? t(`guardian.level.${result.verdict.level}` as never)
    : "";
  // A BLOCK is always shown as a BLOCK; any other decision is replaced by "Expired" once the preview window ends.
  const blocked = result?.verdict.level === "BLOCK";
  const showExpired = expired && !blocked;
  // Amounts are shown only for a quote signed for exactly this request (fail closed: units could be another asset's).
  const trusted =
    !!result &&
    result.verification.signature === "VALID" &&
    !result.verification.mismatch?.length &&
    quoteMatchesRequest(result.request, result.signed);
  const titleId = `near-route-title-${mode}`;
  return (
    <section
      className="card bridge-card near-route"
      aria-labelledby={titleId}
      data-testid="near-route"
      data-mode={mode}
    >
      <div className="card-top near-route-top">
        <h2 id={titleId}>
          {t(mode === "swap" ? "g12.nr.swapTitle" : "g12.nr.title")}
        </h2>
        <Pill tone="info">{t("g12.nr.pill")}</Pill>
      </div>
      <p className="near-route-lede">{t("g12.nr.lede")}</p>

      <fieldset className="near-route-side">
        <legend>{t("g12.nr.from")}</legend>
        <div className="near-route-row">
          <label className="field-stack">
            <span>{t("g12.nr.network")}</span>
            <span className="near-route-select">
              <ChainMark chain={chain} />
              <select
                value={chain}
                data-testid="near-route-chain"
                onChange={(e) => {
                  const c = e.target.value as NearRouteChain;
                  chainTouched.current = true;
                  setChain(c);
                  setOriginId(nearRouteOrigins(c)[0].assetId);
                }}
              >
                {NEAR_ROUTE_CHAINS.map((c) => (
                  <option key={c.key} value={c.key}>
                    {chainName(c.key)}
                  </option>
                ))}
              </select>
            </span>
          </label>
          <label className="field-stack">
            <span>{t("g12.nr.token")}</span>
            <span className="near-route-select">
              <TokenAvatar symbol={origin.symbol} size="sm" />
              <select
                value={origin.assetId}
                data-testid="near-route-origin"
                onChange={(e) => setOriginId(e.target.value)}
              >
                {origins.map((o) => (
                  <option key={o.assetId} value={o.assetId}>
                    {o.contractAddress
                      ? `${o.symbol} · ${shortAddress(o.contractAddress)}`
                      : `${o.symbol} · ${t("g12.nr.nativeCoin")}`}
                  </option>
                ))}
              </select>
            </span>
          </label>
        </div>
        <label className="field-stack">
          <span>{t("g12.nr.amount")}</span>
          <span className="near-route-amount">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              inputMode="decimal"
              dir="ltr"
              autoComplete="off"
              placeholder="0.0"
              data-testid="near-route-amount"
              aria-invalid={amount !== "" && !amountValid ? true : undefined}
            />
            <span className="near-route-unit">{origin.symbol}</span>
          </span>
          {amount !== "" && !amountValid && (
            <small className="input-hint" data-testid="near-route-amount-error">
              {amountReadings
                ? t("g13.amount.ambiguous", {
                    amount: amount.trim(),
                    ...amountReadings,
                  })
                : t("g12.nr.amountInvalid")}
            </small>
          )}
        </label>
        {walletSender ? (
          <p className="near-route-sender" data-testid="near-route-sender">
            <Icon name="wallet" size={14} />
            <span>{t("g12.nr.refundConnected")}</span>
            <bdi dir="ltr">{shortAddress(walletSender)}</bdi>
          </p>
        ) : (
          <div className="near-route-refund">
            <label className="field-stack">
              <span>{t("g12.nr.refund", { network: chainName(chain) })}</span>
              <input
                value={typedSender}
                onChange={(e) => setTypedSender(e.target.value)}
                dir="ltr"
                autoComplete="off"
                spellCheck={false}
                data-testid="near-route-refund"
                aria-invalid={
                  typedSender !== "" && !senderValid ? true : undefined
                }
              />
              <small className="input-hint">
                {typedSender !== "" && !senderValid
                  ? t("g12.nr.refundInvalid", { network: chainName(chain) })
                  : t("g12.nr.refundHint")}
              </small>
            </label>
            {ecosystem === "EVM" && onConnect && (
              <button
                type="button"
                className="secondary near-route-connect"
                onClick={onConnect}
              >
                <Icon name="wallet" size={16} />
                {t("g12.nr.connect")}
              </button>
            )}
          </div>
        )}
        {walletRouteChain && walletRouteChain !== chain && walletSender && (
          <p className="input-hint">
            {t("g12.nr.walletChain", { network: chainName(walletRouteChain) })}
          </p>
        )}
      </fieldset>

      <div className="near-route-arrow" role="img" aria-label={t("g12.nr.to")}>
        <Icon name="arrowDown" size={16} />
      </div>

      <fieldset className="near-route-side">
        <legend>
          <ChainMark chain="near" /> {t("g12.nr.to")}
        </legend>
        <div
          className="near-route-targets"
          role="radiogroup"
          aria-label={t("g12.nr.to")}
        >
          {destinations.map((d) => (
            <label
              key={d.assetId}
              className={`near-route-target${d.assetId === destination.assetId ? " is-selected" : ""}`}
            >
              <input
                type="radio"
                name={`near-route-target-${mode}`}
                value={d.assetId}
                checked={d.assetId === destination.assetId}
                onChange={() => setDestinationId(d.assetId)}
              />
              <TokenAvatar symbol={d.symbol} size="sm" />
              <span>
                <strong>{d.symbol}</strong>
                <small>{t(`g12.nr.kind.${d.kind}` as never)}</small>
              </span>
            </label>
          ))}
        </div>
        <label className="field-stack">
          <span>{t("g12.nr.recipient")}</span>
          <input
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            dir="ltr"
            autoComplete="off"
            spellCheck={false}
            placeholder="name.near"
            data-testid="near-route-recipient"
            aria-invalid={
              recipient !== "" && !recipientValid ? true : undefined
            }
          />
          <small className="input-hint">
            {recipient !== "" && !recipientValid
              ? t("g12.nr.recipientInvalid")
              : t("g12.nr.recipientHint")}
          </small>
        </label>
      </fieldset>

      <button
        className="primary near-route-quote"
        disabled={!ready}
        aria-busy={busy || undefined}
        onClick={() => void quote()}
        data-testid="near-route-quote"
      >
        {busy && <Icon name="refresh" size={16} className="spin" />}
        {busy
          ? t("g12.nr.quoting")
          : expired
            ? t("g12.nr.requote")
            : t("g12.nr.quote")}
      </button>
      {!ready && !busy && (
        <p className="input-hint" data-testid="near-route-needs">
          {t("g12.nr.needs")}
        </p>
      )}
      <p className="near-route-privacy">{t("g12.nr.privacy")}</p>
      <p className="sr-only" role="status" data-testid="near-route-announce">
        {result && !busy
          ? t("g12.nr.quoteReady", {
              decision: showExpired ? t("g12.nr.expiredDecision") : levelText,
            })
          : ""}
      </p>
      {error && (
        <p
          className="notice tone-warn"
          role="alert"
          data-testid="near-route-error"
          data-code={error}
        >
          {t(`g12.nr.error.${error}` as never)}
        </p>
      )}
      {recipientBlock && (
        <GuardianPanel
          verdict={recipientBlock}
          compact
          title={t("g12.nr.recipientCheck")}
          testId="near-route-recipient-guardian"
        />
      )}

      {result && receipt && (
        <div
          className={`near-route-result${expired ? " is-expired" : ""}`}
          data-testid="near-route-result"
          data-state={expired ? "expired" : "live"}
        >
          {!trusted && (
            <p
              className="notice tone-danger"
              role="alert"
              data-testid="near-route-untrusted"
            >
              {t("g12.nr.untrusted")}
            </p>
          )}
          <dl className="near-route-receipt">
            {trusted && (
              <>
                <div>
                  <dt>{t("g12.nr.send")}</dt>
                  <dd>
                    <bdi dir="ltr" className="is-amount">
                      {amountOf(receipt.amountIn, result.origin)}
                    </bdi>
                    <small>
                      {chainName(result.origin.blockchain as NearRouteChain)}
                      {receipt.amountInUsd !== null &&
                        ` · ${formatUsd(receipt.amountInUsd, lang)}`}
                    </small>
                  </dd>
                </div>
                <div className="is-key" data-testid="near-route-receive">
                  <dt>{t("g12.nr.receive")}</dt>
                  <dd>
                    <bdi dir="ltr" className="is-amount">
                      {amountOf(receipt.amountOut, result.destination)}
                    </bdi>
                    <small>
                      {chainName("near")}
                      {receipt.amountOutUsd !== null &&
                        ` · ${formatUsd(receipt.amountOutUsd, lang)}`}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>{t("g12.nr.min")}</dt>
                  <dd>
                    <bdi dir="ltr" className="is-amount">
                      {amountOf(receipt.minAmountOut, result.destination)}
                    </bdi>
                  </dd>
                </div>
                <div data-testid="near-route-fees">
                  <dt>{t("g12.nr.fees")}</dt>
                  <dd>
                    <span>
                      {receipt.providerFeeBps !== null
                        ? t("g12.nr.providerFee", {
                            percent: formatPercent(
                              receipt.providerFeeBps / 10000,
                              lang,
                            ),
                          })
                        : t("g12.nr.providerFeeUnknown")}
                    </span>
                    <small>{t("g12.nr.veinedFee")}</small>
                    {loss !== null && (
                      <small data-testid="near-route-value">
                        {loss < 0
                          ? t("g12.nr.valueGain", {
                              percent: formatPercent(-loss, lang),
                            })
                          : t("g12.nr.valueGap", {
                              percent: formatPercent(loss, lang),
                            })}
                      </small>
                    )}
                    <small>{t("g12.nr.feesUnsigned")}</small>
                  </dd>
                </div>
                {receipt.refundFee !== null && (
                  <div>
                    <dt>{t("g12.nr.refundFee")}</dt>
                    <dd>
                      <bdi dir="ltr" className="is-amount">
                        {amountOf(receipt.refundFee, result.origin)}
                      </bdi>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("g12.nr.gas")}</dt>
                  <dd>{t("g12.nr.gasValue")}</dd>
                </div>
              </>
            )}
            <div>
              <dt>{t("g12.nr.recipientRow")}</dt>
              <dd>
                <bdi dir="ltr">{result.request.recipient}</bdi>
              </dd>
            </div>
            {trusted && receipt.timeEstimate !== null && (
              <div>
                <dt>{t("g12.nr.eta")}</dt>
                <dd>
                  {t("g12.nr.etaValue", {
                    seconds: Math.round(receipt.timeEstimate),
                  })}
                </dd>
              </div>
            )}
            <div
              data-testid="near-route-signature"
              data-signature={result.verification.signature}
            >
              <dt>{t("g12.nr.signature")}</dt>
              <dd>
                {t(`g12.nr.sig.${result.verification.signature}` as never)}
              </dd>
            </div>
            {trusted && (
              <div data-testid="near-route-validity">
                <dt>{t("g12.nr.validity")}</dt>
                <dd>
                  {expired
                    ? t("g12.nr.expiredShort")
                    : t("g12.nr.validitySeconds", { seconds: remaining })}
                </dd>
              </div>
            )}
          </dl>
          {expired && (
            <p className="notice tone-warn" data-testid="near-route-expired">
              {t(
                result.staleConfirmed
                  ? "g12.nr.expired"
                  : "g12.nr.expiredPlain",
              )}
            </p>
          )}
          <div className="near-route-decision">
            <p
              className={`near-route-decision-head is-${showExpired ? "warning" : levelTone(result.verdict.level)}`}
              data-testid="near-route-decision"
              data-decision={showExpired ? "EXPIRED" : decision}
            >
              <span>{t("g12.nr.decision")}</span>
              <strong>
                {showExpired ? t("g12.nr.expiredDecision") : levelText}
                {!showExpired && (
                  <code className="near-route-code">{decision}</code>
                )}
              </strong>
            </p>
            <p className="near-route-decision-note">
              {t("g12.nr.decisionNote")}
            </p>
            {/* After expiry only a review that really reports the quote as stale is shown, never an earlier Clear. */}
            {(!expired || result.staleConfirmed || blocked) && (
              <GuardianPanel
                verdict={result.verdict}
                compact
                testId="near-route-guardian"
              />
            )}
          </div>
          <details className="disclosure near-route-tech">
            <summary>{t("g12.nr.details")}</summary>
            <dl>
              <div>
                <dt>{t("g12.nr.detailsOrigin")}</dt>
                <dd>
                  <code>{result.request.originAsset}</code>
                </dd>
              </div>
              <div>
                <dt>{t("g12.nr.detailsDestination")}</dt>
                <dd>
                  <code>{result.request.destinationAsset}</code>
                </dd>
              </div>
              <div>
                <dt>{t("g12.nr.detailsSlippage")}</dt>
                <dd>{formatPercent(NEAR_ROUTE_SLIPPAGE_BPS / 10000, lang)}</dd>
              </div>
              {receipt.issuedAt !== null && (
                <div>
                  <dt>{t("g12.nr.detailsIssued")}</dt>
                  <dd>
                    <bdi dir="ltr">
                      {new Date(receipt.issuedAt).toISOString()}
                    </bdi>
                  </dd>
                </div>
              )}
              <div>
                <dt>{t("g12.nr.detailsDeadline")}</dt>
                <dd>
                  <bdi dir="ltr">{result.request.deadline}</bdi>
                </dd>
              </div>
            </dl>
          </details>
        </div>
      )}

      <div className="near-route-closed" data-testid="near-route-closed">
        <button type="button" className="primary" disabled>
          <Icon name="lock" size={16} />
          {t("g12.nr.closedButton")}
        </button>
        <p className="near-route-closed-note">
          {t(result && !trusted ? "g12.nr.closedPlain" : "g12.nr.closedBody")}
        </p>
      </div>
      <p className="near-route-scope">
        {t("g12.nr.scope", { count: NEAR_ROUTE_CHAINS.length })}
      </p>
    </section>
  );
}
