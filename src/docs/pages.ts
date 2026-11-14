// V1.11 public documentation structure. Content: content/docs/<locale>/<slug>.md (English and Turkish are the
// canonical documentation languages; the app itself stays in 24 locales — see "Documentation languages" in
// /docs/start). Compiled by `pnpm docs:build` into src/docs/content.generated.ts.
export const DOC_LOCALES = ["en", "tr"] as const;
export type DocLocale = (typeof DOC_LOCALES)[number];
export const DOC_PAGES = [
  "start",
  "portfolio",
  "portfolio/defi",
  "portfolio/coverage",
  "portfolio/risk",
  "bridge",
  "swap",
  "networks",
  "safety",
  "data",
  "fees",
  "developers",
  "troubleshooting",
  "glossary",
] as const;
export type DocSlug = (typeof DOC_PAGES)[number];
export function isDocSlug(v: string): v is DocSlug {
  return (DOC_PAGES as readonly string[]).includes(v);
}
export function docLocaleFor(locale: string): DocLocale {
  return locale === "tr" ? "tr" : "en";
}
