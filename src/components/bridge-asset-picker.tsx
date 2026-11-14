"use client";
// V1.11 ONEbridge asset picker (lazy chunk). Lists ONLY pairs confirmed on-chain on both chains by two sources each
// (src/assets/onebridge-pairs.generated.json, `pnpm assets:sync:onebridge`). Native ONE stays first. A registered
// pair without Otherbridge verification is selectable for information but shows "No verified route" and cannot be
// quoted or sent. Pairs are identified by exact token addresses, never by symbol.
import { useEffect, useRef } from "react";
import pairsFile from "../assets/onebridge-pairs.generated.json" with { type: "json" };
import { useI18n } from "../i18n/provider";
import { modalProps, openModal } from "./dialog";
import { NetworkLogo } from "./network-identity";
import { Icon } from "./icons";
import { TokenAvatar, shortAddress } from "./ui";
import type { BridgePairChoice } from "./product";

interface Pair {
  id: string;
  status: string;
  g5Verified: boolean;
  local: { address: string; native: boolean; symbol: string };
  remote: { address: string; symbol: string };
  source: { paused: boolean };
  destination: { paused: boolean };
}
const file = pairsFile as {
  generatedAt: string;
  pins: { one: { block: number }; bsc: { block: number } };
  pairs: Pair[];
};
export default function BridgeAssetPicker({
  selected,
  onSelect,
  onClose,
}: {
  selected: string;
  onSelect: (choice: BridgePairChoice) => void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    openModal(dialog.current);
  }, []);
  const pairs = [...file.pairs].sort(
    (a, b) =>
      Number(b.local.native) - Number(a.local.native) ||
      Number(b.g5Verified) - Number(a.g5Verified),
  );
  const close = () => dialog.current?.close();
  return (
    <dialog
      ref={dialog}
      className="token-picker"
      aria-labelledby="pair-picker-title"
      {...modalProps(onClose)}
    >
      <div className="dialog-top">
        <div>
          <p className="micro">ONEchain → BNB Smart Chain · ONEbridge</p>
          <h2 id="pair-picker-title">{t("v111.selectAsset")}</h2>
        </div>
        <button
          className="icon-button"
          onClick={close}
          aria-label={t("ui.close")}
        >
          <Icon name="close" size={18} />
        </button>
      </div>
      <div
        role="listbox"
        aria-label={t("v111.selectAsset")}
        className="token-list"
      >
        {pairs.map((p) => {
          const verified = p.g5Verified && p.status === "VERIFIED_ROUTE";
          return (
            <button
              key={p.id}
              role="option"
              aria-selected={p.id === selected}
              className="token-option"
              data-pair={p.id}
              onClick={() => {
                onSelect({
                  id: p.id,
                  fromSymbol: p.local.symbol,
                  toSymbol: p.remote.symbol,
                  verified,
                });
                close();
              }}
            >
              {p.local.native ? (
                <NetworkLogo id="onechain" size="sm" />
              ) : (
                <TokenAvatar symbol={p.local.symbol} />
              )}
              <span className="token-meta">
                <strong>
                  <bdi>{p.local.symbol}</bdi> → <bdi>{p.remote.symbol}</bdi>
                </strong>
                <small>
                  {p.local.native ? (
                    t("product.native")
                  ) : (
                    <code dir="ltr">{shortAddress(p.local.address)}</code>
                  )}
                  {" → "}
                  <code dir="ltr">{shortAddress(p.remote.address)}</code>
                </small>
              </span>
              <span className="token-side">
                <span className={`pill tone-${verified ? "ok" : "warn"}`}>
                  {verified
                    ? t("v111.verifiedRoute")
                    : t("v111.noVerifiedRoute")}
                </span>
                {(p.source.paused || p.destination.paused) && (
                  <small className="amber">{t("v111.paused")}</small>
                )}
              </span>
            </button>
          );
        })}
      </div>
      <p className="input-hint">
        {t("v111.pairsVerifiedAt", {
          one: new Intl.NumberFormat(lang).format(file.pins.one.block),
          bsc: new Intl.NumberFormat(lang).format(file.pins.bsc.block),
        })}
      </p>
    </dialog>
  );
}
