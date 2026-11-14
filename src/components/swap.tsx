"use client";
import { useEffect, useRef, useState } from "react";
import dynamic from "next/dynamic";
import { useI18n } from "../i18n/provider";
import { readCatalog } from "../routing/client";
import type { Asset, Catalog, Network } from "../routing/model";
import type {
  Holding,
  PortfolioIdentity,
  PortfolioResult,
} from "../portfolio/model";
import NetworkSelector from "./network-selector";
import { ChainLogo, chainThemeClass } from "./multichain-identity";
import { Icon } from "./icons";
import { PageHeader, Pill, Skeleton, EmptyState, shortAddress } from "./ui";
import { RouteKindSwitch, useRouteKind } from "./route-kind";
// G12: the reviewed NEAR Intents route (a cross-network swap into a NEAR token), loaded only when chosen.
const NearRoute = dynamic(() => import("./near-route"), { ssr: false });
const SwapIntelligence = dynamic(() => import("./swap-intelligence"), {
  // Keep the surrounding page heading visible while the route editor loads.
  loading: () => <Skeleton lines={3} className="trade-skeleton" />,
});
export default function Swap({
  account,
  walletRevision,
  walletChain,
  portfolio,
  portfolioIdentity,
  prefill,
  guardianDraft,
  onConnect,
}: {
  account: string;
  walletRevision: number;
  walletChain?: number;
  portfolio?: PortfolioResult;
  portfolioIdentity?: PortfolioIdentity;
  prefill?: { network: Network; token: Holding };
  /** A Guardian chat draft (exact tokens and amount) that only fills the screen: quoting stays the user's action. */
  guardianDraft?: { sourceId: string; from: Asset; to: Asset; amount: string };
  onConnect?: () => void;
}) {
  const { t, lang } = useI18n(),
    [catalog, setCatalog] = useState<Catalog>(),
    [network, setNetwork] = useState<Network | undefined>(prefill?.network),
    [picker, setPicker] = useState(false),
    [error, setError] = useState(false),
    [attempt, setAttempt] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);
  const [routeKind, setRouteKind] = useRouteKind();
  useEffect(() => {
    const c = new AbortController();
    readCatalog(c.signal, attempt > 0)
      .then((value) => {
        setError(false);
        setCatalog(value);
        const routable = (n: Network) =>
          n.mainnet && n.provider === "routing-core";
        setNetwork(
          (previous) =>
            previous ??
            value.networks.find(
              (n) => routable(n) && n.id === guardianDraft?.sourceId,
            ) ??
            // A connected EVM wallet starts on its own network when Swap can read routes there.
            value.networks.find(
              (n) => routable(n) && walletChain && n.id === String(walletChain),
            ) ??
            value.networks.find((n) => n.key === "eth") ??
            value.networks.find(routable)!,
        );
      })
      .catch(() => {
        if (!c.signal.aborted) setError(true);
      });
    return () => c.abort();
    // The starting network is chosen once per catalog read; later wallet changes never move the user's choice.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);
  const walletNetwork = catalog?.networks.find(
    (n) => walletChain && n.id === String(walletChain),
  );
  return (
    <section className="swap-page">
      <PageHeader
        title={t("v13.swap")}
        lede={t("v115.preview")}
        meta={
          <>
            {account ? (
              <Pill tone="ok" dot>
                <bdi dir="ltr">{shortAddress(account)}</bdi>
                {walletNetwork ? ` · ${walletNetwork.name}` : ""}
              </Pill>
            ) : (
              onConnect && (
                <button className="pill-button" onClick={onConnect}>
                  <Icon name="wallet" size={14} />
                  {t("product.connect")}
                </button>
              )
            )}
          </>
        }
      />
      <RouteKindSwitch kind={routeKind} onChange={setRouteKind} mode="swap" />
      {routeKind === "near" ? (
        <div className="bridge-grid trade-grid near-route-grid">
          <NearRoute
            account={account}
            walletChain={walletChain}
            mode="swap"
            onConnect={onConnect}
          />
        </div>
      ) : network ? (
        <SwapIntelligence
          key={`${network.id}:${walletRevision}:${account}`}
          network={network}
          account={account}
          walletEpoch={walletRevision}
          portfolio={portfolio}
          watchAddress={
            network.ecosystem === "SVM"
              ? portfolioIdentity?.solana
              : portfolioIdentity?.evm
          }
          prefill={
            prefill?.network.id === network.id ? prefill.token : undefined
          }
          guardianDraft={
            guardianDraft?.sourceId === network.id ? guardianDraft : undefined
          }
          header={
            <div className="card-top swap-card-top">
              <h2>{t("v13.swap")}</h2>
              <button
                ref={trigger}
                className={`network-box network-tinted network-select-trigger swap-network ${chainThemeClass(network)}`}
                onClick={() => setPicker(true)}
                aria-label={t("ui.selectSourceNetwork")}
                aria-haspopup="dialog"
              >
                <ChainLogo network={network} size="sm" />
                <strong>{network.name}</strong>
                <Icon name="chevronDown" />
              </button>
            </div>
          }
        />
      ) : (
        <div className="bridge-grid trade-grid swap-layout is-unquoted">
          <section className="card bridge-card swap-card">
            <div className="card-top">
              <h2>{t("v13.swap")}</h2>
            </div>
            {error ? (
              <EmptyState
                icon="alert"
                title={t("routingErrors.PROVIDER_UNAVAILABLE")}
                actions={
                  <button
                    className="secondary"
                    onClick={() => {
                      setError(false);
                      setAttempt((v) => v + 1);
                    }}
                  >
                    <Icon name="refresh" size={16} />
                    {t("product.refresh")}
                  </button>
                }
              >
                <p role="alert">{t("errors.UPSTREAM_UNAVAILABLE")}</p>
              </EmptyState>
            ) : (
              <>
                <p role="status" className="sr-only">
                  {t("ui.loading")}
                </p>
                <Skeleton lines={2} className="trade-skeleton" />
                <Skeleton lines={2} className="trade-skeleton" />
                <Skeleton lines={1} className="trade-skeleton is-short" />
              </>
            )}
          </section>
        </div>
      )}
      {picker && network && (
        <NetworkSelector
          role="source"
          selected={network}
          lang={lang}
          catalog={catalog}
          onCatalog={setCatalog}
          onSelect={setNetwork}
          onClose={() => {
            setPicker(false);
            trigger.current?.focus();
          }}
          portfolio={portfolio}
        />
      )}
    </section>
  );
}
