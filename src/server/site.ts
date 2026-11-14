import { brand } from "../content/brand";
// V1.11 public site configuration (server-side). Everything here is optional and validated; nothing is invented:
// an unset or invalid value means the feature is hidden (no placeholder "#" links, no guessed social handles).
//   OTHERBRIDGE_PUBLIC_ORIGIN     canonical https origin (e.g. https://otherbridge.example) — enables absolute OG URLs
//   OTHERBRIDGE_PUBLIC_INDEXING   "true" to allow search indexing (also requires the origin); default noindex
//   OTHERBRIDGE_SOCIAL_X | _GITHUB | _TELEGRAM | _DISCORD    https profile URLs on their official hosts only
//   OTHERBRIDGE_STATUS_URL        https status page
//   OTHERBRIDGE_DOCS_URL          external docs URL (the built-in /docs is always available)
import { isIP } from "node:net";

export type SocialKey =
  "x" | "github" | "telegram" | "discord" | "docs" | "status";
export interface SocialLink {
  key: SocialKey;
  href: string;
}
const SOCIAL: { key: SocialKey; env: string; hosts: RegExp | null }[] = [
  { key: "x", env: "OTHERBRIDGE_SOCIAL_X", hosts: /^(x\.com|twitter\.com)$/ },
  { key: "github", env: "OTHERBRIDGE_SOCIAL_GITHUB", hosts: /^github\.com$/ },
  {
    key: "telegram",
    env: "OTHERBRIDGE_SOCIAL_TELEGRAM",
    hosts: /^(t\.me|telegram\.me)$/,
  },
  {
    key: "discord",
    env: "OTHERBRIDGE_SOCIAL_DISCORD",
    hosts: /^(discord\.gg|discord\.com)$/,
  },
  { key: "docs", env: "OTHERBRIDGE_DOCS_URL", hosts: null },
  { key: "status", env: "OTHERBRIDGE_STATUS_URL", hosts: null },
];
/** A public https URL on an allowed host, with a real path for social profiles; null otherwise. */
export function safeExternalUrl(
  raw: string | undefined,
  hosts: RegExp | null,
  needsPath: boolean,
) {
  if (!raw || raw.length > 300 || /[\s<>"'`\\]/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (url.protocol !== "https:" || url.username || url.password || url.port)
    return null;
  if (isIP(host.replace(/^\[|\]$/g, "")) || !host.includes(".")) return null;
  if (/(^|\.)(localhost|local|internal|test|example|invalid)$/.test(host))
    return null;
  if (hosts && !hosts.test(host)) return null;
  if (needsPath && url.pathname.replace(/\/+$/, "").length < 2) return null;
  url.hash = "";
  return url.toString();
}
export function socialLinks(
  env: Record<string, string | undefined> = process.env,
): SocialLink[] {
  return SOCIAL.flatMap(({ key, env: name, hosts }) => {
    if (key === "x" && env.OTHERBRIDGE_SOCIAL_X_CONFIRMED !== "true") return [];
    const href = safeExternalUrl(env[name]?.trim(), hosts, !!hosts);
    return href ? [{ key, href }] : [];
  });
}
export function publicOrigin(
  env: Record<string, string | undefined> = process.env,
) {
  const raw = env.OTHERBRIDGE_PUBLIC_ORIGIN?.trim();
  const href = safeExternalUrl(raw, null, false);
  if (!href) return null;
  const url = new URL(href);
  return url.pathname === "/" && !url.search ? url.origin : null;
}
/** Indexing is opt-in and needs a canonical origin; local/dev/staging stay noindex. */
export function indexable(
  env: Record<string, string | undefined> = process.env,
) {
  return (
    env.OTHERBRIDGE_PUBLIC_INDEXING === "true" &&
    env.OTHERBRIDGE_PUBLIC_DEPLOYMENT === "true" &&
    publicOrigin(env) === brand.publicOrigin
  );
}
