# Otherbridge V1.10 — Product UI/UX refinement

Scope: visual quality, information architecture, usability and trust messaging of every V1 product surface. No
business, routing, wallet-boundary, firewall, G5/G7 or execution logic changed. Execution stays globally closed.

## 1. What was wrong (inventory before work)

| Surface   | Problem found in the V1.9 build                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Shell     | Unicode glyphs as icons (☼ ◐ ◎ ◇ ↔ ↗ ×); eyebrow kickers above every heading; underline nav offset by a magic number; wallet chip without status; no persistent "what can I do now" signal; 10–11 px text for most secondary information.                                        |
| Bridge    | Good card language but weak hierarchy: fee rows and health reads at 11 px, health card was a single amber word, "Ana ağ · salt okunur" state only in a badge, side panels lacked structure.                                                                                      |
| Swap      | A raw vertical form: separate search inputs + native selects listing `symbol · name · 0x…` strings, raw address dumps, two near-identical full-width buttons, the full review dumped inline, no token marks, no side panel, no explanation of what is missing in read-only mode. |
| Portfolio | Six bare inputs (one per ecosystem) without help; hero-metric cards; chain breakdown without share, sorting or expansion; asset list with a text box as "logo", no search/filter/sort, the "quote required" sentence repeated per row; coverage truth was small print.           |
| Activity  | One-line empty state, raw `<select>` filter, buttons without hierarchy.                                                                                                                                                                                                          |
| Networks  | 272 px catalog cards mostly empty, attributes as one long text run, route card a flat key/value list.                                                                                                                                                                            |
| Help      | FAQ only, no orientation, no safety basics.                                                                                                                                                                                                                                      |
| States    | Loading was "Loading…" text; no skeletons; notices used a thick coloured side stripe; light theme flashed through animated colours on load.                                                                                                                                      |

## 2. What changed

### Design system (`src/app/globals.css`, `src/components/icons.tsx`, `src/components/ui.tsx`)

- Tokens for both themes: three surface layers, soft/strong lines, semantic tones (`ok` sage, `warn` amber, `danger`
  soft red, `info` blue-grey) with soft fills and lines; the Privy modal surface/accent (`#151619` / `#bdccb9`) is
  unchanged so the wallet modal stays in family.
- One authored SVG icon family (24 px grid, 1.6 stroke) replacing every Unicode glyph.
- Shared primitives: `PageHeader`, `Pill`, `TokenAvatar` (deterministic monogram from 8 static CSS hue classes —
  CSP-safe), `Skeleton`, `EmptyState`, `useCopy`, `shortAddress`.
- Notices: tinted callout with a masked icon (tone-aware), no side stripe. Badges/pills unified.
- Browser surfaces themed: selection, scrollbars, caret, focus ring, placeholders, tabular numerals for amounts.
- Proportional bars (allocation, coverage, freshness, share) use one CSSOM custom property `--fill` (new
  `cssomFill`, clamped to [0,1]); no style attributes (CSP `style-src-attr 'none'` unchanged).
- Motion: 160 ms state transitions only, disabled until the stored theme is applied (`html[data-ready]`), and off
  under `prefers-reduced-motion`.

### Shell

Sticky header (desktop), pill navigation with `aria-current`, a global read-only/local status pill with an
explanatory tooltip, globe language button, sun/moon theme toggle, wallet chip with provider icon · name · short
address · chain pill. Wallet dialog: provider identity with "Connected" state, address with copy, chain, a
"connect-only, no signature requested" assurance, Change wallet / Disconnect. Footer carries the same read-only
statement and Help/About/Settings links. Mobile: two-row header with a horizontally scrollable, edge-faded nav.

### Bridge

Same layout and card language, refined: route pair with an overlapping direction marker, large amount field with a
token chip and MAX, a "Fee breakdown" receipt with a validity timer once a quote exists, Otherbridge fee highlighted
as zero, structured side panels (route details; route health as a status list: verification · sending closed ·
reserve; observed limits; refresh), lock-marked "Gerçek gönderim kapalı" under the CTA.

### Swap (redesigned)

Uniswap-style pay/receive panels inside the Bridge card family, network selector at the top of the card, token
buttons opening a searchable token picker dialog (held balances first, native asset marked by its network logo,
keyboard navigation, bottom sheet on mobile), switch-tokens control, addresses with ecosystem tags and "From wallet"
markers, segmented slippage/preference, inline blocking reason ("Enter an amount…"), quote freshness bar, quote
facts (rate, minimum received, each fee, Otherbridge fee 0 %, price impact, time, total cost), and an aside with
route options (best value / cheapest / fastest, why-this-route, alternatives list) plus an **execution readiness**
checklist (wallet, network, addresses, current quote, sending closed). A connected wallet starts Swap on its own
network when that network is routable; portfolio holdings appear as quick token chips. The full review dialog is
restyled, still ends in a disabled "Sending disabled".

### Portfolio (redesigned)

Search-bar style scan panel (EVM primary, "Other ecosystems" disclosure with format hints), honest empty state with
three facts, skeleton while scanning. Results: integrated summary (total, allocation bar + legend, assets, networks,
native/token split, networks checked with pending/failed), coverage-truth panel (sentence, coverage bar, counts,
"never counted as empty", data source, still-checking progress, continue scan, refresh-needed), chain allocation
rows (logo, value, share bar, coverage pill, history marker, expandable asset list, "show these assets" filter,
sort by value/name), asset table (search, network filter, sort, small/spam/flagged toggles, token marks, unit price,
value share, badges, copy address, Bridge/Swap only for verified routable tokens), needs-attention list, coverage
details. Pending/failed/catalog-only networks never appear as zero rows.

### Activity, Networks, Help, About, Settings

Activity: page header with export/import actions, segmented filter with counts, product empty state with Bridge/Swap
actions and three facts, richer rows (network marks, state pill), timeline with connectors, restyled previews.
Networks: route overview (source → destination cards with connector), route status with a status list, compact
catalog rows (capability pills, compact TVL), chip filters. Help: "How Otherbridge works" three-step strip, FAQ
accordion, safety basics, future scope (code-split chunk). About/Settings: consistent headers and rows.

### Copy (24 locales)

89 new `v110.*` messages, translated for all 24 locales (484 keys each, parameters checked). Existing copy and claims
unchanged.

## 3. Files

New: `src/components/{icons,icons-extra,ui,token-picker,help-view,product-views}.tsx`, `tests/e2e/v110-ui.spec.ts`,
`tests/unit/v110-ui.test.ts`, this document, `.otherbridge/v110/review-bundle.py`.
Changed: `src/app/globals.css` (rewritten), `src/components/{product,swap,multichain-bridge,portfolio,multichain-catalog,routing-activity,network-selector,language-selector}.tsx`,
`src/components/virtual.ts` (`cssomFill`), `src/i18n/amounts.ts` (`formatUsd`, `formatUsdCompact`), all 24
`src/i18n/locales/*.json` (+89 `v110.*` keys), `tests/e2e/v13.spec.ts` and `tests/e2e/v14.spec.ts` (drive the token
picker instead of the removed native token `<select>`; same intent and assertions).
Not changed: every G5/G7-protected file (42/42 byte-identical to the V1.9 baseline), adapters, routing/core models,
wallet provider/adapter/session, firewall, submission, proxy/CSP, lockfile, `.env*`, G7 pilot code.

## 4. Acceptance mapping

| #     | Criterion                                                                    | Result                                                                                                                                       |
| ----- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 1     | Bridge, Swap, Portfolio, Activity, Networks, Help visibly improved           | Done — see `review-screenshots/` (01–29)                                                                                                     |
| 2     | Swap no longer a raw form                                                    | Pay/receive panels, token picker, segmented settings, quote facts, route options, readiness                                                  |
| 3     | Portfolio no longer an input pile                                            | Scan bar + disclosure, summary with allocation, chain rows, filterable asset table, coverage panel                                           |
| 4     | Header / navigation / wallet chip professional                               | Pill nav with `aria-current`, status pill, icon wallet chip (provider · address · chain)                                                     |
| 5     | Privy modal consistent with the product                                      | Unchanged Privy config (surface `#151619`, accent `#bdccb9`); screenshots 05–07                                                              |
| 6     | Empty / loading / partial / fail states                                      | Skeletons, empty states with facts and actions, partial/stale/failed/no-balance/nothing-checked states                                       |
| 7     | Desktop and mobile screenshots                                               | 1440 / 390 (+768/360 in suites), dark and light, TR/EN, AR RTL, zh-CN                                                                        |
| 8–9   | Execution closed; signatures/approvals/broadcasts/deploys/fee collection = 0 | Unchanged gates; every new test asserts no signing wallet method and a disabled send                                                         |
| 10    | G7 pilot safety intact                                                       | Protected files identical; `g7:safety`, `g7:pilot:safety` PASS (0 findings); in-product pilot 10/10, standalone 11/11 (fixture)              |
| 11–12 | One Privy session across surfaces; account/chain invalidation                | V19 suite 18/18; V1.10 wallet test navigates all surfaces; invalidation logic untouched                                                      |
| 13    | i18n intact                                                                  | 24 locales × 484 keys, parameters checked; 24 production locales PASS                                                                        |
| 14    | CSP / build / smoke                                                          | Strict CSP acceptance 16 pages PASS (no App ID), Privy production checks PASS (test App ID), smoke PASS, builds PASS in three configurations |
| 15–17 | Tests updated, new regression tests, critical suites green                   | Unit 724/724 (+9), integration 223/223, E2E 181/181 (+12), verify-safety PASS                                                                |

## 5. Performance

Initial JavaScript (gzip, `scripts/measure-bundle.mjs`, TR first visit): **289,823 B** with the live `.env.local`
configuration, 289,797 B without an App ID, 289,816 B with the test App ID — budget 290,690 B (unchanged), V1.9
286,000 B (+3,823 B, +1.3 %). Swap, Portfolio, Help, Activity, Networks, About, Settings, the token picker and 17 of
33 icons are code-split; the first-load shell carries 16 core icons (guarded by a unit test). Theme toggle 37–73 ms.
The margin is now 867 B: further first-load UI should first move the review/wallet dialog bodies into lazy chunks.

## 6. Safety

No execution, signing, approval, permit, broadcast, deploy or fee collection was performed or enabled. The global
execution gate, write registry, kill switch and fee policy are untouched; every send control remains disabled and
labelled ("Gönderim kapalı" / "Gerçek gönderim kapalı" / "Sending closed · separate release approval required").
The G7 live dry runs were not executed (opt-in; not requested).
