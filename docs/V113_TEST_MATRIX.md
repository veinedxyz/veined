# V1.13 test matrix

Final engineering acceptance against accepted V1.12.2 (980 unit, 238 integration, 209 E2E). No accepted tests were removed. New documentation menus correctly expect 14 destinations instead of 11. All source was held stable during the final acceptance suites.

| Gate | Result | Evidence relative to evidence/otherbridge-v1-13/v113-20261008T045550888Z-9679b9 |
|---|---|---|
| Unit | 1102/1102 | tests/core-complete/unit.log |
| Integration | 266/266 | tests/core-complete/integration.log |
| E2E | 227/227; zero flaky/skips/retries | tests/e2e-accepted-final; e2e-results.json |
| PostgreSQL | 28/28; additive schema4, registry91/sources73 | tests/db-accepted-final; migrations/ |
| G7 standalone | 11 PASS +1 live opt-in skipped | tests/g7-accepted-final/g7-standalone.log |
| G7 in-product | 15 PASS +3 live opt-ins skipped | tests/g7-accepted-final/g7-product.log |
| Format/lint/types/i18n/docs | PASS | tests/quality-accepted-final |
| verify-safety/G7 safety/pilot safety | PASS | tests/core-complete |
| Fresh frozen install | PASS, lock unchanged, no new dependencies | tests/frozen/results.json install; tests/frozen-accepted-final/freeze-verification.json |
| Production build/bundle/smoke/24 locales/v13/artifacts | PASS | tests/frozen-accepted-final |
| Strict CSP + positive DeFi + axe | PASS, zero violations/errors | portfolio-ui/production-defi.json |
| 24 locales and RTL | PASS; EN/TR canonical,22 English fallbacks await native review | e2e-results.json; tests/quality-accepted-final |
| Stress | 50 protocols/500 positions/2000 assets/50 debts/200 rewards | performance/stress-ui.json; tests/integration/v113-api.test.ts |
| Security / protected / views | 20 focused questions;107 exact hashes;42 view/pure ABIs | security/focused-audit.json |
| DB backup verify + isolated restore drill | PASS, schema4; no dump in bundle | migrations/backup/ |

Positive DeFi fixtures exercise all8 adapter families; these are deterministic fixtures, not forks. Unit suite includes malformed/RPC/stale/unsupported/identity/unpriced scenarios, bigint limits, accrued Morpho fee shares, native risk, nested curated vaults, zero replacement ownership and dust display. Integration includes independent timeout/circuit/failure, cached scope isolation, safe API provenance/auth/rate/pagination. PostgreSQL covers role grants, retention, raw amounts, canonical logs/reorg replay and NFT ownership.

Initial failed and interrupted attempts are retained. The first full E2E had219 pass/6 fail: outdated menu counts, legacy coverage selector collision, and a genuine wallet-continuation abort caused by the lazy component suspending its ancestor. Local Suspense + client-only lazy loading fixed the abort; full V14 progressive suite passed before this final full run. Later Help translation-key errors were fixed and guarded by a literal-key unit test. Parallel-build resource contention caused earlier5s unit/fixture timeouts and stale build freshness failures; final suites ran sequentially without weakening test timeouts or protected checks.

Supplemental legacy production-multichain harness failed because it still expects older V1.12 UI selectors; it is not an accepted V1.12.2 acceptance gate. Supplemental real-public-AppID v19 probe failed because its mock accepts only the designated test AppID; the separate production test-ID wallet/CSP profile passed. Final accepted G7 product suite verifies that fixture wallet/CSP profile on final source. A final DB attempt found the existing local PostgreSQL container stopped (ECONNREFUSED); tests/db-container-stopped-attempt retains that failure, and the same container was restarted before the successful final DB run. Neither supplemental failure is presented as PASS. No real provider request occurred.

| GOAL gate | Engineering result | Evidence |
|---|---|---|
| P1 Wallet balances | PASS (scope above) | tests/core-complete; tests/e2e-accepted-final |
| P2 Automatic connected scan | PASS (scope above) | tests/e2e-accepted-final; live-readonly/owner-ui-replay.json |
| P3 Canonical position model | PASS (scope above) | src/defi/model.ts; tests/unit/v113-defi.test.ts |
| P4 Aave native adapter | PASS (scope above) | aave/aave-v3-fixtures.json |
| P5 Compound III native balances | PASS (scope above) | compound/compound-iii-fixtures.json |
| P6 Morpho Blue accrued shares | PASS (scope above) | morpho/morpho-blue-fixtures.json |
| P7 Morpho Vault / curated ERC4626 | PASS (scope above) | vaults/; tests/unit/v113-defi.test.ts |
| P8 Lido exact conversions | PASS (scope above) | staking/lido-fixtures.json |
| P9 Standard V2 LP | PASS (scope above) | lp/uniswap-v2-fixtures.json |
| P10 Uniswap V3 NFTs | PASS (scope above) | lp/uniswap-v3-fixtures.json; tests/db/v113.test.ts |
| P11 Separate positive debt | PASS (scope above) | tests/unit/v113-defi.test.ts; tests/db/v113.test.ts |
| P12 No wrapper double count | PASS (scope above) | pricing/double-count-proof.json |
| P13 Known net + unpriced warning | PASS (scope above) | pricing/valuation.json; tests/e2e-accepted-final |
| P14 Native risk; no generic HF | PASS (scope above) | risk/protocol-risk.json |
| P15 Provable read-only rewards | PASS (scope above) | rewards/reward-policy.json |
| P16 Truthful zero/failed/unchecked | PASS (scope above) | registry/coverage-matrix.json; tests/integration/v113-defi.test.ts |
| P17 Bounded progressive scan | PASS (scope above) | performance/summary.json |
| P18 Account switch isolation | PASS (scope above) | tests/e2e-accepted-final |
| P19 API provenance and pagination | PASS (scope above) | tests/integration/v113-api.test.ts |
| P20 Five Portfolio surfaces | PASS (scope above) | screenshots/; portfolio-ui/production-defi.json |
| P21 Responsive + accessibility | PASS (scope above) | screenshots/visual-review.json; portfolio-ui/ |
| P22 Focused engineering security review | PASS (scope above) | security/focused-audit.json (not independent certification) |
| P23 Accepted + new regression gates | PASS (scope above) | tests/ final accepted folders |
| P24 107 protected hashes | PASS (scope above) | security/protected-final.json |
| P25 No real signing/writes | PASS (scope above) | live-readonly/summary.json; security/focused-audit.json |

Execution and production release remain CLOSED; this test matrix does not claim independent security certification or real G7 PASS.
