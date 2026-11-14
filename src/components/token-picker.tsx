"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n/provider";
import type { Locale } from "../i18n/config";
import { formatTokenAmount, formatUsd } from "../i18n/amounts";
import type { Asset, Network } from "../routing/model";
import { chainHoldings, type PortfolioResult } from "../portfolio/model";
import { Icon } from "./icons";
import { shortAddress } from "./ui";
import { TideTag, TokenMark, type TideKind } from "./ocean-marks";
import { modalProps, openModal } from "./dialog";
import {
  pushRecent,
  readImported,
  readRecent,
  registryList,
  registrySearch,
  saveImported,
  tokenPreview,
  type AssetView,
  type ImportedToken,
  type PreviewStep,
} from "../assets/client";
import {
  isSolanaMint,
  SOLANA_CHAIN_ID,
  type AssetLevel,
  type RiskFlag,
} from "../assets/model";

// V1.11 token picker (Swap + Bridge). Default list: wallet-held routable → native → canonical/curated → market
// listed → recent/imported — never a raw provider dump. Search: symbol/name (curated first, then exact market
// listings from the route list) or an EXACT address (registry → route list → explicit lookup + "Import token").
// Identity is network + exact address; nothing is ever selected by symbol, and only route-supported, non-blocked
// assets are selectable ("No verified route" otherwise).
type Row = {
  key: string;
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  native: boolean;
  level: AssetLevel;
  risk: RiskFlag[];
  logoUrl: string | null;
  routable: boolean;
  group: number;
  held?: { balance: string; decimals: number; usd: number | null };
  imported?: boolean;
  recent?: boolean;
};
const GROUP_LABEL = [
  "v111.yourTokens",
  "v111.popular",
  "v111.marketListed",
  "v111.recentImported",
  "v111.searchResults",
] as const;
const LEVEL_KEY: Record<AssetLevel, string> = {
  CANONICAL: "v111.levelCanonical",
  CURATED: "v111.levelCurated",
  MARKET_LISTED: "v111.levelMarketListed",
  DEX_DISCOVERED: "v111.levelDexDiscovered",
  IMPORTED_UNVERIFIED: "v111.levelImported",
  BLOCKED: "v111.levelBlocked",
};
// Ocean marks: each trust level has its own glyph (pearl, current, sonar, buoy, reef) and a quiet tone.
const LEVEL_MARK: Record<
  AssetLevel,
  [TideKind, "calm" | "glow" | "amber" | "coral" | "mute"]
> = {
  CANONICAL: ["pearl", "glow"],
  CURATED: ["pearl", "glow"],
  MARKET_LISTED: ["current", "calm"],
  DEX_DISCOVERED: ["sonar", "amber"],
  IMPORTED_UNVERIFIED: ["buoy", "amber"],
  BLOCKED: ["reef", "coral"],
};
const evm = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a);
const norm = (a: string) => (evm(a) ? a.toLowerCase() : a);
// Display order only: identity, trust level and route checks always use the exact address.
const familiarSymbol = (r: Row) =>
  r.level === "CANONICAL" || r.level === "CURATED"
    ? ["USDC", "USDT", "DAI", "WETH", "WBTC", "wSOL"].indexOf(r.symbol) + 1 ||
      100
    : 100;
export default function TokenPicker({
  role,
  assets,
  selected,
  network,
  portfolio,
  lang,
  onSelect,
  onClose,
  allowQuoteDiscovery = false,
  onSelectAsset,
}: {
  role: "source" | "destination";
  /** Route-supported assets for this side (connections / chain list). Only these are selectable. */
  assets: Asset[];
  selected: string;
  network: Network;
  portfolio?: PortfolioResult;
  lang: Locale;
  onSelect: (address: string) => void;
  onClose: () => void;
  allowQuoteDiscovery?: boolean;
  /** Guardian: the selected row's registry evidence travels with the exact asset (never inferred from the symbol). */
  onSelectAsset?: (
    asset: Asset,
    evidence?: { level: AssetLevel; risk: RiskFlag[] },
  ) => void;
}) {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    scroll = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState(""),
    [active, setActive] = useState(0),
    [importedNotice, setImportedNotice] = useState(""),
    [registry, setRegistry] = useState<AssetView[]>([]),
    [remote, setRemote] = useState<{
      q: string;
      results: AssetView[];
      lookup: boolean;
    } | null>(null),
    [imported, setImported] = useState<ImportedToken[]>(() =>
      readImported(network.id),
    ),
    [recent] = useState<string[]>(() => readRecent(network.id)),
    [preview, setPreview] = useState<{
      address: string;
      busy: boolean;
      error?: string;
      result?: Awaited<ReturnType<typeof tokenPreview>>;
    } | null>(null);
  useEffect(() => {
    openModal(dialog.current);
    search.current?.focus();
  }, []);
  useEffect(() => {
    const c = new AbortController();
    registryList(network.id, c.signal)
      .then(setRegistry)
      .catch(() => setRegistry([]));
    return () => c.abort();
  }, [network.id]);
  const q = query.trim();
  const isAddress = network.id === SOLANA_CHAIN_ID ? isSolanaMint(q) : evm(q);
  // Server search: symbol/name (≥ 2 characters) or an exact address not already known locally.
  useEffect(() => {
    if (q.length < 2) return;
    const c = new AbortController();
    const timer = setTimeout(() => {
      registrySearch(network.id, q, c.signal)
        .then((r) => setRemote({ q, ...r }))
        .catch(() => setRemote({ q, results: [], lookup: isAddress }));
    }, 250);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [q, isAddress, network.id]);
  const route = useMemo(
    () => new Map(assets.map((a) => [norm(a.address), a])),
    [assets],
  );
  const held = chainHoldings(portfolio, network.id);
  const native = norm(network.nativeAsset.address);
  const rows = useMemo(() => {
    const out = new Map<string, Row>();
    const add = (r: Omit<Row, "key">) => {
      const key = norm(r.address);
      const prev = out.get(key);
      if (!prev || r.group < prev.group) out.set(key, { ...prev, ...r, key });
    };
    const holding = (a: string) =>
      held.find((h) => norm(h.address) === norm(a));
    const reg = new Map(registry.map((r) => [norm(r.address), r]));
    const fromRoute = (a: Asset, group: number, extra: Partial<Row> = {}) => {
      const r = reg.get(norm(a.address));
      const h = role === "source" ? holding(a.address) : undefined;
      add({
        address: a.address,
        symbol: a.symbol,
        name: a.name,
        decimals: a.decimals,
        native: norm(a.address) === native,
        level:
          norm(a.address) === native
            ? "CANONICAL"
            : (r?.level ?? "IMPORTED_UNVERIFIED"),
        risk: r?.risk ?? [],
        logoUrl: r?.logoUrl ?? null,
        routable:
          (allowQuoteDiscovery || route.has(norm(a.address))) &&
          r?.level !== "BLOCKED",
        group,
        ...(h
          ? { held: { balance: h.balance, decimals: h.decimals, usd: h.usd } }
          : {}),
        ...extra,
      });
    };
    // 1. wallet-held (source side), route-supported, never suspicious/unverified metadata
    if (role === "source")
      for (const h of held)
        if (
          !h.suspicious &&
          h.metadataVerified !== false &&
          (allowQuoteDiscovery || route.has(norm(h.address)))
        )
          fromRoute(route.get(norm(h.address)) ?? h, 0);
    // 2. native + canonical/curated registry entries
    const nativeAsset = route.get(native) ?? network.nativeAsset;
    fromRoute(nativeAsset, 1);
    for (const r of registry) {
      if (r.level === "BLOCKED") continue;
      const group = r.level === "CANONICAL" || r.level === "CURATED" ? 1 : 2;
      const a = route.get(norm(r.address));
      add({
        address: a?.address ?? r.address,
        symbol: r.symbol,
        name: r.name,
        decimals: r.decimals,
        native: r.native,
        level: r.level,
        risk: r.risk,
        logoUrl: r.logoUrl,
        routable: allowQuoteDiscovery || !!a,
        group,
      });
    }
    // 4. recent + imported (exact addresses)
    for (const a of recent) {
      const ra = route.get(norm(a));
      if (ra) fromRoute(ra, 3, { recent: true });
    }
    for (const it of imported)
      add({
        address: route.get(it.address)?.address ?? it.address,
        symbol: it.symbol,
        name: it.name,
        decimals: it.decimals,
        native: false,
        level: reg.get(it.address)?.level ?? "IMPORTED_UNVERIFIED",
        risk: reg.get(it.address)?.risk ?? [],
        logoUrl: it.logoUrl,
        routable:
          (allowQuoteDiscovery || route.has(it.address)) &&
          reg.get(it.address)?.level !== "BLOCKED",
        group: 3,
        imported: true,
      });
    // 5. server search results (exact market listings from the route list, or an exact address hit)
    if (remote && remote.q === q)
      for (const r of remote.results)
        add({
          address: route.get(norm(r.address))?.address ?? r.address,
          symbol: r.symbol,
          name: r.name,
          decimals: r.decimals,
          native: r.native,
          level: r.level,
          risk: r.risk,
          logoUrl: r.logoUrl,
          routable:
            (allowQuoteDiscovery || route.has(norm(r.address))) &&
            r.level !== "BLOCKED",
          group: 4,
        });
    // an exact address present in the route list is always findable
    if (isAddress && route.has(norm(q)) && !out.has(norm(q)))
      fromRoute(route.get(norm(q))!, 4);
    return [...out.values()];
  }, [
    registry,
    remote,
    imported,
    recent,
    held,
    route,
    native,
    network.nativeAsset,
    role,
    q,
    isAddress,
    allowQuoteDiscovery,
  ]);
  const ql = q.toLocaleLowerCase();
  const list = rows
    .filter(
      (r) =>
        !ql ||
        (isAddress
          ? norm(r.address) === norm(q)
          : `${r.symbol} ${r.name}`.toLocaleLowerCase().includes(ql) ||
            norm(r.address) === norm(q)),
    )
    .sort(
      (a, b) =>
        a.group - b.group ||
        Number(b.routable) - Number(a.routable) ||
        (b.held?.usd ?? -1) - (a.held?.usd ?? -1) ||
        Number(b.native) - Number(a.native) ||
        familiarSymbol(a) - familiarSymbol(b) ||
        a.symbol.localeCompare(b.symbol, "en"),
    )
    .slice(0, 150);
  const canLookup =
    isAddress &&
    !list.some((r) => norm(r.address) === norm(q)) &&
    !!remote &&
    remote.q === q &&
    remote.lookup;
  function close() {
    dialog.current?.close();
  }
  function choose(r: Row) {
    if (!r.routable) return;
    pushRecent(network.id, r.address);
    onSelect(r.address);
    onSelectAsset?.(
      {
        chainId: network.id,
        address: r.address,
        symbol: r.symbol,
        name: r.name,
        decimals: r.decimals,
      },
      { level: r.level, risk: r.risk },
    );
    close();
  }
  function move(index: number) {
    const i = Math.max(0, Math.min(index, list.length - 1));
    setActive(i);
    document
      .getElementById(`token-option-${i}`)
      ?.scrollIntoView({ block: "nearest" });
  }
  async function lookup() {
    const address = norm(q);
    setPreview({ address, busy: true });
    try {
      const result = await tokenPreview(network.id, address);
      setPreview({ address, busy: false, result });
    } catch (e) {
      setPreview({
        address,
        busy: false,
        error: String((e as { code?: string }).code ?? "PROVIDER_UNAVAILABLE"),
      });
    }
  }
  function importToken() {
    const a = preview?.result?.asset;
    if (!a || !preview?.result?.importable) return;
    setImported(
      saveImported({
        chainId: network.id,
        address: a.address,
        symbol: a.symbol,
        name: a.name,
        decimals: a.decimals,
        logoUrl: a.logoUrl,
        importedAt: Date.now(),
      }),
    );
    setQuery(a.address);
    setImportedNotice(a.symbol);
    setActive(0);
    setPreview(null);
  }
  const badge = (r: Pick<Row, "level" | "risk" | "native">) => (
    <>
      <TideTag
        kind={r.native ? "native" : LEVEL_MARK[r.level][0]}
        tone={r.native ? "glow" : LEVEL_MARK[r.level][1]}
        className="level-badge"
      >
        {t((r.native ? "v111.levelNative" : LEVEL_KEY[r.level]) as never)}
      </TideTag>
      {r.risk.includes("SYMBOL_IMPERSONATION") && (
        <TideTag kind="reef" tone="coral" className="level-badge">
          {t("v111.riskImpersonation")}
        </TideTag>
      )}
    </>
  );
  // One mark system for every row: the reviewed logo, the network's own logo for its native asset, or a generated
  // medallion; a token on this network never needs a second network badge inside the picker.
  const mark = (r: Pick<Row, "native" | "logoUrl" | "symbol" | "address">) => (
    <TokenMark
      symbol={r.symbol}
      seed={r.address}
      logo={r.native ? network.theme.logo : r.logoUrl}
      size="lg"
    />
  );
  // With a query the results form one group; without, the ranked sections are labelled groups.
  const groups: [number, { r: Row; i: number }[]][] = [];
  list.forEach((r, i) => {
    const g = q ? 4 : r.group;
    const last = groups.at(-1);
    if (last && last[0] === g) last[1].push({ r, i });
    else groups.push([g, [{ r, i }]]);
  });
  return (
    <dialog
      ref={dialog}
      className="token-picker"
      aria-labelledby="token-picker-title"
      {...modalProps(onClose)}
    >
      <div className="dialog-top">
        <div>
          <p className="micro">
            {role === "source" ? t("ui.sourceToken") : t("ui.destinationToken")}{" "}
            · {network.name}
          </p>
          <h2 id="token-picker-title">{t("v110.selectToken")}</h2>
        </div>
        <button
          className="icon-button"
          onClick={close}
          aria-label={t("ui.close")}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      {importedNotice && (
        <p className="import-success" role="status">
          <Icon name="check" size={14} />
          {importedNotice} · {t("v1122.tokenAdded")}
        </p>
      )}
      <div className="picker-search">
        <Icon name="search" size={16} />
        <label className="sr-only" htmlFor="token-search">
          {t("ui.searchSymbolOrAddress")}
        </label>
        <input
          ref={search}
          id="token-search"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("v111.searchTokenPlaceholder")}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="token-options"
          aria-activedescendant={
            list[active] ? `token-option-${active}` : undefined
          }
          onChange={(e) => {
            setQuery(e.target.value.slice(0, 80));
            setActive(0);
            setPreview(null);
            if (scroll.current) scroll.current.scrollTop = 0;
          }}
          onKeyDown={(e) => {
            if (
              ["ArrowDown", "ArrowUp", "Home", "End", "Enter"].includes(e.key)
            ) {
              e.preventDefault();
              if (e.key === "Enter" && list[active]) choose(list[active]);
              else
                move(
                  e.key === "Home"
                    ? 0
                    : e.key === "End"
                      ? list.length - 1
                      : active + (e.key === "ArrowDown" ? 1 : -1),
                );
            }
          }}
        />
      </div>
      {!list.length && !canLookup && (
        <p className="picker-empty" role="status">
          {q && !isAddress ? t("v111.noMatchPasteAddress") : t("v110.noTokens")}
        </p>
      )}
      {canLookup && !preview && (
        <div className="import-lookup">
          <p>{t("v111.addressNotListed")}</p>
          <button className="secondary" onClick={() => void lookup()}>
            <Icon name="search" size={15} />
            {t("v111.lookUpToken")}
          </button>
        </div>
      )}
      {preview && (
        <section
          className="import-preview"
          aria-live="polite"
          aria-labelledby="import-preview-title"
        >
          <h3 id="import-preview-title">{t("v111.importPreview")}</h3>
          {preview.busy && <p role="status">{t("v111.checkingToken")}</p>}
          {preview.error && (
            <p className="notice tone-danger">{t("v111.lookupFailed")}</p>
          )}
          {preview.result && (
            <>
              {preview.result.asset && (
                <div className="import-head">
                  {mark(preview.result.asset)}
                  <span>
                    <strong>
                      <bdi>{preview.result.asset.symbol}</bdi>
                    </strong>
                    <small>
                      <bdi>{preview.result.asset.name}</bdi> ·{" "}
                      <code dir="ltr">
                        {shortAddress(preview.result.asset.address)}
                      </code>
                    </small>
                  </span>
                  {badge(preview.result.asset)}
                </div>
              )}
              <ul className="import-steps">
                {preview.result.steps.map((s: PreviewStep) => (
                  <li key={s.step} className={s.ok ? "is-ok" : "is-todo"}>
                    <Icon name={s.ok ? "check" : "minus"} size={14} />
                    <span>{t(`v111.step.${s.step}` as never)}</span>
                    <small dir="ltr">{s.detail}</small>
                  </li>
                ))}
              </ul>
              {preview.result.warnings.length > 0 && (
                <ul className="import-warnings">
                  {preview.result.warnings.map((w) => (
                    <li key={w} className="notice tone-warn">
                      {t(`v111.risk.${w}` as never)}
                    </li>
                  ))}
                </ul>
              )}
              <p className="input-hint">{t("v111.importDisclaimer")}</p>
              <div className="dialog-actions">
                <button className="secondary" onClick={() => setPreview(null)}>
                  {t("ui.close")}
                </button>
                <button
                  className="primary"
                  disabled={!preview.result.importable}
                  onClick={importToken}
                >
                  {t("v111.importToken")}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      <div
        ref={scroll}
        id="token-options"
        role="listbox"
        aria-label={t("v110.selectToken")}
        className="token-list"
      >
        {groups.map(([group, members]) => (
          <div
            key={group}
            role="group"
            aria-labelledby={q ? undefined : `token-group-${group}`}
            aria-label={q ? t(GROUP_LABEL[4]) : undefined}
          >
            {!q && (
              <p id={`token-group-${group}`} className="micro picker-group">
                {t(GROUP_LABEL[Math.min(group, 4)])}
              </p>
            )}
            {members.map(({ r, i }) => (
              <button
                key={r.key}
                id={`token-option-${i}`}
                role="option"
                tabIndex={-1}
                aria-selected={norm(r.address) === norm(selected)}
                aria-disabled={!r.routable}
                className={`token-option${i === active ? " active" : ""}${r.routable ? "" : " is-unroutable"}`}
                data-token-option={r.address}
                data-level={r.level}
                onClick={() => choose(r)}
              >
                {mark(r)}
                <span className="token-meta">
                  <span className="token-title">
                    <strong>
                      <bdi>{r.symbol}</bdi>
                    </strong>
                    <span className="token-badges">
                      {badge(r)}
                      {!r.routable && (
                        <TideTag
                          kind="still"
                          tone="mute"
                          className="level-badge"
                        >
                          {t("v111.noVerifiedRoute")}
                        </TideTag>
                      )}
                    </span>
                  </span>
                  <small>
                    <bdi>{r.name}</bdi>
                    {!r.native && (
                      <>
                        {" "}
                        · <code dir="ltr">{shortAddress(r.address)}</code>
                      </>
                    )}
                  </small>
                </span>
                <span className="token-side">
                  {r.held ? (
                    <>
                      <bdi dir="ltr">
                        {formatTokenAmount(
                          BigInt(r.held.balance),
                          r.held.decimals,
                          lang,
                          6,
                        )}
                      </bdi>
                      {r.held.usd !== null && (
                        <small>{formatUsd(r.held.usd, lang)}</small>
                      )}
                    </>
                  ) : null}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
      <p className="input-hint">{t("v111.tokenListNote")}</p>
    </dialog>
  );
}
