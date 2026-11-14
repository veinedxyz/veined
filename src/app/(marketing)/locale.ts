import { cookies, headers } from "next/headers";
import {
  acceptedLanguages,
  localeCookie,
  resolveLocale,
} from "../../i18n/config";
import {
  loadDictionary,
  translate,
  type MessageKey,
} from "../../i18n/messages";
// Server-side locale + translator for the landing page and /docs (same cookie/Accept-Language rules as the app).
export async function marketingLocale() {
  const locale = resolveLocale(
    (await cookies()).get(localeCookie)?.value,
    acceptedLanguages((await headers()).get("accept-language")),
  );
  await loadDictionary(locale);
  return {
    locale,
    t: (key: string, values?: Record<string, string | number>) =>
      translate(locale, key as MessageKey, values),
  };
}
