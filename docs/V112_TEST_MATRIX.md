# V1.12 test and evidence matrix

Machine results in evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/tests and RESULTS.json are authoritative. Record every failed initial run, any repair and the final rerun; never subtract tests or count P20-blocked fixtures as passing.

| Gate | Evidence / expected minimum |
| --- | --- |
| Unit | unit-final.json; >=870, plus witness/cooldown/cache/log/mixed-inbox/logo/Solana tests |
| Integration | integration.json; >=237; canonical mock wallet tests remain P20-blocked before baseline acceptance |
| Product E2E | unique output directories; >=196 retained; V1.12 adds 10 tests |
| G7 | common-pin/invariant/prep/reliability suites; standalone and product pilot fixture suites separately reported |
| i18n | i18n:check, 24 locales and all added keys; locale smoke E2E |
| RTL | ar/fa/he/ur browser tests, 360/390/768/1440 no overflow |
| Accessibility | 64 primary axe reports + existing quoted, portfolio, dialog, wallet, help and docs fixtures |
| Performance | unchanged scripts/bundle-budgets.json; app/landing/docs first load gzip and lazy chunks |
| Security | verify-safety, g7 source scan, pilot scan, unchanged financial/write policies, original baseline hash |
| Live G7 | 30 sequential fresh dry sessions after the source freeze, with 15s separation, and final 3 after tests/build; financial reads and release verdict separated |
| Assets | assets:verify exact image hashes and sanitization, before/after coverage and all remaining fallbacks |

Initial product run had shared Playwright artifact-directory collisions while the standalone G7 suite ran concurrently; separate output roots repair test isolation. Tests that asserted the removed empty quote panel now verify the centered actionable empty form and absence of that panel, while retaining all quote and disabled-execution assertions. The initial width assertion measured the outer grid rather than its 660px card and now verifies both card width and centering. Preserved earlier failures remain in their original output families.

P20 source hashes cannot pass until the proposed baseline is independently accepted. The existing fixture tests that require READY will fail against this intact gate; do not mock away the gate, rewrite expectations to BLOCKED, activate the proposal silently or claim owner-retry readiness. Live provider availability is separately evaluated from canonical/read-only financial truth.

Supplemental production contrast audit preserves all 1,515 axe incomplete nodes. 1,481 text samples passed their thresholds (minimum sampled ratio 5.10:1); 34 decorative marks are separate. 33 clipped network-container nodes were rechecked after scrolling into view. See accessibility/MANUAL_REVIEW.json. This bounded sampling is not an independent WCAG certification.

## V1.12 final measured evidence

Status: RETURN_FOR_REPAIR. HEAD 8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5. Active accepted baseline is unchanged; proposed baseline 5c895bfc9d511ce7a3a2e220f5f2376e63dee001b4bf900caf78dc24f2d6cbc1 is not activated.

- Live 30-run cohort: 30/30 financially reconciled, 30/30 P20-blocked; DRY_RUN_COMPLETE 0. Requests p50/p95/p99 845/846/848 and duration ms 54406/55549/57242. Rate-limited observations 359; cooldown avoids 267; canonical write-method count 0.
- Final three after tests/build: 3/3 financial checks pass; 3/3 release blocked; DRY_RUN_COMPLETE 0; intent digest unchanged 3/3.
- Unit 905/933 (28 P20-related failures); integration 235/237 (2 P20-related failures); product E2E 206/206. G7 standalone 2 pass/9 fail/1 skipped; pilot product 6 pass/9 fail/3 skipped. READY-dependent failures remain unmasked.
- Production UI: 64 screenshots and axe audits, eight surfaces, four widths, two themes; zero overflow/broken images/page errors/axe violations. 24 locales, 745 keys; RTL ar/fa/he/ur browser coverage.
- First-load gzip bytes: app 274873/290690, landing 143735/150000, docs 144870/150000. Native lightweight health 39 actual wire reads, no full G7 import.
- Actual wallet requests, signatures, approvals, permits, broadcasts, deploys and fee collection: zero. Production execution stays closed.

Machine authority: evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/RESULTS.json. Original failed runs, corrected derived census and raw audits are preserved. Review archive verification is under evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/review-bundle/ZIP_VERIFICATION.json.
