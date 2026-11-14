"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/provider";
import type { MessageKey } from "../i18n/messages";
import type { DefiScan } from "../defi/model";
import { modalProps, openModal } from "./dialog";
import { Icon } from "./icons";
// V1.14 Explore DeFi coverage. Lazy chunk: the catalog is never shipped in the initial bundle; the browser only receives
// bounded pages from /api/defi/catalog. Protocol TVL is shown separately as context, never as a wallet value, and a
// cataloged protocol without an adapter is never shown as a checked zero.
type Coverage =
  | "FULL_POSITION"
  | "PARTIAL_POSITION"
  | "DISCOVERY_ONLY"
  | "NOT_CHECKED"
  | "CATALOG_ONLY"
  | "NEEDS_REVIEW"
  | "UNSUPPORTED"
  | "DEPRECATED"
  | "FAILED";
interface ProtocolItem {
  id: string;
  name: string;
  category: string;
  productCategory: string;
  parent: string | null;
  status: string;
  tvlUsd: number | null;
  chainCount: number;
  chains: { key: string; name: string }[];
  coverage: {
    headline: Coverage;
    counts: Partial<Record<Coverage, number>>;
    chains: number;
  };
}
interface ChainItem {
  key: string;
  name: string;
  aliases: string[];
  vm: string;
  chainId: string | null;
  status: string;
  capabilities: string[];
  protocolCount: number;
  tvlUsd: number | null;
}
interface CoverageRow {
  chainKey: string;
  product: string;
  status: Coverage;
  reason: string;
  deployments: string[];
}
interface Detail {
  catalogVersion: string;
  identity: {
    id: string;
    name: string;
    parent: { name: string } | null;
    websiteHost: string | null;
    version: string | null;
  };
  category: string;
  status: string;
  tvlContext: { totalUsd: number | null };
  coverage: {
    headline: Coverage;
    counts: Partial<Record<Coverage, number>>;
  } | null;
  reviewedAdapters: {
    product: string;
    adapterVersion: string;
    protocolIds: string[];
    deploymentIds: string[] | null;
  }[];
  chains: {
    key: string;
    name: string | null;
    vm: string | null;
    tvlUsd: number | null;
    coverage: CoverageRow[];
  }[];
}
const COVERAGE: Coverage[] = [
  "FULL_POSITION",
  "PARTIAL_POSITION",
  "DISCOVERY_ONLY",
  "NOT_CHECKED",
  "CATALOG_ONLY",
  "NEEDS_REVIEW",
  "UNSUPPORTED",
  "DEPRECATED",
];
const CATEGORIES = [
  "lending",
  "cdp",
  "stablecoin",
  "dex",
  "yield",
  "farm",
  "liquid-staking",
  "restaking",
  "liquid-restaking",
  "derivatives",
  "options",
  "prediction",
  "rwa",
  "insurance",
  "nft-finance",
  "bridge",
  "cex",
  "chain",
  "launchpad",
  "services",
  "gaming",
  "dex-aggregator",
  "other",
];
const VMS = [
  "EVM",
  "Solana",
  "Sui",
  "Aptos",
  "Cosmos",
  "Bitcoin",
  "Tron",
  "Stellar",
  "Other",
];
const SHOWN_CAPS = [
  "RPC_READ",
  "PORTFOLIO_NATIVE",
  "PORTFOLIO_FUNGIBLE",
  "DEFI_POSITION",
  "DEFI_DISCOVERY",
  "BRIDGE",
  "SWAP",
  "UNSUPPORTED_VM",
  "NEEDS_REVIEW",
  "DEPRECATED",
];
const ROW = 64,
  OVERSCAN = 6,
  VIEWPORT = 448;
const tone = (c: Coverage) =>
  c === "FULL_POSITION"
    ? "ok"
    : c === "PARTIAL_POSITION" || c === "DISCOVERY_ONLY" || c === "NOT_CHECKED"
      ? "warn"
      : c === "FAILED" || c === "NEEDS_REVIEW"
        ? "danger"
        : "neutral";
const reasonKey = (r: string): MessageKey =>
  (({
    UNSUPPORTED_VM: "v114.reasonUnsupportedVm",
    NO_ONCHAIN_USER_POSITION: "v114.reasonNoUserPosition",
    POSITION_ADAPTER_NOT_IMPLEMENTED: "v114.reasonNotImplemented",
    NO_REVIEWED_DEPLOYMENT_ON_CHAIN: "v114.reasonNoDeployment",
    CHAIN_ID_UNKNOWN: "v114.reasonNoDeployment",
    NO_CHAIN_RELATION_IN_SOURCE: "v114.reasonNoChain",
  })[r] as MessageKey | undefined) ??
  (/^PROTOCOL_/.test(r)
    ? "v114.reasonDeprecated"
    : /IDENTITY|SLUG|REVIEW|CHAIN_AMBIGUOUS|MALFORMED|COLLISION/.test(r)
      ? "v114.reasonIdentity"
      : "v114.reasonPartial");
function money(v: number | null, lang: string) {
  if (v === null) return null;
  return new Intl.NumberFormat(lang, {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(v);
}
async function call<T>(body: unknown, signal: AbortSignal): Promise<T> {
  const r = await fetch("/api/defi/catalog", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!r.ok) throw Error("CATALOG_REQUEST_FAILED");
  return (await r.json()) as T;
}
export default function DefiExplore({
  scan,
  onOpenDefi,
}: {
  scan?: DefiScan;
  onOpenDefi: () => void;
}) {
  const { t, lang } = useI18n();
  const [tab, setTab] = useState<"protocols" | "networks">("protocols");
  const [query, setQuery] = useState(""),
    [debounced, setDebounced] = useState("");
  const [category, setCategory] = useState(""),
    [coverage, setCoverage] = useState(""),
    [vm, setVm] = useState(""),
    [status, setStatus] = useState("ACTIVE");
  const [items, setItems] = useState<(ProtocolItem | ChainItem)[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [total, setTotal] = useState(0),
    [version, setVersion] = useState(""),
    [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [scroll, setScroll] = useState(0),
    [detail, setDetail] = useState<Detail>();
  const modal = useRef<HTMLDialogElement>(null),
    paging = useRef<AbortController | null>(null),
    topPad = useRef<HTMLDivElement>(null),
    bottomPad = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(query.trim().slice(0, 80)), 250);
    return () => clearTimeout(id);
  }, [query]);
  const filters = useMemo(
    () =>
      tab === "protocols"
        ? {
            view: "protocols",
            q: debounced || null,
            category: category || null,
            coverage: coverage || null,
            vm: vm || null,
            status,
            limit: 40,
          }
        : {
            view: "chains",
            q: debounced || null,
            vm: vm || null,
            status: status === "ACTIVE" ? "CURRENT" : "ALL",
            limit: 40,
          },
    [tab, debounced, category, coverage, vm, status],
  );
  // The first page belongs to the current filter key; "busy" is derived, so the effect only sets state from the
  // asynchronous response (no synchronous state updates inside the effect body).
  const filterKey = JSON.stringify(filters);
  const [loadedKey, setLoadedKey] = useState("");
  const firstPageBusy = loadedKey !== filterKey;
  useEffect(() => {
    const controller = new AbortController();
    paging.current?.abort();
    call<{
      items: (ProtocolItem | ChainItem)[];
      nextCursor: string | null;
      total: number;
      catalogVersion: string;
    }>(filters, controller.signal)
      .then((r) => {
        setItems(r.items);
        setCursor(r.nextCursor);
        setTotal(r.total);
        setVersion(r.catalogVersion);
        setScroll(0);
        setFailed(false);
        setLoadedKey(filterKey);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        setFailed(true);
        setLoadedKey(filterKey);
      });
    return () => controller.abort();
  }, [filters, filterKey]);
  const more = () => {
    if (!cursor || busy || firstPageBusy) return;
    const controller = new AbortController();
    paging.current = controller;
    setBusy(true);
    call<{ items: (ProtocolItem | ChainItem)[]; nextCursor: string | null }>(
      { ...filters, cursor },
      controller.signal,
    )
      .then((r) => {
        setItems((list) => [...list, ...r.items]);
        setCursor(r.nextCursor);
      })
      .catch(() => !controller.signal.aborted && setFailed(true))
      .finally(() => !controller.signal.aborted && setBusy(false));
  };
  const open = async (id: string, trigger: HTMLElement) => {
    try {
      const d = await call<Detail>(
        { view: "protocol", id },
        new AbortController().signal,
      );
      setDetail(d);
      openModal(modal.current, trigger);
    } catch {
      setFailed(true);
    }
  };
  // Windowed list: only the visible rows (plus overscan) are rendered, so a 20,000-row catalog stays responsive.
  const first = Math.max(0, Math.floor(scroll / ROW) - OVERSCAN),
    last = Math.min(
      items.length,
      Math.ceil((scroll + VIEWPORT) / ROW) + OVERSCAN,
    );
  // Spacer heights are written through CSSOM (allowed by the strict CSP); no inline style attributes in markup.
  useEffect(() => {
    if (topPad.current) topPad.current.style.height = `${first * ROW}px`;
    if (bottomPad.current)
      bottomPad.current.style.height = `${Math.max(0, items.length - last) * ROW}px`;
  }, [first, last, items.length]);
  const covLabel = (c: Coverage) => t(`v114.cov${c}` as MessageKey);
  const wallet = (d: Detail) => {
    const ids = new Set(d.reviewedAdapters.flatMap((a) => a.protocolIds));
    if (!ids.size)
      return {
        text: t("v114.walletCatalogOnly"),
        at: null as number | null,
        found: 0,
      };
    const deployments = new Set(
      d.reviewedAdapters.flatMap((a) => a.deploymentIds ?? []),
    );
    const match = (protocolId: string, deploymentId: string) =>
      ids.has(protocolId) &&
      (!deployments.size || deployments.has(deploymentId));
    const found =
      scan?.positions.filter((p) => match(p.protocolId, p.deploymentId))
        .length ?? 0;
    const checked =
      scan?.coverage.filter((c) => match(c.protocolId, c.deploymentId)) ?? [];
    const at = checked.length
      ? Math.max(...checked.map((c) => c.observedAt))
      : null;
    if (found)
      return { text: t("v114.walletFound", { count: found }), at, found };
    if (checked.length && checked.every((c) => c.scanResult === "CHECKED_ZERO"))
      return { text: t("v114.walletZero"), at, found };
    return { text: t("v114.walletNotChecked"), at, found };
  };
  return (
    <section
      className="defi-explore"
      data-testid="defi-explore"
      aria-labelledby="defi-explore-title"
    >
      <h3 id="defi-explore-title">{t("v114.exploreTitle")}</h3>
      <p className="input-hint">{t("v114.exploreIntro")}</p>
      <div
        className="portfolio-mode-tabs"
        role="tablist"
        aria-label={t("v114.exploreTitle")}
      >
        {(["protocols", "networks"] as const).map((k) => (
          <button
            key={k}
            role="tab"
            id={`defi-explore-tab-${k}`}
            aria-selected={tab === k}
            tabIndex={tab === k ? 0 : -1}
            onClick={() => setTab(k)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              e.preventDefault();
              const next = tab === "protocols" ? "networks" : "protocols";
              setTab(next);
              document.getElementById(`defi-explore-tab-${next}`)?.focus();
            }}
          >
            {t(k === "protocols" ? "v114.tabProtocols" : "v114.tabNetworks")}
          </button>
        ))}
      </div>
      <div
        className="defi-explore-filters"
        role="tabpanel"
        aria-labelledby={`defi-explore-tab-${tab}`}
      >
        <input
          type="search"
          value={query}
          maxLength={80}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t(
            tab === "protocols"
              ? "v114.searchProtocols"
              : "v114.searchNetworks",
          )}
          placeholder={t(
            tab === "protocols"
              ? "v114.searchProtocols"
              : "v114.searchNetworks",
          )}
        />
        {tab === "protocols" && (
          <>
            <select
              aria-label={t("v114.filterCategory")}
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">{t("v114.allCategories")}</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`v114.cat_${c.replace(/-/g, "_")}` as MessageKey)}
                </option>
              ))}
            </select>
            <select
              aria-label={t("v114.filterCoverage")}
              value={coverage}
              onChange={(e) => setCoverage(e.target.value)}
            >
              <option value="">{t("v114.allCoverage")}</option>
              {COVERAGE.map((c) => (
                <option key={c} value={c}>
                  {covLabel(c)}
                </option>
              ))}
            </select>
          </>
        )}
        <select
          aria-label={t("v114.filterVm")}
          value={vm}
          onChange={(e) => setVm(e.target.value)}
        >
          <option value="">{t("v114.allVms")}</option>
          {VMS.map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </select>
        <select
          aria-label={t("v114.filterStatus")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="ACTIVE">{t("v114.statusActive")}</option>
          {tab === "protocols" && (
            <option value="INACTIVE">{t("v114.statusInactive")}</option>
          )}
          <option value="ALL">{t("v114.statusAll")}</option>
        </select>
      </div>
      <p role="status" className="defi-explore-count">
        {firstPageBusy
          ? t("v114.loading")
          : failed
            ? t("v114.catalogUnavailable")
            : t("v114.results", { count: total })}
      </p>
      {!firstPageBusy && !failed && items.length === 0 && (
        <p className="defi-empty">{t("v114.noResults")}</p>
      )}
      <div
        className="defi-explore-viewport"
        role="list"
        aria-label={t(
          tab === "protocols" ? "v114.tabProtocols" : "v114.tabNetworks",
        )}
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          setScroll(el.scrollTop);
          if (el.scrollTop + el.clientHeight > el.scrollHeight - ROW * 4)
            more();
        }}
      >
        <div ref={topPad} aria-hidden="true" />
        {items.slice(first, last).map((item, i) => {
          const index = first + i;
          if ("coverage" in item)
            return (
              <div
                role="listitem"
                aria-setsize={total}
                aria-posinset={index + 1}
                key={item.id}
                className="defi-explore-item"
              >
                <button
                  className="defi-explore-row"
                  onClick={(e) => open(item.id, e.currentTarget)}
                >
                  <span className="protocol-mark" aria-hidden="true">
                    {item.name.slice(0, 2)}
                  </span>
                  <span className="defi-explore-main">
                    <strong>{item.name}</strong>
                    <small>
                      {item.category} ·{" "}
                      {t("v114.chainsCount", { count: item.chainCount })}
                      {item.chains.length > 0 &&
                        ` · ${item.chains.map((c) => c.name).join(", ")}`}
                    </small>
                  </span>
                  <span className={`pill tone-${tone(item.coverage.headline)}`}>
                    {covLabel(item.coverage.headline)}
                  </span>
                </button>
              </div>
            );
          const chain = item as ChainItem;
          return (
            <div
              role="listitem"
              aria-setsize={total}
              aria-posinset={index + 1}
              key={chain.key}
              className="defi-explore-item"
            >
              <div className="defi-explore-row">
                <span className="protocol-mark" aria-hidden="true">
                  {chain.name.slice(0, 2)}
                </span>
                <span className="defi-explore-main">
                  <strong>
                    {chain.name}{" "}
                    <small className="defi-explore-vm">{chain.vm}</small>
                  </strong>
                  <small>
                    {t("v114.protocolsOnChain", {
                      count: chain.protocolCount,
                    })}
                    {chain.chainId &&
                      ` · ${t("v114.chainId")} ${chain.chainId}`}
                    {" · "}
                    {chain.capabilities
                      .filter((c) => SHOWN_CAPS.includes(c))
                      .map((c) => t(`v114.cap_${c}` as MessageKey))
                      .join(" · ") || t("v114.cap_CATALOG")}
                  </small>
                </span>
              </div>
            </div>
          );
        })}
        <div ref={bottomPad} aria-hidden="true" />
      </div>
      {cursor && (
        <button
          className="secondary"
          disabled={busy || firstPageBusy}
          onClick={more}
        >
          {t("v114.loadMore")}
        </button>
      )}
      {version && (
        <p className="input-hint">
          {t("v114.catalogVersion")}: <bdi dir="ltr">{version}</bdi>
        </p>
      )}
      <dialog
        className="defi-dialog"
        ref={modal}
        aria-labelledby="defi-explore-detail"
        {...modalProps(() => setDetail(undefined))}
      >
        <div className="dialog-head">
          <h2 id="defi-explore-detail">
            {detail?.identity.name ?? t("v114.exploreTitle")}
          </h2>
          <button
            aria-label={t("v113.close")}
            onClick={() => modal.current?.close()}
          >
            <Icon name="close" size={20} />
          </button>
        </div>
        {detail && (
          <>
            <p>
              {detail.category}
              {detail.identity.parent &&
                ` · ${t("v114.parent")}: ${detail.identity.parent.name}`}
            </p>
            <h3>{t("v114.otherbridgeCoverage")}</h3>
            {detail.coverage && (
              <span className={`pill tone-${tone(detail.coverage.headline)}`}>
                {covLabel(detail.coverage.headline)}
              </span>
            )}
            <p>
              {t("v114.reviewedAdapter")}:{" "}
              {detail.reviewedAdapters.length
                ? detail.reviewedAdapters
                    .map((a) => `${a.product} (${a.adapterVersion})`)
                    .join("; ")
                : t("v114.noAdapter")}
            </p>
            {(() => {
              const w = wallet(detail);
              return (
                <div className="defi-explore-wallet">
                  <h3>{t("v114.walletPosition")}</h3>
                  <p>{w.text}</p>
                  {w.at && (
                    <p className="input-hint">
                      {t("v114.lastChecked")}:{" "}
                      {new Date(w.at).toLocaleString(lang)}
                    </p>
                  )}
                  {w.found > 0 && (
                    <button
                      className="secondary"
                      onClick={() => {
                        modal.current?.close();
                        onOpenDefi();
                      }}
                    >
                      {t("v114.openDefi")}
                    </button>
                  )}
                </div>
              );
            })()}
            <h3>{t("v114.coverageByChain")}</h3>
            <ul className="defi-explore-chains">
              {detail.chains.map((c) => (
                <li key={c.key}>
                  <span>
                    {c.name ?? t("v114.reasonNoChain")}
                    {c.vm && <small className="defi-explore-vm">{c.vm}</small>}
                  </span>
                  {c.coverage.map((r, i) => (
                    <span key={i} className="defi-explore-chain-state">
                      <span className={`pill tone-${tone(r.status)}`}>
                        {covLabel(r.status)}
                      </span>
                      {r.status !== "FULL_POSITION" && (
                        <small>{t(reasonKey(r.reason))}</small>
                      )}
                    </span>
                  ))}
                </li>
              ))}
            </ul>
            <aside
              className="defi-explore-tvl"
              aria-label={t("v114.tvlContext")}
            >
              <span>{t("v114.tvlContext")}</span>
              <bdi dir="ltr">
                {money(detail.tvlContext.totalUsd, lang) ?? t("v114.tvlNone")}
              </bdi>
            </aside>
            {detail.identity.websiteHost && (
              <p className="input-hint">
                {t("v114.website")}:{" "}
                <bdi dir="ltr">{detail.identity.websiteHost}</bdi>
              </p>
            )}
            <p className="input-hint">
              {t("v114.catalogVersion")}:{" "}
              <bdi dir="ltr">{detail.catalogVersion}</bdi> ·{" "}
              <bdi dir="ltr">{detail.identity.id}</bdi>
            </p>
          </>
        )}
      </dialog>
    </section>
  );
}
