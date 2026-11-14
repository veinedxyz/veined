import type { Metadata, Viewport } from "next";
import { cookies, headers } from "next/headers";
import {
  acceptedLanguages,
  localeCookie,
  localeDirection,
  resolveLocale,
} from "../i18n/config";
import { loadDictionary, translate } from "../i18n/messages";
import { I18nProvider } from "../i18n/provider";
import { brand } from "../content/brand";
import { brandMetadata } from "../server/brand-metadata";
import { docsShortcutBootstrap } from "../components/docs-shortcut";
import "./globals.css";
import "./network-themes.css";
import "./visual-system.css";
import "./brand-system.css";
// V1.22 UX candidate: the shared interface layer refines the accepted system.
import "./ux-system.css";
// Abyssal Intelligence candidate: the shared underwater world and the octopus navigation system load last.
import "./abyss-system.css";
// Ocean candidate: surfaces that keep every control readable over the water.
import "./ocean-system.css";
// Ocean film candidate: the owner's living-ocean video behind the application shell.
import "./ocean-film.css";
// Deep refinement (ux5): one premium ocean language across surfaces, marks, navigation and page atmospheres.
import "./deep-system.css";
// VEINED Guardian: the verdict panel and the Guardian console.
import "./guardian-system.css";
// gf1 G05: the Tide layer (calmer depth, open titles, one surface per flow) is loaded last.
import "./tide-system.css";
// VWP G08: the Almanac layer (open water, ruled readings, one instrument per page) is loaded last.
import "./almanac-system.css";
// VWP G10: the portfolio ledger (DeBank-level information order in the Almanac world).
import "./almanac-portfolio.css";
import "./near-route.css";
export const dynamic = "force-dynamic";
// V1.11: the root layout carries only the document, i18n and SEO defaults. The application shell (wallet layer,
// routing, G7 pilot gate) is in app/(app)/layout.tsx; the landing page and /docs never load it.
async function initialLocale() {
  return resolveLocale(
    (await cookies()).get(localeCookie)?.value,
    acceptedLanguages((await headers()).get("accept-language")),
  );
}
export const viewport: Viewport = {
  themeColor: "#05090c",
  colorScheme: "dark light",
};
export async function generateMetadata(): Promise<Metadata> {
  const locale = await initialLocale();
  await loadDictionary(locale);
  const title = translate(locale, "meta.title");
  return {
    ...brandMetadata(title, translate(locale, "meta.description")),
    title: { default: title, template: `%s · ${brand.name}` },
  };
}
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const requestHeaders = await headers(),
    locale = await initialLocale(),
    dictionary = await loadDictionary(locale),
    nonce = requestHeaders.get("x-nonce") ?? undefined;
  return (
    <html lang={locale} dir={localeDirection(locale)} data-theme="dark">
      <head>
        {/* V1.9: the lazily loaded wallet modal (styled-components) reads this per-request CSP nonce from the
            hidden nonce property, so the strict production style-src needs no 'unsafe-inline'. */}
        {nonce && <meta property="csp-nonce" nonce={nonce} />}
        {nonce && (
          <script id="veined-docs-shortcut" nonce={nonce}>
            {docsShortcutBootstrap}
          </script>
        )}
      </head>
      <body>
        <I18nProvider locale={locale} dictionary={dictionary}>
          {children}
        </I18nProvider>
      </body>
    </html>
  );
}
