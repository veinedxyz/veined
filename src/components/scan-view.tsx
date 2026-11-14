"use client";
// G12 H06 — VEINED Scan: a read-only place to follow a transfer, where each section says where its data comes from.
// Two kinds of source are kept apart and are never mixed:
//   1. "Your saved route previews": the route quotes saved in THIS browser (they are quotes, not transactions) and, for
//      each, the status of a transfer the user made themselves and attached by its hash. The status is read from the
//      route source through VEINED's own API and bound to that preview's networks, assets, amount, sender and recipient
//      by the accepted observation (routing-observation.tsx); without that match it is unverified, never delivered.
//      What "delivered" rests on is said on the page (the route source's report; VEINED does not check the two networks
//      itself; an earlier transfer with identical details would match too). Sending is closed in this build, so no row
//      here was sent through VEINED, and the page says so.
//   2. "Ecosystem activity": a public feed needs a licensed source. None is connected (G12 provider matrix), so the
//      section says exactly that and shows NO rows. Invented rows that only demonstrate the layout appear solely with
//      ?demo=synthetic and each one is labelled Synthetic.
// Nothing is signed, approved or sent. What leaves the browser: the network catalog read on load; and, only when the
// user presses the observation button, the hash with that preview's details to VEINED's own server (which forwards the
// hash and the two networks to the route source). Nothing goes from the browser to a third party.
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useI18n } from "../i18n/provider";
import type { Locale } from "../i18n/config";
import { stateMessage } from "../i18n/messages";
import { formatTokenAmount } from "../i18n/amounts";
import { publicToolLabel } from "../content/public-labels";
import { readPreviews, type RoutePreview } from "../routing/history";
import { readCatalog } from "../routing/client";
import type { Catalog } from "../routing/model";
import { registryList, type AssetView } from "../assets/client";
import { ChainBadge } from "./multichain-identity";
import RoutingObservation from "./routing-observation";
import { Icon } from "./icons";
import { PageHeader, Pill, shortAddress } from "./ui";

type Filter = "all" | "attached" | "none";
/** Layout demonstration only (?demo=synthetic): invented, labelled, never mixed with real rows, never "delivered". */
const SYNTHETIC = [
  { id: "synthetic-1", from: "Base", to: "Arbitrum", state: "PENDING" },
  { id: "synthetic-2", from: "Ethereum", to: "Base", state: "UNKNOWN" },
  { id: "synthetic-3", from: "Polygon", to: "BNB Chain", state: "FAILED" },
] as const;
type Resolved = { symbol: string; decimals: number };

export default function ScanView({ lang }: { lang: Locale }) {
  const { t } = useI18n();
  const [records, setRecords] = useState<RoutePreview[]>(() => readPreviews()),
    [catalog, setCatalog] = useState<Catalog>(),
    [registry, setRegistry] = useState<Record<string, AssetView[]>>({}),
    [query, setQuery] = useState(""),
    [filter, setFilter] = useState<Filter>("all");
  const [demo] = useState(
    () =>
      new URLSearchParams(window.location.search).get("demo") === "synthetic",
  );
  useEffect(() => {
    const c = new AbortController();
    readCatalog(c.signal)
      .then(setCatalog)
      .catch(() => {});
    // The list follows the store: another tab (storage event) and this tab (a hash attached by the observation below
    // is written here without an event), so the store is re-read on a short interval and applied only when it changed.
    const update = () =>
      setRecords((current) => {
        const next = readPreviews();
        return JSON.stringify(next) === JSON.stringify(current)
          ? current
          : next;
      });
    window.addEventListener("storage", update);
    const timer = setInterval(update, 1500);
    return () => {
      c.abort();
      clearInterval(timer);
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
  // Tokens are resolved by network + EXACT address (never by symbol); an unresolved token shows its exact short
  // address and no amount (its decimals are unknown).
  const resolve = useMemo(
    () =>
      (chain: string, address: string): Resolved | null => {
        const same = (a: string) =>
          chain === "1151111081099710"
            ? a === address
            : a.toLowerCase() === address.toLowerCase();
        const n = catalog?.networks.find((x) => x.id === chain);
        if (n && same(n.nativeAsset.address))
          return {
            symbol: n.nativeAsset.symbol,
            decimals: n.nativeAsset.decimals,
          };
        const a = registry[chain]?.find((x) => same(x.address));
        return a ? { symbol: a.symbol, decimals: a.decimals } : null;
      },
    [catalog, registry],
  );
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return records.filter(
      (r) =>
        (filter === "all" ||
          (filter === "attached" ? !!r.sourceHash : !r.sourceHash)) &&
        (!q ||
          [
            r.sourceHash ?? "",
            r.sourceName,
            r.destinationName,
            r.sourceAsset,
            r.destinationAsset,
            resolve(r.source, r.sourceAsset)?.symbol ?? "",
            resolve(r.destination, r.destinationAsset)?.symbol ?? "",
            r.sourceAddress,
            r.destinationAddress,
          ].some((v) => v.toLowerCase().includes(q))),
    );
  }, [records, query, filter, resolve]);
  const network = (id: string, name: string) => {
    const n = catalog?.networks.find((x) => x.id === id);
    return n ? <ChainBadge network={n} /> : <bdi>{name}</bdi>;
  };
  const networkName = (id: string) =>
    catalog?.networks.find((x) => x.id === id)?.name ?? id;
  const token = (chain: string, address: string, amount: string) => {
    const r = resolve(chain, address);
    return r ? (
      <bdi dir="ltr" title={address}>
        {formatTokenAmount(BigInt(amount), r.decimals, lang, 6)} {r.symbol}
      </bdi>
    ) : (
      <code dir="ltr" title={address}>
        {shortAddress(address)}
      </code>
    );
  };
  return (
    <div className="scan-view" data-testid="scan-view">
      <PageHeader title="VEINED Scan" lede={t("g12.scan.lede")} />
      <section
        className="catalog-section scan-section"
        aria-labelledby="scan-veined"
        data-testid="scan-veined"
        data-source="veined-preview"
      >
        <div className="section-head">
          <div>
            <h2 id="scan-veined">{t("g12.scan.veinedTitle")}</h2>
            <p>{t("g12.scan.veinedBody")}</p>
          </div>
        </div>
        <p className="notice" data-testid="scan-not-through-veined">
          <Icon name="lock" size={14} /> {t("g12.scan.notThroughVeined")}
        </p>
        {records.length === 0 ? (
          <p className="scan-empty" data-testid="scan-empty">
            {t("g12.scan.empty")}{" "}
            <Link href="/bridge">{t("product.bridge")} →</Link>
          </p>
        ) : (
          <>
            <div className="scan-tools">
              <label className="scan-search">
                <span className="sr-only">{t("g12.scan.search")}</span>
                <input
                  type="search"
                  value={query}
                  placeholder={t("g12.scan.search")}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={200}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <div role="group" aria-label={t("g12.scan.filterLabel")}>
                {(
                  [
                    ["all", t("product.all")],
                    ["attached", t("g12.scan.attached")],
                    ["none", t("g12.scan.notAttached")],
                  ] as const
                ).map(([value, label]) => (
                  <button
                    key={value}
                    type="button"
                    className="small"
                    aria-pressed={filter === value}
                    onClick={() => setFilter(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <p className="micro" role="status" data-testid="scan-count">
              {t("g12.scan.count", {
                shown: shown.length,
                total: records.length,
              })}
            </p>
            <div className="preview-list">
              {shown.map((r) => (
                <details
                  key={r.id}
                  className="card preview-card scan-row"
                  data-testid="scan-row"
                  data-hash={r.sourceHash ? "attached" : "none"}
                >
                  <summary>
                    <Pill tone="info">{t("ui.previewOnly")}</Pill>
                    <span className="preview-summary-main">
                      <strong>
                        <bdi dir="ltr">
                          {r.sourceName}
                          {r.source !== r.destination
                            ? ` → ${r.destinationName}`
                            : ""}
                        </bdi>
                      </strong>
                      <small>
                        {new Date(r.observedAt).toLocaleString(lang)} ·{" "}
                        {r.sourceHash
                          ? t("g12.scan.attached")
                          : t("g12.scan.notAttached")}
                      </small>
                    </span>
                    <Icon
                      name="chevronDown"
                      size={16}
                      className="preview-chevron"
                    />
                  </summary>
                  <div className="preview-body">
                    <div className="route-identity">
                      <span className="preview-badge">
                        {network(r.source, r.sourceName)}
                      </span>
                      {r.source !== r.destination && (
                        <span className="preview-badge">
                          {network(r.destination, r.destinationName)}
                        </span>
                      )}
                    </div>
                    <p className="preview-tokens" data-testid="scan-amounts">
                      {token(r.source, r.sourceAsset, r.amount)}
                      <Icon name="arrowRight" size={14} className="flip-rtl" />
                      {token(r.destination, r.destinationAsset, r.expected)}
                    </p>
                    <dl className="scan-parties">
                      <div>
                        <dt>{t("v111.from")}</dt>
                        <dd>
                          <code
                            className="native-address"
                            dir="ltr"
                            title={r.sourceAddress}
                          >
                            {shortAddress(r.sourceAddress)}
                          </code>
                        </dd>
                      </div>
                      <div>
                        <dt>{t("v111.recipient")}</dt>
                        <dd>
                          <code
                            className="native-address"
                            dir="ltr"
                            title={r.destinationAddress}
                          >
                            {shortAddress(r.destinationAddress)}
                          </code>
                        </dd>
                      </div>
                    </dl>
                    <ol className="routing-steps" data-testid="scan-steps">
                      {r.steps.map((s, i) => (
                        <li key={i}>
                          {publicToolLabel(
                            catalog?.tools.find((x) => x.id === s.tool)?.name ??
                              s.tool,
                            lang,
                          )}{" "}
                          ·{" "}
                          <bdi dir="ltr">
                            {networkName(s.source)} →{" "}
                            {networkName(s.destination)}
                          </bdi>
                        </li>
                      ))}
                    </ol>
                    <RoutingObservation record={r} lang={lang} />
                  </div>
                </details>
              ))}
            </div>
            <p className="micro" data-testid="scan-basis">
              {t("g12.scan.basis")}
            </p>
          </>
        )}
        <p className="micro" data-testid="scan-privacy">
          {t("g12.scan.privacy")}
        </p>
      </section>
      <section
        className="catalog-section scan-section"
        aria-labelledby="scan-ecosystem"
        data-testid="scan-ecosystem"
        data-source="ecosystem"
        data-feed={demo ? "SYNTHETIC" : "BLOCKED_EXTERNAL_INPUT"}
      >
        <div className="section-head">
          <div>
            <h2 id="scan-ecosystem">{t("g12.scan.ecosystemTitle")}</h2>
            <p>{t("g12.scan.ecosystemBlocked")}</p>
          </div>
        </div>
        {demo && (
          <>
            <p className="notice tone-warn" data-testid="scan-demo-note">
              <Pill tone="warn">{t("g12.scan.demoPill")}</Pill>{" "}
              {t("g12.scan.demoBody")}
            </p>
            <ul className="scan-demo" data-testid="scan-demo">
              {SYNTHETIC.map((row) => (
                <li key={row.id} data-testid="scan-demo-row">
                  <Pill tone="warn">{t("g12.scan.demoPill")}</Pill>
                  <strong>
                    <bdi dir="ltr">
                      {row.from} → {row.to}
                    </bdi>
                  </strong>
                  <span>{stateMessage(lang, row.state)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
    </div>
  );
}
