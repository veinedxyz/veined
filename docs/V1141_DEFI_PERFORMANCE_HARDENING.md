# V1.14.1 DeFi scan performance & coverage hardening

Status: local engineering milestone, READ-ONLY. Not production-ready, not independently audited. Production execution
remains CLOSED. Starting point: accepted V1.14 (HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`, source checkpoint
`5b519a34b4fc22eff6642a7393a2f6a3f5d9f0149b7f9ac1ceed3946de5756e8`, re-derived byte-exact at preflight).

Evidence root: `evidence/otherbridge-v1-14-1/v1141-20261011T061608Z-bd631d/`.

## Documentation index (V1.14.1)

| Document | Content |
| --- | --- |
| this report | scope, defects found, changes, results, gates |
| [DEFI_PERFORMANCE](DEFI_PERFORMANCE.md) | read path, timing receipts, methodology, before → after results |
| [DEFI_REQUEST_BUDGET](DEFI_REQUEST_BUDGET.md) | census vocabulary, bounds, per-family read plans |
| [DEFI_CACHE_POLICY](DEFI_CACHE_POLICY.md) | stores, TTL classes, keys, safety rules, prewarm |
| [V1141_TEST_MATRIX](V1141_TEST_MATRIX.md) | regression gates, new suites, evidence paths |

The V1.14 documents stay canonical for the catalog / coverage / accounting semantics (unchanged):
[DEFI_UNIVERSE](DEFI_UNIVERSE.md), [DEFI_GLOBAL_COVERAGE](DEFI_GLOBAL_COVERAGE.md),
[DEFI_ADAPTER_ARCHITECTURE](DEFI_ADAPTER_ARCHITECTURE.md), [DEFI_DISCOVERY](DEFI_DISCOVERY.md),
[DEFI_POSITION_MODEL](DEFI_POSITION_MODEL.md), [DEFI_VALUATION](DEFI_VALUATION.md),
[DEFI_RISK_METRICS](DEFI_RISK_METRICS.md), [V114_TEST_MATRIX](V114_TEST_MATRIX.md).

## Defects found by measuring V1.14 (all repaired and covered by tests)

| # | Defect (V1.14) | Effect | Repair |
| --- | --- | --- | --- |
| D1 | Aave reserve reads were sent as one JSON-RPC batch of 67 calls; the transport accepts at most 20, so the batch was rejected and every reserve fell back to single calls, each counted twice | 262 logical calls for a treasury wallet; the 256-read budget was exhausted (Aave PARTIAL) and, in the product flow, the 10 s adapter deadline was exceeded (Aave FAILED `SCAN_TIMEOUT`) | coalesced Multicall3 read plan; JSON-RPC batches chunked at 20; one count per logical read |
| D2 | A contract revert (`execution reverted`) was an endpoint fault; receipt probes of plain held tokens revert by design | three reverts quarantined the pinned endpoint; every other adapter of the chain failed (`NO_HEALTHY_ENDPOINT`): 7 FAILED in the live product flow | `EXECUTION_REVERTED` is returned at once and recorded as a healthy response |
| D3 | The client sent the native coin (zero address) as a held receipt candidate | every receipt-probe family (Curve, Balancer, UniswapV2 family) failed with `INVALID_CONTRACT` for any wallet with a native balance | native ids excluded on the client and the server; held ids deduplicated |
| D4 | `bounded()` left the adapter promise unobserved when its signal was already aborted | unhandled rejections (6 in the stress fixture) | the work promise is always observed |
| D5 | A failed registry aggregate fell back to `readMany` / single calls of every market | fan-out of up to 250 single calls per failed chunk under throttling | bounded split (depth 2, never on a rate limit); prefilter stops at the first throttled chunk; discovery stays PARTIAL |
| D6 | Provider capacity errors (`out of gas`, HTTP 413, response too large) were endpoint faults | three oversized aggregates quarantined the endpoint for 60 s | `CAPACITY_EXCEEDED` is not an endpoint fault; the reader splits the request |

## Changes

* Coalescing pinned reader with bounded split, JSON-RPC batch chunking, code-proof batches, shared reorg checks and a
  per-round read memo (`src/defi/reader.ts`).
* Read plans for Aave V3 / SparkLend, Compound III, Morpho Blue, MetaMorpho / ERC4626, Uniswap V2 / V3 families,
  Lido, LST, EigenLayer, Curve, Balancer and Aerodrome / Velodrome (`src/defi/adapters.ts`, `src/defi/families.ts`);
  the V1.14 program order of checks and errors is preserved.
* Process metadata cache with TTL classes and single-flight (`src/defi/cache.ts`); opt-in startup prewarm
  (`src/defi/prewarm.ts`, `OTHERBRIDGE_DEFI_PREWARM=1`).
* Scanner: confidence tiers (scheduling only), native / duplicate held exclusion, failed rounds never cached, endpoint
  cooldown never trips a protocol circuit, bounded failover restart, per-deployment request census, round timing
  receipt (`src/defi/scanner.ts`, `src/defi/model.ts` — optional fields only).
* RPC classification: `EXECUTION_REVERTED`, `CAPACITY_EXCEEDED` (`src/data/rpc/transport.ts`, `src/data/rpc/pool.ts`).
* Progressive NDJSON round and browser User Timing receipts (`src/app/api/portfolio/defi/route.ts`,
  `src/components/defi-stream.ts`, `src/components/perf.ts`, `src/components/portfolio*.tsx`).
* Measurement and E2E harnesses: `scripts/defi-perf.ts`, `tests/fixtures/defi-sim.ts`, `scripts/e2e-chunks.mjs`.

Unchanged by design: global catalog semantics and data, coverage vocabulary, accounting math (Aave, Compound, Morpho
shares/accrual/LLTV/oracle registry, Uniswap V3 exact source-block fees, V2 burn, Lido queue, LST conversions,
wrapper/LP/vault exposure, debt separation, rewards exclusion), the database schema (no migration, no index), the
wallet scan, the G7 protected files and every write / signing boundary.

## Correctness proof

`tests/fixtures/v114-economic-oracle.json` was generated from the unmodified V1.14 code on the deterministic simulator
(every reviewed deployment of chains 1 / 8453 / 10, `production` and `zero` profiles, all value-bearing fields:
raw amounts, prices, values, risk, rewards, fees, warnings, details, coverage outcome). The V1.14.1 code reproduces it
byte-for-byte, cold and warm (`tests/unit/v1141-perf.test.ts`); the treasury-like profile is checked reserve by
reserve against the simulator state (V1.14 could not finish it).

## Results

See [DEFI_PERFORMANCE](DEFI_PERFORMANCE.md) for the full tables. Headline (deterministic fixture, production profile,
cold): first UI-visible DeFi result 3.83 s → 0.98 s, full DeFi scan 15.9 s → 5.9 s, HTTP 362 → 113, FAILED 5 → 0.
Live read-only, accepted V1.14 method: 12.2 s / 342 HTTP (Aave PARTIAL) → 1.5 s / 33 HTTP cold, 0.77 s / 11 HTTP warm
(Aave FULL). Acceptance thresholds (derived from the baseline only, recorded before the acceptance run): all PASS
(`performance/acceptance-evaluation.json`).

## Gates

All mandatory gates PASS ([test matrix](V1141_TEST_MATRIX.md)): unit 1224/1224, integration 280/280, E2E 261/261
(chunked, union = discovered, 0 duplicates / missing / flaky / skipped), DB 38/38, G7 standalone 11 + 1 opt-in skip,
G7 in-product 15 + 3 opt-in skips, G7 artifacts, format / lint / types, i18n (24 locales), docs, verify-safety,
g7:safety, g7:pilot:safety, security census, build, bundle (app 276,106 gzip), production smoke / i18n / V1.13
portfolio / explorer (CSP 0, axe 0), clean frozen reproduction on D:, performance acceptance 16/16. Protected
107/107 unchanged; production execution CLOSED; real wallet requests, signatures, approvals, permits, broadcasts,
deploys and fee collection 0.

## E2E harness

A monolithic run on this shared host is unsafe: the Next dev server reached 6.4 GB (66 worker processes) after 20
tests while free physical memory fell to 0.96 GB; the host-memory guard stopped it (recorded as not a pass,
`e2e/MEMORY_DIAGNOSIS.md`). The accepted method is the deterministic chunked harness `scripts/e2e-chunks.mjs` with a
partition proof (discovered = union, duplicates 0, missing 0).

## Not claimed

No production readiness, no independent audit, no complete net worth, no live write path. Live numbers are
observations of public RPC on one day. External audit / legal / release gates remain open.
