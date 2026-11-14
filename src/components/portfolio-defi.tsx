"use client";
import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/provider";
import { formatTokenAmount } from "../i18n/amounts";
import {
  type DefiPosition,
  type DefiScan,
  type PositionAsset,
} from "../defi/model";
import { perf } from "./perf";
import { readRound } from "./defi-stream";
import { leverage, mergeDefi, portfolioTotals } from "../defi/valuation";
import { economicAssets } from "../defi/economic";
import type { Holding } from "../portfolio/model";
import { modalProps, openModal } from "./dialog";
import { Icon } from "./icons";
import type { MessageKey } from "../i18n/messages";
import { exactUsd, nativeRatio } from "../defi/display";
import { TideTag, TokenMark, type TideKind } from "./ocean-marks";
import dynamic from "next/dynamic";
// V1.14: the global catalog explorer is a separate lazy chunk; the primary Portfolio view stays unchanged.
const DefiExplore = dynamic(() => import("./defi-explore"), { ssr: false });
export type PortfolioView = "overview" | "assets" | "defi" | "debt" | "rewards";
/** A protocol has no reviewed logo here: its medallion carries the initials of its words (Aave V3 → AV). */
const protocolInitials = (name: string) =>
  name
    .split(/[\s-]+/)
    .filter(Boolean)
    .map((word) => [...word][0])
    .join("")
    .slice(0, 3);
/** Position kinds as tide marks: lending and debt are currents, liquidity a sonar pair, vaults pearls. */
const CATEGORY_MARK: Record<string, TideKind> = {
  lending: "current",
  liquidity: "sonar",
  vault: "pearl",
  staking: "depth",
  restaking: "depth",
};
const urls: Record<string, string> = {
  "aave-v3": "https://app.aave.com/",
  "compound-iii": "https://app.compound.finance/",
  "morpho-blue": "https://app.morpho.org/",
  "morpho-vault": "https://app.morpho.org/",
  erc4626: "https://app.spark.fi/",
  lido: "https://stake.lido.fi/",
  "uniswap-v2": "https://app.uniswap.org/",
  "uniswap-v3": "https://app.uniswap.org/",
  // V1.14 reviewed families (same official app origins as the server registry).
  "rocket-pool": "https://stake.rocketpool.net/",
  "coinbase-cbeth": "https://www.coinbase.com/cbeth",
  "binance-wbeth": "https://www.binance.com/en/wbeth",
  "swell-sweth": "https://app.swellnetwork.io/",
  "ether-fi": "https://app.ether.fi/",
  "meth-protocol": "https://www.methprotocol.xyz/",
  stader: "https://www.staderlabs.com/eth/",
  kelp: "https://kerneldao.com/kelp/",
  "stakewise-v3": "https://app.stakewise.io/",
  "frax-ether": "https://app.frax.finance/",
  puffer: "https://app.puffer.fi/",
  eigenlayer: "https://app.eigenlayer.xyz/",
  curve: "https://www.curve.finance/",
  "balancer-v2": "https://balancer.fi/",
  aerodrome: "https://aerodrome.finance/",
  velodrome: "https://velodrome.finance/",
  sushiswap: "https://www.sushi.com/",
  pancakeswap: "https://pancakeswap.finance/",
  "pancakeswap-v3": "https://pancakeswap.finance/",
  sparklend: "https://app.spark.fi/",
};
// Currency strings are formatted without Number coercion, including uint256-size values.
const warningKey = (code: string): MessageKey =>
  (({
    UNPRICED_UNDERLYING: "v113.warnUnpriced",
    UNPRICED_DEBT: "v113.unpricedDebt",
    UNACCRUED_FEES_NOT_CHECKED: "v113.warnFees",
    WITHDRAWAL_QUEUE_NOT_CHECKED: "v113.warnQueue",
    REWARDS_READ_FAILED: "v113.warnRewards",
    RESERVE_READ_INCOMPLETE: "v113.warnReserve",
    NESTED_DEPTH_LIMIT: "v113.warnNested",
    MARKET_DISCOVERY_INCOMPLETE: "v113.warnIncomplete",
    VAULT_DISCOVERY_INCOMPLETE: "v113.warnIncomplete",
    // V1.14 families.
    PAIR_DISCOVERY_INCOMPLETE: "v113.warnIncomplete",
    STAKED_POSITIONS_NOT_CHECKED: "v113.warnIncomplete",
    STAKED_BPT_NOT_CHECKED: "v113.warnIncomplete",
    UNREVIEWED_STRATEGY: "v113.warnIncomplete",
    NATIVE_RESTAKING_CHECKPOINT_BASED: "v113.warnIncomplete",
    NATIVE_RESTAKING_DEFICIT: "v113.warnIncomplete",
    UNSTAKED_LP_FEES_NOT_INCLUDED: "v113.warnFees",
    CURVE_REWARDS_NOT_EXACT: "v113.rewardsUnchecked",
    WITHDRAWAL_PENDING_FINALIZATION: "v114.warnQueuePending",
    QUEUED_WITHDRAWALS_NOT_VALUED: "v114.warnQueuePending",
    UNDERLYING_NOT_DECOMPOSED: "v114.notDecomposed",
    PROTOCOL_REPORTED_RATE: "v114.warnReportedRate",
  })[code] as MessageKey | undefined) ?? "v113.warningUnknown";
export default function PortfolioDefi({
  wallet,
  holdings,
  chainName,
  onScan,
  view,
  onView,
  now,
}: {
  wallet: string;
  holdings: Holding[];
  chainName: (id: string) => string;
  onScan: (scan: DefiScan | undefined) => void;
  view: PortfolioView;
  onView: (view: PortfolioView) => void;
  now: number;
}) {
  const { t, lang } = useI18n(),
    [scan, setScan] = useState<DefiScan>(),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [query, setQuery] = useState(""),
    [category, setCategory] = useState("all"),
    [sort, setSort] = useState("value"),
    [limit, setLimit] = useState(50),
    [selected, setSelected] = useState<DefiPosition>(),
    [epoch, setEpoch] = useState(0),
    [exploring, setExploring] = useState(false);
  const modal = useRef<HTMLDialogElement>(null),
    sequence = useRef(0),
    heldRef = useRef(holdings),
    heldReady = holdings.length > 0;
  useEffect(() => {
    heldRef.current = holdings;
  }, [holdings]);
  useEffect(() => {
    const controller = new AbortController(),
      attempt = ++sequence.current;
    const timer = setTimeout(async () => {
      setScan(undefined);
      onScan(undefined);
      setBusy(true);
      setFailed(false);
      let current: DefiScan | undefined, continuation: string[] | undefined;
      try {
        if (!/^0x[0-9a-f]{40}$/.test(wallet.toLowerCase())) return;
        perf.defiStart();
        // Exact held token ids (never symbols) let the server admit receipt-token candidates first.
        const held = [
          ...new Set(
            heldRef.current
              .filter(
                (h) =>
                  !h.spam &&
                  // V1.14.1: the native coin is a balance, never a receipt-token candidate.
                  !h.native &&
                  /^0x[0-9a-fA-F]{40}$/.test(h.address) &&
                  BigInt(h.balance) > 0n,
              )
              .map((h) => h.chainId + ":" + h.address.toLowerCase())
              .filter((id) => /^\d{1,20}:0x[0-9a-f]{40}$/.test(id)),
          ),
        ]
          .sort()
          .slice(0, 1000);
        for (let round = 0; round < 20; round++) {
          const r = await fetch("/api/portfolio/defi", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/x-ndjson, application/json",
            },
            body: JSON.stringify({
              wallet,
              consent: true,
              ...(continuation ? { continuation } : {}),
              ...(held.length ? { held } : {}),
            }),
            signal: AbortSignal.any([
              controller.signal,
              AbortSignal.timeout(20000),
            ]),
          });
          if (!r.ok) throw Error("FAILED");
          const base = current;
          const next = await readRound(r, wallet.toLowerCase(), (partial) => {
            if (controller.signal.aborted || attempt !== sequence.current)
              return;
            // Provisional view only: the complete round below replaces every deployment it covers.
            const view = base
              ? mergeDefi(base, { ...partial, continuation: base.continuation })
              : partial;
            setScan(view);
            onScan(view);
            perf.once("firstDefiResultMs");
          });
          if (next.wallet !== wallet.toLowerCase())
            throw Error("WALLET_SCOPE_MISMATCH");
          if (controller.signal.aborted || attempt !== sequence.current) return;
          current = current ? mergeDefi(current, next) : next;
          setScan(current);
          onScan(current);
          perf.once("firstDefiResultMs");
          continuation = next.continuation;
          if (!continuation.length) {
            perf.once("fullDefiScanMs");
            break;
          }
        }
      } catch {
        if (!controller.signal.aborted && attempt === sequence.current)
          setFailed(true);
      } finally {
        if (!controller.signal.aborted && attempt === sequence.current)
          setBusy(false);
      }
    }, 0);
    return () => {
      clearTimeout(timer);
      controller.abort();
      sequence.current = attempt + 1;
    };
    // Identity and explicit refresh own the request lifetime; holdings continue independently. The scan restarts
    // once when the first holdings arrive so exact held receipt tokens can admit their candidates first.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallet, epoch, heldReady]);
  // Unpriced is not zero: a value summed from priced assets reads "Unpriced" when none of its positions' assets has
  // a price, and is marked partial when some of them have none (never a silent $0.00).
  const pricedText = (group: readonly DefiPosition[], usd?: string) => {
    const value =
      usd ?? group.reduce((s, p) => addValue(s, p.grossAssetsUsd), "0.000000");
    if (!group.some(hasUnpriced)) return exactUsd(value);
    return fixed(value) === 0n
      ? t("v113.unpriced")
      : `${exactUsd(value)} · ${t("v113.partial")}`;
  };
  const totals = portfolioTotals(holdings, scan),
    protocolValue = new Map<string, string>();
  // G13 review fix (VBA-P1-04): wallet assets that all lack a price have no known value — "Unpriced", never "$0.00".
  const walletAssets = holdings.filter(
    (h) => !h.spam && h.position?.role !== "debt" && BigInt(h.balance) > 0n,
  );
  const walletValueText =
    walletAssets.length > 0 &&
    walletAssets.every((h) => h.usd === null && !h.price)
      ? t("v113.unpriced")
      : exactUsd(totals.walletUsd);
  for (const p of totals.positions)
    protocolValue.set(
      p.protocolId,
      addValue(protocolValue.get(p.protocolId) ?? "0", p.grossAssetsUsd),
    );
  const positions = totals.positions
    .filter(
      (p) =>
        (category === "all" || p.category === category) &&
        (!query ||
          `${p.protocolName} ${chainName(p.chainId)} ${[...p.supplied, ...p.collateral, ...p.borrowed, ...p.underlying].map((a) => a.symbol).join(" ")}`
            .toLocaleLowerCase()
            .includes(query.toLocaleLowerCase())),
    )
    .sort((a, b) =>
      sort === "protocol"
        ? a.protocolName.localeCompare(b.protocolName)
        : sort === "chain"
          ? chainName(a.chainId).localeCompare(chainName(b.chainId))
          : sort === "risk"
            ? Number(
                b.risk.kind !== "not-available" && b.risk.attention !== "none",
              ) -
              Number(
                a.risk.kind !== "not-available" && a.risk.attention !== "none",
              )
            : compareValue(
                protocolValue.get(b.protocolId) ?? "0",
                protocolValue.get(a.protocolId) ?? "0",
              ) ||
              a.protocolId.localeCompare(b.protocolId) ||
              compareValue(b.grossAssetsUsd, a.grossAssetsUsd),
    );
  const debt = positions
      .flatMap((p) => p.borrowed.map((asset) => ({ p, asset })))
      .sort((a, b) =>
        compareValue(b.asset.valueUsd ?? "0", a.asset.valueUsd ?? "0"),
      ),
    rewards = positions.flatMap((p) =>
      p.rewards
        .filter((r) => r.confidence === "protocol-view")
        .map((r) => ({ p, r })),
    );
  const attention = totals.positions.filter(
    (p) =>
      p.borrowed.some((a) => a.valueUsd === null) ||
      (p.risk.kind !== "not-available" && p.risk.attention !== "none") ||
      now - p.observedAt > 60000,
  );
  const risk = (p: DefiPosition) => {
    const r = p.risk;
    if (now - p.observedAt > 60000)
      return <span className="pill tone-warn">{t("v113.stale")}</span>;
    if (r.kind === "not-available")
      return <span className="muted">{t("v113.riskUnavailable")}</span>;
    return (
      <div className="defi-risk">
        <span>
          {r.kind === "health-factor"
            ? `${t("v113.health")} ${nativeRatio(r.value)}`
            : r.kind === "ltv"
              ? `${t("v113.ltv")} ${percent(r.ltv)} / ${percent(r.liquidationLtv)}`
              : `${t("v113.collateralized")}: ${t(r.borrowCollateralized ? "v113.yes" : "v113.no")} · ${t("v113.liquidatable")}: ${t(r.liquidatable ? "v113.yes" : "v113.no")}`}
        </span>
        {r.attention !== "none" && (
          <span
            className={`pill tone-${r.attention === "attention" ? "danger" : "warn"}`}
          >
            {t(r.attention === "attention" ? "v113.attention" : "v113.monitor")}
          </span>
        )}
      </div>
    );
  };
  const assets = (list: PositionAsset[]) =>
    list.map((a, i) => (
      <div className="defi-asset" key={a.assetId + ":" + i}>
        <TokenMark symbol={a.symbol} seed={a.assetId} size="sm" />
        <span>
          {a.symbol}
          <small>
            {formatTokenAmount(BigInt(a.rawAmount), a.decimals, lang)}
          </small>
        </span>
        <bdi dir="ltr">
          {a.valueUsd === null ? t("v113.unpriced") : exactUsd(a.valueUsd)}
        </bdi>
      </div>
    ));
  const show = (p: DefiPosition, trigger: HTMLElement) => {
    setSelected(p);
    openModal(modal.current, trigger);
  };
  return (
    <section
      className="defi-intelligence"
      data-testid="defi-intelligence"
      aria-label={t("v113.supported")}
    >
      <nav
        className="portfolio-mode-tabs"
        role="tablist"
        aria-label={t("v113.portfolioViews")}
      >
        {(["overview", "assets", "defi", "debt", "rewards"] as const).map(
          (mode) => (
            <button
              key={mode}
              role="tab"
              id={`portfolio-tab-${mode}`}
              aria-selected={view === mode}
              tabIndex={view === mode ? 0 : -1}
              onKeyDown={(e) => {
                const modes: PortfolioView[] = [
                  "overview",
                  "assets",
                  "defi",
                  "debt",
                  "rewards",
                ];
                let i = modes.indexOf(mode);
                if (e.key === "ArrowRight") i = (i + 1) % 5;
                else if (e.key === "ArrowLeft") i = (i + 4) % 5;
                else if (e.key === "Home") i = 0;
                else if (e.key === "End") i = 4;
                else return;
                e.preventDefault();
                onView(modes[i]);
                document.getElementById(`portfolio-tab-${modes[i]}`)?.focus();
              }}
              aria-current={view === mode ? "page" : undefined}
              onClick={() => onView(mode)}
            >
              {t(`v113.${mode}`)}
              {mode === "defi" && scan && (
                <span>{totals.positions.length}</span>
              )}
              {mode === "debt" && debt.length > 0 && <span>{debt.length}</span>}
            </button>
          ),
        )}
      </nav>
      <div className="defi-summary-facts">
        <div>
          <span>{t("v113.walletValue")}</span>
          <strong>
            <bdi dir="ltr">{walletValueText}</bdi>
          </strong>
        </div>
        <div>
          <span>{t("v113.defiValue")}</span>
          <strong>
            {/* G13 (VBA-P1-04, I19): nothing is known before the first scan has finished — never "$0.00". */}
            {scan ? (
              <bdi dir="ltr">
                {pricedText(totals.positions, totals.defiUsd)}
              </bdi>
            ) : failed ? (
              t("ui.unknown")
            ) : (
              t("ui.loading")
            )}
          </strong>
        </div>
        <div>
          <span>{t("v113.borrowed")}</span>
          <strong>
            {scan ? (
              <bdi dir="ltr">{exactUsd(totals.debtUsd)}</bdi>
            ) : failed ? (
              t("ui.unknown")
            ) : (
              t("ui.loading")
            )}
          </strong>
        </div>
      </div>
      {totals.unpricedDebt > 0 && (
        <p role="status" className="notice tone-warn">
          {t("v113.unpricedDebt")}
        </p>
      )}
      {scan &&
        (totals.unpricedAssets > 0 ||
          totals.unpricedDebt > 0 ||
          totals.uncheckedCoverage > 0) && (
          <ul className="defi-value-notes" aria-label={t("v114.netIncomplete")}>
            <li>{t("v114.netIncomplete")}</li>
            {totals.unpricedAssets > 0 && (
              <li>
                {t("v114.unpricedAssets", { count: totals.unpricedAssets })}
              </li>
            )}
            {totals.unpricedDebt > 0 && (
              <li>
                {t("v114.unpricedDebtCount", { count: totals.unpricedDebt })}
              </li>
            )}
            {totals.uncheckedCoverage > 0 && (
              <li>
                {t("v114.uncheckedCoverage", {
                  count: totals.uncheckedCoverage,
                })}
              </li>
            )}
          </ul>
        )}
      {totals.feesUsd !== "0.000000" && (
        <p className="input-hint">
          {t("v114.feesUncollected")}:{" "}
          <bdi dir="ltr">{exactUsd(totals.feesUsd)}</bdi>
        </p>
      )}
      <div className="defi-progress">
        <p role="status">
          {busy
            ? t("v113.scanning")
            : failed
              ? t("v113.scanFailed")
              : t("v113.supported")}
        </p>
        <button
          className="text-button"
          disabled={busy}
          onClick={() => setEpoch((e) => e + 1)}
          aria-label={t("v113.retry")}
        >
          <Icon name="refresh" size={16} />
        </button>
      </div>
      {view === "overview" && (
        <>
          <div className="defi-allocation">
            <h3>{t("v113.allocation")}</h3>
            <button onClick={() => onView("assets")}>
              <span className="tmark tmark-md" aria-hidden="true">
                <span className="tmark-face is-medallion tm-h10">
                  <Icon name="wallet" size={15} />
                </span>
              </span>
              <span>{t("v113.walletValue")}</span>
              <bdi dir="ltr">{walletValueText}</bdi>
            </button>
            {[...new Set(totals.positions.map((p) => p.protocolId))].map(
              (id) => {
                const group = totals.positions.filter(
                  (p) => p.protocolId === id,
                );
                return (
                  <button key={id} onClick={() => onView("defi")}>
                    <TokenMark
                      symbol={protocolInitials(group[0].protocolName)}
                      seed={id}
                    />
                    <span>{group[0].protocolName}</span>
                    <bdi dir="ltr">{pricedText(group)}</bdi>
                  </button>
                );
              },
            )}
          </div>
          {attention.length > 0 && (
            <div className="defi-attention">
              <h3>{t("v113.needsAttention")}</h3>
              {attention.map((p) => (
                <button key={p.id} onClick={(e) => show(p, e.currentTarget)}>
                  {p.protocolName} · {chainName(p.chainId)}
                  <span>
                    {p.borrowed.some((a) => a.valueUsd === null)
                      ? t("v113.unpricedDebt")
                      : t("v113.attention")}
                  </span>
                </button>
              ))}
            </div>
          )}
        </>
      )}
      {["defi", "debt", "rewards"].includes(view) && (
        <>
          <div className="defi-toolbar">
            <input
              type="search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setLimit(50);
              }}
              aria-label={t("v113.search")}
              placeholder={t("v113.search")}
            />
            <details>
              <summary>{t("v113.filter")}</summary>
              <select
                aria-label={t("v113.filter")}
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {[
                  "all",
                  "lending",
                  "liquidity",
                  "vault",
                  "staking",
                  "restaking",
                ].map((k) => (
                  <option key={k} value={k}>
                    {t(`v113.${k}` as MessageKey)}
                  </option>
                ))}
              </select>
              <select
                aria-label={t("v113.sort")}
                value={sort}
                onChange={(e) => setSort(e.target.value)}
              >
                {["value", "protocol", "chain", "risk"].map((k) => (
                  <option key={k} value={k}>
                    {t(
                      `v113.sort${k[0].toUpperCase() + k.slice(1)}` as MessageKey,
                    )}
                  </option>
                ))}
              </select>
            </details>
          </div>
          {view === "defi" && (
            <div className="defi-position-list">
              {groupByProtocol(positions.slice(0, limit)).map((group) => (
                <section
                  className="defi-protocol-group"
                  key={group[0].protocolId}
                  aria-label={group[0].protocolName}
                >
                  <header className="defi-protocol-head">
                    <TokenMark
                      symbol={protocolInitials(group[0].protocolName)}
                      seed={group[0].protocolId}
                    />
                    <h4>{group[0].protocolName}</h4>
                    <bdi dir="ltr" className="defi-protocol-total">
                      {pricedText(group)}
                    </bdi>
                  </header>
                  {group.map((p) => (
                    <article
                      className="defi-position-card"
                      key={p.id}
                      data-protocol={p.protocolId}
                    >
                      <button
                        className="defi-position-header"
                        onClick={(e) => show(p, e.currentTarget)}
                        aria-label={`${p.protocolName} ${t("v113.details")}`}
                      >
                        <TideTag
                          kind={CATEGORY_MARK[p.category] ?? "current"}
                          tone="calm"
                        >
                          {t(`v113.${p.category}` as MessageKey)}
                        </TideTag>
                        <span>
                          <strong>
                            {p.details.positionToken ??
                              p.details.shareSymbol ??
                              p.protocolName}
                          </strong>
                          <small>{chainName(p.chainId)}</small>
                        </span>
                        <span className="defi-card-value">
                          <bdi dir="ltr">{pricedText([p])}</bdi>
                          {p.borrowed.length > 0 && (
                            <small>
                              {t("v113.borrowed")} {exactUsd(p.debtUsd)}
                            </small>
                          )}
                        </span>
                        <Icon name="chevronRight" size={16} />
                      </button>
                      {p.borrowed.length > 0 && risk(p)}
                      {p.category === "liquidity" && p.details.range && (
                        <p className="input-hint">
                          {t(
                            p.details.range === "IN_RANGE"
                              ? "v113.inRange"
                              : "v113.outOfRange",
                          )}
                        </p>
                      )}
                    </article>
                  ))}
                </section>
              ))}
            </div>
          )}
          {view === "debt" && (
            <div className="defi-debt-list">
              {debt.slice(0, limit).map(({ p, asset }, i) => (
                <article className="defi-position-card" key={p.id + ":" + i}>
                  <button
                    className="defi-position-header"
                    onClick={(e) => show(p, e.currentTarget)}
                  >
                    <strong>{p.protocolName}</strong>
                    <small>{chainName(p.chainId)}</small>
                    <span>
                      {asset.symbol}{" "}
                      {formatTokenAmount(
                        BigInt(asset.rawAmount),
                        asset.decimals,
                        lang,
                      )}
                    </span>
                    <bdi dir="ltr">
                      {asset.valueUsd === null
                        ? t("v113.unpriced")
                        : exactUsd(asset.valueUsd)}
                    </bdi>
                  </button>
                  {risk(p)}
                </article>
              ))}
            </div>
          )}
          {view === "rewards" && (
            <div>
              {rewards.slice(0, limit).map(({ p, r }, i) => (
                <article className="defi-position-card" key={p.id + ":" + i}>
                  <strong>
                    {p.protocolName} · {t("v113.claimable")}
                  </strong>
                  {assets([r.asset])}
                </article>
              ))}
              <p className="input-hint">{t("v113.rewardsUnchecked")}</p>
            </div>
          )}
          {((view === "defi" && positions.length === 0) ||
            (view === "debt" && debt.length === 0) ||
            (view === "rewards" && rewards.length === 0)) && (
            <div className="defi-empty">
              <Icon name="layers" size={28} />
              <h3>
                {t(
                  view === "debt"
                    ? "v113.debtEmpty"
                    : view === "rewards"
                      ? "v113.noRewards"
                      : "v113.empty",
                )}
              </h3>
              <p>{t("v113.emptyBody")}</p>
            </div>
          )}
          {Math.max(positions.length, debt.length, rewards.length) > limit && (
            <button
              className="secondary"
              onClick={() => setLimit((n) => n + 50)}
            >
              {t("v113.more")}
            </button>
          )}
        </>
      )}
      <div className="defi-explore-entry">
        <button
          className="secondary"
          aria-expanded={exploring}
          aria-controls="defi-explore-region"
          onClick={() => setExploring((v) => !v)}
        >
          <Icon name="globe" size={16} />{" "}
          {t(exploring ? "v114.exploreHide" : "v114.explore")}
        </button>
      </div>
      {exploring && (
        <div id="defi-explore-region">
          <DefiExplore scan={scan} onOpenDefi={() => onView("defi")} />
        </div>
      )}
      <details className="defi-coverage">
        <summary>
          {t("v113.coverageDetails")}{" "}
          <span>
            {scan?.coverage.filter((c) => c.result !== "UNKNOWN").length ?? 0} /{" "}
            {scan?.coverage.length ?? 0}
          </span>
        </summary>
        <p>{t("v113.nonEvm")}</p>
        {scan?.receipt && (
          <ul className="defi-receipt" aria-label={t("v114.receiptTitle")}>
            <li>
              {t("v114.receiptCandidates", {
                run: scan.receipt.funnel.adaptersRun,
                candidates: scan.receipt.funnel.candidateDeployments,
              })}
            </li>
            {scan.receipt.funnel.chainRelevantRows !== null && (
              <li>
                {t("v114.receiptCatalog", {
                  chainRelevant: scan.receipt.funnel.chainRelevantRows,
                })}
              </li>
            )}
            <li>
              {t("v114.receiptZero", { count: scan.receipt.checkedZero })}
            </li>
            <li>
              {t("v114.receiptSkipped", { count: scan.receipt.skipped.length })}
            </li>
            {scan.receipt.failed > 0 && (
              <li>{t("v114.receiptFailed", { count: scan.receipt.failed })}</li>
            )}
            <li>{t("v114.receiptRpc", { count: scan.receipt.rpcCalls })}</li>
          </ul>
        )}
        {failed && <p className="notice tone-warn">{t("v113.failed")}</p>}
        <div
          className="position-coverage-list"
          tabIndex={0}
          role="region"
          aria-label={t("v113.coverage")}
        >
          {scan?.coverage.map((c) => (
            <div key={c.deploymentId}>
              <span>
                {c.protocolName}
                <small>{chainName(c.chainId)}</small>
              </span>
              <span
                className={`pill tone-${c.state === "FAILED" ? "danger" : c.state === "FULL_POSITION" ? "ok" : "warn"}`}
              >
                {t(coverageKey(c.state))}
              </span>
              <small>
                {t(
                  c.result === "ZERO"
                    ? "v113.checkedEmpty"
                    : c.result === "NONZERO"
                      ? "v113.positionsFound"
                      : "v113.unknown",
                )}
                {c.reason === "LOCAL_DISCOVERY_INDEX_REQUIRED" &&
                  ` · ${t("v113.indexRequired")}`}
              </small>
            </div>
          ))}
        </div>
      </details>
      <dialog
        className="defi-dialog"
        ref={modal}
        aria-labelledby="defi-detail-title"
        {...modalProps(() => setSelected(undefined))}
      >
        <div className="dialog-head">
          <h2 id="defi-detail-title">
            {selected?.protocolName ?? t("v113.details")}
          </h2>
          <button
            aria-label={t("v113.close")}
            onClick={() => modal.current?.close()}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        {selected && (
          <>
            <p>
              {chainName(selected.chainId)} ·{" "}
              {t(`v113.${selected.category}` as MessageKey)}
            </p>
            <strong className="defi-detail-value">
              <bdi dir="ltr">{pricedText([selected])}</bdi>
            </strong>
            {(["supplied", "collateral", "borrowed", "underlying"] as const)
              .filter((k) => selected[k].length)
              .map((k) => (
                <section key={k}>
                  <h3>{t(`v113.${k}`)}</h3>
                  {assets(selected[k])}
                </section>
              ))}
            {selected.fees && selected.fees.length > 0 && (
              <section>
                <h3>{t("v114.feesUncollected")}</h3>
                {assets(selected.fees)}
              </section>
            )}
            {selected.positionKey === "withdrawals" && (
              <section>
                <h3>{t("v114.withdrawals")}</h3>
                {selected.details.finalizedUnclaimed !== "0" && (
                  <p>{t("v114.withdrawalClaimable")}</p>
                )}
                {selected.details.pending !== "0" && (
                  <p>{t("v114.withdrawalPending")}</p>
                )}
              </section>
            )}
            {selected.details.notDecomposed && (
              <p>
                {t("v114.notDecomposed")}:{" "}
                <bdi dir="ltr">{selected.details.notDecomposed}</bdi>
              </p>
            )}
            {selected.details.notional && (
              <p>
                {t("v114.notional")}:{" "}
                <bdi dir="ltr">{selected.details.notional}</bdi>
              </p>
            )}
            {leverage(selected) && (
              <p>
                {t("v114.leverage")}:{" "}
                <bdi dir="ltr">{nativeRatio(leverage(selected)!)}x</bdi>
              </p>
            )}
            <h3>{t("v113.protocolRisk")}</h3>
            {risk(selected)}
            {selected.details.range && (
              <p>
                {t("v113.range")}:{" "}
                {t(
                  selected.details.range === "IN_RANGE"
                    ? "v113.inRange"
                    : "v113.outOfRange",
                )}
              </p>
            )}
            {selected.details.shares && (
              <p>
                {t("v113.shares")}:{" "}
                <bdi dir="ltr">
                  {formatTokenAmount(
                    BigInt(selected.details.shares),
                    Number(selected.details.shareDecimals ?? "18"),
                    lang,
                  )}{" "}
                  {selected.details.shareSymbol}
                </bdi>
              </p>
            )}
            {selected.details.positionToken && (
              <p>
                {selected.details.positionToken} · {selected.details.exposure}
              </p>
            )}
            {selected.details.rateRaw && (
              <p>
                {t("v113.stakingRate")}:{" "}
                <bdi dir="ltr">
                  {formatTokenAmount(
                    BigInt(selected.details.rateRaw),
                    18,
                    lang,
                  )}{" "}
                  {selected.underlying[0]?.symbol ?? ""} /{" "}
                  {selected.details.positionToken}
                </bdi>
              </p>
            )}
            {selected.details.fee && (
              <p>
                {t("v113.feeTier")}:{" "}
                <bdi dir="ltr">
                  {(Number(selected.details.fee) / 10000).toFixed(2)}%
                </bdi>
              </p>
            )}
            <ul className="defi-warnings">
              {selected.warnings.map((w) => (
                <li key={w}>{t(warningKey(w))}</li>
              ))}
            </ul>
            <p>
              {t("v113.lastChecked")}:{" "}
              {new Date(selected.observedAt).toLocaleString(lang)}
            </p>
            <details>
              <summary>{t("v113.advanced")}</summary>
              <p>
                {t("v113.block")}: <bdi dir="ltr">{selected.sourceBlock}</bdi>
              </p>
              <p>
                {t("v113.adapter")}: {selected.adapterVersion}
              </p>
              <code>{selected.sourceBlockHash}</code>
              {selected.details.pool && (
                <p>
                  {t("v113.pool")}
                  <code>{selected.details.pool}</code>
                </p>
              )}
              {selected.details.shareContract && (
                <p>
                  {t("v113.shareContract")}
                  <code>{selected.details.shareContract}</code>
                </p>
              )}
              {selected.risk.kind === "ltv" && (
                <p>
                  {t("v113.oracle")}
                  <code>{selected.risk.oracle}</code>
                </p>
              )}
              {[
                ...selected.supplied,
                ...selected.collateral,
                ...selected.borrowed,
                ...selected.underlying,
              ]
                .filter((a) => a.price)
                .map((a, i) => (
                  <p key={a.assetId + i}>
                    {a.symbol} · {t("v113.priceSource")}: {a.price!.method} ·{" "}
                    {a.price!.confidence} ·{" "}
                    <bdi dir="ltr">
                      {a.price!.priceUsd ?? t("v113.unpriced")}
                    </bdi>
                  </p>
                ))}
              {selected.evidence.slice(-16).map((e, i) => (
                <p key={i}>
                  <code>{e.source}</code>
                </p>
              ))}
            </details>
            {urls[selected.protocolId] && (
              <a
                className="secondary"
                href={urls[selected.protocolId]}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("v113.openProtocol")} <Icon name="arrowRight" size={14} />
              </a>
            )}
          </>
        )}
      </dialog>
    </section>
  );
}
function compareValue(a: string, b: string) {
  const x = fixed(a),
    y = fixed(b);
  return x > y ? 1 : x < y ? -1 : 0;
}
function hasUnpriced(p: DefiPosition) {
  return economicAssets(p).some(
    (a) => a.valueUsd === null && BigInt(a.rawAmount) > 0n,
  );
}
function fixed(v: string) {
  const [w, f = ""] = v.split(".");
  return BigInt(w + f.padEnd(6, "0").slice(0, 6));
}
/** Positions of one protocol together, in the order the sorted list first reaches each protocol. */
function groupByProtocol(list: DefiPosition[]) {
  const groups = new Map<string, DefiPosition[]>();
  for (const p of list) {
    const group = groups.get(p.protocolId);
    if (group) group.push(p);
    else groups.set(p.protocolId, [p]);
  }
  return [...groups.values()];
}
function addValue(a: string, b: string) {
  const x = (fixed(a) + fixed(b)).toString().padStart(7, "0");
  return x.slice(0, -6) + "." + x.slice(-6);
}
function percent(v: string) {
  return (Number(v) * 100).toFixed(2) + "%";
}
function coverageKey(state: string): MessageKey {
  return (
    ({
      FULL_POSITION: "v113.fullPosition",
      PARTIAL_POSITION: "v113.partialPosition",
      NOT_CHECKED: "v113.notChecked",
      FAILED: "v113.failedStatus",
      PENDING: "v113.pending",
      UNSUPPORTED: "v113.unsupported",
      BALANCE_ONLY: "v113.balanceOnly",
      DISCOVERY_ONLY: "v113.discoveryOnly",
    }[state] as MessageKey) ?? "v113.notChecked"
  );
}
