import { sanitizeText } from "../../data/core/sanitize";
// Upstream catalog metadata is untrusted. Names become bounded inert text with explicit flags; URLs are reduced to a
// validated origin + path (never rendered as a link for catalog-only entries); logos are never fetched or rendered.
const BIDI = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;
const INVISIBLE =
  /[\u00ad\u115f\u1160\u17b4\u17b5\u180e\u200b-\u200d\u2060-\u2065\u3164\ufe00-\ufe0f\ufeff\uffa0]/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// Common Cyrillic/Greek letters that render like Latin ones. Used only to detect impersonation, never to rename.
const CONFUSABLE: Record<string, string> = {
  а: "a",
  в: "b",
  е: "e",
  к: "k",
  м: "m",
  н: "h",
  о: "o",
  р: "p",
  с: "c",
  т: "t",
  у: "y",
  х: "x",
  і: "i",
  ј: "j",
  ѕ: "s",
  ԁ: "d",
  ӏ: "l",
  ɡ: "g",
  А: "a",
  В: "b",
  Е: "e",
  К: "k",
  М: "m",
  Н: "h",
  О: "o",
  Р: "p",
  С: "c",
  Т: "t",
  Х: "x",
  І: "i",
  Ј: "j",
  Ѕ: "s",
  α: "a",
  ο: "o",
  ρ: "p",
  τ: "t",
  υ: "u",
  ν: "v",
  ι: "i",
  κ: "k",
  χ: "x",
  ε: "e",
  Α: "a",
  Β: "b",
  Ε: "e",
  Ζ: "z",
  Η: "h",
  Ι: "i",
  Κ: "k",
  Μ: "m",
  Ν: "n",
  Ο: "o",
  Ρ: "p",
  Τ: "t",
  Υ: "y",
  Χ: "x",
};
export interface CleanName {
  value: string;
  flags: string[];
}
const MARKUP = /[<>`\\]/u;
export function cleanName(raw: unknown, limit = 120): CleanName {
  const flags: string[] = [];
  if (typeof raw !== "string") return { value: "", flags: ["NAME_MISSING"] };
  if (BIDI.test(raw)) flags.push("BIDI_CONTROL_REMOVED");
  if (INVISIBLE.test(raw)) flags.push("INVISIBLE_REMOVED");
  if (CONTROL.test(raw)) flags.push("CONTROL_REMOVED");
  if (MARKUP.test(raw)) flags.push("MARKUP_REMOVED");
  if (raw.includes('"')) flags.push("QUOTE_REMOVED");
  // Apostrophes are ordinary in protocol names (rendered as React text, never HTML); everything else is reduced to
  // the shared inert-text rules.
  const value = sanitizeText(raw.replace(/'/g, "’"), limit + 1)
    .replace(/’/g, "'")
    .replace(/\s+/g, " ");
  if (value.length > limit) flags.push("NAME_TRUNCATED");
  const text = value.slice(0, limit).trim();
  if (mixedScript(text)) flags.push("MIXED_SCRIPT");
  if (!text) flags.push("NAME_MISSING");
  return { value: text, flags };
}
const SCRIPTS: [string, RegExp][] = [
  ["latin", /\p{Script=Latin}/u],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["greek", /\p{Script=Greek}/u],
];
export function mixedScript(value: string) {
  return SCRIPTS.filter(([, re]) => re.test(value)).length > 1;
}
/** Comparison skeleton: case-folded, confusables folded, separators removed. */
export function skeleton(value: string) {
  return [...value.normalize("NFKC").toLowerCase()]
    .map((c) => CONFUSABLE[c] ?? c)
    .join("")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}
export function cleanUrl(raw: unknown): {
  url: string | null;
  flags: string[];
} {
  if (raw === null || raw === undefined || raw === "")
    return { url: null, flags: [] };
  if (typeof raw !== "string" || raw.length > 2048)
    return { url: null, flags: ["URL_REJECTED"] };
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { url: null, flags: ["URL_REJECTED"] };
  }
  if (
    (u.protocol !== "https:" && u.protocol !== "http:") ||
    u.username ||
    u.password ||
    !/^[a-z0-9.-]{1,253}$/.test(u.hostname) ||
    !u.hostname.includes(".") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)
  )
    return { url: null, flags: ["URL_REJECTED"] };
  const flags = u.hostname.split(".").some((l) => l.startsWith("xn--"))
    ? ["PUNYCODE_HOST"]
    : [];
  if (u.protocol === "http:") flags.push("INSECURE_URL");
  const path = u.pathname.replace(/[^A-Za-z0-9/._~-]/g, "").slice(0, 200);
  return {
    url: `${u.protocol}//${u.hostname}${path === "/" ? "" : path}`.slice(
      0,
      300,
    ),
    flags,
  };
}
// DeFiLlama slugs use lowercase alphanumerics plus . _ - + ( ) ! ; path parameters are always URI-encoded.
const SLUG = /^[a-z0-9][a-z0-9._+()!-]{0,119}$/;
export const validSlug = (value: unknown): value is string =>
  typeof value === "string" && SLUG.test(value);
export function slugify(value: string) {
  return (
    value
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "unnamed"
  );
}
export function finiteNonNegative(value: unknown): number | null {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value < 1e16
    ? Math.round(value * 100) / 100
    : null;
}
