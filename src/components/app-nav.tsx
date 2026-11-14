"use client";
// Application navigation. One <nav> for every viewport: a vertical rail on desktop (every destination visible, no
// wrapping in long locales), a bottom tab bar on narrow screens where the secondary destinations open as a sheet
// from "More". Glyphs are local paths drawn here so the first-load core icon set stays unchanged (CSP: no styles).
// Abyssal layer: every destination is an extension of one organism. The active destination is held by an arm — a reach
// from the rail's nerve cord and a coiled tip around its glyph — drawn by CSS only; it is decorative feedback that never
// delays navigation, never covers a label and is static under reduced motion.
import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";

const glyphs = {
  home: (
    <>
      <path d="M4 10.5 12 4l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5.5h-5V20H5a1 1 0 0 1-1-1v-8.5Z" />
    </>
  ),
  swap: (
    <>
      <path d="M7 4v14m0 0-3-3m3 3 3-3" />
      <path d="M17 20V6m0 0-3 3m3-3 3 3" />
    </>
  ),
  bridge: (
    <>
      <path d="M3 16c3-5.5 15-5.5 18 0" />
      <path d="M3 16h18M7 12.6V16M12 11.2V16M17 12.6V16" />
    </>
  ),
  portfolio: (
    <>
      <path d="m12 3.5 8.5 4.75L12 13 3.5 8.25 12 3.5Z" />
      <path d="m3.5 12.25 8.5 4.75 8.5-4.75M3.5 16.25 12 21l8.5-4.75" />
    </>
  ),
  points: (
    <>
      <path d="m12 3.5 2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.5Z" />
    </>
  ),
  activity: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  // G12 H06 VEINED Scan: a lens over a route line (follow a transfer, read-only).
  scan: (
    <>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15 15 5 5M7.5 10.5h6" />
    </>
  ),
  networks: (
    <>
      <circle cx="6" cy="6.5" r="2.25" />
      <circle cx="18" cy="6.5" r="2.25" />
      <circle cx="12" cy="17.5" r="2.25" />
      <path d="M8.2 6.5h7.6M7.2 8.4l3.6 7.2M16.8 8.4l-3.6 7.2" />
    </>
  ),
  // VEINED Guardian: a shield with a check — a function glyph; the brand symbol stays the octopus.
  guardian: (
    <>
      <path d="M12 3.5 19 6v5.4c0 4.3-2.9 7.7-7 9.1-4.1-1.4-7-4.8-7-9.1V6l7-2.5Z" />
      <path d="m8.8 12.1 2.2 2.2 4.3-4.4" />
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9.7 9.4a2.4 2.4 0 1 1 3.4 2.2c-.7.4-1.1.9-1.1 1.7v.4M12 16.6v.1" />
    </>
  ),
  more: (
    <>
      <circle cx="5.5" cy="12" r="1.2" />
      <circle cx="12" cy="12" r="1.2" />
      <circle cx="18.5" cy="12" r="1.2" />
    </>
  ),
} as const;
export type NavGlyphName = keyof typeof glyphs;
export function NavGlyph({ name }: { name: NavGlyphName }) {
  return (
    <svg
      className="nav-glyph"
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {glyphs[name]}
    </svg>
  );
}
/** Decorative arm: a reach from the inline-start edge (hidden by the deep layer) and a short tip that cradles the
 * 20 px glyph from its inline-start side and curls over its top, never reaching toward the label (glyph-centred
 * coordinates). Mirrored in RTL by CSS; hidden from assistive technology. */
export function NavArm({ className = "" }: { className?: string }) {
  return (
    <svg
      className={`nav-arm ${className}`}
      width={120}
      height={38}
      viewBox="-96 -22 120 38"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        className="nav-arm-reach"
        pathLength={1}
        d="M-96 -4C-70 -4 -50 10 -32 11.5C-24 12 -18 10.5 -16 8"
      />
      <path
        className="nav-arm-tip"
        pathLength={1}
        d="M-9 13C-16.5 9 -17.5 -3 -12 -10.5C-7.5 -16.5 1.5 -17.5 6.5 -13.5C9.5 -11 8 -7.5 5 -9"
      />
      {/* gf1 G04: three suckers on the inner side of the tip, shown once the arm holds the selected destination. */}
      <g className="nav-arm-suckers">
        <circle cx={-13.4} cy={3.2} r={0.85} />
        <circle cx={-13.2} cy={-4.6} r={0.85} />
        <circle cx={-8.2} cy={-11.6} r={0.85} />
      </g>
    </svg>
  );
}
export interface NavItem {
  href: string;
  label: string;
  glyph: NavGlyphName;
}
function NavLink({ item, path }: { item: NavItem; path: string }) {
  const active = path === item.href || path.startsWith(`${item.href}/`);
  return (
    <Link
      className={active ? "nav-link active" : "nav-link"}
      aria-current={active ? "page" : undefined}
      href={item.href}
    >
      <span className="nav-glyph-wrap">
        <NavGlyph name={item.glyph} />
        <NavArm />
      </span>
      <span className="nav-label">{item.label}</span>
    </Link>
  );
}
export function AppNav({
  path,
  label,
  moreLabel,
  primary,
  secondary,
  footer,
}: {
  path: string;
  label: string;
  moreLabel: string;
  primary: NavItem[];
  secondary: NavItem[];
  footer?: ReactNode;
}) {
  // The sheet belongs to the route it was opened on: navigating anywhere closes it without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  const nav = useRef<HTMLElement>(null),
    toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!nav.current?.contains(event.target as Node)) setOpenOn(null);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenOn(null);
      toggle.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  const secondaryActive = secondary.some(
    (item) => path === item.href || path.startsWith(`${item.href}/`),
  );
  return (
    <nav ref={nav} className="main-nav" aria-label={label}>
      <div className="nav-group nav-primary">
        {primary.map((item) => (
          <NavLink key={item.href} item={item} path={path} />
        ))}
      </div>
      <button
        ref={toggle}
        type="button"
        className={`nav-link nav-more${secondaryActive ? " active" : ""}`}
        aria-expanded={open}
        aria-controls="nav-more-panel"
        onClick={() => setOpenOn(open ? null : path)}
      >
        {/* gf1 G04: on phones a secondary destination lives behind "More", so the arm holds "More" while one is open. */}
        <span className="nav-glyph-wrap">
          <NavGlyph name="more" />
          <NavArm />
        </span>
        <span className="nav-label">{moreLabel}</span>
      </button>
      <div
        id="nav-more-panel"
        className="nav-group nav-secondary"
        data-open={open ? "true" : undefined}
      >
        {secondary.map((item) => (
          <NavLink key={item.href} item={item} path={path} />
        ))}
        {footer}
      </div>
    </nav>
  );
}
