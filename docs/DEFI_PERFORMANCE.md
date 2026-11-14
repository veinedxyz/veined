# DeFi scan performance (V1.14.1)

Part of the V1.14.1 DeFi scan performance hardening ([report](V1141_DEFI_PERFORMANCE_HARDENING.md)).
Related: [request budget](DEFI_REQUEST_BUDGET.md), [cache policy](DEFI_CACHE_POLICY.md),
[test matrix](V1141_TEST_MATRIX.md), [adapter architecture](DEFI_ADAPTER_ARCHITECTURE.md),
[discovery](DEFI_DISCOVERY.md), [universe](DEFI_UNIVERSE.md).

Evidence: `evidence/otherbridge-v1-14-1/v1141-20261011T061608Z-bd631d/performance/`.

## Read path

```text
client (Portfolio)                     server                                         public RPC (one pinned endpoint)
──────────────────                     ──────                                         ───────────────────────────────
wallet scan  ── first page renders ──▶ (unchanged V1.11 wallet path)
DeFi round   ── Accept: NDJSON ──────▶ scanDefi: candidates ordered by tier
                                       per chain: 1 pin (eth_chainId + latest, one JSON-RPC batch)
                                       per deployment (3 concurrent):
                                         code proofs  ── cached LONG, else 1 JSON-RPC batch (+ Multicall3 proof)
                                         read plan    ── reads issued in one event-loop turn ──▶ 1 aggregate3 at the pin
                                         dependent    ── next turn's reads ─────────────────────▶ 1 aggregate3
                                         reorg check  ── shared per pin (15 ms window, starts after the reads)
           ◀── progress line ───────── deployment finished (validated coverage + positions + replaced assets)
           ◀── scan line ───────────── complete schema-checked round (continuation)
```

* **Coalescing reader** (`src/defi/reader.ts`). `read()` authorizes the exact target and calldata, then queues it;
  everything queued in one turn is flushed as one Multicall3 `aggregate3` at the pinned block (FIFO chunks of 120),
  a single call stays a plain `eth_call`, and without a verified Multicall3 the reads go out as JSON-RPC batches of at
  most 20. Each logical read is counted once (V1.14 counted a rejected batch's reads twice).
* **Read plans** (`src/defi/adapters.ts`, `src/defi/families.ts`). Independent views are issued together and consumed
  in the V1.14 program order (`settle` / `valueOf`), so the first failure in that order is still the error reported.
  Aave reads identity, account data, the reserve list, every planned reserve's user data and one rewards read in a
  single request; Compound III folds its collateral list into the first request once the list is known (verified at
  the pin); Morpho binds cached market parameters to the market id by hash.
* **Bounded failure handling**. A failed aggregate is split in halves at most twice (never on a rate limit or an
  endpoint in cooldown); a registry prefilter stops sending at the first throttled chunk; contract reverts and provider
  capacity errors (`EXECUTION_REVERTED`, `CAPACITY_EXCEEDED`) are not endpoint faults; an adapter whose pinned endpoint
  throttles restarts once on a fresh pin from another healthy endpoint.
* **Round memo**. Identical exact reads of different adapters in the same round (e.g. the three UniswapV2-family
  probes of the same held tokens) share one result; only deterministic outcomes are shared.
* **Progressive response** (`src/app/api/portfolio/defi/route.ts`, `src/components/defi-stream.ts`). With
  `Accept: application/x-ndjson` every finished deployment is streamed as a validated line; the final line is the
  complete round, which replaces the provisional view. A plain JSON request gets the V1.14 response unchanged.

## Timing receipts

| Receipt | Where | Definition |
| --- | --- | --- |
| `otherbridge:walletFirstResultMs` | browser `performance.measure` | wallet scan start → first wallet page rendered |
| `otherbridge:firstDefiResultMs` | browser `performance.measure` | wallet scan start → first DeFi result rendered (first streamed deployment, or first round) |
| `otherbridge:fullDefiScanMs` | browser `performance.measure` | DeFi start → last round rendered (continuation empty) |
| `receipt.timing.firstResultMs` / `roundMs` | every DeFi round (server) | round start → first finished deployment / round duration |
| `receipt.requests` | every DeFi round (server) | HTTP, RPC items, aggregates, retries, cooldown skips, cache hits, pins, reorg checks |

A new scan (explicit, refresh or account switch) clears the previous identity's browser receipts first.

## Methodology

`scripts/defi-perf.ts` drives the client flow (first wallet page, then DeFi rounds with exact held ids until the
continuation is empty) through stable public APIs only, so the identical harness measured the accepted V1.14 code at
preflight and the V1.14.1 code afterwards on the same machine (AMD Ryzen 9 7950X, 32 logical CPUs, 31.1 GB, Node
v24.18.0, Windows 11).

* **Deterministic fixture** — `tests/fixtures/defi-sim.ts` (SYNTHETIC_TEST_ONLY): every reviewed deployment of the
  simulated chains answers its exact views; Multicall3 with the real canonical runtime code; 90 ms per request + 0.2 ms
  per item, 10 % jitter, seed 7. Profiles: `production` (Aave supply/borrow, Compound, Lido, rETH, sDAI, Uniswap V3 NFT,
  V2 pair, Curve LP, BPT, Morpho market + vault; 1,814 markets / 382 vaults in the registry lanes), `whale`
  (treasury-like: supplied in 50 of 67 Aave reserves), `zero`.
* **Cold / warm** — cold is the first run of a fresh process (empty process caches); warm runs follow in the same process
  after clearing only the 30 s scan result cache. They are never mixed.
* **Stress** — six simulated chains; chain 1 throttles at 25 requests/s and rejects aggregates above 300 inner calls;
  chain 137 answers in 1.2 s.
* **Live read-only** — real public RPC (the committed admitted endpoints), one public protocol treasury contract from a
  pinned official source (the Aave V3 Ethereum Collector, never an identified person); the accepted V1.14 method
  (one first pass on chain 1), the product flow with the wallet page, and the DeFi rounds with the local registry lanes.
* **Thresholds** — derived from the V1.14 baseline only and recorded before the acceptance run
  (`acceptance-thresholds.json`); evaluated in `acceptance-evaluation.json`. Live numbers are observations, never
  thresholds.

## Results (V1.14 → V1.14.1)

Deterministic fixture, `production` profile (`fixture-cold.json`, `fixture-warm.json`):

| Metric | Cold before → after | Warm before → after |
| --- | --- | --- |
| wallet first result | 474 → 471 ms | 357 → 375 ms |
| first UI-visible DeFi result | 3,827 ms (first round) → 982 ms (first streamed deployment) | 3,709 → 728 ms |
| first complete round | 3,827 → 1,654 ms | 3,709 → 1,023 ms |
| full DeFi scan | 15,915 → 5,876 ms | 15,829 → 3,612 ms |
| DeFi HTTP requests | 362 → 113 | 362 → 59 |
| RPC items | 379 → 141 | 379 → 64 |
| FAILED deployments | 5 → 0 | 5 → 0 |

`whale` cold: first round 10,487 → 1,670 ms (V1.14 Aave hit the 10 s adapter deadline), full scan 19,685 → 4,463 ms,
HTTP 371 → 92, FAILED 6 → 0. Stress: full scan 55.9 → 32.9 s cold / 54.7 → 19.4 s warm, HTTP 506 → 290 / 159,
429 responses 3 → 0, FAILED 7 → 0, unhandled rejections 6 → 0.

Isolated per-family census, cold (`adapter-census.json`; HTTP before → after): Aave 121 → 17 (4 deployments),
Compound III 288 → 85 (14), Morpho Blue 43 → 15 (3), MetaMorpho 22 → 13 (3), Uniswap V2 family 73 → 47 (7),
Uniswap V3 family 52 → 28 (5), Lido 10 → 5, Curve 41 → 24 (3), Balancer 32 → 17 (3), Aerodrome / Velodrome 36 → 16 (2).
Warm: Aave 121 → 12, Compound 288 → 42, Morpho 43 → 11, MetaMorpho 22 → 7.

Live read-only (`live-readonly.json`, same address, same day):

| Mode | V1.14 | V1.14.1 cold | V1.14.1 warm |
| --- | --- | --- | --- |
| accepted V1.14 method (chain 1, first pass) | 12,176 ms, 342 HTTP, Aave PARTIAL (budget exhausted, 12.2 s) | 1,476 ms, 33 HTTP, Aave FULL (1.0 s) | 766 ms, 11 HTTP, Aave FULL (0.58 s) |
| product flow: wallet first result | 11,279 / 7,413 ms | 11,538 ms | 8,301 ms |
| product flow: first complete DeFi round (from scan start) | 21,840 / 18,230 ms | 13,915 ms | 9,562 ms |
| product flow: full DeFi scan (from DeFi start) | 20,995 / 21,755 ms, 511 / 514 HTTP, 7 / 2 FAILED | 16,263 ms, 195 HTTP, 0 FAILED | 9,853 ms, 117 HTTP, 0 FAILED |
| DeFi with registry lanes (no wallet page): first round / full | 10,855 / 18,534 ms, 410 HTTP, 7 FAILED | 1,994 / 7,350 ms, 111 HTTP, 0 FAILED | 1,291 / 6,577 ms, 65 HTTP, 0 FAILED |

The accepted V1.14 report recorded 10.6 s / 407 logical calls for the first pass; the same method measured 12.2 s
today. Every live request went to one operator group (`allnodes-publicnode`); no 429 was observed in these runs.

Catalog search (unchanged code; medians of 5): real p95 4.36 ms (accepted 7.2 ms), synthetic 20k p95 3.91 ms
(accepted 3.55 ms; the same code measured 2.6-8.3 ms on this host). Bundle: see the test matrix.

## Remaining limits

* The wallet first page is the unchanged multi-chain wallet scan (about 150 chains, first-page deadline 18 s); it
  dominates the product flow's first DeFi time (11.5 s of 13.2 s cold live). It is measured, not changed here.
  V1.14.2 update: the wallet scan is now progressive and multi-wave; DeFi starts at the wallet first page (live cold
  DeFi start 11.4 s → 2.5 s, first DeFi result 13.2 s → 4.9 s from scan start). See
  [V1142_WALLET_SCAN_PERFORMANCE](V1142_WALLET_SCAN_PERFORMANCE.md).
* Adapter concurrency stays at the accepted bound of 3 per round; the full scan is bounded by sequential waves of
  2-4 round trips each.
* Without a verified Multicall3 on a chain the reader falls back to JSON-RPC batches of 20 (more requests, same truth).
