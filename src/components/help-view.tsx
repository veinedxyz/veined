"use client";
import Link from "next/link";
import { useI18n } from "../i18n/provider";
import type { MessageKey } from "../i18n/messages";
import { Icon, type IconName } from "./icons";
import { PageHeader } from "./ui";
// V1.10 Help: how the read-only product works, the existing FAQ as an accordion, and safety basics. Code-split
// from the first-load bundle; server-rendered when /help is requested directly.
const steps: readonly [IconName, MessageKey, MessageKey][] = [
  ["wallet", "v110.step1Title", "v110.step1Body"],
  ["route", "v110.step2Title", "v110.step2Body"],
  ["pulse", "v110.step3Title", "v110.step3Body"],
];
export default function HelpView() {
  const { t, lang } = useI18n();
  return (
    <>
      <PageHeader
        title={t("product.helpTitle")}
        lede={t("product.helpSubtitle")}
      />
      <nav className="help-topics" aria-label={t("landing.docs")}>
        {(
          [
            [
              "wallet",
              "product.wallet",
              lang === "tr" ? "/docs#cuzdan-baglama" : "/docs#connect-a-wallet",
            ],
            ["layers", "v13.portfolio", "/docs/portfolio"],
            ["layers", "v113.supported", "/docs/portfolio/defi"],
            ["globe", "v111.environment", "/docs/networks"],
            ["route", "product.bridge", "/docs/bridge"],
            ["swap", "v13.swap", "/docs/swap"],
            ["gas", "landing.footerFees", "/docs/fees"],
            ["shield", "landing.footerSafety", "/docs/safety"],
            ["alert", "v112.troubleshooting", "/docs/troubleshooting"],
          ] as const
        ).map(([icon, key, href]) => (
          <Link key={href} href={href}>
            <Icon name={icon as IconName} size={18} />
            <span>{t(key as MessageKey)}</span>
            <Icon name="arrowRight" className="flip-rtl" size={14} />
          </Link>
        ))}
      </nav>
      <section className="help-steps" aria-labelledby="help-how-title">
        <h2 id="help-how-title">{t("v110.howTitle")}</h2>
        <ol>
          {steps.map(([icon, title, body], i) => (
            <li key={title}>
              <span className="step-icon" aria-hidden="true">
                <Icon name={icon} size={20} />
              </span>
              <span className="step-index" aria-hidden="true">
                {i + 1}
              </span>
              <h3>{t(title)}</h3>
              <p>{t(body)}</p>
            </li>
          ))}
        </ol>
      </section>
      <div className="help-grid">
        <section className="card faq" aria-labelledby="help-faq-title">
          <h2 id="help-faq-title">{t("v110.faqTitle")}</h2>
          {[0, 1, 2, 3, 4, 5].map((i) => (
            <details key={i}>
              <summary>
                {t(`faq.${i}q` as MessageKey)}
                <span className="faq-icon" aria-hidden="true">
                  <Icon name="plus" size={16} />
                </span>
              </summary>
              <p>{t(`faq.${i}a` as MessageKey)}</p>
            </details>
          ))}
          <h3>{t("v113.supported")}</h3>
          <div data-testid="defi-help">
            {(["Missing", "Net", "Unpriced", "Risk", "Coverage"] as const).map(
              (topic) => (
                <details key={topic}>
                  <summary>
                    {t(`v113.help${topic}Q` as MessageKey)}
                    <span className="faq-icon" aria-hidden="true">
                      <Icon name="plus" size={16} />
                    </span>
                  </summary>
                  <p>{t(`v113.help${topic}A` as MessageKey)}</p>
                </details>
              ),
            )}
          </div>
        </section>
        <aside className="help-side">
          <section className="card basics" aria-labelledby="help-basics-title">
            <h2 id="help-basics-title">{t("v110.basicsTitle")}</h2>
            <ul>
              {(["v110.basic1", "v110.basic2", "v110.basic3"] as const).map(
                (key) => (
                  <li key={key}>
                    <Icon name="shield" size={16} />
                    <span>{t(key)}</span>
                  </li>
                ),
              )}
            </ul>
            <Link href="/about" className="text-link">
              {t("product.learn")}
              <Icon name="arrowRight" size={13} className="flip-rtl" />
            </Link>
          </section>
          <section className="card future" aria-labelledby="help-future-title">
            <h2 id="help-future-title">{t("product.future")}</h2>
            <p>{t("v13.swapNote")}</p>
            <p>{t("v13.securityNote")}</p>
          </section>
        </aside>
      </div>
    </>
  );
}
