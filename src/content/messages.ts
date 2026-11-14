// Compatibility exports for accepted baseline tests; product copy lives in i18n assets.
import en from "../i18n/locales/en.json" with { type: "json" };
import tr from "../i18n/locales/tr.json" with { type: "json" };
export const messages = { en: en.product, tr: tr.product };
export type Language = import("../i18n/config").Locale;
export type TextKey = keyof typeof en.product;
