import { brand } from "../content/brand";

// Guardian finalization preview: the owner-approved VEINED octopus (brand.previewIdentity) is the symbol everywhere —
// navigation, landing, Guardian and icons — next to the existing VEINED wordmark (unchanged exports). The protected
// Quiet Current files in /assets/veined/brand stay untouched; derivatives live in /assets/veined/brand-octopus.
const SYMBOL = "/assets/veined/brand-octopus/tile-128.png";

/** Shared lockup: octopus tile + VEINED wordmark. Accessible links supply their own name; standalone instances expose
 * one name, independent of the active theme. */
export function BrandLogo({ decorative = false }: { decorative?: boolean }) {
  return (
    <span
      className="veined-logo is-octopus"
      dir="ltr"
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : brand.name}
      aria-hidden={decorative ? true : undefined}
      data-brand-candidate={brand.previewIdentity.candidate}
    >
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand raster; next/image would add an inline style (CSP). */}
      <img
        className="veined-logo-symbol"
        src={SYMBOL}
        width={128}
        height={128}
        alt=""
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG (existing wordmark export). */}
      <img
        className="veined-logo-dark"
        src="/assets/veined/brand/wordmark-light.svg"
        width={232}
        height={42}
        alt=""
      />
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand SVG (existing wordmark export). */}
      <img
        className="veined-logo-light"
        src="/assets/veined/brand/wordmark-dark.svg"
        width={232}
        height={42}
        alt=""
      />
    </span>
  );
}

/** The octopus symbol alone, for the compact navigation rail. Always decorative: it sits inside the brand link, which
 * carries the accessible name. The tile reads on both themes, so one image serves both. */
export function BrandMark() {
  return (
    <span className="veined-mark is-octopus" dir="ltr" aria-hidden="true">
      {/* eslint-disable-next-line @next/next/no-img-element -- static brand raster; next/image would add an inline style (CSP). */}
      <img
        className="veined-mark-dark"
        src={SYMBOL}
        width={128}
        height={128}
        alt=""
      />
    </span>
  );
}

/** The same octopus, for Guardian moments (console title, verdict panel crest). Decorative. */
export function OctopusSymbol({
  size = 22,
  className = "",
}: {
  size?: number;
  className?: string;
}) {
  return (
    // eslint-disable-next-line @next/next/no-img-element -- static brand raster; next/image would add an inline style (CSP).
    <img
      className={`octopus-symbol ${className}`}
      src={size >= 40 ? SYMBOL : "/assets/veined/brand-octopus/tile-64.png"}
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
    />
  );
}
