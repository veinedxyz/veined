// Ocean refinement: framework-free marks shared by the application (ocean-marks.tsx, client) and the server-rendered
// landing page, so the landing gains the same token and tag language without any client code.
// - markHue / markInitials: the generated sea-glass medallion of a token without a reviewed logo.
// - TideGlyph: small marine glyphs on a 12 px grid — pearl = reviewed, current = listed in a market, sonar =
//   discovered on a DEX, buoy = imported by you, reef = a hazard (same symbol, blocked), drift = unpriced,
//   still = no route, native = the network's own asset, depth = a layer of coverage.
// CSP: no style attributes anywhere; hues are static classes (tm-h0 … tm-h11 in deep-system.css).
import type { ReactNode } from "react";

const HUES = 12;
/** Deterministic hue class (0..11) from the exact address, falling back to the symbol. */
export function markHue(seed: string) {
  let h = 2166136261;
  for (const c of seed.toLowerCase()) {
    h ^= c.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % HUES;
}
/** Up to four letters or digits of the symbol (WETH, WBTC keep their full name; longer symbols keep three). */
export function markInitials(symbol: string) {
  const clean = [...(symbol || "").replace(/[^\p{L}\p{N}]/gu, "")];
  return clean
    .slice(0, clean.length <= 4 ? 4 : 3)
    .join("")
    .toUpperCase();
}

export type TideKind =
  | "native"
  | "pearl"
  | "current"
  | "sonar"
  | "buoy"
  | "reef"
  | "drift"
  | "still"
  | "depth";
export type TideTone = "calm" | "glow" | "amber" | "coral" | "mute";

export function TideGlyph({ kind }: { kind: TideKind }) {
  return (
    <svg
      className="tide-glyph"
      width={12}
      height={12}
      viewBox="0 0 12 12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {kind === "pearl" && (
        <>
          <circle cx="6" cy="6" r="3.6" />
          <circle cx="4.9" cy="4.9" r="0.9" fill="currentColor" stroke="none" />
        </>
      )}
      {kind === "native" && (
        <path d="M6 1.6v8.8M3 7.4 6 10.4l3-3M3.6 3.2h4.8" />
      )}
      {kind === "current" && (
        <path d="M1.4 4.6c1.5-1.2 3-1.2 4.6 0s3.1 1.2 4.6 0M1.4 8c1.5-1.2 3-1.2 4.6 0s3.1 1.2 4.6 0" />
      )}
      {kind === "sonar" && (
        <>
          <circle cx="6" cy="6" r="1.1" fill="currentColor" stroke="none" />
          <path d="M3.4 3.4a3.7 3.7 0 0 0 0 5.2M8.6 3.4a3.7 3.7 0 0 1 0 5.2" />
        </>
      )}
      {kind === "buoy" && (
        <>
          <circle cx="6" cy="6" r="3.8" />
          <path d="M6 2.2v1.6M6 8.2v1.6M2.2 6h1.6M8.2 6h1.6" />
        </>
      )}
      {kind === "reef" && (
        <path d="M6 1.8 10.6 10H1.4L6 1.8Zm0 3.4v2.2m0 1.4v.1" />
      )}
      {kind === "drift" && (
        <>
          <circle cx="6" cy="6" r="3.8" strokeDasharray="1.6 1.4" />
          <path d="M6 4.6v1.6" />
        </>
      )}
      {kind === "still" && <path d="M1.6 6h2.6M7.8 6h2.6M5 4.2 7 7.8" />}
      {kind === "depth" && <path d="M2 3h8M3.2 6h5.6M4.6 9h2.8" />}
    </svg>
  );
}

/** Information mark: glyph + always-present label (meaning never depends on colour or shape alone). */
export function TideTag({
  kind,
  tone = "calm",
  children,
  className = "",
  title,
}: {
  kind: TideKind;
  tone?: TideTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      className={`tide tide-${tone}${className ? ` ${className}` : ""}`}
      title={title}
    >
      <TideGlyph kind={kind} />
      <span className="tide-text">{children}</span>
    </span>
  );
}

/** Server-safe medallion (no state): the generated mark of a token without a reviewed logo. */
export function Medallion({
  symbol,
  seed,
  size = "md",
}: {
  symbol: string;
  seed?: string;
  size?: "xs" | "sm" | "md" | "lg";
}) {
  const initials = markInitials(symbol) || "?";
  return (
    <span className={`tmark tmark-${size}`} aria-hidden="true">
      <span
        className={`tmark-face is-medallion tm-h${markHue(seed || symbol || "?")} tm-n${Math.min(initials.length, 4)}`}
      >
        <span className="tmark-initials">{initials}</span>
      </span>
    </span>
  );
}
