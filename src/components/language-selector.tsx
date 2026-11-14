"use client";
import { useRef, useState } from "react";
import { locales } from "../i18n/config";
import { useI18n } from "../i18n/provider";
import { modalProps, openModal } from "./dialog";
import { Icon } from "./icons";
export function LanguageSelector({
  expanded = false,
  onChanged,
}: {
  expanded?: boolean;
  /** Server-rendered pages (landing, docs) refresh after a language change. */
  onChanged?: () => void;
}) {
  const { lang, t, setLocale, selecting, selectionError } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null),
    search = useRef<HTMLInputElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const [query, setQuery] = useState("");
  function close() {
    dialog.current?.close();
  }
  return (
    <>
      <button
        ref={trigger}
        className={expanded ? "language-entry" : "icon-button language-entry"}
        aria-label={t("product.language")}
        aria-haspopup="dialog"
        onClick={() => {
          setQuery("");
          openModal(dialog.current, trigger.current);
          search.current?.focus();
        }}
      >
        <Icon name="globe" size={17} />
        <bdi>
          {expanded
            ? locales.find((x) => x.id === lang)?.nativeName
            : lang.toUpperCase()}
        </bdi>
      </button>
      <dialog
        ref={dialog}
        className="language-picker"
        aria-labelledby={
          expanded ? "settings-language-title" : "header-language-title"
        }
        {...modalProps()}
      >
        <div className="dialog-top">
          <h2
            id={expanded ? "settings-language-title" : "header-language-title"}
          >
            {t("product.language")}
          </h2>
          <button
            className="icon-button"
            aria-label={t("product.close")}
            onClick={close}
          >
            <Icon name="close" size={18} />
          </button>
        </div>
        <label
          className="sr-only"
          htmlFor={
            expanded ? "settings-language-search" : "header-language-search"
          }
        >
          {t("ui.searchLanguages")}
        </label>
        <input
          ref={search}
          id={expanded ? "settings-language-search" : "header-language-search"}
          autoFocus
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("ui.searchLanguages")}
        />
        {selectionError && (
          <p className="notice" role="alert">
            {t("errors.PROVIDER_UNAVAILABLE")}
          </p>
        )}
        <div
          className="language-list"
          role="group"
          aria-label={t("product.language")}
        >
          {locales
            .filter((entry) =>
              `${entry.id} ${entry.nativeName} ${entry.name}`
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            )
            .map((entry) => (
              <button
                key={entry.id}
                disabled={selecting}
                aria-pressed={entry.id === lang}
                onClick={async () => {
                  if (await setLocale(entry.id)) {
                    close();
                    onChanged?.();
                  }
                }}
              >
                <bdi lang={entry.id}>{entry.nativeName}</bdi>
                {entry.id === lang ? <Icon name="check" size={16} /> : null}
              </button>
            ))}
        </div>
      </dialog>
    </>
  );
}
