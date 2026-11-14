# V1.6 test matrix — ONEchain G5 autonomous closure

Evidence root: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476`. Counts may only grow versus V1.5; every failed attempt and its repair is listed at the end.

## Application regression (V1.5 baseline preserved)

| Area | Result | Evidence |
|---|---|---|
| Unit | **529 PASS** (V1.5 473 + 56 V1.6) | `vitest run tests/unit` |
| Integration | **216 PASS** (V1.5 215 + 1 V1.6 CBU-09 replay) | `vitest run tests/integration` |
| DB | **16 PASS** | `regression/db-tests.log` |
| E2E (Bridge, Swap, Portfolio, Activity, Networks, Help/Settings, 24 locales, RTL, axe) | **151 PASS** (0 skipped / flaky / unexpected; final run after the G5 copy change) | `regression/final2/e2e/` |
| Format / lint / typecheck / i18n (24 locales × 390 keys, 0 missing/obsolete/malformed) | PASS | `regression/final/build.log` |
| Production build | PASS | `regression/final2/build.log` |
| Production smoke / production 24-locale run (after the G5 copy change) | PASS / PASS | `regression/final/production-smoke*`, `regression/final/production-i18n*` |
| Production V1.3 / V1.4 surfaces (after the copy change) | PASS / PASS | `regression/final2/production-v13*`, `regression/final2/production-v14*` |
| CSP acceptance (16 pages, after the copy change) | PASS | `regression/final2/csp/` |
| Hardened staging smoke | **32/32 PASS** (image rebuilt from the final source; stack stopped afterwards) | `staging-final/`, first run `staging/` |
| Backup → isolated restore drill | PASS (restore 30,233 ms, total 36,842 ms) | `drills/` |
| Monitoring rules (promtool, pinned image) | 21 rules valid, scenario tests SUCCESS | `regression/promtool.log` |
| Static policy (V1.5) / verify-safety | PASS / PASS | `regression/v15-security.out`, `regression/verify-safety.out` |
| Supply chain: audit prod/dev/all, SBOM, licenses, static secrets, lockfile | 0/0/0 vulnerabilities; CycloneDX SBOM; 0 unknown licenses; 0 findings; lockfile UNCHANGED | `supply-chain/` |
| Initial client JS (gzip) | **290,215 B** (V1.5 289,894; +321 B, +0.11 %; inside the V1.3 budget 290,690) | `regression/final/performance/initial-bundle.json` |

## G5 forensic suite

| Test | Result | Evidence |
|---|---|---|
| Exact build ONE (CrossBridge @ b3b0258): native solc, soljson, forge | full runtime equal, initcode equal, metadata CID equal | `build/one/reproduction.json` |
| Exact build BSC (BSCBridgeV2 @ 6da2fb2) | full runtime equal, initcode equal, metadata CID equal | `build/bsc/reproduction.json` |
| Exact build BridgeVerifier (both chains, @ 23a66d7, cancun, runs 162) | full runtime equal, initcode prefix equal, constructor args decoded | `build/verifier/reproduction.json` |
| Exact build CROSS token (to-nexus/cross-token, OZ 5.1.0, solc 0.8.22, paris) | full runtime equal; 7/7 immutables explained | `build/token/token-reproduction.json` |
| Git blob ↔ GitHub raw for key sources | 5/5 identical | `g5-sources/github-raw/` |
| Selector matrix (live dispatcher ↔ exact ABI) | ONE 58/58, BSC 56/56, no extra/missing selectors | `security/abi-selector-matrix.json` |
| Privileged-path eth_call probes (unprivileged caller) | 22/22 revert with the expected exact-ABI errors | `security/privileged-path-probes.json` |
| Slither 0.11.3 on both exact trees | 57 / 55 results, all triaged (no exploitable finding) | `security/slither-*.json`, `docs/G5_LEGACY_RUNTIME_SECURITY_REVIEW.md` |
| Local fork tests (BSC + ONE live state) | 22/22 PASS (20 behavioural + 2 fork-pin records) | `fork-tests/fork-tests-final.log` |
| Payout proofs 1/2/3 (indices 98483 / 98728 / 98727) | PASS 46/46 checks each | `payouts/payout-proof-*.json` |
| Historical archive deltas around proofs | 3/3 MATCH | `reserve/historical-deltas.json` |
| Event-sourced BSC ledger at the final pin 125745332 | RECONCILED, 15/15 checks | `reserve/bsc-ledger-reconciliation.json` |
| Archive-state surplus bisection | monotonic; single change point (10 CROSS direct transfer) | `reserve/surplus-bisect-48782186-125745332.json` |
| Fresh positive simulation + 6 negative controls (final pin) | PASS | `simulations/simulation-final.json` |
| Runtime-drift recheck (initial → final pins) | PASS, 0 watched events | `chain-pins/drift-recheck.json` |
| Opt-in live app-path probe (`tests/probes/g5-v16-live.test.ts`) | PASS (3 consecutive runs after repair) | `production-like/app-native-snapshot.json` |
| V1.6 unit tests (`tests/unit/v16-g5.test.ts`, 56) | drift mutations (17), reserve model, payout correlation + 12 negatives, offline Merkle/header/signature re-verification, build byte equality, CBOR/CID, immutables, initcode, upgrade timeline | `tests/unit/v16-g5.test.ts` |

## Failed attempts preserved and repaired (diagnose → minimum repair → retest)

1. Build reproduction read CRLF worktree files (core.autocrlf) → source keccak mismatch → sources now read from exact Git blobs → PASS.
2. `@ethereumjs/mpt` `verifyMerkleProof` called with the wrong argument order → fixed to `(key, proof, { root })` → PASS.
3. Fork tests: `vm.expectRevert` bound to the signing view call (4 tests) → signatures prepared before the expectation → 22/22.
4. Ledger scanner split ranges on rate-limit answers → only range errors split; AIMD pacing; public quota forced a proxy-only remainder reconciled by archive bisection.
5. Surplus bisection from the proxy-creation block missed the temporary −20M pre-funding window (A→B→A) → restarted at the post-funding block; pre-funding window verified explicitly from archive state (`reserve/prefunding-window.json`).
6. Ledger attempt 1: 3 checks failed from script defects (CROSS-only index sets; legacy `CrossMintableERC20CodeSet(address)` topic) → repaired → 15/15 (`reserve/ledger-attempt1-failure.json`).
7. Live probe: load-balanced ONE backend answered `header not found` for the head block → reads pinned 3 blocks behind head (`PIN_LAG`) → 3/3 PASS.
8. Integration `native-replay` (9 tests) lacked the new read-only calls → replay harness serves pinned V1.6 values; the health assertion now expects `reserveVerified: true` (the V1.6 reserve model) and reasons `["MAINNET_WRITE_DISABLED"]`.
9. Client bundle 291,285 B exceeded the V1.3 budget (route pins pulled into `onebridge.ts`) → CBU-09 guard moved server-side → 289,894 B; after the G5 copy keys 290,215 B.
10. Drift recheck read pruned ONE state at a fixed block → reads resolved to the current head.
11. ESLint rejected `require()` in a `.cjs` helper → ESM `scripts/g5-v16-soljson.mjs`; reproductions re-run with identical Standard-JSON hashes.
12. After the G5 PASS copy change, E2E `M1` still expected the old Turkish status "G5 kapalı" (150/151, run preserved in `regression/final/e2e`) → the test now asserts the new truthful copy (G5 verified read-only; composition not executable) and the disabled send button → re-run.

External gates (not runnable by the executor): independent external source review, web/API pentest, transaction-firewall review, legal review, owner release approval, G7 — all **NOT_RUN**.
