"use client";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  isLocale,
  localeCookie,
  localeDirection,
  localePreference,
  type Locale,
} from "./config";
import {
  loadDictionary,
  registerDictionary,
  translate,
  type Dictionary,
  type MessageKey,
} from "./messages";
type Value = {
  lang: Locale;
  t: (key: MessageKey, values?: Record<string, string | number>) => string;
  setLocale: (locale: Locale) => Promise<boolean>;
  selecting: boolean;
  selectionError: boolean;
};
const Context = createContext<Value | null>(null);
export function I18nProvider({
  locale,
  dictionary,
  children,
}: {
  locale: Locale;
  dictionary: Dictionary;
  children: ReactNode;
}) {
  registerDictionary(locale, dictionary);
  const [lang, setLang] = useState(locale),
    [selecting, setSelecting] = useState(false),
    [selectionError, setSelectionError] = useState(false);
  const generation = useRef(0);
  async function setLocale(next: Locale) {
    if (!isLocale(next)) return false;
    const attempt = ++generation.current;
    setSelecting(true);
    setSelectionError(false);
    try {
      await loadDictionary(next);
      if (generation.current !== attempt) return false;
      setLang(next);
      document.cookie = `${localeCookie}=${next}; Path=/; Max-Age=31536000; SameSite=Lax`;
      try {
        localStorage.setItem(localePreference, next);
      } catch {
        /* Memory preference remains usable. */
      }
      return true;
    } catch {
      if (generation.current === attempt) setSelectionError(true);
      return false;
    } finally {
      if (generation.current === attempt) setSelecting(false);
    }
  }
  useEffect(() => {
    // Migrate the accepted local preference into the SSR-readable cookie.
    let saved: unknown;
    try {
      saved = localStorage.getItem(localePreference);
    } catch {}
    const cookie = document.cookie
      .split(";")
      .some((entry) => entry.trim().startsWith(`${localeCookie}=`));
    if (!cookie && isLocale(saved) && saved !== locale)
      queueMicrotask(() => void setLocale(saved as Locale));
    // The first server-resolved preference is intentional; subsequent changes are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const initialLang = useRef(locale);
  useEffect(() => {
    document.documentElement.lang = lang;
    document.documentElement.dir = localeDirection(lang);
    // The server already rendered the page's own title/description (landing, docs, app); only an explicit
    // language change re-titles the document with the app's localized defaults.
    if (lang === initialLang.current) return;
    initialLang.current = lang;
    document.title = translate(lang, "meta.title");
    const description = document.querySelector('meta[name="description"]');
    description?.setAttribute("content", translate(lang, "meta.description"));
  }, [lang]);
  return (
    <Context.Provider
      value={{
        lang,
        t: (key, values) => translate(lang, key, values),
        setLocale,
        selecting,
        selectionError,
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function useI18n() {
  const value = useContext(Context);
  if (!value) throw Error("I18N_PROVIDER_REQUIRED");
  return value;
}
