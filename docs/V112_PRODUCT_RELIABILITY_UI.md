# OTHERBRIDGE V1.12 reliability and UI review candidate

Status: **RETURN_FOR_REPAIR** while the accepted protected baseline rejects the proposed G7 source changes. This is not production ready and not READY_FOR_OWNER_RETRY. Financial read-only diagnostics are distinct from a complete release gate. Original V1.11 evidence and user work remain preserved.

Implemented: independently classified witness pool; shared rate-limit cooldown; bounded retry and traffic budget; externally revalidated incremental ledger; source/session single-flight; availability-only retry UX; strict mixed-token inbox enumeration; exact local asset logos; Bridge amount/fee hierarchy; centered Swap; Portfolio logo path correction; Help topics; keyboard/mobile Docs; server-only Landing polish; 24 locale additions. Detailed architecture: G7_RPC_WITNESS_ARCHITECTURE.md, G7_INCREMENTAL_LEDGER.md, G7_REQUEST_BUDGET.md, ASSET_IMAGE_COVERAGE.md and UI_DESIGN_SYSTEM.md.

The protected review proposal lists before/after hashes, reasons, security impact and test references for every changed/additional protected file. It is stored at evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/security/protected-proposal/REVIEW.json; candidate hashes are in protected-hashes.proposed.json. The active pointer remains evidence/otherbridge-v1-11/g7gate-20261006T135310Z-f42f11/preflight/protected-hashes.json, accepted hash 199749d5f613e891f51cf0005567eeff90730cdbf3d375590ba8db9965a5d2c2, 99 files. Neither the safety scanner nor its exception list is weakened. Current protected changes are the five RPC/common-pin/preflight/session/pilot-UI files; the proposal adds six new runtime/cache/diagnostic sources (105 total).

Financial intent stays 4eecb9784961717f8464be8f9a650004974e328239f614211ad51bdf65aac869. Amount, fees, recipient, owner EOA, calldata, expiry, gas rules, authority/reserve semantics, dual ONE simulations, firewall, one-shot and global production closure remain enforced. P8 now binds its count to CROSS while requiring every global index, including non-CROSS entries; no obligation is ignored. src/g5/reserve.ts and financial policy files are unchanged.

Counters: real wallet requests, signatures, approvals, permits, broadcasts, deploys and fee collection all zero. Test fixture wallet operations are synthetic and do not count as real transactions. Public execution remains closed, fee policy remains zero bps. No DNS, mainnet deployment or production enable action was performed.

Validation, timings, screenshots, failures and final checks are indexed in V112_TEST_MATRIX.md and the evidence RESULTS.json. A review bundle contains changed source relative to the preserved working-tree checkpoint, documents, selected read-only evidence, screenshots and SHA manifests. It excludes secrets, env files, wallet-session payloads, dependency/build directories and older review archives. CRC and entry hashes are verified before reporting.

## V1.12 final measured evidence

Status: RETURN_FOR_REPAIR. HEAD 8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5. Active accepted baseline is unchanged; proposed baseline 5c895bfc9d511ce7a3a2e220f5f2376e63dee001b4bf900caf78dc24f2d6cbc1 is not activated.

- Live 30-run cohort: 30/30 financially reconciled, 30/30 P20-blocked; DRY_RUN_COMPLETE 0. Requests p50/p95/p99 845/846/848 and duration ms 54406/55549/57242. Rate-limited observations 359; cooldown avoids 267; canonical write-method count 0.
- Final three after tests/build: 3/3 financial checks pass; 3/3 release blocked; DRY_RUN_COMPLETE 0; intent digest unchanged 3/3.
- Unit 905/933 (28 P20-related failures); integration 235/237 (2 P20-related failures); product E2E 206/206. G7 standalone 2 pass/9 fail/1 skipped; pilot product 6 pass/9 fail/3 skipped. READY-dependent failures remain unmasked.
- Production UI: 64 screenshots and axe audits, eight surfaces, four widths, two themes; zero overflow/broken images/page errors/axe violations. 24 locales, 745 keys; RTL ar/fa/he/ur browser coverage.
- First-load gzip bytes: app 274873/290690, landing 143735/150000, docs 144870/150000. Native lightweight health 39 actual wire reads, no full G7 import.
- Actual wallet requests, signatures, approvals, permits, broadcasts, deploys and fee collection: zero. Production execution stays closed.

Machine authority: evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/RESULTS.json. Original failed runs, corrected derived census and raw audits are preserved. Review archive verification is under evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/review-bundle/ZIP_VERIFICATION.json.
