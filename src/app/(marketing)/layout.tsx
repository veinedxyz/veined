import { brand } from "../../content/brand";
import { BrandLogo } from "../../components/brand-logo";
import Link from "next/link";
import { marketingLocale } from "./locale";
import { socialLinks, type SocialKey } from "../../server/site";
import { MarketingLanguage } from "./marketing-language";
import "./marketing.css";
import "./cinematic.css";
// V1.11 public landing + docs shell. Server-rendered; the only client code is the language selector. It never
// imports the wallet layer, portfolio client, routing/firewall or G7 modules (checked by tests and bundle scans).
const SOCIAL_LABEL: Record<SocialKey, string> = {
  x: "X",
  github: "GitHub",
  telegram: "Telegram",
  discord: "Discord",
  docs: "landing.footerDocsExternal",
  status: "landing.footerStatus",
};
export default async function MarketingLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { t } = await marketingLocale();
  const social = socialLinks();
  return (
    <div className="mk">
      <a className="skip" href="#mk-main">
        {t("ui.skipToContent")}
      </a>
      <header className="mk-header">
        <div className="mk-header-inner">
          <Link href="/" className="mk-brand" aria-label={brand.name}>
            <BrandLogo decorative />
          </Link>
          <nav className="mk-nav" aria-label={t("landing.navLabel")}>
            <Link href="/#swap">{t("landing.navSwap")}</Link>
            <Link href="/#bridge">{t("landing.navBridge")}</Link>
            <Link href="/#portfolio">{t("landing.navPortfolio")}</Link>
            <Link href="/#safety">{t("landing.navSafety")}</Link>
            <Link href="/docs">{t("landing.docs")}</Link>
          </nav>
          <div className="mk-actions">
            <MarketingLanguage />
            <Link href="/docs" className="mk-button is-quiet mk-docs-link">
              {t("landing.docs")}
            </Link>
            <Link href="/app" className="mk-button is-primary">
              {t("landing.launchApp")}
            </Link>
          </div>
        </div>
      </header>
      <main id="mk-main">{children}</main>
      <footer className="mk-footer">
        <div className="mk-footer-inner">
          <div className="mk-footer-brand">
            <BrandLogo />
            <p>{t("landing.footerNote")}</p>
          </div>
          <nav aria-label={t("landing.footerApp")}>
            <h2>{t("landing.footerApp")}</h2>
            <Link href="/bridge">{t("product.bridge")}</Link>
            <Link href="/swap">{t("v13.swap")}</Link>
            <Link href="/portfolio">{t("v13.portfolio")}</Link>
            <Link href="/networks">{t("product.networks")}</Link>
            <Link href="/activity">{t("product.activity")}</Link>
          </nav>
          <nav aria-label={t("landing.footerResources")}>
            <h2>{t("landing.footerResources")}</h2>
            <Link href="/docs">{t("landing.docs")}</Link>
            <Link href="/docs/safety">{t("landing.footerSafety")}</Link>
            <Link href="/docs/fees">{t("landing.footerFees")}</Link>
            <Link href="/help">{t("product.help")}</Link>
          </nav>
          {social.length > 0 && (
            <nav aria-label={t("landing.footerCommunity")}>
              <h2>{t("landing.footerCommunity")}</h2>
              {social.map((s) => (
                <a
                  key={s.key}
                  href={s.href}
                  rel="noopener noreferrer external"
                  target="_blank"
                >
                  {SOCIAL_LABEL[s.key].startsWith("landing.")
                    ? t(SOCIAL_LABEL[s.key])
                    : SOCIAL_LABEL[s.key]}
                </a>
              ))}
            </nav>
          )}
        </div>
        <p className="mk-legal">{t("landing.legal")}</p>
      </footer>
    </div>
  );
}
