# V1.14.2 test matrix

Evidence root: `evidence/otherbridge-v1-14-2/v1142-20261013T072745Z-656420/` (`tests/final/` logs and
`regression-summary.json`, `e2e/final/` chunked E2E, `wallet-performance/` acceptance, `security/` receipts).
Driver: `node .otherbridge/v1142-regression.mjs` (every gate in sequence, own log and exit code, failures recorded).

## Regression gates (floors from V1.14.1; no accepted test removed, no assertion weakened, no failure turned into a skip)

| Gate | V1.14.1 | V1.14.2 | Evidence |
| --- | --- | --- | --- |
| Unit | 1,224 / 1,224 | 1,247 / 1,247 (+23 new) | `tests/final/unit.log` |
| Integration | 280 / 280 | 297 / 297 (+17 new) | `tests/final/integration.log` |
| E2E (chunked) | 261 / 261 | 266 / 266 (+5 new); discovered 266, union 266, duplicates 0, missing 0, flaky 0, retries 0, 6 chunks; peak run memory 5.17 GB (chunk 4), min free 2.5 GB | `e2e/final/e2e-summary.json` |
| DB (real PostgreSQL) | 38 / 38 | 38 / 38 | `tests/final/db.log` |
| G7 standalone / in-product / artifacts | 11 + 1 opt-in skip / 15 + 3 opt-in skips / PASS | 11 + 1 opt-in skip / 15 + 3 opt-in skips / PASS | `tests/final/g7-*.log`, `g7-artifacts.json` |
| format, lint, typecheck | PASS | PASS | `tests/final/*.log` |
| i18n (24 locales, 1,009 leaves each) | PASS (24 × 1,006) | PASS | `tests/final/i18n.log` |
| docs-check | PASS | PASS | `tests/final/docs-check.log` |
| verify-safety, g7:safety, g7:pilot:safety | PASS | PASS | `security/` |
| build | PASS | PASS | `tests/final/build.log` |
| bundle (initial app gzip, budget 290,690) | 276,106 | 276,103 | `tests/final/bundle.log` |
| production smoke / i18n / V1.13 portfolio / explorer (CSP, axe) | PASS | PASS (explorer: CSP 0, console errors 0, wallet requests 0, axe dark / light 0) | `tests/final/production-*` |
| frozen reproduction (fresh copy on D:, frozen install) | PASS | PASS on attempt 2 (fresh copy, `pnpm install --frozen-lockfile`, `pnpm verify`; lock unchanged; generated sources identical); attempt 1 failed on one timing-dependent V1.14.2 test, repaired — `failed-attempts/reproduce-1-timing-flaky-test/` | `tests/final/reproduce/` |
| security census (write census, read-path methods, secrets, static scan, G7 107) | PASS | PASS (wallet + DeFi read paths: read methods only, 0 write references; secrets 0; static findings 0; G7 107 / 107) | `security/security-census.json` |
| catalog search p95 (unchanged code; medians of 5) | real 4.36 ms / synthetic 3.91 ms | real 5.58 ms (set 1, two 11.6 ms outliers) / 4.35 ms (set 2); synthetic 3.23 ms — search code unchanged | `wallet-performance/search-performance.json` |

## New suites (V1.14.2)

| Suite | Tests | Covers (goal §64) |
| --- | --- | --- |
| `tests/unit/v1142-wallet-scan.test.ts` | 23 | **Scheduler**: wave ordering, priority determinism, explainable reasons, wave bounds, permutation (no silent omission), pending on deadline, adaptive concurrency hard maximum + stress back-off, per-group bound, slot waiters pending. **Continuation**: round-trip, narrowing, other wallet, tampered tag / body, changed catalog / plan, expiry, malformed / oversized. **Cache**: single flight, TTL, fresh, wallet / chain / plane isolation, failure / timeout / partial / FAILED / PENDING never cached, caller abort never aborts the shared read, native fan-out, slow-chain memory, read-slot priority + hard maximum + abort. **Streaming**: strict lines, duplicate / provisional replacement, late native ignored, unplanned ignored, pending never empty, failed never zero, milestones once, held ids exclude native / spam / zero. **Perf receipts**: four wallet timings once per scan, cleared on a new scan, render flush marks |
| `tests/integration/v1142-wallet-scan.test.ts` | 17 | **Oracle equivalence** (multichain, indexed, longtail, obscure-erc20, zero, native-only): holdings / coverage / DeFi coverage / economic digests equal to the V1.14.1 single-order scan + profile discovery oracle. **Streaming**: plan first, native before its network, one line per network, provisional reconstruction == final, receipt per network. **Failure matrix**: timeout, down, rate limit, wrong chain, malformed → FAILED (never zero), no Multicall3 → native only, one endpoint down → failover. **Slow network**: deferred / quarantined after repeated overruns, still scanned, never holds the first page again (also with user evidence). **Non-EVM**: Solana / Bitcoin coverage unchanged. **DoS**: refresh storm bounded, ten tabs = one scan. **Identity / cursor**: shared reads per plane, another wallet shares nothing, bound cursor (other wallet, v1 cursor, tampered body rejected; continued round only narrows). **Route**: NDJSON lines + result line, JSON compatibility, shared flight replay, hostile input 422 before any stream (bad / oversized cursor, oversized address, too many hints, unknown fields, RPC URL field, v1 cursor) |
| `tests/e2e/v1142.spec.ts` | 5 | **Browser**: shell → first asset → first page → background → final (pending never empty, DeFi gated until the trigger with exact held ids, coverage live region off while streaming, timings ordered, refresh sends order-only hints + `fresh`), account switch mid-stream (no old-account line renders, aborted stream), disconnect mid-stream (no late merge, watch mode usable), render census (150 networks / 173 lines coalesced; `wallet-performance/render-census.json`), RTL (ar) phase line + axe |

Accepted suites that exercise the wallet path unchanged and still pass: `tests/unit/v14-data.test.ts` (v1 cursor
functions, scheduler limits), `tests/integration/v14-data.test.ts` (aggregation > 40 chains, deadline → pending →
continuation, Data API, route status codes), `tests/integration/v111-api.test.ts`, `tests/integration/v13.test.ts`,
`tests/e2e/v14.spec.ts`, `tests/e2e/v111.spec.ts` (auto scan, priority `["1"]`, account change), `tests/e2e/v113.spec.ts`,
`tests/e2e/v1141.spec.ts` (JSON responses — the client's JSON compatibility path).

## Acceptance gates (goal §68-71)

| Gate | Result | Evidence |
| --- | --- | --- |
| PF1-PF4 timings measured | PASS | harness receipts; scheduler receipt; User Timing |
| PF5 deterministic first result | 9,909 → 94 ms (cold multichain) | `wallet-performance/fixture-cold.json` |
| PF6 live first result | 11,377 → 213 ms (cold) | `wallet-performance/live-cold.json` |
| PF7 full coverage not reduced | identical planned / checked / failed / pending (fixture) | `acceptance-evaluation.json` |
| PF8 requests bounded | HTTP within -1 / +2 (fixture), +3 % live | `request-census.json` |
| PF9 slow network does not block the first page | ≤ 2 s budget; quarantined → excluded | integration slow-network test, `scheduler-census.json` |
| PF10 DeFi before full wallet, safely | DeFi start 9.9 → 2.4 s; held DeFi candidates unchanged | fixture `--defi` runs |
| PF11 search / bundle | bundle 276,103 (≤ 290,690; V1.14.1 276,106); search p95 real 4.35-5.58 ms (V1.14.1 4.36), synthetic 3.23 ms (V1.14.1 3.91), code unchanged | `bundle.log`, `search-performance.json` |
| C1-C10 | PASS | oracle equality (24 digests), discovery oracle, failure matrix, account switch / watch parity E2E, non-EVM test |
| R1-R10 | PASS | failure matrix, slow-network test, cache tests, cursor tests, E2E disconnect / switch, DoS tests, chunked E2E |
| S1-S12 | PASS | `security/security-census.json`, G7 107 / 107, production execution CLOSED, real counters 0 |

## Counters

Real wallet requests 0 · signatures 0 · approvals 0 · permits 0 · broadcasts 0 · deploys 0 · fee collection 0.
Production execution CLOSED.
