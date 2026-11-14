# Data plane V1.5 additions (current)

- Independent log-set witness consensus for every indexed window, persisted evidence (`indexed_window_witnesses`), halt/resume, backward backfill lane with its own lease, legacy-window re-verification (`docs/INDEXER_LOG_CONSENSUS.md`).
- RPC provenance annotations (`operatorGroup`, `witnessEligible`, `reviewStatus`) on every admitted endpoint and deployment profiles (`development`, `staging`, `release`) (`docs/RPC_PROVENANCE_TERMS.md`).
- Tier A: Arbitrum, Avalanche, Ink, World Chain. Release eligibility is computed separately from development indexing.
- Internal metrics listeners and a DB-derived ops exporter (`docs/MONITORING_ARCHITECTURE.md`); backup/verify/restore tooling (`docs/RUNBOOK_BACKUP_RESTORE.md`); staging-equivalent stack (`docs/RUNBOOK_STAGING.md`).

---

# Otherbridge self-hosted data plane (V1.4)

Otherbridge answers "which supported networks hold assets for this wallet, and which native/fungible assets are there?" with its own data plane. No paid portfolio/indexer API is used; the V1.3 paid adapter and its credential were retired from the application path (a deprecated, transport-less copy exists only under `tests/fixtures/` for historical regression tests).

```text
Public RPC / registries ─► RPC registry + admission ─► health/quarantine ─► indexer workers
                                                                              │
Browser ─► /api/portfolio (app server) ─► in-process DataPlane ◄──── PostgreSQL data store
Developer (future) ─► loopback Data API /v1 (API key) ─┘
```

## Components (source)

| Component | Path | Role |
|---|---|---|
| Chain registry | `src/data/registry/chains.ts`, `tiers.json` | Deterministic union of the accepted TVL catalog, routing catalog and custom networks; canonical IDs, finality policy, configured tier ceiling. |
| RPC admission | `src/data/rpc/url-policy.ts`, `admission.ts`, `registry-source.ts` | Candidate → URL policy → HTTPS → public-DNS pinning → chain ID probe → read-only probes → capability (logs range, batch, finalized/safe tags, archive). |
| RPC transport/policy | `src/data/rpc/transport.ts`, `methods.ts` | Pinned DNS, no redirects, byte/time caps, prototype-key rejection, strict read-only method allowlist (balanceOf/decimals/symbol/name/aggregate3 only at the verified Multicall3). |
| Health/pool | `src/data/rpc/health.ts`, `pool.ts` | EWMA latency/error, quarantine (rate limit 30 s, failures backoff, chain mismatch 24 h), head-lag exclusion, bounded failover. |
| Indexer | `src/data/indexer/worker.ts`, `ranges.ts`, `reorg.ts` | Lease-fenced ERC20 Transfer ingestion, adaptive ranges with learned ceiling, same-endpoint header sandwich, two-endpoint canonical-hash consensus, reorg rewind of unfinalized windows only. |
| Balances | `src/data/balances/evm.ts`, `solana.ts`, `src/data/evm/multicall.ts` | Native batch read with chain ID in the same batch; `balanceOf` at a pinned block (Multicall3 only when its runtime hash matches the pin); bounded metadata; SPL token accounts at finalized commitment. |
| Aggregator | `src/data/portfolio/provider.ts`, `scheduler.ts`, `src/portfolio/service.ts` | Provider-neutral orchestration without a chain cap: bounded concurrency, deadline, explicit PENDING + continuation cursor. |
| Store | `src/data/store/*` | `DataStore` contract; PostgreSQL implementation (production-capable) and a semantics-identical memory store (tests/dev). |
| Data API | `src/data/api/*`, `services/data-api.ts` | Versioned read-only `/v1`, API keys (hash only), scopes, plans, cost units, durable rate limits, usage metering, OpenAPI 3.1, static docs page. Loopback only; not launched. |
| Observability | `src/data/observability/log.ts` | Structured redacted logs, counters/latency without wallet labels. |

## Coverage tiers (no "330-chain full index" claim)

| Tier | Meaning | Current measured count (2026-10-04) |
|---|---|---|
| FULL_INDEXED | Vetted log-capable RPC, ERC20 Transfer ingestion with reorg-safe checkpoints, indexed wallet→token discovery, `balanceOf` verification, metadata. | 3 (Arbitrum 42161, Avalanche 43114, Ink 57073) |
| ON_DEMAND_FUNGIBLE | Native + bounded known/routable/previously-discovered token `balanceOf`; historical discovery not guaranteed. Solana: native + complete current SPL/Token-2022 account enumeration. | 60 |
| NATIVE_ONLY | Healthy vetted RPC, native balance only. | 92 |
| CATALOG_ONLY | Visible (TVL-positive) but not checked; never reported as empty. | 193 |

The configured tier in `tiers.json` is a ceiling; `effectiveTier()` lowers it automatically when vetted capability is missing (no healthy RPC → CATALOG_ONLY; no logs/index → ON_DEMAND_FUNGIBLE; no token universe → NATIVE_ONLY). Promotion is configuration, not code.

Tier A selection used the measured registry (`evidence/.../data/rpc-measurement.json`): TVL rank, route relevance, an eth_getLogs-capable endpoint with ≥1000-block probed range, ≤30 Transfer logs/block, verified Multicall3. Ethereum/BSC had no vetted endpoint serving unfiltered `eth_getLogs`; Base/Polygon exceeded 300 logs/block. Start strategy: recent window (20,000 blocks), `historicalComplete=false` until genesis/token-origin coverage exists.

## Correctness rules

- Balances are always `balanceOf`/`eth_getBalance` at an observed block, never transfer sums. Indexed transfers only nominate candidate tokens.
- A chain is COMPLETE only when coverage proves it; PENDING, CATALOG_ONLY and FAILED are never empty. The overall result is COMPLETE only when every planned chain is COMPLETE.
- Native balances ≥ 2^128 base units are RPC sentinels (e.g. gasless chains) and are excluded with reason `IMPLAUSIBLE_BALANCE`. A routable ERC20 mirror of the native asset with an identical balance is not double counted.
- Price evidence (`priceUsd`, `observedAt`, `confidence`, `method`) is presentation only and requested before balances; unknown or stale prices leave USD unknown and never hide an asset.
- Data plane unavailable → the app uses the committed admitted registry (DEGRADED) or reports UNAVAILABLE; Bridge/Swap manual selection keeps working; execution gates are untouched.

## Operations

See `docs/RUNBOOK.md` (data plane section): `pnpm data:db:init`, `data:db:up`, `data:db:migrate`, `data:chains:sync`, `data:rpc:sync --write-snapshot`, `data:rpc:health [--measure-logs]`, `data:tokens:sync`, `data:indexer:once|run`, `data:coverage`, `data:verify-index`, `data:verify`, `data:api:dev`, `data:client:create`, `data:key:create`, `data:key:revoke`, `data:usage:show`, `data:retention`.

Workers use per-chain Postgres leases (owner, chain, from/to, acquired, expiry; expired leases are reclaimable) and fence every commit on lease ownership and checkpoint contiguity. SIGINT/SIGTERM finish the current window and release leases.
