"use client";
import { PercentButtons } from "./percent-buttons";
import { QuoteEconomicsNotice } from "./quote-economics";
import { swapEconomics } from "../quotes/adapters";
import {
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { parseUnits } from "viem";
import { useI18n } from "../i18n/provider";
import {
  ambiguousAmountReadings,
  formatTokenAmount,
  normalizeAmountInput,
} from "../i18n/amounts";
import type { Asset, Network } from "../routing/model";
import {
  chainHoldings,
  type Holding,
  type PortfolioResult,
} from "../portfolio/model";
import { registryList } from "../assets/client";
import { saveSwapPreview } from "../routing/history";
import {
  canonical,
  identity,
  parseIntent,
  POLICY,
  quoteEligible,
  SOL,
  SwapError,
  wire,
  validIdentity,
  ZERO,
  type ProviderHealth,
  type QuoteEvent,
  type SwapIntent,
  type SwapQuote,
} from "../swap/model";
import { rankQuotes, stickySelection } from "../swap/ranking";
import { streamQuotes } from "../swap/client";
import TokenPicker from "./token-picker";
import { shortAddress } from "./ui";
import { TokenMark } from "./ocean-marks";
import { Icon } from "./icons";
import { modalProps, openModal } from "./dialog";
import type { AssetLevel, RiskFlag } from "../assets/model";
import type { AssetFacts, SwapFacts } from "../guardian/model";
import { review as guardianReview } from "../guardian/verdict";
import { GuardianPanel } from "./guardian-panel";
import { publishGuardianFacts } from "./guardian-context";

export default function SwapIntelligence({
  network,
  account,
  walletEpoch,
  portfolio,
  watchAddress,
  prefill,
  guardianDraft,
  header,
}: {
  network: Network;
  account: string;
  walletEpoch: number;
  portfolio?: PortfolioResult;
  watchAddress?: string;
  prefill?: Holding;
  /** A Guardian chat draft: initial tokens and amount only (no quote is requested until the user asks). */
  guardianDraft?: { from: Asset; to: Asset; amount: string };
  header: ReactNode;
}) {
  const { t, lang } = useI18n(),
    [assets, setAssets] = useState<Asset[]>([network.nativeAsset]),
    [logos, setLogos] = useState<ReadonlyMap<string, string>>(new Map()),
    // Guardian: registry evidence per exact address (level + risk flags), never per symbol.
    [evidence, setEvidence] = useState<
      ReadonlyMap<string, { level: AssetLevel; risk: RiskFlag[] }>
    >(new Map()),
    [from, setFrom] = useState<Asset>(
      prefill ?? guardianDraft?.from ?? network.nativeAsset,
    ),
    [to, setTo] = useState<Asset | undefined>(guardianDraft?.to),
    [amount, setAmount] = useState(guardianDraft?.amount ?? ""),
    [taker, setTaker] = useState(
      validIdentity(account, network.ecosystem === "SVM" ? "SVM" : "EVM")
        ? account
        : watchAddress &&
            validIdentity(
              watchAddress,
              network.ecosystem === "SVM" ? "SVM" : "EVM",
            )
          ? watchAddress
          : "",
    ),
    [recipient, setRecipient] = useState(""),
    [customRecipient, setCustomRecipient] = useState(false),
    [saved, setSaved] = useState(false),
    [manual, setManual] = useState(false),
    [bps, setBps] = useState(50),
    [kind, setKind] = useState<SwapIntent["kind"]>("EXACT_IN"),
    [preference, setPreference] =
      useState<SwapIntent["preference"]>("RECOMMENDED"),
    [picker, setPicker] = useState<"source" | "destination">(),
    [quotes, setQuotes] = useState<SwapQuote[]>([]),
    [selected, setSelected] = useState<SwapQuote>(),
    [health, setHealth] = useState<ProviderHealth[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [now, setNow] = useState(0),
    [intent, setIntent] = useState<SwapIntent>(),
    [review, setReview] = useState<{
      digest: string;
      transactionDigest: string;
      simulation: {
        source: string;
        gasOrCompute: string;
        tokenDeltas?: { networkFee: string };
      };
      decoded: {
        approval?: {
          kind: string;
          spender: string | null;
          amount: string;
          tokenApprovalSpender?: string | null;
        };
        router?: string;
        instructions?: { program: string }[];
        economics?: {
          rentMaximum: string;
          priorityFeeMaximum: string;
          tips: string;
        };
      };
    }>(),
    [reviewBusy, setReviewBusy] = useState(false),
    // A prefilled watch address (from Portfolio) keeps the read-only address open; otherwise it waits behind a line.
    [readOpen, setReadOpen] = useState(taker !== "");
  const abort = useRef<AbortController | null>(null),
    reviewAbort = useRef<AbortController | null>(null),
    refreshActive = useRef(false),
    refreshDue = useRef(0),
    quoteIntents = useRef(new Map<string, SwapIntent>()),
    sequence = useRef(0),
    dialog = useRef<HTMLDialogElement>(null);
  const text = (key: string) => t(`v115.${key}` as never);
  const chain = network.ecosystem === "SVM" ? "solana" : network.id;
  const compatibleAccount = validIdentity(
    account,
    network.ecosystem === "SVM" ? "SVM" : "EVM",
  )
    ? account
    : "";
  const supported = ["1", "56", "8453", "solana"].includes(chain);
  const matchingPortfolio =
    watchAddress &&
    identity(watchAddress) === identity(compatibleAccount || taker)
      ? portfolio
      : undefined;
  const held = chainHoldings(matchingPortfolio, network.id),
    balance = held.find((h) => identity(h.address) === identity(from.address));
  const binding = canonical({
    chain,
    from,
    to,
    amount,
    taker: compatibleAccount || taker,
    recipient,
    manual,
    bps,
    kind,
    walletEpoch,
    portfolio: matchingPortfolio?.revision,
  });
  useEffect(() => {
    const c = new AbortController();
    registryList(network.id, c.signal)
      .then((list) => {
        setLogos(
          new Map(
            list
              .filter((a) => a.logoUrl)
              .map((a) => [identity(a.address), a.logoUrl!] as const),
          ),
        );
        setEvidence(
          (known) =>
            new Map([
              ...known,
              ...list.map(
                (a) =>
                  [
                    identity(a.address),
                    { level: a.level, risk: a.risk },
                  ] as const,
              ),
            ]),
        );
        setAssets([
          network.nativeAsset,
          ...list
            .filter((a) => a.level !== "BLOCKED")
            .map((a) => ({
              chainId: network.id,
              address: a.address,
              symbol: a.symbol,
              name: a.name,
              decimals: a.decimals,
            })),
        ]);
      })
      .catch(() => {});
    return () => c.abort();
  }, [network]);
  const [previousBinding, setPreviousBinding] = useState(binding);
  if (previousBinding !== binding) {
    setPreviousBinding(binding);
    setQuotes([]);
    setSelected(undefined);
    setIntent(undefined);
    setReview(undefined);
    setSaved(false);
    setHealth([]);
    setBusy(false);
    setReviewBusy(false);
    setError("");
  }
  useEffect(() => {
    sequence.current++;
    abort.current?.abort();
    reviewAbort.current?.abort();
    refreshActive.current = false;
    quoteIntents.current.clear();
    dialog.current?.close();
    return () => {
      abort.current?.abort();
      reviewAbort.current?.abort();
    };
  }, [binding]);
  const refreshTick = useEffectEvent(() => {
    const at = Date.now();
    setNow(at);
    if (selected && selected.expiresAt <= at && review) {
      setReview(undefined);
      reviewAbort.current?.abort();
      dialog.current?.close();
    }
    if (
      refreshActive.current &&
      !busy &&
      document.visibilityState === "visible" &&
      at >= refreshDue.current
    )
      void quote(true);
  });
  const visibilityChange = useEffectEvent(() => {
    if (document.visibilityState !== "visible") {
      sequence.current++;
      abort.current?.abort();
      setBusy(false);
      reviewAbort.current?.abort();
      setReviewBusy(false);
    } else if (refreshActive.current && !busy) void quote(true);
  });
  useEffect(() => {
    const timer = setInterval(refreshTick, 500);
    const onVisibility = () => visibilityChange();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);
  const ranked = useMemo(
    () =>
      intent
        ? rankQuotes(quotes, { ...intent, preference }, now)
        : { quotes: [], basis: "RAW_OUTPUT", checkedProviders: 0 },
    [quotes, intent, preference, now],
  );
  const selection = stickySelection(selected, ranked.quotes),
    q = selection.selected;
  const fresh = !!q && quoteEligible(q, now),
    amountOf = (n: bigint, a: Asset) => formatTokenAmount(n, a.decimals, lang);
  const costDescription = (c: SwapQuote["costs"][number]) => {
    const simulatedNetworkFee =
      q?.ecosystem === "SVM" && c.kind === "NETWORK"
        ? review?.simulation.tokenDeltas?.networkFee
        : undefined;
    const amount =
      simulatedNetworkFee && /^\d{1,32}$/.test(simulatedNetworkFee)
        ? BigInt(simulatedNetworkFee)
        : c.amount;
    const label =
      c.kind === "PLATFORM"
        ? t("v13.platformFee")
        : c.kind === "NETWORK"
          ? text("networkFee")
          : c.kind === "PROTOCOL"
            ? t("v111.protocol")
            : c.kind === "PROVIDER"
              ? q?.provider
              : text(
                  c.kind === "PRIORITY"
                    ? "priorityFee"
                    : c.kind === "RENT"
                      ? "accountRent"
                      : "tip",
                );
    const asset =
      c.token === "native" ||
      [ZERO, SOL, network.nativeAsset.address].some(
        (v) => identity(v) === identity(c.token),
      )
        ? network.nativeAsset
        : identity(c.token) === identity(from.address)
          ? from
          : to && identity(c.token) === identity(to.address)
            ? to
            : undefined;
    return `${label}: ${amount === null || !asset ? t("ui.unknown") : `${amountOf(amount, asset)} ${asset.symbol}`}`;
  };
  async function quote(refresh = false) {
    const c = new AbortController(),
      seq = ++sequence.current;
    abort.current?.abort();
    abort.current = c;
    setBusy(true);
    setError("");
    if (!refresh) {
      setReview(undefined);
      setQuotes([]);
      setSelected(undefined);
      reviewAbort.current?.abort();
    }
    setNow(Date.now());
    try {
      if (!to) throw new SwapError("INVALID_REQUEST");
      const token = (a: Asset) => ({
        chain,
        address:
          identity(a.address) === identity(network.nativeAsset.address)
            ? chain === "solana"
              ? SOL
              : ZERO
            : a.address,
        decimals: a.decimals,
        symbol: a.symbol,
        native: identity(a.address) === identity(network.nativeAsset.address),
      });
      const decimals = kind === "EXACT_IN" ? from.decimals : to.decimals;
      let normalizedAmount: string;
      try {
        normalizedAmount = normalizeAmountInput(amount, lang, decimals);
      } catch {
        throw new SwapError("INVALID_REQUEST");
      }
      const i =
        refresh && intent && intent.expiresAt > Date.now() + 30000
          ? intent
          : parseIntent({
              ecosystem: network.ecosystem,
              chain,
              taker: compatibleAccount || taker,
              recipient: recipient || compatibleAccount || taker,
              tokenIn: token(from),
              tokenOut: token(to),
              kind,
              amount: parseUnits(normalizedAmount, decimals),
              slippage: {
                mode: manual ? "MANUAL" : "AUTO",
                bps: manual ? bps : 50,
              },
              preference,
              walletEpoch,
              portfolioRevision: matchingPortfolio?.revision ?? "none",
              expiresAt: Date.now() + 120000,
            });
      setIntent(i);
      refreshActive.current = true;
      refreshDue.current = Date.now() + 15000;
      let buffer: QuoteEvent[] = [],
        timer: ReturnType<typeof setTimeout> | undefined;
      const flush = () => {
        timer = undefined;
        if (c.signal.aborted || seq !== sequence.current) return;
        const events = buffer;
        buffer = [];
        for (const e of events) {
          if (e.type === "providers") setHealth(e.providers);
          if (e.type === "health")
            setHealth((h) =>
              h.map((p) => (p.mode === e.health.mode ? e.health : p)),
            );
          if (e.type === "quote") {
            quoteIntents.current.set(e.quote.id, i);
            while (quoteIntents.current.size > 128)
              quoteIntents.current.delete(
                quoteIntents.current.keys().next().value!,
              );
            refreshDue.current = Math.min(
              refreshDue.current,
              Math.max(Date.now() + 4000, e.quote.expiresAt - 5000),
            );
            setQuotes((all) => [
              ...all.filter(
                (p) =>
                  !(
                    p.id !== selected?.id &&
                    p.mode === e.quote.mode &&
                    canonical(p.route) === canonical(e.quote.route)
                  ),
              ),
              e.quote,
            ]);
          }
        }
      };
      try {
        await streamQuotes(i, c.signal, (e) => {
          buffer.push(e);
          timer ??= setTimeout(flush, POLICY.coalesceMs);
        });
      } finally {
        if (timer) clearTimeout(timer);
        flush();
      }
    } catch (e) {
      if (!c.signal.aborted && seq === sequence.current)
        setError(e instanceof SwapError ? e.code : "PROVIDER_UNAVAILABLE");
    } finally {
      if (!c.signal.aborted && seq === sequence.current) {
        setBusy(false);
        refreshDue.current = Math.max(refreshDue.current, Date.now() + 4000);
      }
    }
  }
  async function inspect() {
    // Event handler only: re-check wall-clock expiry at the user's review click.
    if (!q || !quoteIntents.current.has(q.id) || !quoteEligible(q, Date.now()))
      return;
    setSelected(q);
    setSaved(false);
    setReviewBusy(true);
    setError("");
    const boundIntent = quoteIntents.current.get(q.id)!;
    reviewAbort.current?.abort();
    const c = new AbortController();
    reviewAbort.current = c;
    try {
      const r = await fetch("/api/swap", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: wire({ action: "review", id: q.id, intent: boundIntent }),
        signal: c.signal,
      });
      const value = await r.json();
      if (c.signal.aborted) return;
      if (!r.ok) {
        setError(value.error ?? "BUILD_REVIEW_REQUIRED");
        return;
      }
      if (
        value.state !== "EXECUTION_CLOSED" ||
        value.quote?.id !== q.id ||
        !value.verifiedForReview ||
        // The HTTP response is checked inside this event handler, never during render.
        value.expiresAt <= Date.now()
      ) {
        setError("REVIEW_REQUIRED");
        return;
      }
      setReview(value);
      openModal(dialog.current);
    } catch {
      if (!c.signal.aborted) setError("PROVIDER_UNAVAILABLE");
    } finally {
      if (!c.signal.aborted) setReviewBusy(false);
    }
  }
  // Presentation only: the visible quote summary repeats values the route details already show (minimum received,
  // impact, network fee, slippage) so they are readable before review. No value is computed here.
  const highImpact = quotes.some(
    (candidate) =>
      candidate.priceImpactBps !== null &&
      Math.abs(candidate.priceImpactBps) >= POLICY.maxImpactBps,
  );
  const networkCosts = q
    ? q.costs
        .filter((c) => ["NETWORK", "PRIORITY", "RENT", "TIP"].includes(c.kind))
        .map(costDescription)
        .join(" · ")
    : "";
  const routeOptions = ranked.quotes
    .filter(
      (option, index, all) =>
        option.id === selected?.id ||
        (!all.some(
          (candidate) =>
            candidate.mode === option.mode && candidate.id === selected?.id,
        ) &&
          all.findIndex((candidate) => candidate.mode === option.mode) ===
            index),
    )
    .slice(0, 8);
  const heldChips = held
    .filter(
      (h) =>
        !h.suspicious &&
        h.metadataVerified !== false &&
        h.routable !== false &&
        BigInt(h.balance) > 0n,
    )
    .slice(0, 6);
  // Guardian: the same deterministic review before and inside the review dialog (the decoded approval joins it there).
  const assetFacts = (a: Asset): AssetFacts => {
    const native =
      identity(a.address) === identity(network.nativeAsset.address);
    const e = evidence.get(identity(a.address));
    return {
      chainId: network.id,
      address: a.address,
      symbol: a.symbol,
      native,
      level: native ? "CANONICAL" : e?.level,
      risk: native ? [] : (e?.risk ?? []),
    };
  };
  const party = compatibleAccount || taker;
  const guardianFacts: SwapFacts | undefined =
    q && to
      ? {
          kind: "swap",
          chainId: network.id,
          ecosystem: network.ecosystem === "SVM" ? "SVM" : "EVM",
          sender: party,
          recipient: intent?.recipient ?? (recipient || party),
          pay: assetFacts(from),
          receive: assetFacts(to),
          quote: {
            provider: q.provider,
            priceImpactBps: q.priceImpactBps,
            slippageBps: q.slippageBps,
            hops: q.hops,
            splitCount: q.splitCount,
            amountOut: q.amountOut.toString(),
            minAmountOut: q.minAmountOut.toString(),
            inputUsdMicros: q.inputUsdMicros?.toString() ?? null,
            outputUsdMicros: q.outputUsdMicros?.toString() ?? null,
            quotedAt: q.quotedAt,
            expiresAt: q.expiresAt,
            // VEINED's own fee as quoted (policy: 0); Guardian blocks any other value.
            platformFee:
              q.costs.find((c) => c.kind === "PLATFORM")?.amount?.toString() ??
              "0",
          },
          alternatives: ranked.quotes
            .filter((o) => o.id !== q.id && o.mode !== q.mode)
            .map((o) => o.amountOut.toString()),
          known: [party, watchAddress ?? ""].filter(Boolean),
        }
      : undefined;
  const guardian = guardianFacts
    ? guardianReview(guardianFacts, now)
    : undefined;
  const reviewedGuardian =
    guardianFacts && review?.decoded.approval
      ? guardianReview(
          {
            ...guardianFacts,
            approval: {
              kind: review.decoded.approval.kind,
              spender: review.decoded.approval.spender,
              amount: review.decoded.approval.amount,
            },
          },
          now,
        )
      : guardian;
  const guardianBlocked = guardian?.level === "BLOCK";
  // Guardian assistant context: only what this screen already shows (the selected quote and Guardian's verdict).
  const assistantContext = JSON.stringify({
    network: network.name,
    chain:
      network.id === "1"
        ? "ethereum"
        : network.id === "8453"
          ? "base"
          : network.id === "56"
            ? "bsc"
            : null,
    pay: {
      symbol: from.symbol,
      address: from.address,
      native: identity(from.address) === identity(network.nativeAsset.address),
    },
    receive: to && {
      symbol: to.symbol,
      address: to.address,
      native: identity(to.address) === identity(network.nativeAsset.address),
    },
    quote: q &&
      to && {
        provider: q.provider,
        minOut: `${amountOf(q.minAmountOut, to)} ${to.symbol}`,
        impact: q.priceImpactBps === null ? null : `${q.priceImpactBps / 100}%`,
        expiresAt: q.expiresAt,
        count: ranked.quotes.length,
        // gf1 G04: the network-fee value as the quote card shows it (without its label; the assistant adds its own).
        fee: networkCosts
          ? networkCosts.replaceAll(`${text("networkFee")}: `, "")
          : null,
      },
    verdict: guardian,
  });
  useEffect(() => {
    publishGuardianFacts("swap", JSON.parse(assistantContext));
  }, [assistantContext]);
  useEffect(() => () => publishGuardianFacts("swap", undefined), []);
  // One mark per token: the network's own logo for its native asset, the reviewed registry logo, or a medallion.
  const markOf = (a: Asset, size: "xs" | "sm" | "md" = "md") => (
    <TokenMark
      symbol={a.symbol}
      seed={a.address}
      size={size}
      logo={
        identity(a.address) === identity(network.nativeAsset.address)
          ? network.theme.logo
          : logos.get(identity(a.address))
      }
    />
  );
  const compareButton = (
    <button
      className={quotes.length ? "secondary compare-again" : "primary"}
      disabled={busy || !supported || !to || !amount}
      aria-busy={busy || undefined}
      onClick={() => void quote()}
    >
      {busy && <Icon name="refresh" size={16} className="spin" />}
      {busy ? t("ui.loading") : text("compare")}
    </button>
  );
  return (
    <div
      className={`bridge-grid trade-grid swap-layout${quotes.length ? "" : " is-unquoted"}`}
    >
      <section
        className="card bridge-card swap-card"
        data-testid="swap-intelligence"
      >
        {header}
        <div className="swap-legs">
          {(["source", "destination"] as const).map((side) => {
            const a = side === "source" ? from : to;
            const editable =
              kind === "EXACT_IN" ? side === "source" : side === "destination";
            return (
              <div
                className={`trade-amount-box is-${side}${editable ? " is-editable" : ""}`}
                key={side}
              >
                <div className="trade-amount-head">
                  <label htmlFor={editable ? "meta-amount" : "meta-receive"}>
                    {side === "source" ? text("pay") : text("receive")}
                  </label>
                  {side === "source" && (
                    <small>
                      {t("product.balance")}:{" "}
                      <bdi dir="ltr">
                        {balance
                          ? amountOf(BigInt(balance.balance), from)
                          : "—"}
                      </bdi>
                    </small>
                  )}
                </div>
                <div className="amount-row">
                  {editable ? (
                    <input
                      id="meta-amount"
                      inputMode="decimal"
                      autoComplete="off"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      placeholder="0.00"
                    />
                  ) : (
                    <output
                      id="meta-receive"
                      className={q && a ? "has-value" : undefined}
                    >
                      {q && a
                        ? amountOf(
                            side === "source" ? q.amountIn : q.amountOut,
                            a,
                          )
                        : "—"}
                    </output>
                  )}
                  <button
                    className={`token-select-trigger${a ? "" : " is-empty"}`}
                    aria-label={
                      side === "source"
                        ? t("ui.sourceToken")
                        : t("ui.destinationToken")
                    }
                    aria-haspopup="dialog"
                    onClick={() => setPicker(side)}
                  >
                    {a && markOf(a)}
                    <strong>{a?.symbol ?? text("chooseToken")}</strong>
                    <Icon name="chevronDown" size={14} />
                  </button>
                </div>
              </div>
            );
          })}
          <button
            className="secondary swap-reverse"
            aria-label={text("reverse")}
            onClick={() => {
              if (to) {
                setFrom(to);
                setTo(from);
              }
            }}
          >
            <Icon name="swap" size={18} />
          </button>
        </div>
        {/* G12 H04: a share of the READ balance of the token being paid (shown when the paid amount is typed). Under
            the two amount boxes, so their accepted geometry is unchanged. */}
        {kind === "EXACT_IN" && (
          <PercentButtons
            balance={
              matchingPortfolio?.holdings.find(
                (h) =>
                  h.chainId === network.id &&
                  !h.spam &&
                  h.decimals === from.decimals &&
                  identity(h.address) === identity(from.address),
              )?.balance
            }
            decimals={from.decimals}
            native={
              identity(from.address) === identity(network.nativeAsset.address)
            }
            // A swap quote's network cost is not the whole cost of sending (priority, rent, the amount that
            // must stay for the account): the fee is unknown here, so a native coin's 100% is never offered.
            networkFee={null}
            feeFromRoute={false}
            scannedFor={portfolio ? watchAddress : undefined}
            matchesSender={!!matchingPortfolio}
            readAt={matchingPortfolio?.observedAt}
            now={now}
            onPick={setAmount}
            testId="percent-swap"
          />
        )}
        {heldChips.length > 0 && (
          <div
            className="held-chips"
            role="group"
            aria-label={t("v111.yourTokens")}
          >
            {heldChips.map((h) => (
              <button
                key={h.address}
                type="button"
                aria-pressed={identity(h.address) === identity(from.address)}
                onClick={() => setFrom(h)}
              >
                {markOf(h, "xs")}
                {h.symbol}
              </button>
            ))}
          </div>
        )}
        {/* G12 H04: no licensed price history is connected, so no chart is drawn (never one made from single prices). */}
        <p className="micro chart-unavailable" data-testid="chart-unavailable">
          {t("g12.ch.unavailable")}
        </p>
        {compatibleAccount && (
          <div className="trade-parties">
            <p>
              <span>{t("v111.connectedWallet")}:</span>{" "}
              <bdi>{shortAddress(compatibleAccount)}</bdi>
            </p>
            <p>
              <span>{t("v111.recipient")}:</span>{" "}
              {recipient ? (
                <bdi>{shortAddress(recipient)}</bdi>
              ) : (
                t("v111.sameWallet")
              )}
            </p>
          </div>
        )}
        {!compatibleAccount && (
          <details
            className="swap-read-disclosure"
            open={readOpen}
            onToggle={(e) => setReadOpen(e.currentTarget.open)}
          >
            <summary>
              <Icon name="search" size={14} />
              {taker && readOpen === false ? (
                <bdi dir="ltr">{shortAddress(taker)}</bdi>
              ) : (
                t("ux5.previewAddress")
              )}
            </summary>
            <label className="swap-read-address">
              {/* The summary line already says what this is for; the field keeps its full accessible name. */}
              <span className="sr-only">{text("readAddress")}</span>
              <input
                value={taker}
                onChange={(e) => setTaker(e.target.value)}
                dir="ltr"
                autoComplete="off"
                placeholder={network.ecosystem === "SVM" ? undefined : "0x…"}
              />
            </label>
          </details>
        )}
        <details className="disclosure trade-settings-disclosure">
          <summary>
            <Icon name="sliders" size={15} />
            {t("ui.slippage")}: {manual ? `${bps / 100}%` : text("auto")}
          </summary>
          <div className="disclosure-body">
            <label className="toggle">
              <input
                type="checkbox"
                checked={manual}
                onChange={(e) => setManual(e.target.checked)}
              />
              {text("manual")}
            </label>
            {manual && (
              <label className="field-stack">
                {t("ui.slippage")} %
                <input
                  type="number"
                  min="0.01"
                  max="3"
                  step="0.01"
                  value={bps / 100}
                  onChange={(e) =>
                    setBps(Math.round(Number(e.target.value) * 100))
                  }
                />
              </label>
            )}
            <label className="toggle">
              <input
                type="checkbox"
                checked={customRecipient}
                onChange={(e) => {
                  setCustomRecipient(e.target.checked);
                  setRecipient("");
                }}
              />
              {t("v111.sendToAnother")}
            </label>
            {customRecipient && (
              <label className="field-stack">
                {text("recipient")}
                <input
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder={account || taker}
                  dir="ltr"
                />
              </label>
            )}
            {recipient && recipient !== (compatibleAccount || taker) && (
              <p className="notice tone-warn">{t("v111.recipientDiffers")}</p>
            )}
            <label className="field-stack">
              {text("amountMode")}
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as SwapIntent["kind"])}
              >
                <option value="EXACT_IN">{text("exactIn")}</option>
                <option value="EXACT_OUT">{text("exactOut")}</option>
              </select>
            </label>
          </div>
        </details>
        {!quotes.length && compareButton}
        {!supported && (
          <p role="status" className="notice tone-warn">
            {text("unsupported")}
          </p>
        )}
        {!to || !amount ? (
          <p className="trade-hint">{t("v110.needAmount")}</p>
        ) : null}
        {highImpact && (
          <p role="alert" className="notice tone-danger">
            {text("HIGH_PRICE_IMPACT")}
          </p>
        )}
        {quotes.length > 0 && (
          <div className="swap-quotes">
            <div className="swap-quotes-head">
              <label className="field-inline">
                {text("rank")}
                <select
                  value={preference}
                  onChange={(e) =>
                    setPreference(e.target.value as SwapIntent["preference"])
                  }
                >
                  {(
                    ["RECOMMENDED", "OUTPUT", "FASTEST", "DIRECT"] as const
                  ).map((p) => (
                    <option key={p} value={p}>
                      {text(p)}
                    </option>
                  ))}
                </select>
              </label>
              {compareButton}
            </div>
            <p className="micro swap-checked">
              {t("v115.checked", { count: ranked.checkedProviders })} ·{" "}
              {ranked.basis === "BEST_NET_VALUE" ? text("net") : text("output")}
            </p>
            <div className="meta-quote-options">
              {routeOptions.map((option, index) => (
                <button
                  className="secondary route-choice"
                  key={option.id}
                  aria-pressed={q?.id === option.id}
                  onClick={() => {
                    setSelected(option);
                    setReview(undefined);
                  }}
                >
                  <span className="route-choice-main">
                    <span className="route-choice-name">
                      {option.provider} ·{" "}
                      {option.route
                        .map((r) => r.poolType)
                        .filter((v, n, a) => a.indexOf(v) === n)
                        .join(" + ")}
                    </span>
                    {index === 0 && (
                      <span className="route-choice-rank">
                        {text(preference)}
                      </span>
                    )}
                  </span>
                  <strong className="route-choice-out">
                    <bdi dir="ltr">
                      {to ? amountOf(option.amountOut, to) : ""} {to?.symbol}
                    </bdi>
                  </strong>
                </button>
              ))}
            </div>
          </div>
        )}
        {selection.better && (
          <p role="status" className="notice tone-info swap-better">
            {text("better")}
          </p>
        )}
        {q && (
          <>
            {to && (
              <dl className="swap-facts">
                <div>
                  <dt>{text("minimum")}</dt>
                  <dd>
                    <bdi dir="ltr">
                      {amountOf(q.minAmountOut, to)} {to.symbol}
                    </bdi>
                  </dd>
                </div>
                <div>
                  <dt>{text("impact")}</dt>
                  <dd
                    className={
                      q.priceImpactBps === null ? "is-unknown" : undefined
                    }
                  >
                    {q.priceImpactBps === null
                      ? t("ui.unknown")
                      : `${q.priceImpactBps / 100}%`}
                  </dd>
                </div>
                <div>
                  <dt>{t("v13.platformFee")}</dt>
                  <dd>0%</dd>
                </div>
                <div className="is-wide">
                  <dt>{text("networkFee")}</dt>
                  <dd className={networkCosts ? undefined : "is-unknown"}>
                    {networkCosts
                      ? networkCosts.replaceAll(`${text("networkFee")}: `, "")
                      : t("ui.unknown")}
                  </dd>
                </div>
              </dl>
            )}
            <details className="disclosure">
              <summary>{t("v111.routeDetails")}</summary>
              <div className="disclosure-body">
                <dl className="quote-summary">
                  <div>
                    <dt>{text("minimum")}</dt>
                    <dd>
                      {to ? amountOf(q.minAmountOut, to) : ""} {to?.symbol}
                    </dd>
                  </div>
                  <div>
                    <dt>{text("route")}</dt>
                    <dd>
                      {q.route
                        .map((l) => `${l.venue} · ${l.poolType}`)
                        .join(" → ")}
                    </dd>
                  </div>
                  <div>
                    <dt>{text("impact")}</dt>
                    <dd>
                      {q.priceImpactBps === null
                        ? t("ui.unknown")
                        : `${q.priceImpactBps / 100}%`}
                    </dd>
                  </div>
                  <div>
                    <dt>{text("freshness")}</dt>
                    <dd>
                      {Math.max(0, Math.floor((now - q.quotedAt) / 1000))} s ·{" "}
                      {q.sourceBlock ?? "—"}
                    </dd>
                  </div>
                  <div>
                    <dt>{text("networkFee")}</dt>
                    <dd>{networkCosts || t("ui.unknown")}</dd>
                  </div>
                  <div>
                    <dt>{t("ui.slippage")}</dt>
                    <dd>{q.slippageBps / 100}%</dd>
                  </div>
                  <div>
                    <dt>{text("simulation")}</dt>
                    <dd>{review ? text("passed") : text("notRun")}</dd>
                  </div>
                </dl>
                <p>
                  {q.hops} {text("hops")} · {q.splitCount} {text("splits")}
                </p>
                <p>
                  {text("fees")}:{" "}
                  {q.costs
                    .map((c) => {
                      const label =
                        c.kind === "PLATFORM"
                          ? t("v13.platformFee")
                          : c.kind === "NETWORK"
                            ? t("ui.networkFee")
                            : c.kind === "PROTOCOL"
                              ? t("v111.protocol")
                              : c.kind === "PROVIDER"
                                ? q.provider
                                : text(
                                    c.kind === "PRIORITY"
                                      ? "priorityFee"
                                      : c.kind === "RENT"
                                        ? "accountRent"
                                        : "tip",
                                  );
                      const asset =
                        identity(c.token) === identity(from.address)
                          ? from
                          : to && identity(c.token) === identity(to.address)
                            ? to
                            : c.token === "native"
                              ? network.nativeAsset
                              : undefined;
                      return `${label}: ${c.amount === null || !asset ? t("ui.unknown") : `${amountOf(c.amount, asset)} ${asset.symbol}`}`;
                    })
                    .join(" · ")}
                </p>
              </div>
            </details>
            {to && (
              <QuoteEconomicsNotice
                economics={swapEconomics(q, from.decimals, to.decimals)}
                testId="quote-economics-swap"
              />
            )}
            {guardian && (
              <GuardianPanel
                verdict={guardian}
                compact
                testId="guardian-swap"
              />
            )}
            {guardianBlocked && (
              <p className="notice tone-danger guardian-block-note">
                {t("guardian.blockedRoute")}
              </p>
            )}
            <button
              className="primary"
              disabled={
                !fresh ||
                reviewBusy ||
                q.build !== "UNSIGNED_BUILD" ||
                guardianBlocked
              }
              aria-busy={reviewBusy || undefined}
              onClick={inspect}
            >
              {reviewBusy && <Icon name="refresh" size={16} className="spin" />}
              {reviewBusy ? t("ui.loading") : text("review")}
            </button>
            {!fresh && (
              <p role="status" className="notice tone-warn">
                {text("QUOTE_STALE")}
              </p>
            )}
          </>
        )}
        {error && (
          <p role="alert" className="notice tone-danger">
            {/* The server runs Guardian too: a review it refuses reads as Guardian's block, never a provider error. */}
            {error === "GUARDIAN_BLOCKED"
              ? t("guardian.blockedRoute")
              : (() => {
                  // G13 (VBA-P1-01): an amount refused only because it reads two ways names both spellings.
                  const readings =
                    error === "INVALID_REQUEST"
                      ? ambiguousAmountReadings(
                          amount,
                          lang,
                          kind === "EXACT_IN"
                            ? from.decimals
                            : (to?.decimals ?? 0),
                        )
                      : null;
                  return readings
                    ? t("g13.amount.ambiguous", {
                        amount: amount.trim(),
                        ...readings,
                      })
                    : text(error);
                })()}
          </p>
        )}
        <p className="execution-status" title={t("landing.statusNote")}>
          <Icon name="lock" size={14} />
          {text("closed")}
        </p>
        {health.length > 0 && (
          <details className="disclosure provider-health">
            <summary>{text("availability")}</summary>
            <ul>
              {health.map((p) => (
                <li key={p.mode}>
                  <span>{p.mode}</span>
                  <span>
                    {p.status === "OK"
                      ? text("passed")
                      : p.status === "PENDING"
                        ? t("ui.loading")
                        : text(p.status)}{" "}
                    {p.latencyMs !== null ? `${p.latencyMs} ms` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </details>
        )}
        <dialog
          ref={dialog}
          className="review-dialog swap-review"
          aria-labelledby="meta-review-title"
          {...modalProps(() => setReview(undefined))}
        >
          <div className="dialog-top">
            <h2 id="meta-review-title">{text("review")}</h2>
            <button
              className="icon-button"
              aria-label={t("ui.close")}
              onClick={() => dialog.current?.close()}
            >
              <Icon name="close" />
            </button>
          </div>
          {review && q && to && (
            <>
              <div className="review-amounts">
                <p>
                  <span className="review-leg-label">{text("pay")}</span>
                  <strong>
                    {markOf(from, "sm")}
                    <bdi dir="ltr">
                      {amountOf(q.amountIn, from)} {from.symbol}
                    </bdi>
                  </strong>
                </p>
                <span className="review-amounts-arrow" aria-hidden="true">
                  <Icon name="arrowDown" size={16} />
                </span>
                <p>
                  <span className="review-leg-label">{text("receive")}</span>
                  <strong>
                    {markOf(to, "sm")}
                    <bdi dir="ltr">
                      {amountOf(q.amountOut, to)} {to.symbol}
                    </bdi>
                  </strong>
                </p>
              </div>
              <p
                role="status"
                className={`review-closed${fresh ? "" : " is-stale"}`}
              >
                <Icon name="lock" size={16} />
                {fresh ? text("verifiedClosed") : text("QUOTE_STALE")}
              </p>
              <div className="review-facts">
                <p className="review-fact is-key">
                  <span>{text("minimum")}:</span>{" "}
                  <strong>
                    {amountOf(q.minAmountOut, to)} {to.symbol}
                  </strong>
                </p>
                <p className="review-fact">
                  <span>{t("ui.slippage")}:</span>{" "}
                  <strong>{q.slippageBps / 100}%</strong>
                </p>
                <p className="review-fact">
                  <span>{text("impact")}:</span>{" "}
                  <strong
                    className={
                      q.priceImpactBps === null ? "is-unknown" : undefined
                    }
                  >
                    {q.priceImpactBps === null
                      ? t("ui.unknown")
                      : `${q.priceImpactBps / 100}%`}
                  </strong>
                </p>
                <p className="review-fact">
                  <span>{text("route")}:</span>{" "}
                  <strong>
                    {q.provider} ·{" "}
                    {q.route.map((l) => `${l.venue} ${l.poolType}`).join(" → ")}{" "}
                    · {q.hops} {text("hops")} · {q.splitCount} {text("splits")}
                  </strong>
                </p>
                <p className="review-fact">
                  <span>{text("recipient")}:</span>{" "}
                  <bdi className="review-address">{intent?.recipient}</bdi>
                </p>
                <p className="review-fact">
                  <span>{text("freshness")}:</span>{" "}
                  <strong>
                    {Math.max(0, Math.floor((now - q.quotedAt) / 1000))} s ·{" "}
                    {q.sourceBlock ?? "—"}
                  </strong>
                </p>
                <p className="review-fact">
                  <span>{text("fees")}:</span>{" "}
                  <strong className="review-fees">
                    {q.costs.map((c, index) => (
                      <span className="review-fee" key={`${c.kind}:${index}`}>
                        {index > 0 && (
                          <span className="review-fee-sep"> · </span>
                        )}
                        {costDescription(c)}
                      </span>
                    ))}
                  </strong>
                </p>
                {q.ecosystem === "SVM" && review.decoded.economics && (
                  <p className="review-fact">
                    <span>{text("accountRent")}:</span>{" "}
                    <strong>
                      ≤{" "}
                      {amountOf(
                        BigInt(review.decoded.economics.rentMaximum),
                        network.nativeAsset,
                      )}{" "}
                      {network.nativeAsset.symbol} · {text("priorityFee")}: ≤{" "}
                      {amountOf(
                        BigInt(review.decoded.economics.priorityFeeMaximum),
                        network.nativeAsset,
                      )}{" "}
                      {network.nativeAsset.symbol} · {text("tip")}:{" "}
                      {amountOf(
                        BigInt(review.decoded.economics.tips),
                        network.nativeAsset,
                      )}{" "}
                      {network.nativeAsset.symbol}
                    </strong>
                  </p>
                )}
                <p className="review-fact">
                  <span>{text("simulation")}:</span>{" "}
                  <strong className="is-ok">{text("passed")}</strong>
                </p>
                <p className="review-fact">
                  <span>{text("futureSteps")}:</span>{" "}
                  <strong>
                    {review.decoded.approval?.kind === "PERMIT2"
                      ? "Permit2"
                      : review.decoded.approval?.kind === "ERC20"
                        ? "ERC-20"
                        : "—"}
                  </strong>
                </p>
                <p className="review-fact">
                  <span>{t("v13.platformFee")}:</span> <strong>0%</strong>
                </p>
              </div>
              {reviewedGuardian && (
                <GuardianPanel
                  verdict={reviewedGuardian}
                  testId="guardian-swap-review"
                />
              )}
              <details className="disclosure">
                <summary>{text("advanced")}</summary>
                <div className="disclosure-body review-advanced">
                  <p>{review.simulation.source}</p>
                  <p>
                    <code>{review.digest}</code>
                  </p>
                  <p>
                    <code>{review.transactionDigest}</code>
                  </p>
                  {review.decoded.router && (
                    <p>
                      <code>{review.decoded.router}</code>
                    </p>
                  )}
                  {review.decoded.instructions && (
                    <p>
                      {[
                        ...new Set(
                          review.decoded.instructions.map((v) => v.program),
                        ),
                      ].map((program) => (
                        <code key={program}>{program} </code>
                      ))}
                    </p>
                  )}
                  <ul>
                    {q.route.map((leg, index) => (
                      <li key={`${leg.pool}:${index}`}>
                        <code>{leg.pool}</code>
                      </li>
                    ))}
                  </ul>
                  <p>
                    {review.decoded.approval?.spender} ·{" "}
                    {review.decoded.approval?.amount}
                  </p>
                  {review.decoded.approval?.tokenApprovalSpender && (
                    <p>
                      <code>
                        {review.decoded.approval.tokenApprovalSpender}
                      </code>
                    </p>
                  )}
                </div>
              </details>
              <button
                className="secondary review-save"
                disabled={!fresh || saved}
                onClick={async () => {
                  const bound = quoteIntents.current.get(q.id);
                  if (!bound) return;
                  try {
                    await saveSwapPreview(q, bound, network);
                    setSaved(true);
                  } catch {
                    setError("PROVIDER_UNAVAILABLE");
                  }
                }}
              >
                {saved && <Icon name="check" size={16} />}
                {saved ? t("ui.previewSaved") : t("ui.savePreviewToActivity")}
              </button>
            </>
          )}
        </dialog>
        {picker && (
          <TokenPicker
            role={picker}
            assets={assets}
            selected={(picker === "source" ? from : to)?.address ?? ""}
            network={network}
            portfolio={matchingPortfolio}
            lang={lang}
            allowQuoteDiscovery
            onSelect={() => {}}
            onSelectAsset={(a, e) => {
              if (e)
                setEvidence((known) =>
                  new Map(known).set(identity(a.address), e),
                );
              if (picker === "source") setFrom(a);
              else setTo(a);
              setAssets((list) =>
                list.some((v) => identity(v.address) === identity(a.address))
                  ? list
                  : [...list, a],
              );
            }}
            onClose={() => setPicker(undefined)}
          />
        )}
      </section>
    </div>
  );
}
