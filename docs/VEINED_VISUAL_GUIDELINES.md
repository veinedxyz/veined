# VEINED V1.20 visual guidelines

This system retains the accepted V1.19 visual direction. Quiet Current is the recommended identity candidate; owner selection remains open.

## Color and material hierarchy

| Token / role                   | Dark               | Light                |
| ------------------------------ | ------------------ | -------------------- |
| Page background                | `#0b0c0f` graphite | `#f6f4f0` warm paper |
| Elevated background            | `#0e0f12`          | `#f9f8f5`            |
| Primary data surface           | `#151619`          | `#ffffff`            |
| Secondary surface              | `#1b1c20`          | `#faf9f6`            |
| Inset controls                 | `#101114`          | `#f3f1ed`            |
| Primary text / wordmark        | `#f1f0ec` ivory    | `#232326` ink        |
| Brand / action accent          | `#bdccb9` sage     | `#3e604a` deep sage  |
| Strong accent                  | `#d4e0d0`          | `#2f4b39`            |
| Primary border                 | `#2b2c32`          | `#dcd8cf`            |
| Muted text                     | `#b0afb5`          | `#625d66`            |
| Caution, never decoration-only | `#e3bd77`          | `#7d5c12`            |

These colors come from the existing `src/app/globals.css` and V1.19 materials. Ivory is reserved for readable primary text; sage identifies brand/actions/verified states, and warm amber remains caution. Do not recolor warnings to match the logo. Financial surfaces remain opaque.

Measured relative-luminance contrast for the actual exported colors: sage on graphite **11.64:1**, deep sage on paper **6.42:1**, ivory on graphite **17.15:1**, and ink on paper **14.27:1**. These solid-background measurements do not replace checking a logo placed over imagery; use a quiet opaque backing when necessary.

## Typography and spacing

Keep the existing Inter/system sans-serif stack and locale-aware Noto fallbacks. The primary logo lettering is supplied vector geometry, not a new product font. No remote font request is introduced. Financial numbers retain existing tabular/monospace treatments and alignment.

Use the established display rhythm: page titles at 30–54px depending on context, with approximately −0.035em to −0.045em tracking; normal content retains its existing readable sizing and line height. Eyebrows use 11px, weight 600 and +0.12em. Avoid applying logo-style uppercase tracking to paragraphs or transaction amounts. Use logical inline/block properties so component spacing follows RTL while the logo remains unmirrored.

## Surfaces, borders and shadows

Retain the V1.19 24px major visual radius, 1px restrained edges and opaque data cards. `--visual-edge` is sage at 18% on dark or deep sage at 20% on light. Existing smaller controls and menus keep their established radii rather than inheriting the large card radius.

The accepted dark visual shadow remains `0 20px 60px -35px rgb(0 0 0 / 0.8)`; light remains `0 20px 60px -35px rgb(32 40 30 / 0.25)`. Do not add glows, heavy blur behind amounts or contrast-reducing translucency to financial surfaces.

## Imagery and icons

Preserve the V1.19 Earth, bridge at dusk, liquidity currents, portfolio nodes, network atlas and safety architecture images. Their warm architectural light and muted sage texture provide atmosphere. They are decorative, locally hosted and never evidence of real balances, integrations, routes or execution. Illustrative data stays explicitly labelled.

The brand icon belongs in shared navigation, the footer and identity metadata. Use the existing consistent line-icon family for controls; avoid repeating the logo across every card or treating it as a warning/status symbol. Do not use cartoon tentacles, neon network globes or generic crypto hexagons as new decoration.

## Motion and performance

The brand assets are static. Retain the existing 220ms material transition and easing where already appropriate, and honor reduced motion. No looping logo animation, canvas, viewport listener or image-loading effect is needed for the identity. Declare dimensions and keep navigation asset sizing stable. Atmospheric artwork must not obscure meaningful content or dominate its loading path; Portfolio performance evidence belongs in `V120_PERFORMANCE_REPAIR.md`.

## Review and export use

The local review gallery is `/assets/veined/brand/review.html`. Its concept cards show both themes and actual-size previews; the evaluation is explicitly subjective. Social images are completed exports with “owner-review candidate / execution closed” labeling. The X banner is a deliverable, not evidence of account control or an instruction to publish it.

Asset integrity and sanitization are enforced by `tests/unit/v120-brand-assets.test.ts`. Full product responsive, locale, RTL, axe and performance results are recorded separately in the V1.20 test matrix; the presence of these assets alone does not imply those gates passed.
