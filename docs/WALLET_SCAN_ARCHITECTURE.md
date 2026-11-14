# Wallet scan architecture (V1.14.2)

Status: local engineering milestone, READ-ONLY. Not production-ready, not independently audited. Production execution
remains CLOSED. Related: [WALLET_SCAN_PRIORITY](WALLET_SCAN_PRIORITY.md), [WALLET_SCAN_STREAMING](WALLET_SCAN_STREAMING.md),
[WALLET_SCAN_CACHE_POLICY](WALLET_SCAN_CACHE_POLICY.md), [V1142_WALLET_SCAN_PERFORMANCE](V1142_WALLET_SCAN_PERFORMANCE.md).

## Goal

Fast first truth, full coverage continues: show trustworthy wallet assets as early as possible without reducing the
eventual global coverage. The V1.14.1 scan read every planned network in one order and answered once the whole round
ended (~10 s fixture, ~11.4 s live). V1.14.2 reads the same plan in explainable waves and streams every answer.

## Read path

```text
Portfolio client ──POST /api/portfolio (Accept: application/x-ndjson)──▶ route (validation, rate limit, flight)
        ▲                                                                   │
        │ NDJSON: plan · native · chain · firstPage · defiReady · result    ▼
        └──────────────────────────── scanPortfolio(waves: true) ── SelfHostedPortfolioProvider ── vetted RPC pools
```

1. **Plan.** `discoverActivity` returns the scannable networks (accepted V1.14.1 order: indexed activity, routable,
   TVL). The canonical plan is `[connected chain, …rest]` exactly as in V1.14.1. Waves only reorder it
   ([WALLET_SCAN_PRIORITY](WALLET_SCAN_PRIORITY.md)); no network is ever removed or added.
2. **Budgets fixed in canonical order.** Per-scan provider budgets (the eight upstream price chains) are fixed by
   `planScan(canonical)` before scheduling, so the wave order can never change which networks are priced. This is
   what keeps the final economic output byte-equal to V1.14.1 (`tests/fixtures/wallet-economics.ts`).
3. **Schedule.** `runScheduled` reads the wave order with: base concurrency 8, adaptive hard maximum 16 (+2 after four
   healthy settles ≤ 2.5 s, back to 8 at once on a rate limit / timeout / HTTP / DNS failure, no increase while the
   process RSS is above 1.5 GiB), at most four networks of one provider operator group at once, the 7 s per-network
   timeout and the 18 s round deadline (unchanged), and a process-wide hard maximum of 48 concurrent network reads
   across every scan, granted by class (first-result → first-page → background).
4. **Per network.** One native read (`eth_chainId`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount` in
   one vetted JSON-RPC batch) pins the block; a confirmed nonzero native balance is streamed at once (native fast
   path) and never read again. Token candidates (receipt contracts, store / routing universe, curated registry, user
   imports, indexed discoveries) are read at the same pinned block through a code-hash-verified Multicall3 — exactly
   the accepted V1.14.1 discovery. One network result is one snapshot at one block.
5. **First page.** Waves 0-2 (minus slow-quarantined networks, which are still read) form the first page; the
   deterministic first-page rule
   (`WAVES_SETTLED` / `CHAIN_BUDGET` 2 s / `DEADLINE` 5 s / `ROUND_END`) emits `firstPage`. Background waves continue.
6. **DeFi start.** `defiReady` is emitted when every planned network hosting reviewed DeFi deployments has answered
   (`DEFI_CHAINS_SETTLED`) or at the first page (`FIRST_PAGE`), whichever is first. The client starts DeFi with the
   exact held receipt-token ids it has; if the held set on DeFi networks differs at the end of the wallet scan, DeFi
   restarts once with the complete set (candidate truth).
7. **Final round.** The `result` line is the complete reconciled round, built exactly like V1.14.1 (coverage
   precedence, DeFi receipt coverage, summary, state). It replaces every provisional line. Pending networks continue
   through the bound v2 cursor in canonical order (≤ 15 continuation rounds for the connected wallet, 3 for
   "View another address", as accepted).

## Invariants

| Invariant | Mechanism |
| --- | --- |
| No silent omission | `planWaves` is a permutation of the canonical plan; every admitted id ends done / failed / pending; overflow stays pending |
| Timeout ≠ zero | per-network timeout, rate limit, HTTP / DNS failure → `FAILED`; round deadline → `PENDING` + cursor; only an exact successful read is checked |
| Unchecked ≠ zero | the progressive view marks every unanswered planned network `PENDING`; terminal (catalog-only, unsupported, no vetted RPC) coverage comes from the plan line |
| No double count | one `chain` line per network per round replaces any native fast-path line of that network; the `result` line replaces the whole provisional round |
| Economic equivalence | price chains fixed in canonical order; the final round is built by the V1.14.1 code path; oracle digests byte-equal (`baseline/oracle-v1141.json` vs `final/…`) |
| Identity isolation | client sequence + abort on account / address / mode change; server keys carry the keyed wallet pseudonym; cursors are bound to the identity scope |
| Read-only | the route accepts no RPC URL, no method, no write; the method census is `eth_chainId`, `eth_blockNumber`, `eth_getBalance`, `eth_getTransactionCount`, `eth_getCode`, `eth_call` (Multicall3 `aggregate3` of `balanceOf` / metadata) |

## Compatibility

* The route keeps the V1.11 JSON response for clients that do not accept NDJSON (test doubles, scripts); the request
  schema only gained two optional, strict fields (`hints`, `fresh`).
* The Data API (`/v1/address/{address}/portfolio`) is unchanged: no waves, the accepted v1 cursor, the accepted
  first-come price budget. Only the app route enables `waves: true`.
* The app route accepts only the bound v2 cursor; a v1 cursor is `INVALID_CONTINUATION` (422).

## Non-EVM

Unchanged. Solana remains an enumerated read when a vetted RPC exists (also shared through the chain cache, without a
native fast path); Bitcoin / Sui / Tron / Stellar stay `CATALOG_ONLY / UNSUPPORTED_ECOSYSTEM` and are never checked
zero.
