# V1.14 test matrix

V1.14.1 performance hardening (read plans, request budget, cache policy, timing receipts): [report](V1141_DEFI_PERFORMANCE_HARDENING.md) · [performance](DEFI_PERFORMANCE.md) · [request budget](DEFI_REQUEST_BUDGET.md) · [cache policy](DEFI_CACHE_POLICY.md) · [test matrix](V1141_TEST_MATRIX.md).

Final engineering regression for the V1.14 global DeFi completion milestone (READ-ONLY). Baseline at preflight:
1102 unit, 266 integration (V1.13 accepted: 227 E2E, 28 DB). No accepted test was removed; two DB assertions that
pinned the schema version to 4 now expect the forward-only V1.14 migration (version 5).

Evidence root: `evidence/otherbridge-v1-14/v114-20261010T224255Z-cfd59c`.

| Gate | Result | Evidence |
| --- | --- | --- |
| Unit | 1189/1189 PASS | tests/final/unit.log |
| Integration | 275/275 PASS | tests/final/integration.log |
| E2E (Playwright, all specs) | 257/257 PASS; 0 failed / skipped / flaky (6 sequential chunks after one memory-pressure interruption, kept in failed-attempts/) | tests/final/e2e/chunk-1..6.log, e2e/e2e-summary.json |
| PostgreSQL | 38/38 PASS (schema 5) | tests/final/db.log |
| G7 standalone / in-product | standalone 11 PASS + 1 live opt-in skip; in-product 15 PASS + 3 live opt-in skips; artifacts PASS (unchanged from V1.13) | tests/final/g7-*.log |
| Format / lint / typecheck | PASS | tests/final/format.log, lint.log, typecheck.log |
| verify-safety / g7:safety / g7:pilot:safety | PASS; protected 107/107 unchanged | tests/final/verify-safety.log, g7-safety-full.json, g7-pilot-safety.log |
| i18n (24 locales, 1,006 keys) / docs | PASS | tests/final/i18n.log, docs-check.log |
| Build / bundle budgets | PASS; initial app JS 276,105 gzip (budget 290,690), landing 143,741 / 150,000, docs 144,876 / 150,000 | tests/final/build.log, bundle.log |
| Clean frozen reproduction | PASS: frozen install (lock unchanged since preflight) + full verify in a new directory (format, lint, types, 1189 unit, 275 integration, safety, build) | tests/final/reproduce/reproducibility.json, reproduce/logs/ |
| Production smoke / CSP / axe | PASS: production smoke (all pages 200, axe 0, CSP 0), production i18n 24 locales, production V1.13 portfolio, production explorer (strict CSP 0, axe 0 dark/light, no console errors) | tests/final/production-smoke/, production-i18n/, production-v13/, production-explore-run3/ |
| DB backup restore drill | PASS: verified backup restored into a new isolated container (schema 5, row counts, structure, secret scan), drill container/volume removed | tests/final/restore/ |

## New V1.14 suites

| Suite | Tests | Scope |
| --- | --- | --- |
| `tests/unit/v114-universe.test.ts` | 30 | parity, aliases, VM families, chain ids, untrusted metadata, history/diff/anomaly, coverage truth, capabilities, catalog queries |
| `tests/unit/v114-defi.test.ts` | 47 | LST conversion (never 1:1), EigenLayer, Curve, Balancer V2, Aerodrome/Velodrome, isqrt/_mintFee/V3 fee math vs independent implementations, V2 exact burn, PancakeSwap V3, Lido withdrawal queue, Morpho registry prefilter, Multicall3 policy + pinned aggregate, reverse index, lanes decode/log source, value summary, exposure graph v2, SparkLend |
| `tests/unit/v114-security.test.ts` | 6 | logos/free text never stored, fork-parent confusion, chain-identity spoof, malformed rows, oversized/prototype payloads, hostile search/cursor/chain input |
| `tests/unit/v114-stress.test.ts` | 4 | 5,000 chains / 20,000 protocols / 100,000 rows; 500 positions / 2,000 assets / 100 debts / 500 rewards |
| `tests/integration/v114-catalog.test.ts` | 9 | Data API catalog endpoints, app catalog route, fixture sync accept/reject/corrupt with last-good fallback, candidate-driven scan receipt |
| `tests/db/v114.test.ts` | 10 | migration 0005, idempotent loader, never-delete identity, constraints, lane backfill/reorg/non-canonical abort, registry completeness, receipts, role grants |
| `tests/e2e/v114.spec.ts` | 30 | explorer search/detail/TVL separation/catalog-only truth, networks, windowed long catalog, responsive 390/768 light + axe, value summary + V3 fees, 24 locales + RTL |

Fixture tests are synthetic and never reported as real execution. Real evidence is separate: 25 pinned mainnet
nonzero proofs (`core-nonzero/`), live registry-complete Morpho scans (`portfolio/`) and a live read-only scan with
catalog funnel (`performance/real-catalog-and-live-scan.json`).

## Failed and interrupted attempts (kept, not counted)

- `failed-attempts/e2e-memory-pressure/`: first final E2E run stopped by the host under critical memory pressure (104/104
  passed before the event; later worker crashes are environmental). Re-run in six sequential chunks: 257/257.
- `failed-attempts/reproduce-missing-g7-baseline/`, `failed-attempts/reproduce-missing-review-record/`: the clean
  reproduction copy lacked the G7 protected-baseline inputs (root AGENTS.md/CLAUDE.md/V1.7 goal, baseline pointer,
  accepted hashes, rebaseline review record), so G7 unit tests correctly reported BLOCKED. `scripts/reproduce.mjs`
  now copies them (unprotected harness file); no G7 file or baseline was changed.
- `failed-attempts/production-explore-harness/`: two harness errors in the new production explorer check (synthetic
  portfolio shape; axe requires an explicit browser context) before the passing run.
- `failed-attempts/morpho-registry-live-scan-rate-limited.jsonl`: public endpoint rate limiting during a live stress
  scan; reported FAILED/PARTIAL truthfully.
