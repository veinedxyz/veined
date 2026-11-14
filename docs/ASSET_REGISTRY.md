# Unified asset registry (V1.11)

One registry for Bridge, Swap, Portfolio and Activity. Code: `src/assets/model.ts` (pure rules),
`src/assets/registry.ts` (server: list/search/preview), `src/assets/client.ts` (browser helper for lazy pickers),
`src/app/api/assets/route.ts` (read-only API), data `src/assets/registry.generated.json` (built by
`pnpm assets:build` from committed source snapshots).

## Identity

`network + exact contract address` (EVM lowercase); a native asset has the explicit native identity
`<chain>:native`. **A symbol is never an identity**: nothing is matched, merged, auto-selected or given a logo by
symbol. ONEbridge pairs are exact token addresses confirmed on-chain (see below).

## Levels

| Level | Meaning | Count in registry (2026-10-06) |
| --- | --- | --- |
| `CANONICAL` | network native asset, or a ONEbridge registered pair token verified on-chain | 75 |
| `CURATED` | Trust Wallet curated tokenlist **and** the routing provider list agree on exact chain + contract + decimals; no text-risk flag; no symbol collision | 340 |
| `MARKET_LISTED` | exact platform + contract listed on CoinGecko. **Not** a safety claim | 2 in the registry (+ route tokens with an exact CoinGecko listing returned by search; 7,673 exact listings on 59 chains in the snapshot) |
| `DEX_DISCOVERED` | exact chain + token with a DEXScreener pair (runtime, exact-address search only). **Not** verified/safe | runtime only |
| `IMPORTED_UNVERIFIED` | an exact address the user imported on this device | per device |
| `BLOCKED` | invisible/bidi characters, mixed-script look-alike symbol, policy | runtime |

Total **417** assets on **72** networks; **414** with a sanitized local logo (99.3 %). Excluded at build time
(still reachable by exact address search / import): `SYMBOL_COLLISION_WITHOUT_MARKET_EVIDENCE` (1),
`TEXT_RISK_WITHOUT_MARKET_EVIDENCE` (1).

Risk flags (`RiskFlag`): `SYMBOL_IMPERSONATION` (same symbol as a canonical/curated token with another contract),
`BIDI_OR_INVISIBLE`, `MIXED_SCRIPT`, `LONG_TEXT`, `URL_IN_TEXT`, `NO_CODE`, `METADATA_MISMATCH`,
`NO_MARKET_EVIDENCE`, `LOW_LIQUIDITY` (< $10k DEX liquidity), `TESTNET`, `SPAM_LISTED`.

Rules: `autoSelectable` = CANONICAL/CURATED with no risk; `routeEligible` = not BLOCKED **and** route-supported.
Imported or DEX tokens never route without route support; nothing is ever auto-selected by symbol.

## Metadata and logo priority

Metadata: canonical protocol/route metadata → Otherbridge curated → Trust Wallet exact contract → CoinGecko exact
platform + contract → DEXScreener exact chain + token → on-chain `name/symbol/decimals` → deterministic fallback.
Decimals must agree between Trust Wallet and the route list for CURATED.

Logos: canonical local → Trust Wallet exact contract (path derived from the checksummed address, never the list's
URL) → CoinGecko exact contract → DEXScreener exact contract → monogram. All copies are sanitized server-side (see
`CHAIN_IDENTITY_COVERAGE.md`); import-time logos are content-addressed in memory and served by
`/api/asset-image/<sha256>` with `nosniff`, `CSP: default-src 'none'; sandbox` and `CORP: same-origin`.

No CoinMarketCap dependency. CoinGecko is used **keyless** (public `asset_platforms` + `coins/list?include_platform`
snapshot); an optional `COINGECKO_API_KEY` (sync-time only, sent as the demo/pro key header; `COINGECKO_API_PLAN=pro`
selects `pro-api`) raises rate limits but is never required. The 2026-10-06 snapshot was taken without a key. DEXScreener: `tokens/v1/{chain}/{address}` with a
5-minute cache and a 60 requests/minute budget; listings, boosts and profiles are never treated as safety.

## ONEbridge pairs and route capabilities

`pnpm assets:sync:onebridge` (`scripts/assets/onebridge.ts`): candidates from the ONEbridge pairs API are only
**candidates**; each pair is confirmed by `getTokenPair` on both chains, each via two independent sources, at
pinned blocks (ONE head−3 with equal hashes on both official endpoints; BSC common finalized pin). Normalized fields:
local/remote token, `isOrigin`, `paused`/`finalizePaused`, decimals, route, pending/deposited/minted, reserve
semantics, runtime pins. Result (`src/assets/onebridge-pairs.generated.json`, ONE block 45,806,950 / BSC block
126,041,816):

| Pair | Status |
| --- | --- |
| ONE (native) → CROSS `0x6bf6…a510` | `VERIFIED_ROUTE` (G5 verified) |
| USDTx `0x1c37…a85c` → BSC USDT `0x55d3…7955` | `REGISTERED_NOT_VERIFIED` — selectable for information, "No verified route", never quoted or sent |

Generic routes: the routing provider's per-chain token list is the route capability (`asset_route_capabilities`
in the database model; `routeStatus` = `ROUTABLE | NO_VERIFIED_ROUTE | UNKNOWN` in the API). In local-test mode the
API is hermetic (no route list, every status `UNKNOWN`, no lookups).

## Pickers

- **Swap/Bridge token picker** (`token-picker.tsx`): wallet-held routable → native + canonical/curated → market
  listed → recent/imported → search results (DEX-discovered exact address) → explicit address import. The default
  list is never a raw provider dump. Symbol search: registry first, then route tokens with an exact market listing
  (impersonation flagged); unlisted route tokens are reachable **only by exact address**. Rows: logo, symbol, name,
  network, balance, USD, level badge, risk badge, "No verified route" for unroutable rows (not selectable).
- **ONEbridge asset picker** (`bridge-asset-picker.tsx`): only the confirmed pairs; native ONE first.

## Database model

Migration `src/data/store/migrations/0003_asset_registry.sql` (forward-only, checksummed, non-destructive guard):
`chain_identities`, `chain_image_sources`, `asset_identities`, `asset_contracts`, `asset_metadata_sources`,
`asset_market_sources`, `asset_images`, `asset_risk_flags`, `asset_route_capabilities`, `asset_registry_sync_runs`
with CHECK constraints (levels, environments, lowercase addresses, 64-hex hashes). Least privilege
(`grants.sql`): indexer SELECT/INSERT/UPDATE; api SELECT (not `chain_image_sources` / sync runs); monitor sees only
sync-run job/status columns. `pnpm test:db` applies it on a real PostgreSQL (16/16 pass).

## Sync jobs

`assets:sync:chains`, `assets:sync:trustwallet`, `assets:sync:routing`, `assets:sync:coingecko`,
`assets:sync:dexscreener`, `assets:sync:onebridge`, `assets:build`, `assets:verify` (re-sanitizes every image,
hashes, duplicates, orphaned images, unsafe paths, curated-with-risk), `assets:coverage`, `assets:sync:all`.
