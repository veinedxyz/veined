# CSP hardening (V1.5)

Result: the production app policy no longer allows inline scripts **or** inline styles; the Data API docs page allows exactly one stylesheet by SHA-256 hash. No functionality, responsive layout, RTL or theme was removed (full E2E 151/151, production smoke, 24 production locales, V1.3/V1.4 production suites and the CSP browser acceptance all pass).

## Inventory (before V1.5)

| Source | Kind | Where | Disposition |
|---|---|---|---|
| `chainStyle(network)` | per-network CSS variables (`--network-*`) | `multichain-identity.tsx` (ChainLogo, ChainBadge), `product.tsx` (source/destination selectors), `swap.tsx`, `network-selector.tsx`, `multichain-catalog.tsx` | network theme → generated same-origin classes |
| `networkStyle(id)` | curated V1 identities (ONEchain, BSC) | `network-identity.tsx`, `product.tsx` network cards | generated classes |
| `<main style={{--source-glow,--destination-glow}}>` | ambient scene light | `product.tsx` | generated `src-*` / `dst-*` classes |
| virtual list geometry (`height`, `position`, `top`, `width`) | virtualization positioning | `network-selector.tsx`, `multichain-catalog.tsx` | static CSS classes + CSSOM offsets |
| `next/image` | framework-injected `style="color:transparent"` on every image | logos | plain lazy `<img>` (`logo-image.tsx`) |
| Data API docs `<style>` | static docs stylesheet | `src/data/api/docs-page.ts` | exact SHA-256 hash |
| Next.js inline styles | framework | none emitted in production (verified: 0 `<style>` elements on all 8 routes) | per-request nonce kept in `style-src` for any future framework-generated `<style>` |

## Implementation

- **Network themes** (`src/content/network-themes.ts`, generated `src/app/network-themes.css`, generator `scripts/network-themes-css.mjs`): a theme maps to a class only when its exact colour tuple belongs to the reviewed source set (neutral, ONEchain, BSC, 76 catalog assets → 79 classes). Colours are validated (`#rrggbb`, `r g b` ≤ 255, `transparent`) before they are emitted. Unknown or tampered tuples fall back to `nt-neutral`; no runtime value is ever interpolated into CSS text. A unit test asserts the committed stylesheet is byte-identical to the generator and that every rule has a strict shape.
- **Virtual lists** (`src/components/virtual.ts`): static `virtual-spacer`, `virtual-row`, `active-catalog-row` classes; the per-row `top` and spacer `height` are applied with `element.style.setProperty` (CSSOM). CSP `style-src` governs style attributes and `<style>` elements, not CSSOM property assignment; only finite, non-negative pixel numbers derived from list indices are written. Behaviour (keyboard navigation, `aria-posinset/setsize`, scrolling) is unchanged.
- **Logos** (`src/components/logo-image.tsx`): plain `<img loading="lazy" decoding="async">` with fixed size; only same-origin static paths are rendered (anything else becomes the neutral logo).
- **Docs** (`DOCS_CSS`, `DOCS_CSS_HASH`, `DOCS_CSP`): `default-src 'none'; style-src 'sha256-…'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`. The page has no scripts.

## Final policy (`src/proxy.ts`, `contentSecurityPolicy()`)

Production:

```text
default-src 'self'; script-src 'self' 'nonce-<per-request>' 'strict-dynamic'; style-src 'self' 'nonce-<per-request>';
style-src-attr 'none'; img-src 'self' data:; connect-src 'self'; font-src 'self'; frame-src 'none';
frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'
```

Development only: `'unsafe-eval'` in `script-src` (React dev tooling) and `style-src 'self' 'unsafe-inline'` (Next dev style injection); no `style-src-attr`. A new nonce is generated per response (verified: two concurrent responses differ).

## Tests and evidence

- `tests/unit/v15-csp.test.ts`: exact directives, dev-only allowances, docs hash/no scripts, stylesheet sync and rule shape, seeded tamper fallback, CSSOM writer bounds, source guard (no `style={…}`, `next/image`, `dangerouslySetInnerHTML`, `setAttribute('style')` in `src`).
- `scripts/v15-csp.mjs` (production build, evidence `csp/`): header exactness on `/`, `/swap`, `/portfolio`, `/networks`, `/activity`, `/settings`, `/help`, `/about`; no inline style attribute or un-nonced `<style>` in SSR HTML; browser at 1440 and 390 px with network selector and language selector opened and AR RTL Portfolio: **0 CSP violations, 0 console errors**; resolved `--source-glow` proves the classes apply. Injected payload served under the real header: inline script, inline event handler, `javascript:` URL, inline style attribute, inline `<style>`, external script/stylesheet, `data:` iframe and `<object>` — none executed or applied; violations recorded for `script-src-elem`, `script-src-attr`, `style-src-attr`, `style-src-elem`, `frame-src`, `object-src`. Data API docs: hashed stylesheet applied (`max-width: 920px`), injected `<style>`/`<script>`/style attribute blocked.
- Staging (TLS ingress) re-checks the header and 0 violations on Bridge, Swap, Portfolio and Networks.
- Visual: screenshots in `csp/screenshots/`; full E2E 151/151 (theme, viewport, RTL, keyboard, 200% zoom and reduced-motion cases included).

## Security headers decisions (§22)

| Header | Decision | Reason |
|---|---|---|
| `Strict-Transport-Security: max-age=31536000` | kept | effective once served over HTTPS; ignored on loopback HTTP |
| `includeSubDomains` / `preload` | **not enabled** | requires verified ownership and HTTPS on every subdomain of the final domain and is hard to revert; owner/release decision (`docs/DOMAIN_RELEASE_CHECKLIST.md`) |
| `Referrer-Policy: no-referrer` | kept | no referrer is needed by any flow |
| `Permissions-Policy: camera=(), microphone=(), geolocation=()` | kept | no device APIs used |
| `X-Content-Type-Options: nosniff` | kept | app and Data API |
| framing | CSP `frame-ancestors 'none'` | supersedes `X-Frame-Options` |
| COOP / COEP / CORP | **not enabled** | injected wallet providers and wallet popups rely on cross-window communication; COOP `same-origin` can break them and COEP gives no benefit without cross-origin isolation needs. Re-evaluate with real wallet testing before release. |
