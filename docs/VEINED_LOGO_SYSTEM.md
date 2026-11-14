# VEINED V1.20 logo system

**Quiet Current is a recommended candidate, not an owner-approved final logo.**

## Geometry and optical balance

The icon is a single closed path on a 128 × 128 grid. Its visible extent is approximately x14–118 and y15–108. Two inbound left currents meet beneath an open incision; the wider lower curve transitions to a tapered rising right route. There are no overlapping paint layers, masks, embedded rasters, filters or stroke-scaling dependencies.

The wordmark uses six original path glyphs on a 232 × 42 grid. Letter cap height is 34 units (y4–38). The V and D are slightly broader than the E; the I has the same stem weight as the other characters. Letter positions, not CSS tracking, establish the spacing. Do not typeset a substitute and call it the supplied wordmark.

The horizontal lockup uses a 376 × 96 artboard. The icon occupies an 80-unit grid starting at (8,8). The wordmark begins at (112,25), scaled 1.04. Its cap center aligns optically to the icon’s visible center. At 157 × 40 CSS pixels, the visible mark is about 27px high and the lettering about 15px high. Explicit intrinsic width/height prevent layout shifts.

## Required variants

| File                                         | Intended use                                                                        |
| -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `primary-logo.svg`                           | Sage icon and ivory wordmark on graphite/dark surfaces.                             |
| `logo-on-light.svg`                          | Deep sage icon and ink wordmark on paper/light surfaces.                            |
| `primary-icon.svg` / `icon-on-light.svg`     | Transparent standalone icon, dark/light target surface.                             |
| `wordmark-light.svg` / `wordmark-dark.svg`   | Ivory/ink **letter color**, respectively.                                           |
| `logo-mono-white.svg` / `logo-mono-dark.svg` | One-color lockups for constrained use.                                              |
| `favicon.svg` / `favicon.ico`                | Sage icon with opaque graphite background. ICO contains 16, 32, 48 and 64px frames. |
| `maskable-icon-512.png`                      | Full opaque canvas, 22% grid inset, foreground inside the centered 80% safe circle. |

All files above are under `public/assets/veined/brand/`. Concept directories preserve icon, wordmark, lockup, white/dark mono, light/dark backgrounds and 16/24/32/64/128/256px raster previews for each alternative.

## Clear space and minimum sizes

- Use at least **16 icon-grid units**, or one eighth of displayed icon width, as clear space from unrelated text, boundaries and controls. The supplied lockup already handles its internal spacing.
- Standalone icon: **16px minimum** for browser favicon; **24px minimum** for interface use. At 16px, preserve the silhouette and allow the incision to read as a subtle optical split. Do not thicken it independently.
- Wordmark: **96px minimum width** when used alone. Lockup: **148px minimum width**, with the native 376:96 aspect ratio. For dense navigation, use a separate 28–32px icon and 112–120px wordmark with an 8–10px gap.
- Do not mirror the identity in RTL. Preserve the letter order **VEINED**, and place surrounding navigation according to locale direction.

## Accessibility

An identity link should have one accessible name, such as “VEINED home”. If its icon and wordmark are separate SVGs, hide the decorative children from assistive technology and name the parent. Standalone exported SVGs include a `title` referenced by `aria-labelledby`; use `alt="VEINED"` when consumed as an HTML image. Provide explicit dimensions. A decorative repeated mark uses empty alt text.

Never replace an action label, a transaction warning or status text with a logo. The brand mark is not a loading spinner or a financial status indicator. Reduced motion does not need a special logo variant because the identity is static.

## Incorrect usage

| Incorrect example                                                   | Required correction                                                    |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Stretch a 376 × 96 lockup to 180 × 30                               | Keep its native aspect ratio, or use the standalone wordmark and icon. |
| Put ivory lettering on the paper background                         | Use the ink/deep-sage light-surface export.                            |
| Close the shoulder incision or add a fourth stroke                  | Use the original supplied silhouette.                                  |
| Append `.xyz` to the primary wordmark                               | Keep the logo exactly VEINED; domain text belongs in supporting copy.  |
| Add glow, metallic effects, bevels, a circular badge or extra nodes | Use the flat original geometry; atmosphere belongs behind the UI.      |
| Rotate/mirror the mark or reverse letters for RTL                   | Keep the original orientation and LTR brand spelling.                  |
| Claim the candidate is approved, trademark-cleared or deployed      | Preserve the owner-review status and closed execution boundary.        |
