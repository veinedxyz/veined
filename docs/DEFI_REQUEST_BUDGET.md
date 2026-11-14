# DeFi request budget (V1.14.1)

Part of the V1.14.1 DeFi scan performance hardening ([report](V1141_DEFI_PERFORMANCE_HARDENING.md)).
Related: [performance](DEFI_PERFORMANCE.md), [cache policy](DEFI_CACHE_POLICY.md),
[adapter architecture](DEFI_ADAPTER_ARCHITECTURE.md).

## Vocabulary (request census)

| Field | Meaning |
| --- | --- |
| logical reads (`calls`) | exact view capabilities an adapter evaluated (each counted once, whatever carried it); bounded by the reader budget (256, registry families 4,608) |
| HTTP requests (`http`) | HTTPS POSTs to an RPC endpoint (a JSON-RPC batch or one aggregate is one request) |
| RPC items (`rpcItems`) | JSON-RPC method invocations (a batch of 15 counts 15; an aggregate counts 1) |
| Multicall batches (`multicallBatches`) | `aggregate3` eth_calls to the canonical, code-hash-verified Multicall3 at the pinned block |
| retries | bounded aggregate splits, JSON-RPC batch fallbacks and the single bounded failover restart |
| cooldown skips | reads or deployments not sent because the endpoint (or every endpoint of the chain) is in cooldown |
| cache hits | static metadata answered by the process cache and identical reads answered by the round memo |

Per deployment these fields are in each coverage row; per round they are summed in `receipt.requests` together with
the shared pin (`pins`) and reorg checks (`pinVerifications`). Per-deployment HTTP counts exclude the shared pin and
reorg check of the chain.

## Bounds

| Bound | Value | Where |
| --- | --- | --- |
| Inner calls per coalesced aggregate | 120 (`COALESCE_MAX`) | `src/defi/reader.ts` |
| Inner calls per registry prefilter aggregate | 500 (`PREFILTER_CHUNK`, the RPC policy maximum) | `src/defi/adapters.ts` |
| Prefilter aggregates in flight | 2 | `src/defi/adapters.ts` |
| Split depth of a failed aggregate | 2 (at most 1 + 2 + 4 requests for one chunk; never on a rate limit or an endpoint in cooldown) | `src/defi/reader.ts` |
| JSON-RPC batch size | 20 (transport limit; the V1.14 Aave path exceeded it) | `src/data/rpc/transport.ts` |
| Adapter concurrency | 3 (accepted V1.13 bound) | `src/defi/scanner.ts` |
| Deployments per round | 6 (kept: a larger round did not shorten the full scan, see `performance/decisions/round-size.json`) | `src/defi/scanner.ts` |
| Failover restarts per adapter | 1, only to another healthy admitted endpoint | `src/defi/scanner.ts` |
| Receipt probes per deployment | 32 held contracts (unchanged) | `src/defi/adapters.ts` |
| Request timeouts | single eth_call 3.5 s, JSON-RPC batch 4 s, aggregate 8 s, adapter 10 s (registry families 20 s), round 15 s | reader / scanner |

## Read plans (requests per deployment, isolated scan, after the shared pin)

| Family | Warm path | Cold path adds | Notes |
| --- | --- | --- | --- |
| Aave V3 / SparkLend | 1 aggregate: identity (getPool, getPoolDataProvider), account data, reserve list, every planned reserve's user data, one rewards read | code-proof batch (+ the chain's Multicall3 proof), proof aggregate for nonzero reserves | exact zero: no proofs, no rewards; a reserve listed after the plan is read in the next request |
| Compound III | 1 aggregate: base token, balances, collateral count, asset infos and collateral balances of the planned asset list | asset infos, then collateral balances (2 aggregates) | risk views only when there is debt (+1) |
| Morpho Blue | prefilter: ⌈markets / 500⌉ aggregates (2 in flight); per nonzero market 1–3 coalesced requests | idToMarketParams in the first request | parameters cached once proven by hash; oracle price only after the official factory proves the oracle |
| MetaMorpho | prefilter: ⌈vaults / 500⌉ aggregates; per nonzero vault 2 coalesced requests | isMetaMorpho proof | throttling stops the prefilter (PARTIAL, never zero) |
| Uniswap V3 / PancakeSwap V3 | balanceOf, then token ids in 1 request; per NFT 2 requests | pool proof (poolFor + identity) | exact source-block fee math unchanged |
| Uniswap V2 family | per held / indexed pair: 1 identity request + 1 state request | getPair proof | identical token probes of the three forks share one read per round |
| Lido | steth / wsteth / queue refs coalesce into 1–2 requests | — | finalized claimable ETH exact; pending never valued; no claim path |
| LST / ERC4626 | 1 request (balance), +1 when nonzero | token metadata | |
| EigenLayer | 1 request (deposits, pod shares, queued roots) | — | |
| Curve / Balancer / Aerodrome / Velodrome | per held contract: registry / factory proof, then the pool views in one request | — | bounded fallback probes, scheduled last |

Measured per-deployment numbers (before / after, cold / warm) are in
`evidence/otherbridge-v1-14-1/<run>/performance/adapter-census.json`; scenario totals in `request-census.json`.
