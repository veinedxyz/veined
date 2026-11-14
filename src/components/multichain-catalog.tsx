"use client";
import { useI18n } from "../i18n/provider";
import { G5_STATUS } from "../g5/status";
import type { Locale } from "../i18n/config";

import { useEffect, useState } from "react";
import { readActiveCatalog } from "../catalog/client";
import type { ActiveCatalog } from "../catalog/model";
import {
  chainHoldings,
  detectedValue,
  type PortfolioResult,
} from "../portfolio/model";
import { formatUsd, formatUsdCompact } from "../i18n/amounts";
import type { Catalog } from "../routing/model";
import { readCatalog, routingMessage } from "../routing/client";
import { ChainLogo, chainThemeClass } from "./multichain-identity";
import { cssomPosition } from "./virtual";
import { LogoImage } from "./logo-image";
import { Icon } from "./icons";
import { Pill, Skeleton, type Tone } from "./ui";
import { publishGuardianFacts } from "./guardian-context";
import chainIdentities from "../registry/chain-identities.client.json" with { type: "json" };
import {
  environmentOf as classifyEnvironment,
  type ClientChainIdentity,
} from "../registry/chain-identity";
// V1.11: canonical chain identity (environment, sanitized logo, explorer) by exact chain id.
const identities = chainIdentities as unknown as Record<
  string,
  ClientChainIdentity
>;
// V1.10: compact capability rows (88 px) instead of tall cards; the list stays virtualized and CSP-safe.
const ROW = 88;
export default function MultichainCatalog({
  lang,
  portfolio,
}: {
  lang: Locale;
  portfolio?: PortfolioResult;
}) {
  const [catalog, setCatalog] = useState<Catalog>(),
    [search, setSearch] = useState(""),
    [error, setError] = useState("");
  const [active, setActive] = useState<ActiveCatalog>(),
    [filter, setFilter] = useState("all"),
    [environment, setEnvironment] = useState<"mainnet" | "testnet">("mainnet"),
    [top, setTop] = useState(0);
  useEffect(() => {
    const c = new AbortController();
    readCatalog(c.signal)
      .then(setCatalog)
      .catch(() => {
        if (!c.signal.aborted) setError("PROVIDER_UNAVAILABLE");
      });
    readActiveCatalog(c.signal)
      .then(setActive)
      .catch(() => {});
    return () => c.abort();
  }, []);
  const { t } = useI18n();
  // The active TVL catalog lists mainnets only; testnets come from the routing catalog's own environment flag.
  const testnets =
    catalog?.networks
      .filter((n) => !n.mainnet)
      .map((n) => ({
        id: `chain:${n.id}`,
        name: n.name,
        chainId: n.id,
        network: n,
        capability: {
          catalogVisible: true as const,
          portfolio: "unsupported" as const,
          bridge: "unsupported" as const,
          swap: "unsupported" as const,
          wallet: "available" as const,
          tvlUsd: null,
          observedAt: catalog.observedAt,
        },
      })) ?? [];
  // Registry first; otherwise the sync rules (routing flag, or positive TVL for active-catalog rows; a test/dev name
  // always moves a network away from mainnet).
  const envOf = (c: {
    chainId: string | null;
    id: string;
    name: string;
    network?: { mainnet: boolean };
    capability?: { tvlUsd: number | null };
  }) =>
    identities[c.chainId ?? c.id]?.[0] ??
    classifyEnvironment(
      c.network
        ? {
            id: c.chainId ?? c.id,
            name: c.name,
            routingMainnet: c.network.mainnet,
          }
        : {
            id: c.chainId ?? c.id,
            name: c.name,
            tvlPositive: (c.capability?.tvlUsd ?? 0) > 0,
          },
    ).environment;
  const all = [
    ...(active?.chains ??
      catalog?.networks
        .filter((n) => n.mainnet)
        .map((n) => ({
          id: `chain:${n.id}`,
          name: n.name,
          chainId: n.id,
          network: n,
          capability: {
            catalogVisible: true,
            portfolio: "unsupported",
            bridge:
              n.provider === "otherbridge-onebridge"
                ? "custom-gated"
                : "quoteable",
            swap: "quoteable",
            wallet: "available",
            tvlUsd: null,
            observedAt: catalog.observedAt,
          },
        })) ??
      []),
    ...testnets,
  ];
  const envCount = (e: string) => all.filter((c) => envOf(c) === e).length;
  // Guardian assistant context: the coverage counts this list shows (mainnets), once the list is loaded.
  const mainnets = all.filter((c) => envOf(c) === "mainnet");
  const assistantContext =
    active || catalog
      ? JSON.stringify({
          total: mainnets.length,
          bridge: mainnets.filter((c) => c.capability.bridge === "quoteable")
            .length,
          swap: mainnets.filter((c) => c.capability.swap === "quoteable")
            .length,
          tokens: mainnets.filter(
            (c) =>
              c.capability.portfolio !== "unsupported" &&
              c.capability.portfolio !== "native-only",
          ).length,
          native: mainnets.filter(
            (c) => c.capability.portfolio === "native-only",
          ).length,
          none: mainnets.filter((c) => c.capability.portfolio === "unsupported")
            .length,
          testnets: envCount("testnet"),
        })
      : "";
  useEffect(() => {
    publishGuardianFacts(
      "networks",
      assistantContext ? JSON.parse(assistantContext) : undefined,
    );
  }, [assistantContext]);
  useEffect(() => () => publishGuardianFacts("networks", undefined), []);
  const entries = all
    .filter(
      (c) =>
        envOf(c) === environment &&
        `${c.name} ${c.chainId} ${c.network?.ecosystem ?? ""}`
          .toLowerCase()
          .includes(search.toLowerCase()) &&
        (filter === "all" ||
          (filter === "my" &&
            chainHoldings(portfolio, c.chainId ?? "").length > 0) ||
          (filter === "bridge" && c.capability.bridge === "quoteable") ||
          (filter === "swap" && c.capability.swap === "quoteable") ||
          (filter === "portfolio" &&
            c.capability.portfolio !== "unsupported") ||
          (filter === "custom" && c.capability.bridge === "custom-gated")),
    )
    .sort(
      (a, b) =>
        Number(chainHoldings(portfolio, b.chainId ?? "").length > 0) -
          Number(chainHoldings(portfolio, a.chainId ?? "").length > 0) ||
        detectedValue(chainHoldings(portfolio, b.chainId ?? "")) -
          detectedValue(chainHoldings(portfolio, a.chainId ?? "")) ||
        Number(b.capability.bridge === "quoteable") -
          Number(a.capability.bridge === "quoteable") ||
        (b.capability.tvlUsd ?? 0) - (a.capability.tvlUsd ?? 0) ||
        a.id.localeCompare(b.id),
    );
  const start = Math.max(0, Math.floor(top / ROW) - 1),
    visible = entries.slice(start, start + 8);
  const capability = (label: string, state: string): [Tone, string] =>
    state === "quoteable"
      ? ["ok", label]
      : state === "custom-gated"
        ? [
            "warn",
            `${label} · ${t(G5_STATUS === "PASS" ? "ui.g5VerifiedReadOnly" : "ui.g5Blocked")}`,
          ]
        : ["neutral", `${label} · ${t("v13.noRoute")}`];
  return (
    <section className="catalog-section" aria-labelledby="catalog-title">
      <div className="section-head">
        <div>
          <h2 id="catalog-title">{t("ui.networkCatalog")}</h2>
          <p>{t("ui.networksAvailableFromCurrentRouteData")}</p>
        </div>
        <p className="catalog-count">
          <strong>{new Intl.NumberFormat(lang).format(entries.length)}</strong>{" "}
          {t("ui.networksSendingDisabled")}
          {active && (
            <small>
              {new Intl.DateTimeFormat(lang, {
                dateStyle: "short",
                timeStyle: "short",
              }).format(active.observedAt)}{" "}
              {active.stale ? t("v13.stale") : ""}
            </small>
          )}
        </p>
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
              setTop(0);
            }}
          >
            {t(env === "mainnet" ? "v111.mainnets" : "v111.testnets")}
            <span className="count">
              {new Intl.NumberFormat(lang).format(envCount(env))}
            </span>
          </button>
        ))}
      </div>
      <div className="catalog-tools">
        <div className="search-field">
          <Icon name="search" size={16} />
          <label className="sr-only" htmlFor="catalog-search">
            {t("ui.searchNetworks")}
          </label>
          <input
            id="catalog-search"
            value={search}
            autoComplete="off"
            onChange={(e) => {
              setSearch(e.target.value);
              setTop(0);
            }}
            placeholder={t("ui.networkNameOrEcosystem")}
          />
        </div>
        <div
          className="chip-row"
          role="group"
          aria-label={t("ui.networkCatalog")}
        >
          {(
            ["all", "my", "bridge", "swap", "portfolio", "custom"] as const
          ).map((f) => (
            <button
              key={f}
              className="chip"
              aria-pressed={filter === f}
              onClick={() => {
                setFilter(f);
                setTop(0);
              }}
            >
              {t(
                f === "all"
                  ? "v13.allActive"
                  : f === "my"
                    ? "v13.myNetworks"
                    : f === "custom"
                      ? "v13.customRoutes"
                      : f === "portfolio"
                        ? "v13.portfolio"
                        : f === "swap"
                          ? "v13.swap"
                          : "product.bridge",
              )}
            </button>
          ))}
        </div>
      </div>
      <p className="input-hint catalog-note">
        <Icon name="info" size={13} />
        {t("v13.quoteRequired")}
      </p>
      {!catalog && !error && (
        <>
          <p role="status" className="sr-only">
            {t("ui.loading")}
          </p>
          <Skeleton lines={4} className="card" />
        </>
      )}
      {(error || catalog?.stale) && (
        <p className="notice" role="status">
          {routingMessage(error || "STALE_CATALOG", lang)}
        </p>
      )}
      {catalog && !entries.length && (
        <p className="picker-empty" role="status">
          {t("ui.noMatchingNetwork")}
        </p>
      )}
      <div
        className="active-catalog-list"
        tabIndex={0}
        role="region"
        aria-label={t("ui.networks")}
        onScroll={(e) => setTop(e.currentTarget.scrollTop)}
      >
        <div
          className="virtual-spacer"
          ref={cssomPosition({ height: entries.length * ROW })}
        >
          {visible.map((c, i) => {
            const n = c.network,
              held = detectedValue(chainHoldings(portfolio, c.chainId ?? "")),
              // V1.22 UX: a network nobody scanned shows "—", never a fabricated $0.00.
              scanned = !!portfolio?.coverage.some(
                (v) => v.chainId === c.chainId && v.native === "CHECKED",
              );
            const caps = [
              capability(t("product.bridge"), c.capability.bridge),
              capability(t("v13.swap"), c.capability.swap),
            ];
            return (
              <article
                key={c.id}
                tabIndex={0}
                className={`card network-tinted virtual-row active-catalog-row ${chainThemeClass(n)}`}
                ref={cssomPosition({ top: (start + i) * ROW })}
                data-chain={c.chainId ?? c.id}
              >
                <div className="catalog-id">
                  {n ? (
                    <ChainLogo network={n} />
                  ) : (
                    <span className="network-mark network-mark-md nt-neutral">
                      <LogoImage
                        src={
                          identities[c.chainId ?? c.id]?.[1] ||
                          "/networks/neutral.svg"
                        }
                        size={32}
                      />
                    </span>
                  )}
                  <div>
                    <h3>{c.name}</h3>
                    <p>
                      {n?.ecosystem ? `${n.ecosystem} · ` : ""}
                      <bdi dir="ltr">{c.chainId ?? c.id}</bdi>
                    </p>
                  </div>
                </div>
                <div className="catalog-caps">
                  {envOf(c) !== "mainnet" && (
                    <Pill tone="warn">{t("v111.testnet")}</Pill>
                  )}
                  {caps.map(([tone, label]) => (
                    <Pill
                      key={label}
                      tone={tone}
                      title={
                        tone === "ok"
                          ? t("v111.quotesSendingDisabled")
                          : undefined
                      }
                    >
                      {label}
                    </Pill>
                  ))}
                  <Pill
                    tone={
                      c.capability.portfolio === "unsupported"
                        ? "neutral"
                        : "info"
                    }
                  >
                    {c.capability.portfolio === "unsupported"
                      ? t("v13.unavailable")
                      : `${t("v13.coverage")} · ${t(
                          c.capability.portfolio === "native-only"
                            ? "v13.nativeOnly"
                            : "v13.walletTokens",
                        )}`}
                  </Pill>
                </div>
                <dl className="catalog-figures">
                  <div>
                    <dt>{t("v13.tvl")}</dt>
                    <dd>
                      {c.capability.tvlUsd === null
                        ? t("ui.unknown")
                        : formatUsdCompact(c.capability.tvlUsd, lang)}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("v13.value")}</dt>
                    <dd>{scanned ? formatUsd(held, lang) : "—"}</dd>
                  </div>
                </dl>
              </article>
            );
          })}
        </div>
      </div>
    </section>
  );
}
