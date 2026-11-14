"use client";
// Ocean refinement: the shared marks of every token row, selector and summary in the application.
// - TokenMark: the token's own reviewed logo when one exists (same-origin path only, see logo-src.ts); otherwise a
//   generated sea-glass medallion (deterministic hue from the exact address or symbol, initials sized to fit) so no
//   token is ever shown as bare text or an empty circle. A logo that fails to load falls back to the medallion. An
//   optional network badge sits on the medallion's edge: it tells which network the asset lives on without another
//   line of text.
// - TideTag (re-exported from ocean-glyphs.tsx): the information marks (trust level, risk, price and route state).
// CSP: no style attributes; the hue is one of twelve static classes, the logo a plain <img>.
import { useState } from "react";
import { safeLogoSrc } from "./logo-src";
import { markHue, markInitials } from "./ocean-glyphs";

export { TideGlyph, TideTag, type TideKind } from "./ocean-glyphs";

export type MarkSize = "xs" | "sm" | "md" | "lg";
export interface MarkNetwork {
  logo?: string | null;
  name?: string;
}
const NEUTRAL = "/networks/neutral.svg";

export function TokenMark({
  symbol,
  logo,
  seed,
  network,
  size = "md",
  className = "",
}: {
  symbol: string;
  /** Reviewed same-origin logo path (registry, asset image proxy or network logo for a native asset). */
  logo?: string | null;
  /** Exact address (or any stable identity) for the medallion hue; the symbol is used when absent. */
  seed?: string;
  /** Network badge on the medallion's edge. */
  network?: MarkNetwork | null;
  size?: MarkSize;
  className?: string;
}) {
  const [broken, setBroken] = useState<string | null>(null);
  const src = logo ? safeLogoSrc(logo) : null;
  const usable = src !== null && src !== NEUTRAL && broken !== src;
  const initials = markInitials(symbol) || "?";
  const badge = network?.logo ? safeLogoSrc(network.logo) : null;
  return (
    <span
      className={`tmark tmark-${size}${className ? ` ${className}` : ""}`}
      aria-hidden="true"
    >
      {usable ? (
        <span className="tmark-face is-logo">
          {/* eslint-disable-next-line @next/next/no-img-element -- CSP: plain same-origin image, no inline style */}
          <img
            src={src}
            alt=""
            width={40}
            height={40}
            loading="lazy"
            decoding="async"
            onError={() => setBroken(src)}
          />
        </span>
      ) : (
        <span
          className={`tmark-face is-medallion tm-h${markHue(seed || symbol || "?")} tm-n${Math.min(initials.length, 4)}`}
        >
          <span className="tmark-initials">{initials}</span>
        </span>
      )}
      {badge && badge !== NEUTRAL && (
        <span className="tmark-badge">
          {/* eslint-disable-next-line @next/next/no-img-element -- CSP: plain same-origin image, no inline style */}
          <img
            src={badge}
            alt=""
            width={16}
            height={16}
            loading="lazy"
            decoding="async"
          />
        </span>
      )}
    </span>
  );
}
