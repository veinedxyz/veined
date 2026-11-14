// Only same-origin static paths are rendered (img-src 'self' enforces the same in the browser): a
// protocol-relative "//host/..." or a traversal falls back to the neutral mark.
export function safeLogoSrc(src: string) {
  return /^\/[A-Za-z0-9_.-][A-Za-z0-9/_.-]{0,199}$/.test(src) &&
    !src.includes("..") &&
    !src.includes("//")
    ? src
    : "/networks/neutral.svg";
}

export { isAssetLogoSrc } from "../assets/logo-path";
