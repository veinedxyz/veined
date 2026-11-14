"use client";
import Link from "next/link";
import { useEffect } from "react";
import { useI18n } from "../i18n/provider";
import { Icon } from "./icons";
import { NavArm, NavGlyph } from "./app-nav";
import { publishGuardianFacts } from "./guardian-context";
import { shortAddress } from "./ui";

/** Guardian decisions in policy order, shown in the workflow with their own neutral labels (never a green "safe"). */
const DECISIONS = ["ALLOW", "WARN", "ESCALATE", "BLOCK"] as const;

/** An entry surface, deliberately without fabricated balances, quotes or history. The hero is a window onto the
 * organism's core in the shared abyssal field; each tool tile is held by one of its arms. Guardian-first (gf1): the
 * hero's first action is Guardian, and one ordered flow says how the product is used — connect, choose, Guardian
 * review, then the user's own next step — with each step's state stated honestly (nothing here signs or sends). */
export default function AppOverview({
  account,
  hasPortfolio,
  onConnect,
}: {
  account: string;
  hasPortfolio: boolean;
  onConnect: () => void;
}) {
  const { t } = useI18n();
  const reached = account
    ? "v111.connectedWallet"
    : hasPortfolio
      ? "gf.ov.s1Scanned"
      : "gf.ov.s1Pending";
  // gf1 G04: the Guardian assistant reads the first step's state exactly as shown here (no address, no balance).
  const step = account ? "connected" : hasPortfolio ? "scanned" : "pending";
  useEffect(() => {
    publishGuardianFacts("overview", { step });
  }, [step]);
  useEffect(() => () => publishGuardianFacts("overview", undefined), []);
  return (
    <div className="overview">
      <section className="overview-welcome" aria-labelledby="overview-title">
        <div className="overview-welcome-copy">
          <h1 id="overview-title">{t("gf.ov.title")}</h1>
          <p>{t("gf.ov.body")}</p>
          <div className="overview-welcome-actions">
            <Link href="/guardian" className="button-link primary-link">
              <NavGlyph name="guardian" />
              {t("gf.ov.ask")}
            </Link>
            <Link href="/swap" className="button-link">
              {t("v13.swap")}
            </Link>
            <Link href="/bridge" className="button-link">
              {t("product.bridge")}
            </Link>
          </div>
        </div>
      </section>
      <div className="overview-status">
        <Icon name="lock" size={16} />
        <p>{t("landing.statusNote")}</p>
        <Link href="/docs/safety">
          {t("landing.footerSafety")}{" "}
          <Icon name="arrowRight" size={14} className="flip-rtl" />
        </Link>
      </div>
      <section className="overview-flow" aria-labelledby="overview-flow-title">
        <h2 id="overview-flow-title">{t("gf.ov.flowTitle")}</h2>
        <ol className="overview-flow-steps">
          <li data-step="connect">
            <span className="overview-flow-index" aria-hidden="true">
              1
            </span>
            <span className="overview-flow-copy">
              <strong>{t("gf.ov.s1")}</strong>
              <small>{t("gf.ov.s1b")}</small>
            </span>
            <span
              className="overview-flow-state"
              data-done={account || hasPortfolio ? "true" : undefined}
            >
              {t(reached)}
            </span>
          </li>
          <li data-step="choose">
            <span className="overview-flow-index" aria-hidden="true">
              2
            </span>
            <span className="overview-flow-copy">
              <strong>{t("gf.ov.s2")}</strong>
              <small>{t("gf.ov.s2b")}</small>
            </span>
            <span className="overview-flow-links">
              <Link href="/swap">{t("v13.swap")}</Link>
              <Link href="/bridge">{t("product.bridge")}</Link>
            </span>
          </li>
          <li data-step="guardian" className="is-guardian">
            {/* VWP G08: the sequence keeps its figure; the Guardian mark rides beside it. */}
            <span className="overview-flow-index" aria-hidden="true">
              3
              <NavGlyph name="guardian" />
            </span>
            <span className="overview-flow-copy">
              <strong>{t("gf.ov.s3")}</strong>
              <small>{t("gf.ov.s3b")}</small>
              <span className="overview-flow-decisions">
                {DECISIONS.map((d) => (
                  <span key={d} data-decision={d}>
                    {t(`guardian.chat.decision.${d}` as never)}
                  </span>
                ))}
              </span>
            </span>
            <span className="overview-flow-links">
              <Link href="/guardian">{t("gf.ov.ask")}</Link>
            </span>
          </li>
          <li data-step="next">
            <span className="overview-flow-index" aria-hidden="true">
              4
            </span>
            <span className="overview-flow-copy">
              <strong>{t("gf.ov.s4")}</strong>
              <small>{t("gf.ov.s4b")}</small>
            </span>
            <span className="overview-flow-state" data-closed="true">
              <Icon name="lock" size={13} />
              {t("v115.closed")}
            </span>
          </li>
        </ol>
      </section>
      <section className="overview-tools" aria-label={t("landing.footerApp")}>
        {(
          [
            ["swap", "swap", "v13.swap", "ux5.toolSwap"],
            ["bridge", "bridge", "product.bridge", "ux5.toolBridge"],
            ["portfolio", "portfolio", "v13.portfolio", "ux5.toolPortfolio"],
          ] as const
        ).map(([path, glyph, title, body]) => (
          <Link key={path} href={`/${path}`} className="overview-tool">
            <span className="overview-tool-mark" aria-hidden="true">
              <NavGlyph name={glyph} />
              <NavArm className="is-tile" />
            </span>
            <span className="overview-tool-copy">
              <h2>{t(title)}</h2>
              <p>{t(body)}</p>
            </span>
            <Icon name="arrowRight" className="flip-rtl" size={18} />
          </Link>
        ))}
      </section>
      <div className="overview-bottom">
        <section className="card overview-wallet">
          <span className="overview-wallet-icon" aria-hidden="true">
            <Icon name="wallet" size={24} />
          </span>
          <div>
            <h2>
              {t(
                account
                  ? "v111.connectedWallet"
                  : hasPortfolio
                    ? "v13.portfolio"
                    : "v110.notScanned",
              )}
            </h2>
            <p>
              {account ? (
                <bdi dir="ltr">{shortAddress(account)}</bdi>
              ) : (
                t(
                  hasPortfolio
                    ? "landing.portfolioBody"
                    : "v110.connectOrPaste",
                )
              )}
            </p>
          </div>
          {account || hasPortfolio ? (
            <Link href="/portfolio" className="secondary button-link">
              {t("v13.portfolio")}
            </Link>
          ) : (
            <button className="secondary" onClick={onConnect}>
              <Icon name="wallet" />
              {t("product.connect")}
            </button>
          )}
          <Link href="/portfolio" className="text-link">
            {t("v110.factPublicOnly")}{" "}
            <Icon name="arrowRight" size={14} className="flip-rtl" />
          </Link>
        </section>
        <section
          className="overview-explore"
          aria-label={t("landing.footerResources")}
        >
          {(
            [
              ["/points", "points", "points.nav", "ux5.exPointsLifetime"],
              ["/networks", "networks", "product.networks", "ux5.exNetworks"],
              ["/activity", "activity", "product.activity", "ux5.exActivity"],
              ["/docs", "help", "landing.docs", "ux5.exDocs"],
            ] as const
          ).map(([href, glyph, title, body]) => (
            <Link href={href} key={href}>
              <NavGlyph name={glyph} />
              <span>
                <strong>{t(title)}</strong>
                <small>{t(body)}</small>
              </span>
              <Icon name="arrowRight" size={16} className="flip-rtl" />
            </Link>
          ))}
        </section>
      </div>
    </div>
  );
}
