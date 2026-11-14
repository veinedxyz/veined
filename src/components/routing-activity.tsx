"use client";
import { useI18n } from "../i18n/provider";
import type { Locale } from "../i18n/config";

import { publicToolLabel } from "../content/public-labels";
import { useEffect, useState } from "react";
import { readPreviews, type RoutePreview } from "../routing/history";
import { readCatalog } from "../routing/client";
import type { Catalog } from "../routing/model";
import { ChainBadge } from "./multichain-identity";
import RoutingObservation from "./routing-observation";
import { Icon } from "./icons";
import { LogoImage } from "./logo-image";
import { TokenAvatar, shortAddress } from "./ui";
import { formatTokenAmount } from "../i18n/amounts";
import { registryList, type AssetView } from "../assets/client";
// V1.11: tokens are resolved through the unified asset registry by network + EXACT address (never by symbol);
// an unresolved token shows its exact short address and no amount (decimals unknown).
type Resolved = { symbol: string; decimals: number; logo: string | null };
export default function RoutingActivity({ lang }: { lang: Locale }) {
  const { t } = useI18n();
  const [records, setRecords] = useState<RoutePreview[]>(() => readPreviews()),
    [catalog, setCatalog] = useState<Catalog>(),
    [registry, setRegistry] = useState<Record<string, AssetView[]>>({});
  useEffect(() => {
    const c = new AbortController();
    readCatalog(c.signal)
      .then(setCatalog)
      .catch(() => {});
    const update = () => setRecords(readPreviews());
    window.addEventListener("storage", update);
    return () => {
      c.abort();
      window.removeEventListener("storage", update);
    };
  }, []);
  const chainKey = [
    ...new Set(records.flatMap((r) => [r.source, r.destination])),
  ]
    .sort()
    .join(",");
  useEffect(() => {
    if (!chainKey) return;
    const c = new AbortController();
    for (const chain of chainKey.split(",").slice(0, 12))
      registryList(chain, c.signal)
        .then((assets) => setRegistry((m) => ({ ...m, [chain]: assets })))
        .catch(() => {});
    return () => c.abort();
  }, [chainKey]);
  const resolve = (chain: string, address: string): Resolved | null => {
    const same = (a: string) =>
      chain === "1151111081099710"
        ? a === address
        : a.toLowerCase() === address.toLowerCase();
    const n = catalog?.networks.find((x) => x.id === chain);
    if (n && same(n.nativeAsset.address))
      return {
        symbol: n.nativeAsset.symbol,
        decimals: n.nativeAsset.decimals,
        logo: n.theme.logo || null,
      };
    const a = registry[chain]?.find((x) => same(x.address));
    return a
      ? { symbol: a.symbol, decimals: a.decimals, logo: a.logoUrl }
      : null;
  };
  const token = (chain: string, address: string, amount: string) => {
    const r = resolve(chain, address);
    return (
      <span className="token-chip" title={address}>
        {r?.logo ? (
          <span className="token-logo">
            <LogoImage src={r.logo} size={20} />
          </span>
        ) : (
          <TokenAvatar symbol={r?.symbol ?? "?"} size="sm" />
        )}
        {r ? (
          <bdi dir="ltr">
            {formatTokenAmount(BigInt(amount), r.decimals, lang, 6)} {r.symbol}
          </bdi>
        ) : (
          <code dir="ltr">{shortAddress(address)}</code>
        )}
      </span>
    );
  };
  if (!records.length) return null;
  return (
    <section
      className="catalog-section previews"
      aria-labelledby="previews-title"
    >
      <div className="section-head">
        <div>
          <h2 id="previews-title">{t("ui.routePreviews")}</h2>
          <p>{t("ui.savedQuotesAreNotTransactionsLocal")}</p>
        </div>
      </div>
      <div className="preview-list">
        {records.map((r) => (
          <details key={r.id} className="card preview-card">
            <summary>
              <span className="pill tone-info">
                {t(r.source === r.destination ? "v13.swap" : "product.bridge")}
              </span>
              <span className="preview-summary-main">
                <strong>
                  {r.sourceName}
                  {r.source !== r.destination ? ` → ${r.destinationName}` : ""}
                </strong>
                <small>
                  {new Date(r.observedAt).toLocaleString(lang)} ·{" "}
                  {t("ui.previewOnly")}
                </small>
              </span>
              <Icon name="chevronDown" size={16} className="preview-chevron" />
            </summary>
            <div className="preview-body">
              <div className="route-identity">
                {[r.source, r.destination].map((id, i) => {
                  const n = catalog?.networks.find((n) => n.id === id);
                  return (
                    <span key={`${id}-${i}`} className="preview-badge">
                      {n ? <ChainBadge network={n} /> : <span>{id}</span>}
                    </span>
                  );
                })}
              </div>
              <p className="preview-meta">
                <Icon name="clock" size={13} />
                {new Date(r.observedAt).toLocaleString(lang)} ·{" "}
                {t("ui.previewOnly")}
              </p>
              <div className="review-addresses">
                <code className="native-address" title={r.sourceAddress}>
                  {shortAddress(r.sourceAddress)}
                </code>
                <code className="native-address" title={r.destinationAddress}>
                  {shortAddress(r.destinationAddress)}
                </code>
              </div>
              <p className="preview-tokens">
                {token(r.source, r.sourceAsset, r.amount)}
                <Icon name="arrowRight" size={14} className="flip-rtl" />
                {token(r.destination, r.destinationAsset, r.expected)}
              </p>
              <ol className="routing-steps">
                {r.steps.map((s, i) => (
                  <li key={i}>
                    {publicToolLabel(
                      catalog?.tools.find((t) => t.id === s.tool)?.name ??
                        s.tool,
                      lang,
                    )}{" "}
                    · {s.source} → {s.destination}
                  </li>
                ))}
              </ol>
              <RoutingObservation record={r} lang={lang} />
            </div>
          </details>
        ))}
      </div>
    </section>
  );
}
