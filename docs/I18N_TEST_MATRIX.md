# Otherbridge V1.2 final test matrix

Verified 2026-10-03T09:26:09.209Z. HEAD 8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5; uncommitted source checkpoint 0d476b8b3d98e85ca8ac94a6363ed90a61bcd100179f872d9d5f311d08d5bb7a. Evidence root: evidence/otherbridge-v1-2/v12-20261003T080544442Z-eb1c84. All six delivered command snapshots below exactly match the final 230 source/assets/tests/scripts/config hashes. Their raw logs and full per-file hashes are included. Earlier failures remain diagnostic evidence and are superseded only by the delivered runs.

| Check | Final result | Raw evidence |
|---|---|---|
| Frozen lockfile install | PASS (unchanged lockfile) | protocol-final-checks/frozen-install.json |
| Format / lint / typecheck | PASS | protocol-final-checks/protocol-final-verify.json + logs |
| Unit | 253 PASS (201 accepted + 52 i18n) | protocol-final-checks/logs/protocol-final-verify.log |
| Integration | 46 PASS | protocol-final-checks/logs/protocol-final-verify.log |
| E2E | 93 PASS, 0 skipped/flaky | protocol-final-e2e/e2e-results.json |
| Locale critical surfaces | 24/24 PASS | protocol-final-e2e/i18n/*-smoke.json |
| Representative themes/widths | 7 locales × 2 themes × 4 widths = 56 PASS | protocol-final-e2e/i18n/axe-*.json + screenshots |
| RTL functional/visual | AR/FA/HE/UR × 360/1440 = 8 PASS | protocol-final-e2e/i18n/rtl-*.json |
| Dictionaries | 24 × 313; missing/obsolete/malformed = 0 | protocol-final-checks/i18n-schema.json |
| Financial input/display | Safe decimal normalization; adversarial grouping/bidi/precision; BigInt above safe integer; expected/minimum order LTR | tests/unit/i18n.test.ts + RTL review assertions |
| Production build | PASS Next 16.3.8 | protocol-final-checks/logs/protocol-final-verify.log |
| Production smoke | Existing 18 controls PASS | protocol-production-smoke/production-smoke.json |
| Production routing | Actual ETH→Base PASS_READ_ONLY; non-EVM PASS_READ_ONLY | production-http-diagnostic/production-multichain.json + quote-responses.json |
| Production locales | 24 browser locales, 144 actual SSR surfaces PASS | protocol-production-i18n/production-i18n.json |
| Production safety | Hostile write env still false/null; 5 routing write actions rejected | production smoke/routing records |
| Clean reproducibility | Frozen install + build PASS in fresh copied workspace | protocol-final-repro/reproducibility.json |
| Public brand | All 24 dictionaries/rendered critical pages + public docs PASS | unit, E2E raw texts, production public-text, docs-final |
| Baseline preservation | All 2390 initial paths exist; unrelated changes 0 | baseline-preservation.json |

460 final PNGs are captured across E2E and production. Inspect the screen index and visual-review.json for individually viewed images. E2E quote/history fixtures are explicitly synthetic and do not establish actual liquidity or G5. Production pages and routing response records are actual local production-build read-only observations.

## Repairs and limits

Initial unit failures exposed ICU Arabic Latin defaults; explicit numeric locales repaired them. Initial browser collection required Node JSON import attributes; serializer script text caused a missing-key scanner false positive, corrected by checking product DOM separately while retaining full body brand checks. Network modal focus and all technical code direction were repaired. Accepted fee/status assertions were localized with unchanged financial-value and unverified-reload assertions. One development run was disrupted by our concurrent provider edit; it is not final evidence. RTL screenshot inspection additionally isolated expected/minimum amounts to preserve their order. All 93 E2E tests were rerun after the final source change.

The first live production routing attempt returned NO_EXECUTABLE_ROUTE. Independent bounded read diagnostics and subsequent production retest preserve the actual request/response; synthetic fixtures never replace that check. Provider availability and quote validity are time-limited. G5 remains BLOCKED independently of local tests. Translation review is model semantic review, not native-speaker certification. Axe automation complements visual/keyboard checks and is not an independent accessibility audit. No release or mainnet execution occurred.

## Final bound command records

- protocol-final-checks/protocol-final-verify.json: pnpm verify; exit 0; 2026-10-03T09:12:03.076Z–2026-10-03T09:13:11.899Z; final source hashes match.
- protocol-final-e2e/protocol-final-e2e.json: pnpm test:e2e; exit 0; 2026-10-03T09:12:11.525Z–2026-10-03T09:18:06.640Z; final source hashes match.
- protocol-production-smoke/protocol-production-smoke.json: pnpm exec node scripts/production-smoke.mjs; exit 0; 2026-10-03T09:14:50.736Z–2026-10-03T09:15:11.953Z; final source hashes match.
- production-http-diagnostic/production-http-diagnostic.json: pnpm exec node scripts/production-multichain.mjs; exit 0; 2026-10-03T09:20:21.664Z–2026-10-03T09:20:36.764Z; final source hashes match.
- protocol-production-i18n/protocol-production-i18n.json: pnpm exec node scripts/production-i18n.mjs; exit 0; 2026-10-03T09:16:29.974Z–2026-10-03T09:16:52.229Z; final source hashes match.
- protocol-final-repro/protocol-final-repro.json: pnpm exec node scripts/reproduce.mjs; exit 0; 2026-10-03T09:13:12.889Z–2026-10-03T09:13:57.783Z; final source hashes match.

## Live routing availability and diagnostic observer

The actual production ETH→Base/ETH→Solana PASS in production-http-diagnostic used a Node HTTPS response listener that records status/raw bytes without changing URL, DNS pinning, request, response, validation or API output. The exact observer is .otherbridge/v12-http-debug.cjs and is included with its hash. It is not a test double. Subsequent uninstrumented routing-production-final returned NO_EXECUTABLE_ROUTE for both reads; preceding runs also returned TOOL_OR_NETWORK_DISAPPEARED. These failed acceptance attempts remain preserved and are not labeled PASS. The last uninstrumented live-availability check is BLOCKED; only the timestamped actual successful observation is PASS_READ_ONLY. Existing 18-control production smoke and all 24-locale production browser/SSR checks pass independently.

The first real protocol/feeCollection step exposed MISSING_KEY:tr:kinds.protocol. All 24 protocol terms and a safe typed unknown-kind mapping repaired it. Unit and 24-locale synthetic protocol-step browser coverage, then actual production response/render evidence verify the repair. MAX wrapping and the Japanese received-amount label were also corrected during visual review. G5 remains separately BLOCKED.
