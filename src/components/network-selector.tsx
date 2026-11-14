"use client";
import { useI18n } from "../i18n/provider";
import type { Locale } from "../i18n/config";

import { useEffect, useRef, useState } from "react";
import { readCatalog, routingMessage } from "../routing/client";
import type { Catalog, Network } from "../routing/model";
import { ChainLogo, chainThemeClass } from "./multichain-identity";
import { cssomPosition } from "./virtual";
import {
  sortNetworks,
  chainHoldings,
  detectedValue,
  portfolioStale,
  type PortfolioResult,
} from "../portfolio/model";
import { formatFiat } from "../i18n/amounts";
import { readActiveCatalog } from "../catalog/client";
import type { ActiveCatalog } from "../catalog/model";
import { neutralTheme } from "../routing/catalog";
import { Icon } from "./icons";
import "./icons-extra";
import { modalProps, openModal } from "./dialog";
import chainIdentities from "../registry/chain-identities.client.json" with { type: "json" };
import {
  environmentOf as classifyEnvironment,
  type ChainEnvironment,
  type ClientChainIdentity,
} from "../registry/chain-identity";
// V1.11: canonical chain identities (environment + sanitized local logo) for catalog-only networks.
const identities = chainIdentities as unknown as Record<
  string,
  ClientChainIdentity
>;
// The committed registry decides first; a network it does not know yet (a new routing or TVL-catalog row) gets the
// same rules as the sync: the routing mainnet flag, or positive locked value (active catalog rows are TVL > 0), and
// a test/dev-looking name always moves it away from mainnet. Never a silent "mainnet" guess.
const environmentOf = (n: {
  id: string;
  name: string;
  mainnet: boolean;
  provider: string;
}): ChainEnvironment => {
  const id = n.id.replace(/^chain:/, "");
  return (
    identities[id]?.[0] ??
    classifyEnvironment(
      n.provider === "catalog"
        ? { id, name: n.name, tvlPositive: true }
        : { id, name: n.name, routingMainnet: n.mainnet },
    ).environment
  );
};
type CatalogDisplay = {
  id: string;
  key: string;
  name: string;
  ecosystem: "";
  mainnet: true;
  provider: "catalog";
  theme: Network["theme"];
};
export default function NetworkSelector({
  role,
  selected,
  lang,
  catalog,
  onCatalog,
  onSelect,
  onClose,
  portfolio,
}: {
  role: "source" | "destination";
  selected: Network;
  lang: Locale;
  catalog?: Catalog;
  onCatalog: (c: Catalog) => void;
  onSelect: (n: Network) => void;
  onClose: () => void;
  portfolio?: PortfolioResult;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    request = useRef<AbortController | null>(null);
  const [query, setQuery] = useState(""),
    [activeCatalog, setActiveCatalog] = useState<ActiveCatalog>(),
    [top, setTop] = useState(0),
    [active, setActive] = useState(0),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(!catalog),
    [tab, setTab] = useState("all"),
    // Mainnets by default; the testnet section only when the current selection is a testnet.
    [environment, setEnvironment] = useState<"mainnet" | "testnet">(
      selected.mainnet ? "mainnet" : "testnet",
    ),
    [searchAll, setSearchAll] = useState(false),
    [favorites, setFavorites] = useState<string[]>(() => {
      try {
        return JSON.parse(
          localStorage.getItem("otherbridge:favorite-networks") ?? "[]",
        )
          .filter((v: unknown) => typeof v === "string")
          .slice(0, 20);
      } catch {
        return [];
      }
    }),
    [recent] = useState<string[]>(() => {
      try {
        return JSON.parse(
          localStorage.getItem("otherbridge:recent-networks") ?? "[]",
        )
          .filter((v: unknown) => typeof v === "string")
          .slice(0, 8);
      } catch {
        return [];
      }
    });
  const { t } = useI18n();
  useEffect(() => {
    const c = new AbortController();
    readActiveCatalog(c.signal)
      .then(setActiveCatalog)
      .catch(() => {});
    return () => c.abort();
  }, []);
  useEffect(() => {
    openModal(dialog.current);
    search.current?.focus();
  }, []);
  useEffect(() => {
    const c = new AbortController();
    request.current = c;
    if (!catalog)
      readCatalog(c.signal)
        .then(onCatalog)
        .catch(() => {
          if (!c.signal.aborted) setError("PROVIDER_UNAVAILABLE");
        })
        .finally(() => {
          if (!c.signal.aborted) setLoading(false);
        });
    return () => c.abort();
  }, [catalog, onCatalog]);
  const routeNetworks = sortNetworks(
    catalog?.networks ?? [],
    role === "source" ? portfolio : undefined,
  );
  const other: CatalogDisplay[] = (activeCatalog?.chains ?? [])
    .filter((c) => !routeNetworks.some((n) => n.id === c.chainId))
    .map((c) => {
      const identity = identities[c.chainId ?? c.id];
      return {
        id: c.id,
        key: c.id,
        name: c.name,
        ecosystem: "",
        mainnet: true,
        provider: "catalog",
        // Sanitized same-origin logo from the chain identity registry (exact chain id), else the neutral mark.
        theme: identity?.[1]
          ? {
              ...neutralTheme,
              logo: identity[1],
              provenance: "Chain identity registry",
            }
          : neutralTheme,
      } as CatalogDisplay;
    });
  const wanted: ChainEnvironment = environment;
  const counts = {
    mainnet: [...routeNetworks, ...other].filter(
      (n) => environmentOf(n) === "mainnet",
    ).length,
    testnet: [...routeNetworks, ...other].filter(
      (n) => environmentOf(n) === "testnet",
    ).length,
  };
  const list = [...routeNetworks, ...other].filter(
    (n) =>
      // Search stays inside the active environment unless "search all networks" is on.
      ((searchAll && query) || environmentOf(n) === wanted) &&
      (tab !== "recent" || recent.includes(n.id)) &&
      (tab !== "favorites" || favorites.includes(n.id)) &&
      `${n.name} ${n.key} ${n.id} ${n.ecosystem}`
        .toLocaleLowerCase()
        .includes(query.toLocaleLowerCase()),
  );
  const start = Math.max(0, Math.floor(top / 72) - 2),
    visible = list.slice(start, start + 10);
  function closePicker() {
    dialog.current?.close();
  }
  function choose(n: Network | CatalogDisplay) {
    if (n.provider === "catalog") return;
    try {
      localStorage.setItem(
        "otherbridge:recent-networks",
        JSON.stringify([n.id, ...recent.filter((v) => v !== n.id)].slice(0, 8)),
      );
    } catch {}
    onSelect(n);
    closePicker();
  }
  function move(index: number) {
    const i = Math.max(0, Math.min(index, list.length - 1));
    setActive(i);
    if (scroll.current) {
      scroll.current.scrollTop = Math.max(0, i * 72 - 144);
      setTop(scroll.current.scrollTop);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="network-picker"
      aria-labelledby="picker-title"
      {...modalProps(onClose)}
    >
      <div className="card-top">
        <div>
          <p className="micro">
            {role === "source"
              ? t("ui.sourceNetwork")
              : t("ui.destinationNetwork")}
          </p>
          <h2 id="picker-title">{t("ui.selectANetwork")}</h2>
        </div>
        <button
          className="icon-button"
          onClick={closePicker}
          aria-label={t("ui.close")}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <label className="sr-only" htmlFor="network-search">
        {t("ui.searchNetworks")}
      </label>
      <div className="picker-search">
        <Icon name="search" size={16} />
        <input
          ref={search}
          id="network-search"
          autoFocus
          placeholder={t("ui.networkEcosystemOrChainID")}
          value={query}
          role="combobox"
          aria-expanded="true"
          aria-controls="network-options"
          aria-activedescendant={
            list[active] ? `network-option-${list[active].id}` : undefined
          }
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setTop(0);
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
      <div
        className="segmented environment-tabs"
        role="group"
        aria-label={t("v111.environment")}
      >
        {(["mainnet", "testnet"] as const).map((env) => (
          <button
            key={env}
            type="button"
            aria-pressed={environment === env}
            data-environment={env}
            onClick={() => {
              setEnvironment(env);
              move(0);
            }}
          >
            {t(env === "mainnet" ? "v111.mainnets" : "v111.testnets")}
            <span className="count">
              {new Intl.NumberFormat(lang).format(counts[env])}
            </span>
          </button>
        ))}
      </div>
      {environment === "testnet" && (
        <p className="notice tone-warn" role="note">
          {t("v111.testnetNote")}
        </p>
      )}
      <label className="toggle search-all">
        <input
          type="checkbox"
          checked={searchAll}
          onChange={(e) => setSearchAll(e.target.checked)}
        />
        <span>{t("v111.searchAllNetworks")}</span>
      </label>
      <div className="picker-tools">
        <button
          aria-pressed={tab === "all"}
          onClick={() => {
            setTab("all");
            move(0);
          }}
        >
          {t("ui.allNetworks")}
        </button>
        <button
          aria-pressed={tab === "recent"}
          onClick={() => {
            setTab("recent");
            move(0);
          }}
        >
          {t("ui.recent")}
        </button>
        <span>
          {list.length} {t("ui.networks")}
        </span>
        <button
          aria-pressed={tab === "favorites"}
          onClick={() => {
            setTab("favorites");
            move(0);
          }}
        >
          {t("v13.favorites")}
        </button>
        <button
          aria-pressed={favorites.includes(selected.id)}
          onClick={() => {
            const next = favorites.includes(selected.id)
              ? favorites.filter((id) => id !== selected.id)
              : [selected.id, ...favorites].slice(0, 20);
            setFavorites(next);
            try {
              localStorage.setItem(
                "otherbridge:favorite-networks",
                JSON.stringify(next),
              );
            } catch {}
          }}
        >
          {t("v13.favorites")} · {selected.name}
        </button>
      </div>
      <p className="micro">
        {t(
          role === "source" &&
            portfolio?.holdings.some((h) => BigInt(h.balance) > 0n && !h.spam)
            ? "v13.yourNetworks"
            : "v13.otherNetworks",
        )}
      </p>
      {loading && <p role="status">{t("ui.loadingNetworks")}</p>}
      {(error || catalog?.stale) && (
        <p className="notice" role="status">
          {routingMessage(error || "STALE_CATALOG", lang)}
        </p>
      )}
      {!loading && !list.length && (
        <p role="status">{t("ui.noMatchingNetwork")}</p>
      )}
      <div
        ref={scroll}
        id="network-options"
        role="listbox"
        aria-label={t("ui.supportedNetworks")}
        className="picker-list"
        onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      >
        <div
          className="virtual-spacer"
          ref={cssomPosition({ height: list.length * 72 })}
        >
          {visible.map((n, i) => (
            <button
              id={`network-option-${n.id}`}
              key={n.id}
              role="option"
              aria-selected={n.id === selected.id}
              aria-disabled={n.provider === "catalog"}
              aria-posinset={start + i + 1}
              aria-setsize={list.length}
              tabIndex={-1}
              className={`picker-option network-tinted virtual-row ${chainThemeClass(n)} ${start + i === active ? "active" : ""}`}
              data-chain={n.id}
              ref={cssomPosition({ top: (start + i) * 72 })}
              onClick={() => choose(n)}
            >
              <ChainLogo network={n} />
              <span>
                <strong>{n.name}</strong>
                {role === "source" &&
                  chainHoldings(portfolio, n.id).length > 0 && (
                    <small className="holding-badge">
                      {t("v13.yourNetworks")} ·{" "}
                      {detectedValue(chainHoldings(portfolio, n.id))
                        ? formatFiat(
                            detectedValue(chainHoldings(portfolio, n.id)),
                            lang,
                          )
                        : t("product.balance")}
                    </small>
                  )}
                {environmentOf(n) !== "mainnet" && (
                  <span className="pill tone-warn env-badge">
                    {t(
                      environmentOf(n) === "testnet"
                        ? "v111.testnet"
                        : "v111.environmentUnknown",
                    )}
                  </span>
                )}
                <small>
                  {n.ecosystem} · {n.id}
                  {n.provider === "otherbridge-onebridge"
                    ? ` · ${t("ui.custom")}`
                    : ""}
                  {n.provider === "catalog" ? ` · ${t("v13.noRoute")}` : ""}
                </small>
              </span>
            </button>
          ))}
        </div>
      </div>
      {portfolio && portfolioStale(portfolio) && (
        <p className="notice">{t("v13.stale")}</p>
      )}
      <p className="input-hint">{t("ui.aListedNetworkDoesNotGuarantee")}</p>
      <button
        className="small picker-refresh"
        disabled={loading}
        onClick={() => {
          request.current?.abort();
          const c = new AbortController();
          request.current = c;
          setLoading(true);
          setError("");
          readCatalog(c.signal, true)
            .then(onCatalog)
            .catch(() => setError("PROVIDER_UNAVAILABLE"))
            .finally(() => setLoading(false));
        }}
      >
        <Icon name="refresh" size={14} />
        {t("ui.refreshCatalog")}
      </button>
    </dialog>
  );
}
