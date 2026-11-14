"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { LanguageSelector } from "../../components/language-selector";
import { Icon } from "../../components/icons";
import { useI18n } from "../../i18n/provider";
// Landing and docs text is server-rendered: after a language change the server renders the page again.
export function MarketingLanguage() {
  const router = useRouter();
  const { t } = useI18n();
  const [theme, setTheme] = useState("dark");
  useEffect(() => {
    try {
      document.documentElement.dataset.theme =
        localStorage.getItem("otherbridge.theme") === "light"
          ? "light"
          : "dark";
    } catch {
      document.documentElement.dataset.theme = "dark";
    }
    queueMicrotask(() =>
      setTheme(document.documentElement.dataset.theme ?? "dark"),
    );
  }, []);
  return (
    <>
      <LanguageSelector onChanged={() => router.refresh()} />
      <button
        className="icon-button mk-theme-toggle"
        aria-label={t("product.theme")}
        onClick={() => {
          const next = theme === "dark" ? "light" : "dark";
          setTheme(next);
          document.documentElement.dataset.theme = next;
          try {
            localStorage.setItem("otherbridge.theme", next);
          } catch {
            /* The current page still switches. */
          }
        }}
      >
        <Icon name={theme === "dark" ? "sun" : "moon"} size={16} />
      </button>
    </>
  );
}
