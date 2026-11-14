# V1.13 DeFi coverage matrix

91 configured official deployment candidates on 22 chains; 8 adapter families. These counts do not claim all deployments are live checked. Seven-chain public-EOA read-only probe: 55 rows, {"FULL_POSITION":29,"NOT_CHECKED":19,"PARTIAL_POSITION":7}, zero nonzero positions. Positive accounting evidence is synthetic, not a live fork. No protocol is inferred from a token symbol. Exact per-deployment addresses/revisions, block hashes, observed code, state/result and reasons are in evidence/otherbridge-v1-13/v113-20261008T045550888Z-9679b9/registry/coverage-matrix.json.

| Adapter | Candidates | Chain IDs | This live probe | Tests |
|---|---:|---|---|---|
| aave-v3 | 17 | 42161, 43114, 56, 8453, 42220, 1, 100, 59144, 5000, 1088, 10, 9745, 137, 534352, 1868, 146, 324 | 7 FULL / 0 PARTIAL / 0 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| compound-iii | 22 | 42161, 8453, 1, 10, 137, 130 | 20 FULL / 0 PARTIAL / 0 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| uniswap-v3 | 9 | 1, 10, 137, 42161, 42220, 43114, 56, 59144, 8453 | 0 FULL / 7 PARTIAL / 0 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| uniswap-v2 | 9 | 1, 10, 137, 42161, 42220, 43114, 56, 59144, 8453 | 0 FULL / 0 PARTIAL / 7 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| erc4626 | 1 | 1 | 1 FULL / 0 PARTIAL / 0 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| morpho-blue | 16 | 1, 8453, 137, 42161, 10, 480, 252, 534352, 57073, 130, 146, 34443, 59144, 56, 42220, 1868 | 0 FULL / 0 PARTIAL / 6 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| morpho-vault | 16 | 1, 8453, 137, 42161, 10, 480, 252, 534352, 57073, 130, 146, 34443, 59144, 56, 42220, 1868 | 0 FULL / 0 PARTIAL / 6 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |
| lido | 1 | 1 | 1 FULL / 0 PARTIAL / 0 unchecked | fixture positive, zero, malformed, RPC failure, stale, identity, price, unsupported |

Accounting, debt/risk, reward semantics and discovery limits: [DEFI_PROTOCOL_COVERAGE](DEFI_PROTOCOL_COVERAGE.md). Official-source content/revisions/hash inventory: [DEFI_SOURCE_INVENTORY](DEFI_SOURCE_INVENTORY.md).

Morpho Blue/Vault V1 and V2 LP discovery needs reviewed self-hosted historical event backfill; its completion is not guessed. V3 enumerates current official manager ownership, with max100 NFTs; indexed ERC721 state is reorg safe, but full uncheckpointed fees remain unchecked. Morpho production oracle allowlist is empty: LTV is unavailable unless exact oracle semantics are separately reviewed. Lido queue and direct validator holdings are unchecked. Non-EVM DeFi is NOT_CHECKED.

Curve, Balancer, Aerodrome/Velodrome, Rocket Pool, direct restaking, Spark/Sky lending, Yearn/Beefy, Aave V4, Uniswap V4 and Morpho Vault V2 are deferred. Existing fungible wallet balances remain available; no position support is fabricated. Curated sDAI is the explicitly reviewed ERC4626 exception, not generic Sky lending support.
