# Public copy repair — current acceptance

3 October 2026. This task is scoped only to public text/labels; it is not a new phase. HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`, last source checkpoint `b10070fab172ccf61808fc5cce96d1261b1c30fb92ed8dfc36125b7b2a9fa37c`. **201 unit / 46 integration / 46 E2E PASS**, skipped/unexpected/flaky=0. The eight acceptance commands, build, the 18 production checks and the real ETH→Base TR/EN read-only review PASS. Denylist matches in the normal public docs and the full production browser textContent are zero; technical/legal INTERNAL, raw upstream fixture/evidence, package/import and the original user instructions are deliberate exceptions.

Raw evidence: `evidence/otherbridge-v1-1/public-brand-20261003T071538Z-4bd6d4/acceptance-delivered`, `e2e-delivered`, `production-delivered`, `production-routing-delivered`, `docs-final`; the JSON+log+PNG files and the four matching source snapshots are linked in `source-inventory.json`. The real fee amount/token/included/order stay the same, and the provider service fee is shown neutrally; technical protocol identities are preserved in the review. G5 UNCHANGED_BLOCKED, write gate false/null; signatures/approvals/broadcasts/deploys=0. Old failed diagnostic runs are not used in place of the new PASS. The multichain foundation results below belong to the previous checkpoint.

---

# Multichain acceptance matrix — 3 October 2026

Evidence root: `evidence/otherbridge-v1-1/multichain-20261002T203410Z-146be9/`. HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`; working tree checkpoint SHA-256 `2f583651da3549f061d39eb2a1cdcb86db1b69ae9c7c729c97cdfd323f61314d`. No commit was made. The latest real evidence is below; older diagnostic files are not used in place of the latest PASS.

| Check | Result | Raw evidence |
| --- | --- | --- |
| frozen install / format / lint / types / safety / build | eight commands exit 0 | acceptance-delivered/commands.json + logs |
| Unit | 180 PASS, 9 files | acceptance-delivered/logs/test.log |
| Integration | 45 PASS, 4 files | acceptance-delivered/logs/test-integration.log |
| E2E | 44 PASS, skipped/unexpected/flaky=0 | e2e-delivered/e2e-results.json + logs/delivered.log |
| Final responsive UI | all 360/390/768/1440 × dark/light, keyboard, 200% CSS zoom, reduced motion | e2e-delivered/screenshots + axe-routing JSON |
| Original production | 6 routes + 6 additional theme/mobile = 12 PASS; browser/CSP/external-image error 0 | production-delivered/production-smoke.json + csp-diagnostic.json |
| Dynamic production | gate false/null, five write-action rejections, real catalog + public quotes, native VM recipient, axe/CSP/overflow | production-routing-delivered/production-multichain.json + quote-responses.json + raw log |
| Fresh install/build | PASS; new isolated tree including public | repro-delivered/reproducibility.json + two raw logs |
| Live read-only | 7 real bounded GETs; Ethereum→Base and Ethereum→Solana quote; M9 PASS_READ_ONLY | live-delivered/live-readonly.json + each response's SHA/raw JSON |
| SVG/cache | 76 CACHED, hash/provenance/diff | asset-sync-b/asset-sync.json |
| Text contrast | minimum 4.846:1; together with axe incomplete + PNG review | contrast-multichain.json + browser axe JSON |
| Initial JS/interaction | PASS against the measured baseline budget | baseline-performance, bundle-delivered, performance-budget/performance-comparison-delivered JSON |

M1 preserves the existing 112 unit/23 integration/28 E2E regression, included in the final total. The new native VM fixture scenarios are for EVM↔Solana, EVM→Bitcoin/Sui/Tron/Stellar; none of them is a real route claim. SYNTHETIC_TEST_ONLY is explicitly visible in the E2E quote/status fixtures. Real API availability can be inferred only from the live and production public quote records. The quote endpoint returns a single real alternative; the comparison helpers do not fabricate a nonexistent second route.

M2 dynamic catalog+ONE, M3 adapter/domain isolation, M4 native address/wallet, M5 current quote binding, M6 logo/theme/accessibility, M7 closed execution and M8 evidence-backed verification PASS. M9 PASS_READ_ONLY, M10 G5 UNCHANGED_BLOCKED. M11 NOT_RUN — USER_APPROVAL_REQUIRED; M12 BLOCKED — RELEASE_APPROVAL_REQUIRED. This is a local READY_FOR_REVIEW, not mainnet-ready.

The diagnostic chain is preserved: lint compiler hook errors, trn/xlm fixture keys, connection BaseToken hydration, real feeCollection schema, probe request-id/name collision, Node JSON import, language/theme/modal focus/test locator, manual sender mount race. The last race was repaired with a minimal identity-change synchronization; all 44 tests passed again. The wrapper's live-readonly/reproducibility name collisions preserved the old file via wx; the final unique bounded-probe/fresh-copy records exit 0. The production lazy-image timeout test was repaired so that it checks all local assets with an eager health check; lazy loading was preserved in the product. A Solana pair change resets the inputs; the smoke also refills the public inputs.

In the development abort tests, Next ECONNRESET diagnostics may be visible in the raw log; these are deliberately aborted requests. In the production smokes, browser/CSP errors are separate and zero. The safety scan is not an independent security audit. Real wallet/native extension acceptance, signing/approve/broadcast/deploy and V2/V3 were not performed.

The test–checkpoint relationship is in `source-inventory.json`. The final E2E/acceptance/production/fresh-copy starting SHA-256 maps are fully identical to the final source/asset/test/script/config checkpoint. The old V1/R1 evidence belongs to its own historical commits/checkpoints.
