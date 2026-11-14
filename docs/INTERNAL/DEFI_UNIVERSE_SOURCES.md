# DeFi universe upstream sources (internal, legal review only)

This internal note names the upstream catalog providers used by `pnpm defi:universe:sync`. Public documents refer to
them neutrally. Licence state for every source below is **LEGAL_REVIEW_REQUIRED**; no legal approval is claimed.

## Catalog API (JSON only; website HTML is never scraped)

| Source id | URL | Use |
| --- | --- | --- |
| defillama-protocols | `https://api.llama.fi/protocols` | protocol identity, category, chains, TVL context |
| defillama-chains | `https://api.llama.fi/v2/chains` | chain list, chain ids, TVL context |
| defillama-config | `https://api.llama.fi/config` (gzip, bounded) | chain configuration, key-to-label map, parent protocols |

Accepted sync at delivery: `u20261011T044714Z-d1c35a` (2026-10-11T04:47:19Z). Raw responses and SHA-256 values are in
`content/defi-universe/sources.json`, `content/defi-universe/sync-receipt.json` and the V1.14 evidence directory
(`sources/<syncId>/`).

## Pinned repositories (revision pinned through the GitHub API; text/AST only, never executed)

| Repository | Use |
| --- | --- |
| DefiLlama/chainlist | `constants/chainIds.js` parsed as text for chain-id fill (exact single key only) |
| DefiLlama/DefiLlama-Adapters | reference only (adapter module names); code is never run |
| DefiLlama/dimension-adapters | reference only |
| DefiLlama/icons | reference only; logos are never stored or served |

## Reviewed deployment sources

Official protocol repositories and documentation files pinned by revision and SHA-256 are listed in
`src/defi/sources/manifest.json` and summarised in `docs/DEFI_SOURCE_LICENSE_INVENTORY.md`.
