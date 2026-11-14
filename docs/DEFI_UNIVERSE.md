# DeFi universe, coverage truth and candidate-driven discovery (V1.14)

V1.14.1 performance hardening (read plans, request budget, cache policy, timing receipts): [report](V1141_DEFI_PERFORMANCE_HARDENING.md) · [performance](DEFI_PERFORMANCE.md) · [request budget](DEFI_REQUEST_BUDGET.md) · [cache policy](DEFI_CACHE_POLICY.md) · [test matrix](V1141_TEST_MATRIX.md).

Status: local engineering milestone, READ-ONLY. Not production-ready, not independently audited, not a complete
portfolio product. Upstream source names, URLs and licence notes are kept in `docs/INTERNAL/DEFI_UNIVERSE_SOURCES.md`.

## 1. Catalog breadth (every chain, protocol and protocol-chain relation)

`pnpm defi:universe:sync` downloads the upstream public DeFi catalog API (protocol list, chain list and chain
configuration; JSON only, no HTML scraping) through an exact host allowlist with bounded size, bounded gzip and
retries. The chain-id module of the pinned chain-list repository is parsed as text by a regular expression and is never
executed. Repository revisions are pinned through the hosting API; downloaded third-party adapter code is never run.

Normalisation (`src/defi/universe/normalize.ts`) keeps every upstream row:

- every chain name seen anywhere (chain list, configuration, protocol `chains`) becomes a canonical chain or an alias;
- aliases are merged only by exact (case-insensitive) name, the upstream key-to-label map, or a shared EVM chain id
  corroborated by the same gecko id or a similar name; conflicts become `AMBIGUOUS_ALIAS` and are never merged;
- VM family comes from Otherbridge network identity first, then explicit name overrides, then upstream tags
  (EVM, Solana, Sui, Aptos, Cosmos, Bitcoin, Tron, Stellar, Other);
- an EVM chain without a verifiable id is `UNKNOWN_CHAIN_ID`; the chain-list only fills an exact single key;
- every protocol keeps its raw category, a normalised product category, parent, version, fork list, listed date,
  status (active, deprecated, dead, rugged, removed upstream) and first/last seen;
- names are cleaned (bidi/invisible/control/markup removed, mixed-script flagged), URLs reduced to an `https` origin and
  path (no credentials, no IP hosts, punycode flagged); logos and free text are never stored;
- slug collisions, a slug claimed by a different id than in the last-good catalog (takeover), confusable names and
  duplicate names are recorded for review and can never inherit an identity;
- malformed rows are kept with exact reasons (`unmapped-chains.json`, `unmapped-protocols.json`).

A parity audit proves that every upstream chain name and protocol row is present in the result.

### Anomaly protection and last-good fallback

`src/defi/universe/anomaly.ts` rejects a sync on silent omission (never overridable), empty sources, a protocol or
chain-catalog drop, mass removal, mass rename, chain identity change or an unmapped spike. A rejected sync leaves the
last-good catalog byte-identical and writes a rejected receipt; a reviewer may accept specific overridable codes with
`--accept-review=CODE`. A machine diff (`diff.generated.json`) and a human diff (`docs/DEFI_UNIVERSE_DIFF.md`) are
written for every accepted sync. Counts are never hard-coded.

Accepted catalog files live in `content/defi-universe/` (one entity per line, strict schema, ≤ 64 MB).

## 2. Coverage truth

Coverage (`src/defi/universe/coverage.ts`) is keyed by protocol + chain + product + adapter version, never a single
"supported" flag. States: `FULL_POSITION`, `PARTIAL_POSITION`, `DISCOVERY_ONLY`, `NOT_CHECKED`, `CATALOG_ONLY`,
`UNSUPPORTED`, `NEEDS_REVIEW`, `DEPRECATED`, `FAILED`. Scan results are separate: `CHECKED_ZERO` ≠ `NOT_CHECKED` ≠
`FAILED` ≠ `CATALOG_ONLY`.

Only reviewed links (`src/defi/universe/adapter-map.ts`, keyed by upstream id **and** slug) connect a catalog entry
to a position adapter. Drift of a reviewed id/slug, a takeover, a fork (`forkedFrom`) or a parent relation never
enables financial logic. Product-family attribution is capped at `PARTIAL_POSITION`. Catalog changes cannot change an
adapter, a deployment or a value.

## 3. Chain capabilities

Independent capabilities per canonical chain (`src/defi/universe/capabilities.ts`): `CATALOG`, `IDENTIFIED`,
`RPC_READ`, `PORTFOLIO_NATIVE`, `PORTFOLIO_FUNGIBLE`, `DEFI_DISCOVERY`, `DEFI_POSITION`, `INDEXED`, `BRIDGE`, `SWAP`,
`UNSUPPORTED_VM`, `DEPRECATED`, `NEEDS_REVIEW`. Product capabilities are derived from reviewed registries (vetted RPC
endpoints, verified Multicall3, reviewed deployments, routing support), never from a name match.

## 4. Reviewed position families (V1.14)

| Family | Products | Accounting | Coverage notes |
| --- | --- | --- | --- |
| Aave V3 (adapter 1.1.0) | Aave V3 on 17 chains, SparkLend Ethereum/Gnosis | protocol account + reserve views; health factor | unreviewed reserve: checked zero when empty, partial when nonzero |
| Compound III | all reviewed Comet markets | base supply/borrow, collateral, liquidation state | |
| Morpho Blue (1.1.0) | markets | shares → assets with accrual; oracle reviewed only through the official factory | discovery from a complete local registry lane (Ethereum) or the wallet index |
| MetaMorpho V1.1 / ERC4626 | factory vaults, curated vaults (sDAI, sfrxETH, pufETH) | `convertToAssets`, nested vaults with cycle guard (depth 3) | V1.0 factory not pinned |
| Lido (1.1.0) | stETH, wstETH, withdrawal queue | wstETH via `getStETHByWstETH`; finalized queue ETH via `getClaimableEther` with checkpoint hints | pending requests listed, valued only after finalization; no claim path |
| Liquid staking / LRT (1.1.0) | rETH, cbETH, wBETH, swETH, weETH, mETH, ETHx, rsETH, osETH | protocol conversion view or protocol-reported rate (flagged), never 1:1 | |
| EigenLayer (1.1.0) | reviewed strategies | slashing-aware withdrawable shares → `sharesToUnderlyingView` | unreviewed strategies, native restaking and queued withdrawals partial |
| Uniswap V2 family (1.1.0) | Uniswap V2, SushiSwap, PancakeSwap V2 | protocol-fee mint (`_mintFee`, ×5 / ×3) then burn share of token balances | receipt-triggered for held pairs; complete only with an index |
| Uniswap V3 family (1.1.0) | Uniswap V3, PancakeSwap V3 | liquidity amounts + exact uncollected fees (fee growth inside, 0.7 wrapping) | PancakeSwap MasterChef stakes not enumerated |
| Curve (1.1.0) | MetaRegistry pools, gauges | proportional share of registry balances, one metapool level | CRV accrual not a view: rewards not checked |
| Balancer V2 (1.1.0) | WeightedPool factory V4 | exact `exitExactBPTInForTokensOut` with `getActualSupply` | staked BPT not checked |
| Aerodrome / Velodrome (1.1.0) | basic pools + gauges | burn share of token balances; gauge `earned` | unstaked LP fees not included |

Uncollected fees and claimable rewards are shown beside the known net, never inside it. A derivatives notional is
never an asset value. An economic asset that is itself a reviewed receipt/vault/staking token of another protocol is
flagged `UNDERLYING_NOT_DECOMPOSED` and shown as that wrapper (exposure graph v2, `src/defi/valuation.ts`).
Leverage is shown only when both sides are fully priced and equity is positive.

Every reviewed deployment address is a literal in a pinned, hash-checked official source file
(`src/defi/sources/manifest.json`) or an explicit on-chain derivation recorded as `ONCHAIN_DERIVED`.

## 5. Candidate-driven discovery (no brute force)

`src/defi/scanner.ts` orders reviewed deployments by evidence: exact held receipt tokens (reverse contract index
`src/defi/reverse-index.ts`, exact chain + contract → protocol/product/version/role), account-level lookups, then
explicit deployments. Receipt families (Curve, Balancer, Aerodrome/Velodrome) run only behind exact held tokens whose
identity is proven on-chain; without a candidate they are `NOT_CHECKED` (`NO_RECEIPT_CANDIDATE`), never zero.

Registry-complete Morpho discovery reduces every market (1,814) or vault (382) to the wallet's nonzero entries with
exact view capabilities sent as inner calls of one pinned Multicall3 `aggregate3` per 250 references (Multicall3 code
hash verified at the pinned block; the RPC policy accepts an inner call only when target + calldata equal a
server-built capability). A failed inner read keeps discovery incomplete.

Every scan returns a receipt: catalog version, chains considered/checked, funnel (catalog rows → chain-relevant rows
→ candidate deployments → adapters run), signals, skipped/failed/checked-zero/nonzero counts, positions, unpriced
counts, RPC calls and the slowest adapter. Opt-in snapshots store the receipt with the scan run (pseudonymous).

## 6. Resumable, reorg-safe registry lanes

`src/defi/lanes.ts` backfills factory/registry events per deployment lane from the official deployment block with
`indexedFrom`, `indexedThrough`, canonical window hashes and `historicalComplete`. Every window is hash-checked before
and after the read, every log's block hash must be canonical, removed logs are rejected, gaps fail atomically and a
reorg rolls back to the newest canonical window. Only registry identities are stored (no raw chain archive). The
operator log source is an exact HTTPS host allowlist with read-only methods.

## 7. Storage and API

Migration `0005_defi_universe.sql` (forward-only) adds catalog syncs, source revisions, chains, aliases, protocols,
protocol-chain rows, coverage, adapter queue, deployment candidates, the reverse contract index, lanes, lane windows,
registry entries and scan receipts. `pnpm defi:universe:load` loads an accepted catalog transactionally and
idempotently; identity rows are upserted and never deleted.

Data API (scope `chains:read`): `GET /v1/defi/catalog/protocols`, `/v1/defi/catalog/protocols/:id`,
`/v1/defi/catalog/chains`, `/v1/defi/catalog/categories`, `/v1/defi/catalog/coverage` — paginated, searchable,
filterable, served from the accepted catalog (no upstream proxy). App route `POST /api/defi/catalog` powers the
"Explore DeFi coverage" explorer (lazy chunk, windowed list, protocol detail with TVL context visually separated).

## 8. Adapter queue and reports

`pnpm defi:universe:report` writes `docs/DEFI_GLOBAL_ADAPTER_QUEUE.md` (+ JSON), `docs/DEFI_GLOBAL_COVERAGE.md`,
`docs/DEFI_GLOBAL_CHAINS.md` and `docs/DEFI_SOURCE_LICENSE_INVENTORY.md` from the accepted catalog.

## 9. Known limits

Non-EVM DeFi positions are not checked (catalog only). Morpho registry lanes are complete on Ethereum only. MetaMorpho
V1.0, Compound V2 forks, Euler, Venus, Fluid, Silo, Radiant, CDPs, perps, farms and structured yield remain cataloged
with honest non-FULL states (see the adapter queue). Source licences are `LEGAL_REVIEW_REQUIRED`; no legal approval is
claimed.
