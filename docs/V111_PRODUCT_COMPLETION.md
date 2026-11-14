# OTHERBRIDGE V1.11 — PRODUCT COMPLETION

Status: **OTHERBRIDGE V1.11 PRODUCT COMPLETION — READY_FOR_REVIEW / G7 READY_FOR_OWNER_RETRY**. Production ready is **not** claimed. Real signatures, approvals, permits, broadcasts, deploys
and fee collection: **0**. Production execution stays closed; the global execution gate, write registry, global
kill and fee policy (0 bps) are unchanged; 42/42 G7-protected files are byte-identical to the reviewed baseline.

Run evidence: `evidence/otherbridge-v1-11/v111-20261006T094009Z-dfa690/` · code checkpoint `a8624f2ca00f9661dbd9b6a58973666e72d611f860b8bea2251f997a387598ed` (1,149 files)
· HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5` (no new commit).

## The owner's 14 issues

| # | Issue | Result |
| --- | --- | --- |
| 1 | G7 could not reach the transaction step | Root cause: the BSC pin was one endpoint's newest finalized block; the second independent operator lagged → "block not found" in all 3 attempts → X0 BLOCKED. Fixed with a **common finalized pin** across two independent operator groups (hash-equal, witness-checked, ≤ 30 s old, bounded step-down, vetted fallback pair), owner copy "Safety check needs another attempt" with Advanced details. 19 regression tests. Final dry acceptance 10/10 consecutive sessions DRY_RUN_COMPLETE. **G7 READY_FOR_OWNER_RETRY.** See `G7_RPC_CONSENSUS_RELIABILITY.md`. |
| 2 | Mainnet/testnet mixed | `environment` on every network (mainnet/testnet/devnet/local/unknown); selector *Mainnets \| Testnets* (default Mainnets), testnet badge, environment-scoped search + *Search all networks*; cross-environment routes refused before any quote; testnet value excluded from portfolio totals; Networks page filter. `NETWORK_ENVIRONMENTS.md`. |
| 3 | Network logos | Chain Identity Registry: 343 networks, 304 real logos (88.6 %; 89 % of mainnets), 39 monograms — no fake 100 %. Server-side sanitized ingestion only. `CHAIN_IDENTITY_COVERAGE.md`. |
| 4 | Dialog closing | One behaviour for every Otherbridge dialog/sheet: X, Escape and backdrop close; inside clicks never close; focus trapped and returned to the trigger; a review simply closes (no transaction; reopening needs a fresh quote). |
| 5 | Bridge native-only | Asset picker on the ONEbridge form with the pairs confirmed on-chain (ONE→CROSS verified; USDTx→USDT registered, "No verified route", never quoted); generic routes use the registry token picker with route support from the routing provider. |
| 6 | Route details/health too technical | Short route card; one health state (Route ready / Needs refresh / Temporarily unavailable / Sending disabled) with ≤ 3 rows; *Route details* (provider, contracts, chain IDs, quote ID, steps) and *Safety details* (runtime pins, authority, observed bounds, reserve, RPC consensus, pending/in-flight, last checked) on demand. |
| 7 | "Read only" noise | Persistent read-only labels removed (header, cards, Activity rows/detail, review); execution state lives in the CTA ("Sending disabled" / "Real sending closed"), route status, Safety details and tooltips. |
| 8 | Unified asset registry | One registry (chain + exact contract; native explicit; symbol never identity) with CANONICAL/CURATED/MARKET_LISTED/DEX_DISCOVERED/IMPORTED_UNVERIFIED/BLOCKED. `ASSET_REGISTRY.md`. |
| 9 | Metadata/logo sources | Priority chains implemented; no CoinMarketCap; CoinGecko keyless; DEXScreener exact chain+token, cached and budgeted; listings never "safe". `ASSET_PROVENANCE.md`. |
| 10 | Asset database | Migration 0003 (10 tables, CHECK constraints, least-privilege grants), sync jobs `assets:sync:*`, `assets:build/verify/coverage`. |
| 11 | Swap token picker | Ranked default list (held → native/curated → market listed → recent/imported → DEX-discovered exact address → import); symbol search curated-first; no raw provider dump; rows with logo, network, balance, USD, level/risk badge. |
| 12 | Token address import | 8-step check (address, code, ERC-20 metadata, curated, market, DEX, sanitized logo, route) + explicit *Import token*; default IMPORTED_UNVERIFIED; never routes without route support; bidi/homoglyph BLOCKED. `TOKEN_IMPORT_SECURITY.md`. |
| 13 | Swap address UX | *From: Connected wallet* · *Recipient: Same wallet*; raw fields only behind *Send to another address* (or for cross-ecosystem/non-EVM/quote-without-wallet). |
| 14 | Swap details | Primary: rate, you receive, route/network fee, gas, price impact, quote age; *Route details*: steps, protocols, minimum received, fee, execution checks. |

Additional spec items: Portfolio auto scan + My wallet / View another address (§15), curated balance sweep with a
verified Multicall3 and the new `CURATED_BALANCE_SCAN` class (§16), progressive phases with priority chains (§17),
truthful non-EVM (§18), total known value + unpriced count + price source (§19), V1.10 portfolio UX preserved (§20),
landing at `/` and docs at `/docs` (§21–30), whitepaper outline (§31), Activity token chips via the registry (§32),
privacy table (§33), security tests (§34–37), terms/license inventory (§38).

## Fixes found during the milestone's own review

- Portfolio: after an account switch the auto scan saw the stale previous result and never scanned the new account
  (fixed; E2E covers it). Busy flag reset on abort.
- Portfolio: a network whose index was still catching up was labelled "Full index" (now "Known tokens" + "Indexing in
  progress").
- Portfolio: testnet holdings were excluded from the total but still entered the allocation bar, chain/asset shares and
  the native/token split (shares above 100 %). Testnet rows now show "Testnet", no price/value/share, and sort last.
- Bundle: `src/i18n/messages.ts` statically imported the full English and Turkish dictionaries, so every new string
  (landing copy) shipped in the shared client chunk; the first measurement was 304,127 B (over the 290,690 B budget).
  Dictionaries are no longer imported by client code (the browser receives its locale from the server; English, the
  canonical schema, loads on demand for validation); a unit test forbids static locale imports in `src/`.
- Registry: tokens with risky text were labelled MARKET_LISTED without CoinGecko evidence (now excluded unless listed);
  orphaned logo files are now detected by `assets:verify`.
- Networks: catalog rows missing from the committed registry were "unknown" and vanished from both tabs (now the same
  rules as the sync: positive TVL → mainnet; test/dev names → testnet).
- Activity empty state linked "Bridge" to `/` (now `/bridge`); restored observed min/max bounds in Safety details.
- Scan-mode toggle overflowed at 768 px / 200 % zoom (now wraps).
- No OG/canonical URL is emitted without a configured public origin (no guessed `localhost` URLs).
- A run of the final G7 dry acceptance started while `.env.example` (a protected file) carried documentation lines:
  both sessions failed closed at **P20 STATIC_SAFETY_SCAN_FAILED**. The lines were removed, the scans re-passed and the
  final run was restarted (`g7-dry-aborted-protected-file/`, kept as evidence that the gate works).

## Performance (gzip, `next start`, `scripts/measure-bundle.mjs`)

| Surface | gzip B (live config) | no App ID | test App ID | Budget |
| --- | --- | --- | --- | --- |
| App shell (`/bridge`, first load) | **274,864** | 274,834 | 274,855 | 290,690 (unchanged; V1.10 289,823) |
| Landing (`/`) | **143,741** | 143,741 | 143,741 | 150,000 (new, from the first measurement) |
| Docs (`/docs`) | **144,472** | 144,472 | 144,472 | 150,000 (new) |
| Network picker (lazy, on open) | +26,473 | | | — |
| Swap view (lazy, includes the token picker; opening it adds 0) | +34,485 | | | — |
| Portfolio view (lazy) | +12,105 | | | — |

The first V1.11 measurement was 304,127 B (over budget) because client code bundled the full EN/TR dictionaries;
after the fix the app shell is 14.7 KB **below** V1.10. Landing/docs load no Privy, wallet, portfolio, routing,
firewall or G7 module. Evidence: `final/bundle-*/initial-bundle.json`.

## Tests

Unit **822/822** (26 files) · integration **237/237** · PostgreSQL **16/16** (migrations 0001–0003) · E2E
**196/196** (181 preserved + 15 V1.11; 0 skipped/flaky) · i18n 24 locales × 739 keys · production locales **24/24**
(landing + bridge per locale, RTL 360 px) · strict CSP acceptance **22 pages** PASS (landing, docs, every app route,
1440/390, Arabic RTL, injected payloads) · production smoke PASS · Privy production checks no App ID / test App ID PASS
(landing makes no Privy request) · `verify-safety`, `g7:safety`, `g7:pilot:safety` PASS (0 findings) · G7 standalone
harness 11 passed (+1 opt-in live test skipped, as in the baseline) · G7 in-product pilot **15/15** · builds: no App ID,
test App ID, live config, local-g7-pilot — PASS; artifact checks: 0 pilot modules in the public `.next` · format, lint,
typecheck, docs:check, assets:verify PASS. Runner summary: `final/summary.txt` (29/29 steps exit 0).

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

## Configuration (optional, documented here because `.env.example` is G7-protected)

`OTHERBRIDGE_PUBLIC_ORIGIN` (https canonical origin), `OTHERBRIDGE_PUBLIC_INDEXING=true` (opt-in indexing),
`OTHERBRIDGE_SOCIAL_X|GITHUB|TELEGRAM|DISCORD` (official-host https profile URLs), `OTHERBRIDGE_DOCS_URL`,
`OTHERBRIDGE_STATUS_URL`; sync only: `COINGECKO_API_KEY`, `COINGECKO_API_PLAN=demo|pro`. Unset → hidden / noindex.

## Self review (§47)

| Question | Answer |
| --- | --- |
| Did G7 security weaken? | No. Only the BSC pin selection changed (stricter: two independent operators + witness, hash-equal, recent); `prep.ts` gates, intent, firewall, one-shot lock, wallet-send path and protected files are unchanged. P20 still fails closed on a protected-file change (observed). |
| Is RPC consensus still independent? | Yes. Pairs must come from different operator groups; the same group never counts; no single-source pass; hash disagreement fails closed. |
| Can a testnet appear as a mainnet? | No. Environment from the registry or the sync rules (test/dev names always move away from mainnet); Mainnets/Testnets are separate; cross-environment routes are refused; testnet value is excluded. |
| Can a wrong same-symbol contract appear? | Only as a flagged row (SYMBOL_IMPERSONATION), never auto-selected; identity is chain + exact contract; colliding curated tokens without market evidence are excluded. |
| Can a token image inject active code? | No. SVG/HTML rejected, PNG fully decoded and re-encoded, WebP rebuilt, metadata stripped, served same-origin with `nosniff` and a sandbox CSP. |
| Are listings called safe? | No. UI and docs state that curated/market/DEX listings are labels, not safety claims. |
| Can an imported token route automatically? | No. Imported = IMPORTED_UNVERIFIED; selectable only with route support; never auto-selected. |
| Can Portfolio merge the previous account? | No. An account change aborts the scan and drops the previous result (bug found and fixed in this milestone; E2E covers it). |
| Can auto scan overload RPC? | Bounded: single-flight per identity, 3 networks in parallel, deadlines, batched Multicall3 with call budgets, refresh every 2 min only while visible and idle. |
| Does Landing/Docs import wallet/G7 execution code? | No (import-graph test, E2E network check, production check: no Privy request on `/`). |
| Can a backdrop click trigger a transaction? | No. Backdrop/Escape/X only close the dialog; sending is disabled. |
| Did the app JS budget exceed? | The first measurement did (304,127 B); fixed by not shipping dictionaries in the client bundle → 274,864 B, budget 290,690 B unchanged. |
| Were fake social URLs invented? | No. None configured; unset links are hidden. |
| Are unsupported networks/assets overclaimed? | No. 88.6 % logo coverage stated as such; coverage classes name what was read (INDEXING mislabel fixed); MARKET_LISTED requires exact CoinGecko evidence (mislabel fixed). |
| Did any real transaction/signature occur? | No. All counters are 0. |

Pre-existing finding — **fixed in the release gate** ([G7_RELEASE_GATE_V111](G7_RELEASE_GATE_V111.md)): `scripts/verify-safety.mjs` line 81 contained a literal backspace
character where `\b` was intended, so the `.ethereum\b` alternative of that boundary check never matches (the other
alternatives still apply). The file is G7-protected; a fix needs a reviewed rebaseline.

## Remaining blockers (not solved by V1.11)

1. **G7 owner retry** — the real, manual wallet confirmation is the owner's step (`pnpm g7:product-pilot`); it was not
   run here by design.
2. **Production release** — RELEASE_APPROVAL_REQUIRED: independent security audit, pentest, firewall review and owner
   approval are not done; sending stays disabled.
3. **Legal review** — every LEGAL_REVIEW_REQUIRED item in `ASSET_PROVENANCE.md` (Trust Wallet/CoinGecko/DEXScreener
   reuse and attribution, chain/token marks, Privy, WalletConnect/Reown, public RPC terms incl. the new OnFinality
   endpoint).
4. **Public configuration** — no public origin or social URLs are configured: the site stays `noindex`, socials hidden.
5. **ONEbridge USDTx → USDT** is registered on-chain but not verified by Otherbridge (information only, never quoted).
6. **Registry data** — MANTRA chain id 5887 environment conflict kept as testnet; registry syncs are manual jobs (no
   schedule); NodeReal's public key quota can rate-limit the G7 logs witness (fail-closed; a dedicated endpoint would
   improve reliability).
7. **Translations** — new strings in 22 locales are machine-assisted with recorded uncertain terms; native review
   recommended. Docs exist in EN/TR only (by decision).
8. ~~Protected-file items for review~~ — **done** in the release gate: G7 changes re-reviewed, baseline updated
   (42 → 99 files), `verify-safety.mjs` regex repaired with 37 regression tests ([G7_RELEASE_GATE_V111](G7_RELEASE_GATE_V111.md)).
