# DeFi cache policy (V1.14.1)

Part of the V1.14.1 DeFi scan performance hardening ([report](V1141_DEFI_PERFORMANCE_HARDENING.md)).
Related: [performance](DEFI_PERFORMANCE.md), [request budget](DEFI_REQUEST_BUDGET.md),
[adapter architecture](DEFI_ADAPTER_ARCHITECTURE.md).

The DeFi read path caches **facts, never wallet state**. Every value a position reports is read at the scan's pinned
block; caches only decide which reads are needed, and every cached identity is still compared at use.

## Stores

| Store | Module | Scope | Holds | Lifetime |
| --- | --- | --- | --- | --- |
| Metadata cache | `src/defi/cache.ts` | process | static, non-user facts proven on-chain | TTL class (below), max 50,000 entries |
| Scan result cache | `src/defi/scanner.ts` | process, keyed by client scope + wallet + chains + deployments + round size + held ids | one complete round | 30 s (`SHORT`) |
| Round read memo | `src/defi/scanner.ts` → `DefiReader` | one scan round, one chain pin (`endpoint@blockHash`) | identical exact reads of adapters in that round | the round |
| Scan single-flight | `src/defi/scanner.ts` | same key as the result cache | the in-flight round | until it settles |

## TTL classes

| Class | Value | Used for |
| --- | --- | --- |
| `LONG` | 6 h | contract code proofs (code hash + observation block), the verified Multicall3 per chain, token decimals + symbol, Aave reserve identity proofs (aToken, variable-debt token, decimals), Morpho market parameters (bound to the market id by `MarketParamsLib.id`), MetaMorpho curation proofs (`isMetaMorpho`), UniswapV2 pair proofs (`getPair`), UniswapV3 pool identities (factory, tokens, fee, tick spacing) |
| `MEDIUM` | 10 min | read *plans* only: the last observed Aave reserve list and the last Compound III collateral list (both re-read and re-verified at every pinned block before any result is used) |
| `SHORT` | 30 s | position, price, risk and rewards state — only as a complete round in the scan result cache; `cacheSet(..., "SHORT")` in the metadata cache throws |

## Keys

`kind | chainId | scope | subject`

* `chainId` — decimal chain id (a fact of one chain is never served to another chain).
* `scope` — `chain` for chain-wide facts (code, Multicall3, token metadata), otherwise `deploymentId@adapterVersion`
  (an adapter semantics change invalidates every proof of that deployment).
* `subject` — the exact contract address or 32-byte market id / pool key; never a wallet.

Keys are validated by `cacheKey()`; the unit suite asserts every key shape and that no stored key or value contains
any scanned wallet address (`tests/unit/v1141-perf.test.ts`).

## Rules

1. **No failure is cached.** A rejected load is dropped (`cached()` only stores resolved values); the next scan reads
   again. A Multicall3 code-hash mismatch is not cached either (the reader fails closed for that scan only).
2. **No user state is cached** outside the 30 s wallet-scoped round cache. Rounds that contain a `FAILED` or `PENDING`
   deployment are not cached at all, so a failure is never served again as if it were a result.
3. **Cached identities are compared at use.** A cached Aave reserve proof is compared with the reviewed registry on
   every scan (a forged or outdated proof fails the position: `POSITION_READ_FAILED`, never a value or a zero).
4. **Plans are verified at the pin.** The `MEDIUM` reserve / collateral lists only choose the reads of the first
   request; the on-chain list is read in that same request and any planned entry that changed is read again.
5. **Only the production reader uses the process cache.** Synthetic or test contexts (any `AdapterContext` that is not
   a `DefiReader`) always prove everything again, so a proof never comes from a test double.
6. **Single-flight never inherits a foreign deadline.** Concurrent scans share one load per key; if the shared load
   fails (e.g. the other scan's deadline), the waiting scan reads with its own budget. The same rule holds for the
   round read memo: only deterministic outcomes (a value, a contract revert, an undecodable return) are shared.
7. **Freshness stays explicit.** Positions carry their pin's `observedAt`; adapters refuse a pin older than 60 s
   (`STALE_STATE`) and the UI marks a position older than 60 s as stale. Merging continuation rounds never refreshes
   an older position.

## Prewarm

`src/defi/prewarm.ts` (`OTHERBRIDGE_DEFI_PREWARM=1`, started in the background by `src/instrumentation.ts`) fills the
`LONG`/`MEDIUM` classes at server start: one pin per reviewed position chain, the Multicall3 proof, every reviewed
contract's code proof, Aave reserve identities and reserve lists, Compound III collateral lists and token metadata.
It never issues a wallet-scoped view (asserted by the unit suite) and is bounded by a 60 s deadline. Without prewarm
the first scan of each deployment proves the same facts (cold path).
