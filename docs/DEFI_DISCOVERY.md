# Self-hosted position discovery

V1.14.1 performance hardening (read plans, request budget, cache policy, timing receipts): [report](V1141_DEFI_PERFORMANCE_HARDENING.md) · [performance](DEFI_PERFORMANCE.md) · [request budget](DEFI_REQUEST_BUDGET.md) · [cache policy](DEFI_CACHE_POLICY.md) · [test matrix](V1141_TEST_MATRIX.md).

Phase 1 existing wallet scan; phases 2–6 run independently through /api/portfolio/defi: deployment candidates, native discovery/locally indexed refs, pinned state, valuation/risk, provable rewards. Exact registry receipt/share identities can prioritize local refs; symbols cannot. Local wallet_protocol_activity is discovery only; current protocol state decides position existence.

Migration 0004 adds official deployment/source records, event checkpoints/windows, market/vault/pair refs, approved position ERC721 transfers/ownership, scoped optional snapshots/assets/rewards/risk and scan coverage. Run pnpm defi:sync after migration. Run pnpm defi:index <deployment-id> <explicit-start-block> repeatedly to backfill one bounded 2,000-block window (max 10,000), resumable by checkpoint. Only known CreateMarket, CreateMetaMorpho, PairCreated and approved manager Transfer + Blue Supply/Borrow/SupplyCollateral events are accepted. Explicit operator start cannot be called complete deployment history unless a reviewed deployment start is configured. No guessed historical completeness.

Reorg: compare prior window hash; find retained canonical ancestor (32 windows), rollback refs/activity/transfers after it, rebuild NFT ownership, replay. Missing ancestor halts. Fresh NFT enumeration + ownerOf at the pin is authoritative over historical ownership. Fresh exact zero drops the position; cache does not turn a failed read into zero.

Morpho V1 vaults validate isMetaMorpho at official factory. V3 can work without a local NFT index via bounded official enumeration; old/stale index ownership never authorizes a position. Discovery candidates max64 mean partial breadth for large registries. Initial live local index coverage is documented in evidence, not claimed as historical complete.
