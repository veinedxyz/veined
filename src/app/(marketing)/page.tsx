import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { OceanStage } from "./ocean-stage";
import "./ocean-landing.css";
import "./deep-landing.css";
// VWP G08: the Almanac landing layer (open water, ruled readings, tide-line section shores) is loaded last.
import "./almanac-landing.css";
import chainFile from "../../registry/chain-identities.generated.json" with { type: "json" };
import registryFile from "../../assets/registry.generated.json" with { type: "json" };
import routingSnapshot from "../../routing/catalog-snapshot.json" with { type: "json" };
import tvlSnapshot from "../../catalog/snapshot.json" with { type: "json" };
import type { ChainIdentity } from "../../registry/chain-identity";
import { locales } from "../../i18n/config";
import { platformFeePolicy } from "../../routing/fee-policy";
import { marketingLocale } from "./locale";
import { brandMetadata } from "../../server/brand-metadata";
import { Medallion, TideGlyph, TideTag } from "../../components/ocean-glyphs";
// V1.11 public landing page (server-rendered, no wallet/portfolio/routing/G7 client code). Every number on this page
// is computed from the committed registries at render time; product visuals are labelled illustrations.
// Ocean film candidate: the whole page is one descent through the owner's underwater film, from the surface at the
// hero to the ocean floor at the closing call; scroll position picks the frame (ocean-stage.tsx). The stage is
// decorative, aria-hidden and never a pointer target.
// Deep refinement (ux5): less copy, one clear idea per depth. Each product section keeps its title and one paragraph;
// its details live in the illustration (token marks and tide tags instead of bullet lists). "How it works" is a
// descent with depth markers; safety is a four-part trust architecture. The token and tag language is the
// application's own (components/ocean-glyphs.tsx), rendered on the server without client code.
export async function generateMetadata(): Promise<Metadata> {
  const { t } = await marketingLocale();
  return brandMetadata(
    t("landing.metaTitle"),
    t("landing.metaDescription"),
    "/",
  );
}
const chains = (chainFile as { chains: ChainIdentity[] }).chains;
const assets = (registryFile as { assets: { level: string }[] }).assets;
const routingMainnets =
  (
    routingSnapshot as {
      chains: { chains: { id: string; mainnet: boolean }[] };
    }
  ).chains.chains.filter((c) => c.mainnet).length + 1; // + the custom ONEchain route
const tvl = new Map(
  (tvlSnapshot as { raw: { chainId?: unknown; tvl?: unknown }[] }).raw
    .filter((r) => r.chainId != null && typeof r.tvl === "number")
    .map((r) => [String(r.chainId), Number(r.tvl)]),
);
const logoCloud = chains
  .filter((c) => c.environment === "mainnet" && c.logo && c.chainId)
  .sort((a, b) => (tvl.get(b.chainId!) ?? 0) - (tvl.get(a.chainId!) ?? 0))
  .slice(0, 24);
const byId = (id: string) => chains.find((c) => c.id === id);
/** A registry token's mark: its reviewed logo, or the generated medallion when it has none. */
function TokenMark({
  chain,
  address,
  symbol,
  badge,
}: {
  chain: string;
  address: string;
  symbol: string;
  badge?: string;
}) {
  const asset = (
    registryFile as {
      assets: {
        chainId: string;
        address: string;
        logo: { src: string } | null;
      }[];
    }
  ).assets.find((a) => a.chainId === chain && a.address === address);
  const network = badge ? byId(badge) : undefined;
  if (!asset?.logo) return <Medallion symbol={symbol} seed={address} />;
  return (
    <span className="tmark tmark-md" aria-hidden="true">
      <span className="tmark-face is-logo">
        {/* eslint-disable-next-line @next/next/no-img-element -- exact reviewed local registry image, strict CSP */}
        <img
          src={asset.logo.src}
          alt=""
          width={40}
          height={40}
          loading="lazy"
        />
      </span>
      {network?.logo && (
        <span className="tmark-badge">
          {/* eslint-disable-next-line @next/next/no-img-element -- sanitized same-origin asset, strict CSP */}
          <img
            src={network.logo}
            alt=""
            width={16}
            height={16}
            loading="lazy"
          />
        </span>
      )}
    </span>
  );
}
function Mark({ id, size = 28 }: { id: string; size?: number }) {
  const c = byId(id);
  return c?.logo ? (
    // eslint-disable-next-line @next/next/no-img-element -- sanitized same-origin asset; next/image adds inline style (CSP)
    <img
      src={c.logo}
      alt=""
      width={size}
      height={size}
      className="mk-logo"
      loading="lazy"
    />
  ) : (
    <span className="mk-logo mk-logo-fallback" aria-hidden="true">
      {(c?.shortName ?? "?").slice(0, 2)}
    </span>
  );
}
/** Line glyphs for the descent and the trust architecture (24 px grid, decorative). */
const GLYPH: Record<string, ReactNode> = {
  connect: (
    <>
      <path d="M8 12h8M5.5 9.5a3.5 3.5 0 0 1 0 5M18.5 9.5a3.5 3.5 0 0 0 0 5" />
      <circle cx="12" cy="12" r="8.5" strokeOpacity=".35" />
    </>
  ),
  find: (
    <>
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4M16.2 7.8a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14" />
    </>
  ),
  verify: (
    <>
      <path d="M12 3.5 19 6v5.6c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6l7-2.5Z" />
      <path d="m8.8 12.2 2.2 2.2 4.2-4.6" />
    </>
  ),
  decide: (
    <>
      <path d="M12 4v12M12 16c-3.6 0-6.5-1.6-7-4M12 16c3.6 0 6.5-1.6 7-4" />
      <circle cx="12" cy="4" r="1.6" />
      <path d="M8.5 20h7" />
    </>
  ),
  closed: (
    <>
      <path d="M12 3.5 19 6v5.6c0 4.2-2.9 7.6-7 8.9-4.1-1.3-7-4.7-7-8.9V6l7-2.5Z" />
      <path d="M9.5 11.5h5v3.5h-5zM10.5 11.5v-1.3a1.5 1.5 0 0 1 3 0v1.3" />
    </>
  ),
  shown: (
    <>
      <path d="M2.8 12s3.4-6 9.2-6 9.2 6 9.2 6-3.4 6-9.2 6-9.2-6-9.2-6Z" />
      <circle cx="12" cy="12" r="2.6" />
    </>
  ),
  approvals: (
    <>
      <rect x="5" y="10.5" width="14" height="9" rx="2" />
      <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5M12 14.2v2" />
    </>
  ),
  fees: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M14.8 9.2c-.5-.9-1.6-1.4-2.8-1.4-1.6 0-2.8.8-2.8 2 0 2.9 5.8 1.4 5.8 4.3 0 1.2-1.3 2.1-3 2.1-1.3 0-2.5-.6-3-1.6M12 6.2v1.6M12 16.2v1.6" />
    </>
  ),
};
function Glyph({ name }: { name: keyof typeof GLYPH }) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPH[name]}
    </svg>
  );
}
export default async function Landing() {
  const { t, locale } = await marketingLocale();
  const n = (v: number) => new Intl.NumberFormat(locale).format(v);
  const stats = {
    mainnets: chains.filter((c) => c.environment === "mainnet").length,
    routes: routingMainnets,
    curated: assets.filter(
      (a) => a.level === "CURATED" || a.level === "CANONICAL",
    ).length,
    languages: locales.length,
  };
  const feePercent = new Intl.NumberFormat(locale, {
    style: "percent",
    maximumFractionDigits: 2,
  }).format(platformFeePolicy.bps / 10_000);
  return (
    <div className="ocean-landing">
      {/* One ocean behind the whole page: the descent from the surface to the floor, driven by scroll. */}
      <OceanStage />

      <section className="mk-hero" aria-labelledby="mk-hero-title">
        <div className="mk-hero-copy">
          {/* gf1 G05: Guardian leads the promise (check before you move); the multichain reach follows as proof. The
              primary action asks Guardian; the app itself stays one click away in the header. */}
          <h1 id="mk-hero-title">{t("gf.ov.title")}</h1>
          <p className="mk-lede">{t("gf.ov.body")}</p>
          <p className="mk-lede mk-lede-secondary">{t("landing.heroLede")}</p>
          <div className="mk-cta">
            <Link href="/guardian" className="mk-button is-primary is-large">
              {t("gf.ov.ask")} <span aria-hidden="true">↗</span>
            </Link>
            <Link href="/docs" className="mk-button is-quiet is-large">
              {t("landing.readDocs")}
            </Link>
          </div>
          {/* Three promises and the honest product state, on one quiet line (no transaction CTA exists). */}
          <ul className="mk-assure">
            <li title={t("landing.trustNonCustodial")}>
              <TideGlyph kind="pearl" />
              {t("ux5.assureCustody")}
            </li>
            <li title={t("landing.trustReadOnlyScan")}>
              <TideGlyph kind="sonar" />
              {t("ux5.assureRead")}
            </li>
            <li title={t("landing.trustCoverage")}>
              <TideGlyph kind="depth" />
              {t("ux5.assureHonest")}
            </li>
            <li className="mk-hero-status" title={t("landing.statusNote")}>
              <span className="mk-hero-status-dot" aria-hidden="true" />
              {t("v115.closed")} · {t("ui.previewOnly")}
            </li>
          </ul>
        </div>
      </section>

      <nav className="mk-product-strip" aria-label={t("landing.launchApp")}>
        {(
          [
            ["swap", "v13.swap", "ux5.toolSwap"],
            ["bridge", "product.bridge", "ux5.toolBridge"],
            ["portfolio", "v13.portfolio", "ux5.toolPortfolio"],
          ] as const
        ).map(([id, title, description]) => (
          <Link key={id} href={`#${id}`}>
            <span>
              <strong>{t(title)}</strong>
              <small>{t(description)}</small>
            </span>
            <span aria-hidden="true">↓</span>
          </Link>
        ))}
      </nav>

      <section
        className="mk-section mk-split"
        id="swap"
        aria-labelledby="mk-swap"
      >
        <div className="mk-section-head">
          <h2 id="mk-swap">{t("landing.swapTitle")}</h2>
          <p>{t("landing.swapBody")}</p>
        </div>
        <figure
          className="mk-visual mk-scene mk-swap-scene"
          aria-label={t("landing.illustration")}
        >
          <div className="mk-panel mk-deep-panel">
            <p className="mk-panel-label">{t("landing.visualPicker")}</p>
            <ul className="mk-token-rows">
              <li>
                <TokenMark
                  chain="1"
                  address="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                  symbol="USDC"
                />
                <span className="mk-token-id">
                  <strong>USDC</strong>
                  <code dir="ltr">0xa0b8…eb48</code>
                </span>
                <TideTag kind="pearl" tone="glow">
                  {t("landing.visualCurated")}
                </TideTag>
              </li>
              <li>
                <TokenMark
                  chain="1"
                  address="0x514910771af9ca656af840dff83e8264ecf986ca"
                  symbol="LINK"
                />
                <span className="mk-token-id">
                  <strong>LINK</strong>
                  <code dir="ltr">0x5149…86ca</code>
                </span>
                <TideTag kind="current" tone="calm">
                  {t("landing.visualMarket")}
                </TideTag>
              </li>
              <li className="is-hazard">
                <Medallion symbol="USDC" seed="0x9f2c11e0" />
                <span className="mk-token-id">
                  <strong>USDC</strong>
                  <code dir="ltr">0x9f2c…11e0</code>
                </span>
                <TideTag kind="reef" tone="coral">
                  {t("landing.visualImpersonation")}
                </TideTag>
              </li>
            </ul>
          </div>
          <figcaption>{t("landing.illustration")}</figcaption>
        </figure>
      </section>

      <section
        className="mk-section mk-split"
        id="bridge"
        aria-labelledby="mk-bridge"
      >
        <div className="mk-section-head">
          <h2 id="mk-bridge">{t("landing.bridgeTitle")}</h2>
          <p>{t("landing.bridgeBody", { count: n(stats.routes) })}</p>
        </div>
        <figure
          className="mk-visual mk-scene mk-bridge-scene"
          aria-label={t("landing.illustration")}
        >
          <div className="mk-panel mk-deep-panel">
            <p className="mk-panel-label">{t("landing.visualRoute")}</p>
            <p className="mk-current">
              <span className="mk-current-end">
                <Mark id="8453" size={32} />
                <span>Base</span>
              </span>
              <span className="mk-current-line" aria-hidden="true" />
              <span className="mk-current-end">
                <Mark id="42161" size={32} />
                <span>Arbitrum</span>
              </span>
            </p>
            <dl className="mk-facts">
              <div>
                <dt>{t("landing.visualYouSend")}</dt>
                <dd>
                  <TokenMark
                    chain="8453"
                    address="0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
                    symbol="USDC"
                  />{" "}
                  5 USDC
                </dd>
              </div>
              <div>
                <dt>{t("landing.visualYouReceive")}</dt>
                <dd>
                  <TokenMark
                    chain="42161"
                    address="0xaf88d065e77c8cc2239327c5edb3a432268e5831"
                    symbol="USDC"
                  />{" "}
                  ≈ 4.98 USDC
                </dd>
              </div>
              <div>
                <dt>{t("landing.visualHealth")}</dt>
                <dd>
                  <TideTag kind="still" tone="amber">
                    {t("landing.visualHealthValue")}
                  </TideTag>
                </dd>
              </div>
            </dl>
          </div>
          <figcaption>{t("landing.illustration")}</figcaption>
        </figure>
      </section>

      <section
        className="mk-section mk-split"
        id="portfolio"
        aria-labelledby="mk-portfolio"
      >
        <div className="mk-section-head">
          <h2 id="mk-portfolio">{t("landing.portfolioTitle")}</h2>
          <p>{t("landing.portfolioBody")}</p>
          <Link
            href={
              locale === "tr"
                ? "/docs/portfolio#cuzdan-ve-defi"
                : "/docs/portfolio#wallet-and-defi"
            }
            className="mk-link"
          >
            {t("v1122.defiCoverage")} →
          </Link>
        </div>
        <figure
          className="mk-visual mk-scene mk-portfolio-scene"
          aria-label={t("landing.illustration")}
        >
          <div className="mk-panel mk-deep-panel">
            <p className="mk-panel-label">{t("landing.visualCoverage")}</p>
            <div className="mk-coverage" aria-hidden="true">
              <span className="c-ok" />
              <span className="c-pending" />
              <span className="c-failed" />
            </div>
            <ul className="mk-legend">
              <li className="is-ok">{t("landing.visualChecked")}</li>
              <li className="is-warn">{t("landing.visualPending")}</li>
              <li className="is-bad">{t("landing.visualFailed")}</li>
            </ul>
            <ul className="mk-token-rows">
              <li>
                <TokenMark
                  chain="1"
                  address="0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
                  symbol="USDC"
                  badge="1"
                />
                <span className="mk-token-id">
                  <strong>USDC</strong>
                  <code dir="ltr">1,250.00</code>
                </span>
                <TideTag kind="pearl" tone="glow">
                  {t("landing.visualCurated")}
                </TideTag>
              </li>
              <li>
                <TokenMark
                  chain="1"
                  address="0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"
                  symbol="WETH"
                  badge="1"
                />
                <span className="mk-token-id">
                  <strong>WETH</strong>
                  <code dir="ltr">0.8420</code>
                </span>
                <TideTag kind="pearl" tone="glow">
                  {t("landing.visualCurated")}
                </TideTag>
              </li>
              <li>
                <Medallion symbol="XYZ" seed="xyz" />
                <span className="mk-token-id">
                  <strong>XYZ</strong>
                  <code dir="ltr">1,000,000</code>
                </span>
                <TideTag kind="drift" tone="amber">
                  {t("landing.visualUnpriced")}
                </TideTag>
              </li>
            </ul>
          </div>
          <figcaption>{t("landing.illustration")}</figcaption>
        </figure>
      </section>

      <section className="mk-section" id="find" aria-labelledby="mk-find">
        <div className="mk-section-head">
          <h2 id="mk-find">{t("landing.findTitle")}</h2>
          <p>{t("landing.findBody")}</p>
        </div>
        {/* Three layers of the scan, from the surface down: native, curated sweep, indexed discovery. */}
        <ol className="mk-layers">
          {(
            [
              ["findNative", "native"],
              ["findCurated", "pearl"],
              ["findIndexed", "sonar"],
            ] as const
          ).map(([key, glyph], i) => (
            <li key={key}>
              <span className="mk-layer-mark" aria-hidden="true">
                <TideGlyph kind={glyph} />
                <span>{`L${i + 1}`}</span>
              </span>
              <h3>{t(`landing.${key}Title`)}</h3>
              <p>{t(`landing.${key}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="mk-section mk-split mk-points"
        id="points"
        aria-labelledby="mk-points"
      >
        <div className="mk-section-head">
          {/* gf1 G06: the owner's lifetime points direction (own points, fixed per verified activity, no sign-up points,
              10% referral, no public ranking); not active until the owner sets the numbers, and no pool is stated. */}
          <h2 id="mk-points">{t("points.nav")}</h2>
          <p>{t("points.lifetime.lede")}</p>
          {/* "How points will work" frames the rules as the future program, and the status is in the text column too,
              not only in the figure (review m7). */}
          <p>
            <strong>{t("points.lifetime.rules.title")}</strong>
            {" · "}
            {t("points.lifetime.pending")}
          </p>
          <ul className="mk-checks">
            <li>{t("points.lifetime.rules.fixed")}</li>
            <li>{t("points.lifetime.rules.noSignup")}</li>
            <li>{t("points.lifetime.rules.referral")}</li>
            <li>{t("points.lifetime.rules.private")}</li>
          </ul>
          <Link href="/points" className="mk-link">
            {t("points.nav")} →
          </Link>
        </div>
        <figure
          className="mk-visual mk-scene mk-points-scene"
          aria-label={t("landing.illustration")}
        >
          <div className="mk-panel mk-deep-panel">
            <p className="mk-panel-label">{t("points.lifetime.title")}</p>
            <p className="mk-points-pool">{t("points.lifetime.pending")}</p>
            <p className="mk-points-private">
              <span aria-hidden="true" />
              {t("points.lifetime.rules.private")}
            </p>
            <p className="mk-points-note">{t("points.how.value")}</p>
          </div>
          <figcaption>{t("landing.illustration")}</figcaption>
        </figure>
      </section>

      <section
        className="mk-section"
        id="networks"
        aria-labelledby="mk-networks"
      >
        <div className="mk-section-head">
          <h2 id="mk-networks">{t("landing.reachTitle")}</h2>
          <p>{t("landing.reachBody")}</p>
        </div>
        <dl className="mk-stats">
          <div>
            <dt>{t("landing.statMainnets")}</dt>
            <dd>{n(stats.mainnets)}</dd>
          </div>
          <div>
            <dt>{t("landing.statRoutes")}</dt>
            <dd>{n(stats.routes)}</dd>
          </div>
          <div>
            <dt>{t("landing.statCurated")}</dt>
            <dd>{n(stats.curated)}</dd>
          </div>
          <div>
            <dt>{t("landing.statLanguages")}</dt>
            <dd>{n(stats.languages)}</dd>
          </div>
        </dl>
        <ul className="mk-logo-cloud" aria-label={t("landing.reachLogos")}>
          {logoCloud.map((c) => (
            <li key={c.id} title={c.name}>
              <Mark id={c.id} size={32} />
              <span>{c.shortName}</span>
            </li>
          ))}
        </ul>
        <p className="mk-note">{t("landing.reachNote")}</p>
      </section>

      <section className="mk-section" id="how" aria-labelledby="mk-how">
        <div className="mk-section-head">
          <h2 id="mk-how">{t("landing.howTitle")}</h2>
        </div>
        {/* The descent: four depths, one decision each; the depth labels are decorative. */}
        <ol className="mk-descent">
          {(
            [
              [1, "connect", 0],
              [2, "find", 200],
              [3, "verify", 1000],
              [4, "decide", 4000],
            ] as const
          ).map(([i, glyph, metres]) => (
            <li key={i}>
              <span className="mk-descent-depth" aria-hidden="true">
                {n(metres)} m
              </span>
              <span className="mk-descent-node" aria-hidden="true">
                <Glyph name={glyph} />
              </span>
              <h3>{t(`landing.howStep${i}Title`)}</h3>
              <p>{t(`landing.howStep${i}Body`)}</p>
            </li>
          ))}
        </ol>
      </section>

      <section
        className="mk-section mk-safety"
        id="safety"
        aria-labelledby="mk-safety"
      >
        <div className="mk-section-head">
          <h2 id="mk-safety">{t("landing.safetyTitle")}</h2>
          <p>{t("landing.safetyBody")}</p>
        </div>
        {/* Trust architecture: four guarantees, each with its own mark. */}
        <ul className="mk-cards mk-trust-grid">
          {(
            [
              [1, "closed"],
              [2, "shown"],
              [3, "approvals"],
              [4, "fees"],
            ] as const
          ).map(([i, glyph]) => (
            <li key={i}>
              <span className="mk-trust-mark" aria-hidden="true">
                <Glyph name={glyph} />
              </span>
              <h3>{t(`landing.safetyPoint${i}Title`)}</h3>
              <p>
                {t(
                  `landing.safetyPoint${i}Body`,
                  i === 4 ? { fee: feePercent } : undefined,
                )}
              </p>
            </li>
          ))}
        </ul>
      </section>

      <section
        className="mk-section mk-split"
        id="data"
        aria-labelledby="mk-data"
      >
        <div className="mk-section-head">
          <h2 id="mk-data">{t("landing.dataTitle")}</h2>
          <p>{t("landing.dataBody")}</p>
          <Link href="/docs/developers" className="mk-link">
            {t("landing.dataLink")} →
          </Link>
        </div>
        <figure className="mk-visual" aria-label={t("landing.illustration")}>
          <pre className="mk-code" dir="ltr">{`GET /v1/chains/1/coverage
{
  "tier": "FULL_INDEXED",
  "historicalComplete": false,
  "observedBlock": "…"
}`}</pre>
          <figcaption>{t("landing.illustration")}</figcaption>
        </figure>
      </section>

      <section className="mk-section" id="faq" aria-labelledby="mk-faq">
        <div className="mk-section-head">
          <h2 id="mk-faq">{t("landing.faqTitle")}</h2>
        </div>
        <div className="mk-faq">
          {[1, 2, 3, 4, 5, 6, 7].map((i) => (
            <details key={i}>
              <summary>{t(`landing.faq${i}Q`)}</summary>
              <p>
                {t(
                  `landing.faq${i}A`,
                  i === 3
                    ? { count: n(stats.mainnets) }
                    : i === 6
                      ? { fee: feePercent }
                      : undefined,
                )}
              </p>
            </details>
          ))}
        </div>
      </section>

      <section className="mk-final" aria-labelledby="mk-final">
        <h2 id="mk-final">{t("landing.finalTitle")}</h2>
        <p>{t("landing.finalBody")}</p>
        <div className="mk-cta">
          <Link href="/app" className="mk-button is-primary is-large">
            {t("landing.launchApp")}
          </Link>
          <Link href="/docs" className="mk-button is-quiet is-large">
            {t("landing.readDocs")}
          </Link>
        </div>
      </section>
    </div>
  );
}
