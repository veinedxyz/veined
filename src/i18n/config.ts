export const locales = [
  { id: "tr", nativeName: "Türkçe", name: "Turkish", dir: "ltr" },
  { id: "en", nativeName: "English", name: "English", dir: "ltr" },
  { id: "es", nativeName: "Español", name: "Spanish", dir: "ltr" },
  {
    id: "pt-BR",
    nativeName: "Português (Brasil)",
    name: "Portuguese",
    dir: "ltr",
  },
  { id: "fr", nativeName: "Français", name: "French", dir: "ltr" },
  { id: "de", nativeName: "Deutsch", name: "German", dir: "ltr" },
  { id: "it", nativeName: "Italiano", name: "Italian", dir: "ltr" },
  { id: "nl", nativeName: "Nederlands", name: "Dutch", dir: "ltr" },
  { id: "pl", nativeName: "Polski", name: "Polish", dir: "ltr" },
  { id: "ru", nativeName: "Русский", name: "Russian", dir: "ltr" },
  { id: "uk", nativeName: "Українська", name: "Ukrainian", dir: "ltr" },
  { id: "ar", nativeName: "العربية", name: "Arabic", dir: "rtl" },
  { id: "fa", nativeName: "فارسی", name: "Persian", dir: "rtl" },
  { id: "he", nativeName: "עברית", name: "Hebrew", dir: "rtl" },
  { id: "ur", nativeName: "اردو", name: "Urdu", dir: "rtl" },
  {
    id: "zh-CN",
    nativeName: "简体中文",
    name: "Simplified Chinese",
    dir: "ltr",
  },
  {
    id: "zh-TW",
    nativeName: "繁體中文",
    name: "Traditional Chinese",
    dir: "ltr",
  },
  { id: "ja", nativeName: "日本語", name: "Japanese", dir: "ltr" },
  { id: "ko", nativeName: "한국어", name: "Korean", dir: "ltr" },
  { id: "hi", nativeName: "हिन्दी", name: "Hindi", dir: "ltr" },
  { id: "bn", nativeName: "বাংলা", name: "Bengali", dir: "ltr" },
  { id: "id", nativeName: "Bahasa Indonesia", name: "Indonesian", dir: "ltr" },
  { id: "vi", nativeName: "Tiếng Việt", name: "Vietnamese", dir: "ltr" },
  { id: "th", nativeName: "ไทย", name: "Thai", dir: "ltr" },
] as const;
export type Locale = (typeof locales)[number]["id"];
export const defaultLocale: Locale = "en";
export const localeCookie = "otherbridge.locale";
export const localePreference = "otherbridge.language";
const numericLocales: Partial<Record<Locale, string>> = {
  ar: "ar-u-nu-arab",
  fa: "fa-u-nu-arabext",
  ur: "ur-u-nu-arabext",
};
export function numberLocale(locale: Locale) {
  return numericLocales[locale] ?? locale;
}
export function isLocale(value: unknown): value is Locale {
  return locales.some((locale) => locale.id === value);
}
export function localeDirection(locale: Locale) {
  return locales.find((entry) => entry.id === locale)!.dir;
}
export function matchLocale(value: string): Locale | undefined {
  const tag = value.trim().toLowerCase().replaceAll("_", "-");
  const exact = locales.find((entry) => entry.id.toLowerCase() === tag);
  if (exact) return exact.id;
  if (/^zh(?:-|$)/.test(tag))
    return /hant|tw|hk|mo/.test(tag) ? "zh-TW" : "zh-CN";
  return locales.find(
    (entry) => entry.id.toLowerCase().split("-")[0] === tag.split("-")[0],
  )?.id;
}
export function resolveLocale(
  preference: unknown,
  languages: readonly string[] = [],
): Locale {
  if (isLocale(preference)) return preference;
  for (const language of languages) {
    const match = matchLocale(language);
    if (match) return match;
  }
  return defaultLocale;
}
export function acceptedLanguages(header: string | null): string[] {
  return (header ?? "")
    .split(",")
    .map((entry) => {
      const [tag, parameter] = entry.trim().split(";");
      const quality = parameter?.startsWith("q=")
        ? Number(parameter.slice(2))
        : 1;
      return { tag, quality };
    })
    .filter(
      (entry) =>
        entry.tag &&
        Number.isFinite(entry.quality) &&
        entry.quality > 0 &&
        entry.quality <= 1,
    )
    .sort((a, b) => b.quality - a.quality)
    .map((entry) => entry.tag);
}
