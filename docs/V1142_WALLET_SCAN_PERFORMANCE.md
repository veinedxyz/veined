# V1.14.2 wallet scan / first paint performance

Status: local engineering milestone, READ-ONLY. Not production-ready, not independently audited. Production execution
remains CLOSED. Starting point: accepted V1.14.1 (HEAD `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5`, source checkpoint
`fb0f13c502860105cd3d462f6a2c114dc942e23a8634e7a780e6f5132f451874`, re-derived byte-exact at preflight: 877/877 files).

Evidence root: `evidence/otherbridge-v1-14-2/v1142-20261013T072745Z-656420/`.

**Fast first truth, full coverage continues.** The Portfolio no longer waits for the whole ~150-network round: the plan
renders at once, the connected chain / priority networks are read first, the first nonzero balance streams in about
0.1 s (fixture) / 0.2 s (live), a deterministic first page completes in ~1.5-2.5 s, and every remaining network keeps
being read in the background with truthful coverage. The final economic result is byte-equal to V1.14.1.

## Documentation index (V1.14.2)

| Document | Content |
| --- | --- |
| this report | scope, method, results, gates, self-review |
| [WALLET_SCAN_ARCHITECTURE](WALLET_SCAN_ARCHITECTURE.md) | read path, scheduler, invariants, compatibility |
| [WALLET_SCAN_PRIORITY](WALLET_SCAN_PRIORITY.md) | evidence, waves, first-page rule, slow-chain quarantine |
| [WALLET_SCAN_STREAMING](WALLET_SCAN_STREAMING.md) | NDJSON contract, reconciliation, client rendering, identity safety |
| [WALLET_SCAN_CACHE_POLICY](WALLET_SCAN_CACHE_POLICY.md) | cache classes, keys, TTLs, cursor binding |
| [V1142_TEST_MATRIX](V1142_TEST_MATRIX.md) | regression gates, new suites, evidence paths |

The V1.14 / V1.14.1 documents stay canonical for coverage, accounting and DeFi semantics (unchanged).

## Method

One harness measures both versions: `scripts/wallet-perf.ts` drives the Portfolio client flow at the server boundary
with the route's exact options (first round, continuation rounds until every planned network has an answer, the DeFi
rounds the client starts), records every HTTP request (chain, operator group, methods, timing, outcome, wallet / DeFi
phase) and computes the four wallet timings:

| Timing | Definition |
| --- | --- |
| `walletShellReadyMs` | the Portfolio can render the scan state (plan line; V1.14.1: the first round response) |
| `firstMeaningfulAssetMs` | the first confirmed nonzero native / token holding, or the first definitive checked result when the wallet holds nothing in the first page |
| `firstPageCompleteMs` | the deterministic first-page rule fired ([WALLET_SCAN_PRIORITY](WALLET_SCAN_PRIORITY.md)); V1.14.1: the first round response |
| `fullWalletCoverageMs` | every scheduled network checked / failed / pending-with-continuation |

Plus the accepted `firstDefiResultMs` / `fullDefiScanMs`. Deterministic fixture: `tests/fixtures/wallet-sim.ts`
(SYNTHETIC_TEST_ONLY) simulates all 154 scannable EVM networks of the committed registry with their endpoint counts and
batch capability, plus documented failure classes (slow 1.2 s/request, timeout, down, rate limited, wrong chain,
malformed, no Multicall3, first endpoint down); six wallet profiles (multichain, indexed, zero, native-only,
obscure-erc20, longtail) and watch mode. Live: real read-only public RPC, the V1.14.1 public treasury address (Aave
Collector; never an identified person), "View another address" flow, cold + two warm runs.

The baselines were measured on the byte-exact V1.14.1 source (the new modules moved aside, `scheduler.ts` /
`privacy.ts` restored from the preflight snapshot, 877/877 accepted hashes verified) before any optimisation was
enabled: `baseline/`. The acceptance thresholds were derived only from that baseline and frozen before the acceptance
run (`wallet-performance/acceptance-thresholds.json`, SHA-256 `bc08e84d…020d19`, pointer
`.otherbridge/v1142-thresholds-sha.txt`); they were never edited (`acceptance-evaluation.json` re-verifies the hash).
A first acceptance attempt was stopped deliberately to add one scheduling improvement found in its census (slow
networks with user evidence no longer hold the first page); it is preserved in `failed-attempts/acceptance-1-superseded/`
and the acceptance run was repeated in full.

## Results — deterministic fixture (ms; V1.14.1 → V1.14.2)

| profile | cache | shell | first asset | first page | full | HTTP | RPC items | checked/failed/pending | economic |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| multichain | cold | 9909 → 6 | 9909 → 94 | 9909 → 2435 | 9910 → 8581 | 193 → 193 | 664 → 664 | 147/7/0 | equal |
| multichain | warm 1 | 9662 → 1 | 9662 → 90 | 9662 → 2352 | 9662 → 8387 | 175 → 173 | 640 → 632 | 147/7/0 | equal |
| multichain | warm 2 | 9239 → 1 | 9239 → 91 | 9239 → 1490 | 9239 → 8367 | 169 → 171 | 616 → 624 | 147/7/0 | equal |
| multichain (watch) | cold | 9931 → 6 | 9931 → 93 | 9931 → 2412 | 9932 → 8576 | 193 → 193 | 664 → 664 | 147/7/0 | equal |
| multichain (watch) | warm 1 | 9658 → 1 | 9658 → 89 | 9658 → 2317 | 9658 → 8504 | 175 → 173 | 640 → 632 | 147/7/0 | equal |
| multichain (watch) | warm 2 | 9184 → 1 | 9184 → 93 | 9184 → 1495 | 9184 → 8165 | 169 → 171 | 616 → 624 | 147/7/0 | equal |
| indexed | cold | 9712 → 6 | 9712 → 92 | 9712 → 2346 | 9712 → 8311 | 183 → 183 | 654 → 654 | 147/7/0 | equal |
| indexed | warm | 9581 → 1 | 9581 → 102 | 9581 → 2284 | 9581 → 8337 | 169 → 169 | 628 → 628 | 147/7/0 | equal |
| zero | cold | 9842 → 7 | 9842 → 113 | 9842 → 2338 | 9843 → 8438 | 188 → 188 | 659 → 659 | 147/7/0 | equal |
| zero | warm | 9641 → 2 | 9641 → 102 | 9641 → 2226 | 9641 → 8329 | 169 → 169 | 628 → 628 | 147/7/0 | equal |
| native-only | cold | 9827 → 6 | 9827 → 311 | 9827 → 2335 | 9827 → 8424 | 188 → 188 | 659 → 659 | 147/7/0 | equal |
| native-only | warm | 9641 → 1 | 9641 → 105 | 9641 → 2239 | 9641 → 8348 | 169 → 169 | 628 → 628 | 147/7/0 | equal |
| obscure-erc20 | cold | 9892 → 6 | 9892 → 405 | 9892 → 2336 | 9892 → 8468 | 191 → 191 | 662 → 662 | 147/7/0 | equal |
| obscure-erc20 | warm | 9634 → 1 | 9634 → 319 | 9634 → 2356 | 9635 → 8408 | 171 → 171 | 630 → 630 | 147/7/0 | equal |
| longtail | cold | 9844 → 6 | 9844 → 2019 | 9844 → 2343 | 9844 → 8434 | 188 → 188 | 659 → 659 | 147/7/0 | equal |
| longtail | warm | 9628 → 1 | 9628 → 106 | 9628 → 2280 | 9629 → 8493 | 169 → 169 | 628 → 628 | 147/7/0 | equal |

* The first asset of the longtail profile (natives only on a slow and a long-tail network) arrives at 2.0 s cold —
  its networks are honestly in waves 4; on the warm run its previous-nonzero evidence moves them to wave 1 (0.1 s).
* Full coverage is bounded by the two timeout-class networks (7 s per-network timeout, unchanged); it improved because
  parallelism adapts between 8 and 16. The economic oracle (`oracle-v1141.json` vs `oracle-v1142.json`: 6 profiles ×
  wallet / watch × cold / warm = 24 digests) is byte-equal.
* Multichain cold: plan waves 0 = 1 (connected chain 8453), 1 = 3 (known tokens), 2 = 27, 3 = 32, 4 = 91; first page
  `CHAIN_BUDGET` (outstanding 295 / 100 / 4217 — the slow and timeout classes); by the third run the three are
  quarantined and the first page settles (`WAVES_SETTLED`, 1.49 s). Peak concurrency 8 → 16 (hard maximum), adaptive
  increases 10 / stress back-offs 4; peak RSS 165.5 → 166.1 MB, heap 61.2 → 63.2 MB.
* DeFi (multichain cold, `--defi`): DeFi starts at 9,910 → 2,436 ms; first DeFi result 10,446 → 2,960 ms from scan
  start; end-to-end (wallet + full DeFi) 36.2 → 28.4 s; the DeFi scan itself is unchanged (26.3 → 26.0 s, 419 → 419
  HTTP). Held receipt candidates on DeFi networks at DeFi start equal those at wallet completion (`heldChangedOnDefiChains:
  false` in every run); a held id on a non-DeFi network (the obscure token on slow network 295) arrives later, which
  admits no DeFi candidate.

## Results — live read-only (ms; V1.14.1 → V1.14.2, same harness and address)

| run | shell | first asset | first page | full | HTTP | RPC items | checked / failed / pending | DeFi start → first result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| cold | 11,377 → 9 | 11,377 → 213 | 11,377 → 2,537 | 11,377 → 9,564 | 193 → 199 | 667 → 676 | 152/2/0 → 149/5/0 | 11,377 → 2,537 / 13,221 → 4,886 |
| warm 1 | 8,566 → 2 | 8,566 → 116 | 8,566 → 1,267 | 8,570 → 5,155 | 178 → 182 | 637 → 644 | 152/2/0 → 149/5/0 | 8,566 → 1,163 / 9,615 → 2,401 |
| warm 2 | 8,158 → 2 | 8,158 → 114 | 8,158 → 1,584 | 8,158 → 4,689 | 178 → 178 | 637 → 634 | 152/2/0 → 150/4/0 | 8,158 → 1,012 / 9,270 → 1,912 |

* First page (cold): `WAVES_SETTLED` at 2.5 s with 39 networks answered (waves 2 = 30, 3 = 32, 4 = 92 for this
  evidence-free watch scan). Slowest networks (cold): 2020 (Ronin) 2.7 s, 41923 2.3 s, 10088 2.2 s, 122 1.7 s, 9 1.7 s
  (failed), 56 (BSC) 1.6 s. Peak concurrency 16 (four per-operator-group deferrals, no stress back-off, no 429).
* External variance (documented, gate not loosened): three long-tail networks failed in this run and not in the
  baseline. A sequential, no-concurrency probe right after the run (`live-readonly/failure-probe-1.json`) reproduces
  HTTP errors on 106 (Velas: both of its own endpoints) and 5330 (Superseed: its only endpoint); 1231 (Ultron) failed
  intermittently in the first two runs and answered in the third and in the probe; 9 (Quai) failed in the baseline too.
  Each of them has dedicated endpoints (no shared operator), so the higher parallelism cannot have caused them. They are
  reported `FAILED`, never zero. The frozen live gates (checked ≥ baseline − 3, failed ≤ baseline + 3) pass.
* DeFi full scan (unchanged code) 38.9 → 41.7 s cold: public-RPC variance of the same adapters (504 → 515 HTTP).

## Acceptance

`wallet-performance/acceptance-evaluation.json`: **204 / 204 checks PASS** — per profile and run: shell ≤ 500 ms, first
asset ≤ 25 % of baseline, first page ≤ 50 %, full coverage ≤ 110 %, HTTP / RPC items ≤ 115 %, identical coverage counts,
identical economic digest, peak concurrency ≤ 16, peak RSS ≤ 150 %, DeFi start before wallet completion, held DeFi
candidates unchanged; 24 oracle digests equal; live: first asset ≤ 50 %, first page ≤ 60 %, full ≤ 120 %, checked
≥ 149, failed ≤ 5, pending 0, planned networks equal; thresholds intact.

Gate summary (goal §68-71): PF1-PF4 measured (machine-readable receipts in every harness run and User Timing in the
browser); PF5 first result 9.9 s → 0.09 s (fixture); PF6 11.4 s → 0.21 s (live); PF7 coverage counts and planned
networks identical; PF8 HTTP within +3 %; PF9 a slow network never holds the first page beyond 2 s and, once
quarantined, not at all; PF10 DeFi starts at the first page / DeFi-network settlement with candidate truth; PF11 bundle
and search not regressed (initial app JS 276,106 → 276,103 gzip; catalog search p95 real 4.36 → 4.35-5.58 ms on unchanged code, synthetic 3.91 → 3.23 ms; [V1142_TEST_MATRIX](V1142_TEST_MATRIX.md)). C1-C10, R1-R10 and S1-S12: test matrix.

## Self-review (goal §73)

| # | Question | Answer (evidence) |
| --- | --- | --- |
| 1 | Faster because networks were dropped? | No: identical planned / checked / failed / pending counts in every fixture run; `planWaves` is a permutation (unit test) |
| 2 | All scheduled networks represented? | Yes: done / failed / pending + cursor; plan line lists every network; receipt has one row per network |
| 3 | Unchecked → zero? | No: progressive view marks unanswered networks `PENDING`; unit + integration + E2E |
| 4 | Timeout → zero? | No: timeout / rate limit / HTTP → `FAILED` (failure matrix test); round deadline → `PENDING` |
| 5 | Previous data shown as current? | No: hints are order-only; a refresh keeps the previous result with its own observation time and stale marker until the new first page, then shows only new reads |
| 6 | Old account streaming into new? | No: sequence + abort; E2E account switch / disconnect mid-stream |
| 7 | Cursor replay for another wallet? | No: HMAC-tagged v2 cursor bound to identity scope, generation, catalog + plan digest, round, expiry; unit + integration + route 422 |
| 8 | Cache leak across wallets? | No: keyed pseudonym + chain + read set + epoch, plane-owned; isolation tests |
| 9 | Native double read / double count? | No: one native read per network; the `chain` line replaces the native line; reconstruction test equals the final round |
| 10 | Long-tail token discovery lost? | No: discovery code unchanged; per-profile expected holdings found; oracle equal |
| 11 | One slow network blocks the first page? | At most 2 s (`CHAIN_BUDGET`), never after quarantine |
| 12 | Provider request storm? | No: base 8, hard 16, ≤ 4 per operator group, 48 process-wide slots, back-off on stress, flight sharing, 15 s result cache, route rate limit |
| 13 | DeFi starving wallet first paint? | No: DeFi starts only at the first page / DeFi-network settlement; wallet first-result reads hold the highest slot class |
| 14 | Timings exact and machine-readable? | Yes: harness receipts, scheduler receipt, User Timing marks |
| 15 | Cold / warm separated? | Yes, every receipt |
| 16 | Final output equals the V1.14.1 oracle? | Yes, 24 / 24 digests + every fixture run |
| 17 | Global catalog regressed? | No: catalog / universe files untouched (security census changed-file list) |
| 18 | JS bundle regressed? | No: 276,106 → 276,103 gzip (portfolio code stays in its lazy chunk) |
| 19 | E2E missed tests? | No: 266 discovered = union, duplicates 0, missing 0, flaky / retries 0 |
| 20 | G7 protected file changed? | No: 107 / 107 |
| 21 | Real write / sign request? | No: 0 (census + E2E write recorders) |
| 22 | Active C: path? | 0 (path audit) |

## Remaining limits

* Full coverage stays bounded by the slowest answering network and the accepted 7 s per-network timeout (two
  timeout-class networks in the fixture; ~9.6 s cold live). It continues in the background and never blocks the page.
* Public RPC variance moves live numbers; the long-tail failures above are external and reported, not hidden.
* Locale strings for the three new phase messages are machine-assisted outside EN / TR and await native review (as
  earlier milestones).
* External audit, legal review and release gates remain open; no production-readiness claim.
