// V1.5 CSP: next/image renders style="color:transparent" on every <img>, which a strict style-src
// (no 'unsafe-inline') blocks. Network logos are local, fixed-size, already unoptimized SVGs, so a
// plain lazy <img> renders identically without any inline style attribute.
import { safeLogoSrc } from "./logo-src";
export function LogoImage({ src, size }: { src: string; size: number }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- see the CSP note above.
    <img
      src={safeLogoSrc(src)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  );
}
