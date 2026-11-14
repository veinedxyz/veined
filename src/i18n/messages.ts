import type en from "./locales/en.json";
import type { Locale } from "./config";
import { G5_STATUS } from "../g5/status";
// V1.11: no dictionary is imported statically, so no locale strings ship in the shared client chunk. The browser
// receives its locale's dictionary from the server (I18nProvider props); other locales load on demand. English is
// the canonical schema: it is loaded before any other locale is validated (server, tests and language switches).
type Widen<T> = { [K in keyof T]: T[K] extends string ? string : Widen<T[K]> };
export type Dictionary = Widen<typeof en>;
type Paths<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${Paths<T[K]>}`;
}[keyof T & string];
export type MessageKey = Paths<Dictionary>;
export type ProductKey = keyof Dictionary["product"];
const cache = new Map<Locale, Dictionary>();
const loaders = {
  en: () => import("./locales/en.json", { with: { type: "json" } }),
  tr: () => import("./locales/tr.json", { with: { type: "json" } }),
  es: () => import("./locales/es.json", { with: { type: "json" } }),
  "pt-BR": () => import("./locales/pt-BR.json", { with: { type: "json" } }),
  fr: () => import("./locales/fr.json", { with: { type: "json" } }),
  de: () => import("./locales/de.json", { with: { type: "json" } }),
  it: () => import("./locales/it.json", { with: { type: "json" } }),
  nl: () => import("./locales/nl.json", { with: { type: "json" } }),
  pl: () => import("./locales/pl.json", { with: { type: "json" } }),
  ru: () => import("./locales/ru.json", { with: { type: "json" } }),
  uk: () => import("./locales/uk.json", { with: { type: "json" } }),
  ar: () => import("./locales/ar.json", { with: { type: "json" } }),
  fa: () => import("./locales/fa.json", { with: { type: "json" } }),
  he: () => import("./locales/he.json", { with: { type: "json" } }),
  ur: () => import("./locales/ur.json", { with: { type: "json" } }),
  "zh-CN": () => import("./locales/zh-CN.json", { with: { type: "json" } }),
  "zh-TW": () => import("./locales/zh-TW.json", { with: { type: "json" } }),
  ja: () => import("./locales/ja.json", { with: { type: "json" } }),
  ko: () => import("./locales/ko.json", { with: { type: "json" } }),
  hi: () => import("./locales/hi.json", { with: { type: "json" } }),
  bn: () => import("./locales/bn.json", { with: { type: "json" } }),
  id: () => import("./locales/id.json", { with: { type: "json" } }),
  vi: () => import("./locales/vi.json", { with: { type: "json" } }),
  th: () => import("./locales/th.json", { with: { type: "json" } }),
} satisfies Record<Locale, () => Promise<{ default: unknown }>>;
export function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") return { [prefix]: value };
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error(`INVALID_DICTIONARY:${prefix}`);
  return Object.assign(
    {},
    ...Object.entries(value).map(([key, child]) =>
      flatten(child, prefix ? `${prefix}.${key}` : key),
    ),
  );
}
export function parameters(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/\{([a-zA-Z][\w.]*)\}/g)].map((match) => match[1]),
    ),
  ].sort();
}
export function validateDictionary(
  value: unknown,
): asserts value is Dictionary {
  const en = cache.get("en");
  if (!en) throw Error("CANONICAL_DICTIONARY_NOT_LOADED");
  const canonical = flatten(en),
    candidate = flatten(value);
  const missing = Object.keys(canonical).filter((key) => !(key in candidate));
  const obsolete = Object.keys(candidate).filter((key) => !(key in canonical));
  const malformed = Object.keys(canonical).filter(
    (key) =>
      key in candidate &&
      (!candidate[key].trim() ||
        /[<>]/.test(candidate[key]) ||
        JSON.stringify(parameters(canonical[key])) !==
          JSON.stringify(parameters(candidate[key]))),
  );
  if (missing.length || obsolete.length || malformed.length)
    throw Error(JSON.stringify({ missing, obsolete, malformed }));
}
export function registerDictionary(locale: Locale, dictionary: Dictionary) {
  if (cache.get(locale) === dictionary) return;
  if (locale === "en") {
    cache.set("en", dictionary);
    try {
      validateDictionary(dictionary);
    } catch (e) {
      cache.delete("en");
      throw e;
    }
    return;
  }
  // Validated against English when it is loaded. The browser's first dictionary comes from the server, which
  // validated it in loadDictionary before rendering.
  if (cache.has("en")) validateDictionary(dictionary);
  cache.set(locale, dictionary);
}
export async function loadDictionary(locale: Locale): Promise<Dictionary> {
  const loaded = cache.get(locale);
  if (loaded) return loaded;
  if (locale !== "en" && !cache.has("en")) await loadDictionary("en");
  const value = (await loaders[locale]()).default as Dictionary;
  registerDictionary(locale, value);
  return value;
}
export function getDictionary(locale: Locale): Dictionary {
  const dictionary = cache.get(locale);
  if (!dictionary) throw Error(`LOCALE_NOT_LOADED:${locale}`);
  return dictionary;
}
export function translate(
  locale: Locale,
  key: MessageKey,
  values: Record<string, string | number> = {},
): string {
  let current: unknown = getDictionary(locale);
  for (const part of key.split("."))
    current = (current as Record<string, unknown>)?.[part];
  if (typeof current !== "string") throw Error(`MISSING_KEY:${locale}:${key}`);
  const required = parameters(current);
  if (
    required.some((name) => !(name in values)) ||
    Object.keys(values).some((name) => !required.includes(name))
  )
    throw Error(`INVALID_INTERPOLATION:${key}`);
  return current.replace(/\{([a-zA-Z][\w.]*)\}/g, (_match, name: string) =>
    String(values[name]),
  );
}
export function errorMessage(
  locale: Locale,
  code: string,
  routing = false,
): string {
  const section = routing ? "routingErrors" : "errors";
  const entries = getDictionary(locale)[section];
  // The API code stays stable; after a G5 PASS the gate reason shown is the separate sending approval.
  const shown =
    routing && code === "CUSTOM_ROUTE_NOT_EXECUTABLE_G5" && G5_STATUS === "PASS"
      ? "CUSTOM_ROUTE_NOT_EXECUTABLE_APPROVAL"
      : code;
  const key = Object.hasOwn(entries, shown) ? shown : "PROVIDER_UNAVAILABLE";
  return translate(locale, `${section}.${key}` as MessageKey);
}
export function stateMessage(locale: Locale, state: string): string {
  const key = Object.hasOwn(getDictionary(locale).states, state)
    ? state
    : "UNKNOWN";
  return translate(locale, `states.${key}` as MessageKey);
}
export function plural(locale: Locale, key: string, count: number): string {
  const category = new Intl.PluralRules(locale).select(count);
  const dictionary = flatten(getDictionary(locale));
  const selected =
    `counts.${key}.${category}` in dictionary ? category : "other";
  return translate(locale, `counts.${key}.${selected}` as MessageKey, {
    count: new Intl.NumberFormat(locale).format(count),
  });
}
