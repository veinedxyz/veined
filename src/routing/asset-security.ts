import { SaxesParser } from "saxes";
const tags = new Set(
  "svg g path rect circle ellipse polygon polyline line defs linearGradient radialGradient stop clipPath mask title desc style use".split(
    " ",
  ),
);
const attributes = new Set(
  "xmlns xmlns:xlink version viewBox width height x y x1 x2 y1 y2 cx cy r rx ry d fill stroke stroke-width stroke-linecap stroke-linejoin stroke-miterlimit fill-rule clip-rule opacity fill-opacity stroke-opacity transform id class style points offset stop-color stop-opacity gradientUnits gradientTransform spreadMethod clip-path mask maskUnits maskContentUnits preserveAspectRatio href xlink:href enable-background".split(
    " ",
  ),
);
export function safeSvg(source: string): boolean {
  if (source.length > 262144 || /<!DOCTYPE|<!ENTITY|<\?|\u0000/i.test(source))
    return false;
  let valid = true,
    root = false;
  const css = (value: string) =>
    !/[@\\]|expression|javascript|data:|https?:|\/\*/i.test(value) &&
    [...value.matchAll(/url\s*\(([^)]*)\)/gi)].every((m) =>
      /^['"]?#[a-z0-9_-]+['"]?$/i.test(m[1].trim()),
    );
  const parser = new SaxesParser();
  parser.on("error", () => {
    valid = false;
  });
  parser.on("opentag", (tag) => {
    if (!root) {
      root = true;
      if (tag.name !== "svg") valid = false;
    }
    if (!tags.has(tag.name)) valid = false;
    for (const [name, value] of Object.entries(tag.attributes)) {
      if (!attributes.has(name) || /^on/i.test(name)) valid = false;
      if (
        (name === "href" || name === "xlink:href") &&
        !/^#[a-z0-9_-]+$/i.test(value)
      )
        valid = false;
      if (
        name.startsWith("xmlns") &&
        ![
          "http://www.w3.org/2000/svg",
          "http://www.w3.org/1999/xlink",
        ].includes(value)
      )
        valid = false;
      if (!name.startsWith("xmlns") && !css(value)) valid = false;
    }
  });
  parser.on("text", (value) => {
    if (!css(value)) valid = false;
  });
  parser.on("cdata", () => {
    valid = false;
  });
  try {
    parser.write(source).close();
  } catch {
    valid = false;
  }
  return root && valid;
}
// Only public asset repositories used by the current official catalog. No redirects,
// URL credentials, non-HTTPS, IP hosts, user supplied host or arbitrary proxy.
export function safeLogoUrl(raw: string) {
  try {
    const u = new URL(raw);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      !u.hash &&
      !u.search &&
      ((u.hostname === "raw.githubusercontent.com" &&
        /^\/lifinance\/types\/main\/src\/assets\/icons\/chains\/[a-zA-Z0-9_.-]+\.(svg|png|webp)$/.test(
          u.pathname,
        )) ||
        (u.hostname === "lifinance.github.io" &&
          /^\/types\/src\/assets\/icons\/chains\/[a-zA-Z0-9_.-]+\.svg$/.test(
            u.pathname,
          )))
    );
  } catch {
    return false;
  }
}
