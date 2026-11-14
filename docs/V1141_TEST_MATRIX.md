# V1.14.1 test matrix

Final engineering regression for the V1.14.1 DeFi scan performance hardening (READ-ONLY). Preflight baseline on the
unmodified V1.14 tree: unit 1189/1189, integration 275/275. No accepted test was removed, skipped or weakened.

Evidence root: `evidence/otherbridge-v1-14-1/v1141-20261011T061608Z-bd631d` (gate logs in `tests/final/`,
`regression-summary.json`).

| Gate | Result | Evidence |
| --- | --- | --- |
| Unit | 1224/1224 PASS (V1.14: 1189; +35) | tests/final/unit.log |
| Integration | 280/280 PASS (V1.14: 275; +5) | tests/final/integration.log |
| PostgreSQL | 38/38 PASS (no schema / index change; no migration, so no restore drill) | tests/final/db.log |
| Format / lint / typecheck | PASS | tests/final/format.log, lint.log, typecheck.log |
| i18n (24 locales, 1,006 keys, RTL locales unchanged) / docs | PASS | tests/final/i18n.log, docs-check.log |
| verify-safety / g7:safety / g7:pilot:safety | PASS; protected 107/107 unchanged; baseline SHA-256 12e30898… | security/verify-safety/, g7-safety-full.json, g7-pilot-safety.json |
| Security census (write methods, DeFi read-path RPC methods, secret scan, static scan, changed files) | PASS: wallet send literal 1 (unchanged, gated); DeFi read path eth_call / eth_getCode / eth_getBlockByNumber / eth_chainId only; 0 leaks; 0 findings; no protected overlap | security/security-census.json |
| Build / bundle budgets | PASS; initial app 276,106 gzip (budget 290,690; V1.14 276,105), landing 143,741 / 150,000, docs 144,876 / 150,000; portfolio lazy chunk +17,047 | tests/final/build.log, bundle.log, build/bundle/ |
| Production smoke (CSP, axe) / production i18n (24 locales) / production V1.13 portfolio | PASS | tests/final/production-smoke/, production-i18n/, production-v13/ |
| G7 standalone / in-product / artifacts | standalone 11 PASS + 1 opt-in skip; in-product 15 PASS + 3 opt-in skips; artifacts PASS (unchanged) | tests/final/g7-*.log, g7-artifacts.json |
| Performance acceptance (baseline-derived thresholds fixed before the acceptance run) | 16/16 PASS | performance/acceptance-thresholds.json, acceptance-evaluation.json |
| E2E (deterministic chunked harness, 261 discovered = 257 accepted + 4 new) | 261/261 PASS; 0 skipped / failed / flaky / retries; union 261, duplicates 0, missing 0; six chunks (peak run memory 2.3-6.7 GB). A first driver was stopped by the host memory reaper during chunk 1 (not counted; failed-attempts/regression-run-1-host-memory-reap); a guarded monolithic diagnosis is recorded as not a pass (e2e/MEMORY_DIAGNOSIS.md) | e2e/final/e2e-summary.json, chunk-plan.json, chunk-1..6/ |
| Production explorer check (strict CSP, axe dark / light) | PASS (CSP 0, axe 0, console errors 0); first attempt failed on a missing harness input (synthetic fixture export), kept in failed-attempts/ | tests/final/production-explore/ |
| Clean frozen reproduction (fresh copy on D:) | PASS: `.otherbridge/repro/<ts>` on D:, frozen install (lock unchanged) + full verify (format, lint, types, unit 1224, integration 280, safety, build); generated sources identical; no C: path in the logs | tests/final/reproduce/reproducibility.json, reproduce/logs/ |

## New V1.14.1 suites

| Suite | Tests | Scope |
| --- | --- | --- |
| `tests/unit/v1141-perf.test.ts` | 35 | V1.14 economic oracle equivalence (every deployment, 3 chains, cold + warm), Aave read plan and request reduction, exact zero short-circuit, reserve revert → PARTIAL, forged cached proof, static cache (no re-proof, key scope, chain scope, no failure / no SHORT state, no wallet value), single-flight, round memo, reverts and capacity errors never quarantine, bounded split, throttled prefilter, whole-request failure, partial Multicall result, malformed batch, slow adapter, bounded failover, retry-storm bound, tiers, native / duplicate held, continuation dedup, timing receipt, NDJSON reader, User Timing receipts, fixture timing order, forged target, stale block, wrong chain, account switch, stale pin and 30 s expiry, prewarm without wallet views, catalog out of client modules |
| `tests/integration/v1141-api.test.ts` | 5 | NDJSON progress lines equal the final round, JSON default unchanged, client reader on the real route, concurrent wallets isolated, hostile origin / arbitrary input refused before streaming |
| `tests/e2e/v1141.spec.ts` | 4 | wallet-first then streamed DeFi (desktop + mobile, browser timing receipts, CSP 0, no wallet requests, native never sent as a candidate), partial MetaMorpho / failed / full coverage (axe 0), address switch during a streamed round |
