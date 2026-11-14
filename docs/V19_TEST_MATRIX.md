# V1.9 test matrix — Privy connect-only wallet layer

Evidence root: `evidence/otherbridge-v1-9/v19-20261005T131224Z-2c32cd` (final runs under `final/`). All browser
tests run the REAL `@privy-io/react-auth@3.47.0` SDK against deterministic Privy/WalletConnect doubles
(`tests/e2e/privy-mock.ts`, test-only App ID `obtestprivyapp00000000001`, which does not exist at Privy) and
EIP-6963 wallet doubles. No real App ID exists, so the live Privy acceptance (W18) is **NOT_RUN**.

## Results (final)

| Suite | Result | Evidence |
| --- | --- | --- |
| Format / lint / typecheck / i18n (24 × 395 keys) | PASS | `final/logs/{format,lint,typecheck,i18n}.log` |
| verify-safety (incl. V1.9 wallet invariants) | PASS | `final/verify-safety/safety.json` |
| G7 source scan / G7 pilot safety scan | PASS (after reviewed re-baseline) | `final/logs/g7-*.log`, `g7-rebaseline/` |
| Unit | **715/715** (V1.8 641 + 74 V1.9) | `final/logs/unit.log` |
| Integration | **223/223** (216 + 7 V1.9) | `final/logs/integration.log` |
| E2E (product) | **169/169** (151 accepted + 18 V1.9), 0 skipped / flaky / unexpected (10.5 min) | `final/e2e/e2e-results.json`, `final/e2e/screenshots/` |
| G7 in-product pilot E2E (fixture, mock wallet via Privy modal) | **10/10** (+1 live spec skipped by design) | `final/g7-product/` |
| G7 standalone technical page E2E (fixture) | **11/11** (+1 live spec skipped by design) | `final/g7-standalone/` |
| G7 live in-product dry run (mainnet read-only, recording wallet via Privy) | PASS — initial + final preflight READY, 28/28 gates (P1–P20, S1–S8), ARMABLE, arm suppressed, 0 send requests | `g7-live-dry-run/`, `evidence/otherbridge-g7-product-pilot/dry-run-20261005T151801455Z-b684ba` |
| Production build (no App ID) | PASS (24 × 395 keys); no test App ID and no pilot marker in `.next/static` | `final/build-no-app-id/` |
| Production smoke / CSP acceptance / 24 production locales | PASS / PASS (16 pages) / PASS (24 locales incl. RTL) | `final/production-*` |
| Production V1.9 — no App ID (unavailable, 0 third-party, strict CSP) | PASS (dark + light) | `final/production-v19-no-app-id/` |
| Production V1.9 — test App ID (nonce CSP, connect/disconnect, only the intended frame block) | PASS (dark + light): MetaMask connected without signature, disconnected; violations = `frame-src https://auth.privy.io` only | `final/production-v19-app-id/` |
| Initial JS gzip | **286,000 B** (before 290,224 B; budget 290,690 B unchanged). With a test App ID: first load 285,978 B; Product/Bridge chunk 17,307 B; wallet modal loaded on click: 26 files, 699,852 B | `final/bundle-*` |
| Supply chain | audit prod/dev/all: 0 critical, 0 high, 1 moderate (documented); lifecycle scripts denied; SBOM; licenses (legal-review items) ; secret scan 0 | `final/supply-chain/` |
| Clean frozen reproduction | PASS (fresh copy, frozen install with scripts ignored, full `pnpm verify` incl. build; generated sources identical) | `final/repro/` |
| DB tests | NOT RUN — the wallet layer does not touch the data plane, its schema, store or shared gates | — |

## V1.9 unit tests (`tests/unit/v19-wallet.test.ts`, 74)

Normalization (external EVM wallet, `isEmbedded:false`, explicit key, CAIP-2 chain); embedded/`privy`/`privy-v2`/
embedded connectors/imported refused; smart accounts refused; Phantom Solana identity refused (EVM boundary);
malformed addresses/chains; icon sanitizing (data URI or bundled component only); bounded names; explicit active
wallet (order never used); session fingerprint. Adapter: no generic request; read allowlist; trusted chain
registry (switch/add parameters); watch-asset fixed; canonical send (frozen, identity first); each of the 8
fields mutated → refused before the wallet; extra/missing/case-changed fields; account/chain/live-identity
mismatches; revoked/stale; gate required; revocation between read and send; single flight; `beforeWalletRequest`
marking. Controller (deterministic Privy double): connect, embedded refused, bind mismatch, accountsChanged
re-bind + revocation, locked wallet, account race, chainChanged re-bind + invalid chain, disconnect event,
user disconnect + reconnect epoch, change wallet, connector-removal sync, WalletConnect session end, provider
failure, immediate revocation on Change wallet. Store: queued open, disconnect revocation, unavailable, frozen
sessions. Config: wallet-only login, embedded off, no `defaultChain`, Coinbase `eoaOnly`, WalletConnect on, no
cookies, theme, App ID rule. CSP with/without Privy, SVG style hash pinned to the installed SDK. Review findings
R1/R2/R4/R5/R7 regressions. Submission boundary uses the adapter.

## V1.9 integration tests (`tests/integration/v19-wallet.test.ts`, 7)

Missing App ID → strict CSP through the real `proxy()`; App ID → exact origins only; outage → unavailable, no
injected-provider read anywhere in `src/`; one store feeds every surface; G7 (fixture): authorized EOA via the
adapter sends exactly the armed canonical transaction once, lock persists across reconnect/new session; old EOA
refused by server and adapter; account change after review revokes the armed path.

## V1.9 browser tests (`tests/e2e/v19-wallet.spec.ts`, 18)

V19-01 modal + logos (MetaMask, Rabby, Phantom, Coinbase), no email/social/passkey/create; V19-02 ×4 connect-only
per wallet (only the chosen wallet asked, no signing), header icon/name/short address/network, account dialog,
disconnect; V19-03 close/reopen + focus restoration; V19-04 same session Bridge/Swap/Portfolio/Activity + Change
wallet; V19-05 account change, chain change, separate switch action through the trusted registry, wallet
disconnect; V19-06 disconnect keeps local history; V19-07 Privy outage → unavailable, no fallback, read-only
works; V19-08 mobile 360/390; V19-09 light theme + axe; V19-10 RTL ar/fa/he/ur; V19-11 network inventory (only
Privy/WalletConnect hosts, no address/wallet/amount data) + CSP (only the intended embedded-wallet frame block).

Adapted accepted E2E (same intent, Privy flow): product C1 (competing events during connection never bind an
unconfirmed identity), quote-busy after account/chain/disconnect, R1/F4 stalled read, late permission after
close, W02 no wallet / rejection (Privy *Retry*), W03, U02 keyboard focus with the Privy modal; multichain M3.
All specs now use `tests/e2e/fixtures.ts` (automatic Privy/WalletConnect doubles; no test can reach a real third
party); test init scripts are limited to the app document.

## Not covered offline (W18 live acceptance)

WalletConnect QR / mobile deep link: Privy's WalletConnect connector does not finish initializing inside the
offline harness (no relay/verify/network attempt observed); configuration, CSP origins and session handling are
unit-tested. Real extension logos, real dashboard login-method settings and the live network inventory need a
real App ID ([PRIVY_SETUP.md](PRIVY_SETUP.md) §8).
