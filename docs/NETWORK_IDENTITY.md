# Multichain network identity — current addendum

3 October 2026. The earlier official ONE/BNB identity is preserved in the historical section below. The new dynamic catalog uses 76 provider-metadata logos + the custom ONE entry. Asset names are content-hashed and same-origin; `src/routing/generated-assets.json` carries each network's logo/primary/accent/glow/badgeDark/badgeLight/logoSurface/provenance tokens. The list of networks is not built from the visual manifest; it comes from the real chain/tools API. A new network whose asset has not been reviewed gets text + a safe geometric icon.

Current source/pipeline: [MULTICHAIN_NETWORK_CATALOG.md](MULTICHAIN_NETWORK_CATALOG.md), [MULTICHAIN_ROUTING_RESEARCH.md](MULTICHAIN_ROUTING_RESEARCH.md). The 76 cached logo hashes are in the `asset-sync-b/asset-sync.json` file; ambient colors are derived from the SVG palette and do not count as official brand colors. The official logos were not recolored. Black/white icons get a suitable matte plate. The dynamic Bridge/Networks/Activity/review use the same `ChainLogo`/`ChainBadge` tokens; the old ONE details keep their old shared components.

The dark opaque center and the low-intensity radial/ambient light are preserved. The new selector includes a virtual list, search, recent networks, keyboard support and real logos; there are no emoji. `contrast-multichain.json` computed a minimum of **4.846:1** for small text across 76 networks × two themes; 21 light-intensity samples and the badge blend were checked. Raw browser axe incomplete results are also kept; zero violations alone does not count as contrast evidence. The final correct modal screenshots are in `ui-final/screenshots/` and in the production evidence. The earlier, premature width-selector captures did not wait for the modal mount and are therefore not used as final visual evidence.

---

# V1 network visual identity

2 October 2026. This change is to the presentation of the existing ONEchain → BNB Smart Chain route. The financial route registry, eligibility, contracts, RPC, quote/observer, wallet and submission gate do not change. G5 BLOCKED; no real signature, broadcast, deploy or V2/V3.

## Sources and local assets

| Network | Official/public source | Local file | Processing |
| --- | --- | --- | --- |
| ONEchain | The [ONE Docs](https://docs.onechain.nexus/docs/dev_getting-started) header's [ONE SVG](https://files.readme.io/365e08e670169474bafa838c6ec4aad94d41b576021120bb892d3bb8495c6508-one.svg) | `public/networks/onechain.svg` | The symbol to the left of the official wordmark was separated out. The four wordmark paths were removed; the symbol was placed in a square viewport with its geometry, color and gradient/filter definitions preserved. No redrawing or other ONE mark was used. |
| BNB Smart Chain | [BNB Chain brand guidelines](https://www.bnbchain.org/en/brand-guidelines), [Yellow Symbol SVG](https://www.bnbchain.org/images/brand-guidelines/svg/BNB%20Chain_Symbol_Yellow.svg) | `public/networks/bsc.svg` | The official symbol is byte-for-byte identical. The yellow color, proportions and geometry are preserved. No shadow/glow/gradient is applied to the logo itself; the light is on the surrounding UI background. |

Both SVG downloads: HTTP 200. ONE Docs `dev_getting-started` and the BNB brand page confirmed the logo references with HTTP 200. The old ONE `/docs/chain` path returned 404 in the current check; this result was recorded separately and the working page reference was used. There are no CDN/third-party asset requests at runtime; assets are loaded same-origin from the Next public directory. The SVGs contain no script/event handlers, foreignObject, external image/href or executable content.

Source SVGs, HTTP/date/content-type and SHA-256 records: `evidence/otherbridge-v1/network-identity-20261002T080413Z-2bce74/assets/`. The sources are for brand identification; no endorsement/sponsorship/partnership or transfer of logo rights is claimed. BNB's guidelines specify not changing the logo's form/color; the brand usage terms must be evaluated by the product owner before publication. No publication was performed in this task.

| File | SHA-256 |
| --- | --- |
| Official ONE wordmark | `89035d93ed1019fa0eeb58e1c96b3dcd6ec8d3053d001998e577bdec8577e603` |
| Local ONE symbol | `8afac25ab1d65656ca8835282786b9227b436e2b23d47161bd04627966a6d454` |
| Official / local BNB symbol | `b8ff1ce0b5af2e2d9bcf5ec89fedd5224079f4f7267e306e23e8d691024f5eff` |

## Token structure and appearance

`src/content/networks.ts` contains only visual config. `NetworkId`, logo/name/shortName, primary/accent/glow RGB, dark/light badge text and logo surface are defined. `networkStyle` carries the same CSS custom properties to the Bridge cards, Networks cards and badges. `NetworkLogo`, `NetworkBadge` and `RouteIdentity` are a single component family. Add the new network's asset as a safe local SVG, record its source note/hash, and add an entry to the visual config; this does not enable the network's financial capability.

| Network | Primary | Accent | Glow | Badge dark / light |
| --- | --- | --- | --- | --- |
| ONEchain | `#EC1272` (official SVG) | `#F3752D` (official SVG) | `236 18 114` | `#F5B3C9` / `#962944` |
| BNB Smart Chain | `#F0B90B` (official guidelines) | `#E1C77A` (UI tone) | `240 185 11` | `#E8C66B` / `#70530D` |

Main dark background `#0C0D10`, card `#151619`, inset `#101114`. Neutral text and a matte sage action color; very-low-intensity fixed radial light, ONE on the left and BNB on the right. Card light dark 9% / light 4.5%; edge scene light dark 7.5% / light 4.5%. The form background in the center is opaque. The logo color is not changed for text contrast; in the light theme the BNB symbol stays on the official charcoal plate. Source/destination names and chain ID also appear in text; color is not the only information channel. The logo img is decorative; the adjacent text gives the network name to the screen reader. The smallest icon is 18px, above the 15px minimum in the BNB guidelines.

The Bridge input cards, route summary and review dialog; the Networks network cards; and the Activity rows and detail timeline endpoints carry the same identity. The ONE/CROSS asset names and the ONEchain/BSC network names are separate. The O/diamond/first-letter placeholder representing the network name was removed. Responsive breakpoints and reduced-motion support are preserved; there is no light animation.

## Verification approach

Real component E2E tests check two themes × 360/768/1440px × the Bridge/Networks/Activity/detail screens. The tests explicitly use mocked read-only health + a hashless record; they do not count as a real network test or delivery evidence. Local SVG URL/load/minimum size, correct source/destination name/chain ID, overflow, closed submission and the absence of wallet access are checked. The two logos in the review dialog were added to the existing synthetic flow test.

Raw axe violations and incomplete results are kept. Gradient backgrounds can be incomplete in automated color-contrast measurement; these texts are subjected to a WCAG contrast calculation at 21 points across 0–maximum light intensity, using the real foreground/inset/glow values resolved in the browser (at least 4.5:1 for all text). The logos' original geometry/colors and the desktop/mobile composition are additionally inspected visually via PNG. The latest real command results are in the current handoff and evidence summary.
# V1.3 discovery and holdings

The active TVL catalog is independent of executable routes. Unknown identities use the existing local neutral SVG and ambient tokens; external image URLs cannot load. Existing curated icons and colors remain intact. Virtual selectors render at most ten rows, preserve keyboard/search/recent behavior and add favorites stored only as chain IDs. User holdings sort first, followed by route infrastructure and remaining TVL catalog entries. Holdings never silently change a selected chain or asset. No emoji logos are introduced.
