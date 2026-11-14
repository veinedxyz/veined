# Otherbridge V1.3 review evidence

Evidence root: `evidence/otherbridge-v1-3/v13-20261003T113551175Z-bc93b0`. HEAD remains `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`, main; no commit, reset or deployment. The canonical final source checkpoint and per-file hashes are in `source-inventory.json`. Historical V1/R1/V1.1/V1.2 receipts remain preserved.

| Check | Delivered result | Evidence |
|---|---|---|
| Accepted baseline | 253 unit / 46 integration PASS | baseline-unit.log, baseline-integration.log |
| Final source verification | Format, lint, typecheck, safety, build PASS | checks-final.log |
| Unit | 314 PASS, including 61 new V1.3 cases | checks-final.log, tests/unit/v13.test.ts |
| Integration | 56 PASS, including 10 V1.3 cases | checks-final.log, tests/integration/v13.test.ts |
| Full browser regression | 122 PASS; skipped/flaky/unexpected 0 | e2e-delivered/e2e-results.json |
| Final Portfolio/Swap display and selector repair | 35 PASS (29 V1.3 + 6 accepted identity cases); skipped/flaky/unexpected 0 | e2e-review-final/e2e-results.json |
| Locales | 24 × 362; schema failures 0 | checks-final/i18n-schema.json |
| New locale surfaces | All 24; public text/axe checks PASS | e2e-review-final/v13-locales/*.json |
| RTL | AR/FA/HE/UR accepted functional cases retained; new RTL Portfolio/Swap PASS | e2e-delivered/i18n, e2e-new-final |
| Production controls | Existing 18 controls PASS | production-legacy-final/production-smoke.json |
| Production locales | 24 browser locales / 144 SSR surfaces PASS | production-locales-final/production-i18n.json |
| New production boundaries | Origin, body limit, prototype, consent, write actions and private no-store PASS; 3 public surfaces axe/brand/overflow PASS | production-final/production-v13.json |
| Actual TVL discovery | 330 finite-positive live chains; 331 normalized entries including preserved custom ONEchain | catalog-sync/active-catalog*.json, catalog-diff.json |
| Actual native portfolio | Ethereum/Base/BSC reads retained as PARTIAL, three native holdings; USD unknown | production-final/sanitized-native-portfolio.json |
| Broad live token portfolio | BLOCKED_CREDENTIAL_REQUIRED; no key available | native portfolio receipt, PORTFOLIO_COVERAGE.md |
| Actual same-chain Swap | Two read-only ETH→USDC quotes, execution=false, platform fee 0 | production-final/live-swap-quotes.json |
| Actual Bridge | Two read-only ETH→Base quotes, execution=false, platform fee 0 | production-final/live-bridge-quotes.json |
| Frozen clean reproduction | Fresh copied workspace install --frozen-lockfile --ignore-scripts + build PASS | repro-review-final/reproducibility.json |
| Performance | 276,848 → 286,964 initial JS gzip bytes; +3.65%, within measured +5% budget | performance-summary.json, baseline-performance, performance-final |
| Secret/static scan | 0 findings; production signing registry unchanged false/null | security-review-final/static-secrets-check.json, safety receipt |
| Supply chain | 441 installed packages; 0 unknown licenses; 25 lifecycle entries inventoried, scripts denied; unchanged lockfile | security-review-final/sbom.cdx.json, licenses-lifecycle.json |
| Dependency audit | 1 high development-only finding, no published fixed version; release blocker retained | dependency-audit.json, INTERNAL/V13_PROVIDERS.md |
| Preservation | Accepted protected financial/wallet/history/assets/lock/config hashes unchanged; prior evidence hashes verified; old locale leaves preserved | baseline-preservation.json, review manifest |
| Final images | Indexed with dimensions and SHA-256; visual review receipt | screenshots-index.json, visual-review.json |
| Review archive | Unique allowlisted ZIP, CRC and every entry hash verified | review-bundle-integrity.json, adjacent BUNDLE_INTEGRITY.json |

Catalog mapping: 67 network identities (including ONEchain), 66 Bridge/Swap infrastructure mappings, four direct native portfolio mappings. Infrastructure capability is not current liquidity, verified spendable balance or transaction authority. Unsupported TVL entries remain searchable and cannot be selected as financial routes. Search/keyboard/recent/favorite/virtual rows and user holding order are tested with a synthetic 600-chain catalog. No chain is asserted empty just because it was not discovered or indexed.

The 24-chain synthetic integration scan proves bounded discovery/concurrency and retained partial success, not broad live account coverage. Fixtures explicitly say synthetic. Actual observations use the user's previously supplied public address and save a redacted address marker; no secret, wallet session, signing request or state override is used. Quotes expire and are only timestamped observations. USD totals omit unknown/stale/conflicting prices and spam; all transaction amounts remain integer base units.

Security tests mutate transaction chain/from/contract/value/selector, decoded token/amount/output minimum/recipient/spender/fee, simulation digest/freshness, replay and all kill scopes. Incomplete decoder data, unsupported endpoints, redirects/private destinations, RPC write methods and prototype fields fail closed. The future reviewed decoder/registry/simulation foundation is isolated from wallet signing, with an empty production registry and global kill enabled. It is not an independent audit or permission to sign.

## Diagnosis and limits

The first ranking test exposed missing USD output in economic deduplication; that key was repaired. Typecheck originally traversed historical copied evidence sources; evidence/review artifacts were excluded from the application project without excluding actual tests. New page views were missing from the product allowlist and were repaired. A concurrent early format operation disrupted development HMR; its run is diagnostic, not delivered acceptance.

Production checks found missing keyboard focus on the virtual catalog and on overflowing narrow cards. Both areas now accept keyboard focus and cards have room for localized copy. The first full run was 120 PASS / 2 FAIL: narrow light-theme focus and an incorrectly named test button. Assertions were retained, the UI/test repaired, and the entire 122-test suite passed. Final visual inspection corrected old-activity copy and made synthetic same-chain quotes use an exchange protocol; all 29 affected browser cases and source checks were retested. Native prefill deduplicates the token option.

Production runner diagnostics preserve an origin-status mismatch, incorrect public-text helper invocation and immediate locale-dialog timing check. Origin denial now uses HTTP 403; helper arguments and element readiness were corrected. Failures and original logs remain under their attempt directories. No failure is relabeled PASS. Prior traces stay in original evidence; nested ZIPs are excluded from the new review archive.

The initial baseline hash collection accidentally captured only `.env.example`. The retained accepted 230-file V1.2 inventory, prior raw-evidence hashes, complete initial untracked path list and prior ZIP locale dictionaries provide the independently checked preservation evidence. This limitation is disclosed in baseline-preservation.json. There are no dependency upgrades or silent vulnerability suppressions.

ONEchain G5 remains BLOCKED by exact deployment-build provenance, spendable reserve/obligation evidence and the second canonical archive payout. Its accepted funded-address read-only simulation is preserved; no failed external research loop was repeated. G7 remains NOT_RUN — USER_APPROVAL_REQUIRED; production release BLOCKED — RELEASE_APPROVAL_REQUIRED. Independent security review, the unresolved dependency finding, actual provider credential/plan/legal review and explicit pilot/release approval remain future gates. Signatures, approvals, broadcasts, deploys and real fee collection are all zero.
