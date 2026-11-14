"use client";
// V1.10 follow-up: the wallet and review dialog bodies are not needed for the first render, so they live in this
// lazily loaded chunk. The <dialog> shells (and their titles/close buttons) stay in the product; the product loads
// this module on hover/focus/click of the opener and opens the dialog only once the body has rendered.
import type { ComponentType, ReactNode } from "react";
import type { TextKey } from "../content/messages";
import type { Mode, Quote } from "../core/model";
import type { MessageKey } from "../i18n/messages";
import type { WalletSession } from "../features/wallet/session";
import { Icon } from "./icons";
import { RouteIdentity } from "./network-identity";

type T = (key: TextKey | MessageKey) => string;
type Row = (label: string, value: ReactNode, className?: string) => ReactNode;
type Address = (value: string) => ReactNode;

export function WalletDialogBody(props: {
  t: T;
  connected: boolean;
  session: WalletSession;
  account: string;
  chainText: string;
  WalletIcon: ComponentType<{ session: WalletSession }>;
  row: Row;
  address: Address;
  onChangeWallet: () => void;
  onDisconnect: () => void;
}) {
  const { t, session, WalletIcon } = props;
  return (
    <>
      {props.connected && (
        <>
          <div className="wallet-identity">
            <span className="wallet-identity-icon">
              <WalletIcon session={session} />
            </span>
            <div>
              <strong>{session.walletName}</strong>
              <span className="pill tone-ok">
                <span className="pill-dot" aria-hidden="true" />
                {t("v110.connected")}
              </span>
            </div>
          </div>
          {props.address(props.account)}
          {props.row(t("chainId"), props.chainText)}
          <p className="wallet-safe">
            <Icon name="shield" size={16} />
            {t("v110.connectOnly")}
          </p>
          <div className="wallet-actions">
            <button className="secondary" onClick={props.onChangeWallet}>
              <Icon name="refresh" size={15} />
              {t("changeWallet")}
            </button>
            <button
              className="secondary is-danger"
              onClick={props.onDisconnect}
            >
              {t("disconnect")}
            </button>
          </div>
        </>
      )}
      <p className="input-hint">{t("walletNote")}</p>
    </>
  );
}

export function ReviewDialogBody(props: {
  t: T;
  lang: string;
  quote: Quote | undefined;
  mode: Mode;
  quoteValid: boolean;
  bnb: bigint | undefined;
  error: string;
  explain: (code: string) => string;
  formatAmount: (value: bigint, places?: number) => string;
  row: Row;
  address: Address;
  onRun: () => void;
}) {
  const { t, quote, mode, row, formatAmount } = props;
  if (!quote) return null;
  return (
    <>
      {mode === "local-test" && <p className="badge">{t("local")}</p>}
      <RouteIdentity />
      <div className="receipt">
        {row(t("amount"), `${formatAmount(quote.amount, 18)} ONE`)}
        {row(
          t("v111.fee"),
          `${formatAmount(quote.networkFee + quote.serviceFee)} ONE`,
        )}
        {row(
          t("receive"),
          `${formatAmount(quote.expected, 18)} CROSS`,
          "is-receive",
        )}
      </div>
      <details className="disclosure">
        <summary>{t("v110.feeBreakdown")}</summary>
        <div className="disclosure-body">
          {" "}
          {row(t("fee"), `${formatAmount(quote.networkFee, 18)} ONE`)}
          {row(t("serviceFee"), `${formatAmount(quote.serviceFee, 18)} ONE`)}
          {row(
            t("debit"),
            `${formatAmount(quote.amount + quote.networkFee + quote.serviceFee, 18)} ONE`,
            "is-strong",
          )}
          {row(t("gas"), `${formatAmount(quote.gasBudget)} ONE`)}
        </div>
      </details>
      <p className="micro">{t("recipient")}</p>
      {props.address(quote.recipient)}
      <p className="input-hint">
        <Icon name="clock" size={13} /> {t("expiry")}:{" "}
        {new Date(quote.expiresAt).toLocaleTimeString(props.lang)}
      </p>
      <details className="disclosure">
        <summary>{t("v111.safetyDetails")}</summary>
        <p className="notice">{t("riskReview")}</p>
        <p className="notice">
          {t("bnb")}{" "}
          {props.bnb !== undefined ? `${formatAmount(props.bnb)} BNB` : "—"}
        </p>
      </details>
      {props.error && <p role="alert">{props.explain(props.error)}</p>}
      <button
        className="primary"
        disabled={!props.quoteValid || mode !== "local-test"}
        onClick={props.onRun}
      >
        {t(mode === "local-test" ? "runLocal" : "writeDisabled")}
        <Icon
          name={mode === "local-test" ? "arrowRight" : "lock"}
          size={18}
          className="flip-rtl"
        />
      </button>
    </>
  );
}
