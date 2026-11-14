# V1.11 test matrix

Evidence root: `evidence/otherbridge-v1-11/v111-20261006T094009Z-dfa690/` (`final/` = verification runner
`.otherbridge/v111/final-checks.sh`, `e2e-final/` = full Playwright run on the final code).

## Preserved suites

| Suite | Result | Evidence |
| --- | --- | --- |
| Unit (`pnpm test`) | 822/822 | `final/unit.log` |
| Integration (`pnpm test:integration`) | 237/237 | `final/integration.log` |
| PostgreSQL (`pnpm test:db`, migrations 0001–0003, real local PostgreSQL) | 16/16 | `db/test-db.log` |
| E2E (`pnpm test:e2e`, 181 preserved + V1.11) | 196/196 (181 preserved + 15 V1.11), 0 skipped/flaky | `e2e-final/e2e.log`, `e2e-final/e2e-results.json` |
| 24 locales (i18n-check, 739 keys each) | PASS | `final/i18n.log` |
| 24 production locales (SSR lang/dir for `/`, `/docs`, `/bridge`, …; landing + bridge in the browser; RTL 360 px) | 24/24 | `final/i18n-prod/` |
| RTL (ar/fa/he/ur) | covered by production locales and E2E i18n/network-identity | — |
| Strict CSP acceptance (landing, docs, every app route, 1440/390, Arabic RTL, injected payloads) | PASS, 22 pages | `final/csp/` |
| Production smoke (landing, docs, app routes, identity logos, TR/EN, axe, CSP, no external images) | PASS | `final/smoke/` |
| Privy production checks (no App ID / test App ID; landing makes no Privy request) | PASS / PASS | `final/prod-no-app-id/`, `final/prod-test-app-id/` |
| G7 safety scans (`g7:safety`, `g7:pilot:safety`), `verify-safety` | PASS, 0 findings | `final/*.log` |
| G7 standalone harness E2E | 11 passed, 1 opt-in live test skipped (same as baseline) | `final/g7-standalone/` |
| G7 in-product pilot E2E (production runtime, test artifact) | 15/15 | `final/g7-product/` |
| Builds: no App ID / test App ID / live config / local-g7-pilot + artifact checks | PASS ×4; 0 pilot modules in the public `.next` | `final/build-*.log`, `final/artifacts-*.json` |
| Format / lint / typecheck / docs:check / assets:verify | PASS | `final/*.log` |

## New V1.11 tests

| Area | Tests |
| --- | --- |
| G7 common pin | `tests/unit/g7-common-pin.test.ts` (19): A ahead/B behind, block not found, older common pin, hash disagreement, witness disagreement, wrong chainId, timeout, 429/quota, recovered endpoint, no independent pair, same operator group, floor, witness down, method allow-list, classification |
| Networks | `v111-registry` (environment rules, cross-environment, short names, generated registry integrity) · E2E environments (default Mainnets, Testnets count, scoped search, search-all, refusal before quote) |
| Assets | `v111-registry` (identity, levels, collision/impersonation, bidi/homoglyph, long text, ranking, curated-first search, ONEbridge pairs, import preview), `v111-image-security` (SSRF, redirects, DNS rebinding, decompression bomb, malformed PNG/CRC, SVG script, HTML as image, metadata strip, dimension cap, cache key stability, prototype pollution), `v111-api` (strict schema, no wallet data, IMPORTED_UNVERIFIED, NO_CONTRACT_CODE, preview rate limit, hermetic local-test, DEX-discovered exact address, image route) |
| Bridge | E2E ONEbridge asset picker (native first, verified vs registered-only, unverified pair cannot be quoted), simplified route UI (one state, ≤ 3 rows, no "Read only"), environment refusal |
| Swap | E2E ranked picker, exact-address import (preview steps, IMPORTED_UNVERIFIED, unroutable row disabled, impersonation import disabled), parties (Connected wallet / Same wallet / toggle), quote summary + Route details |
| Portfolio | `v111-portfolio` (curated sweep exact contracts, verified Multicall3 required, imported bounded and never routable, priority chain first, class mapping incl. INDEXING), `v111-api` (single-flight, identity isolation, bounded inputs) · E2E auto scan on connect, priority, testnet excluded, unpriced count, classes, account switch rescans only the new account, watch mode never auto-scans, mobile |
| Activity | E2E saved route preview shows registry token logos/amounts, never "Delivery verified" |
| Landing | E2E CTA → `/bridge`, Docs link, no `#` links, no fabricated socials, no absolute claims, no wallet/portfolio/routing/Privy requests; unit social config + indexing; production smoke/CSP/locales |
| Docs | `v111-docs-site` (renderer never emits HTML, link policy, EN/TR parity, live constants, no stale/overclaiming text, bundle boundary) · E2E navigation, search, markup-as-text search, 404, 390 px, TR vs. English-with-note |
| Dialogs | E2E X / Escape / backdrop close, inside click stays, focus trap, focus return |

## Live read-only acceptance

Live public build (`next start`, mainnet-readonly, submission false), 2026-10-06, `live/live-acceptance.json`:

- **Network identity**: live active catalog 330 networks; 329 in the committed registry (328 mainnet, 1 testnet — MANTRA
  5887, conservative); 1 newer network classified by the sync rules.
- **Registry + live route list**: Ethereum 225 assets, all routable (1 canonical, 222 curated, 2 market listed; 224
  logos); BSC 50/50 routable (3 canonical, 47 curated; 49 logos); Base 7/7. Symbol search "usdc": curated USDC first,
  then exact-listed market tokens.
- **Exact-address DEX lookup**: 4 route-supported, unlisted BSC addresses searched (bounded); one returned
  `DEX_DISCOVERED` (1 pair, ≈ $137 liquidity → `LOW_LIQUIDITY`).
- **Import preview** (live RPC code + metadata, DEXScreener, sanitized logo): vBNB → `IMPORTED_UNVERIFIED`, route
  supported, logo served as `/api/asset-image/<sha256>`; REEF (not in the route list) → `IMPORTED_UNVERIFIED`,
  `NO_VERIFIED_ROUTE`.
- **Connected-wallet-equivalent portfolio scan** (user-supplied public address, redacted; priority BSC): 187 networks
  planned, 151 checked, 0 pending, 3 failed, 33 catalog-only; 9 networks `CURATED_BALANCE_SCAN`, 142 native-only;
  34 holdings incl. 7 tokens found by the curated sweep; 19 unpriced holdings kept visible; ≈ 10.8 s. `FULL_INDEXED`
  needs the self-hosted indexer + datastore, which were not running for this check (covered by DB/integration tests).
- **CoinGecko**: no key configured → keyless snapshot (product works without a key).
- **G7 common-pin dry preflight**: 10/10 consecutive DRY_RUN_COMPLETE on the final G7 code (see G7 doc).

## G7 dry acceptance

| Run | Result |
| --- | --- |
| `g7-dry-paced` (repair verification) | 10/10 DRY_RUN_COMPLETE |
| `g7-dry-aborted-protected-file` | 2/2 BLOCKED at P20 (protected file edited) — expected fail-closed, run stopped |
| `g7-dry-final` (final code) | 10/10 consecutive DRY_RUN_COMPLETE, write methods 0, intent digest unchanged |
