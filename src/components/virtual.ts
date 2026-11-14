// V1.5 CSP: virtual-list geometry is applied through the CSSOM (element.style), which a strict
// style-src policy does not govern, instead of style="" attributes (blocked without 'unsafe-inline').
// Only finite, non-negative pixel numbers computed from list indices are ever written.
// V1.10: proportional fills (allocation bars, quote freshness) go through one clamped custom property, --fill in
// [0, 1], read by static CSS. Non-finite input writes nothing.
export function cssomFill(fraction: number) {
  return (el: HTMLElement | null) => {
    if (!el || !Number.isFinite(fraction)) return;
    el.style.setProperty(
      "--fill",
      String(Math.round(Math.min(1, Math.max(0, fraction)) * 1000) / 1000),
    );
  };
}
export function cssomPosition(box: { top?: number; height?: number }) {
  return (el: HTMLElement | null) => {
    if (!el) return;
    for (const [prop, value] of Object.entries(box))
      if (typeof value === "number" && Number.isFinite(value) && value >= 0)
        el.style.setProperty(prop, `${Math.round(value)}px`);
  };
}
