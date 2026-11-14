# Data

Portfolio and coverage data come from {{BRAND}}'s own data plane, not from a paid portfolio API.

## Self-hosted data plane

- **Vetted RPC registry**: every endpoint is admitted only after URL policy, public-DNS, chain-ID and read-only probes, and carries an operator group, provenance and review status. Two endpoints of the same operator never count as independent.
- **Own index**: on selected networks {{BRAND}} indexes ERC-20 transfers to discover token candidates; windows are witnessed by an independent source before they are trusted.
- **Datastore**: PostgreSQL with forward-only, checksum-pinned migrations and least-privilege roles. When it is unavailable, the app falls back to the committed registry and says so ("degraded").
- **Asset registry**: chain identities, asset identities and contracts, metadata and market sources, sanitized images, risk flags and route capabilities, synced by `assets:sync` jobs.

## Indexer

The indexer reads logs in bounded windows below each chain's finality depth, reconciles reorgs, and pauses (never guesses) when sources disagree.

## Coverage tiers

| Tier | Source of truth |
| --- | --- |
| Full index | Own index for candidates, live `balanceOf` for balances |
| Known tokens | Token universe from the routing provider and datastore, live `balanceOf` |
| Curated balance scan | Curated registry contracts, live `balanceOf` through a verified Multicall3 |
| Native only | Native balance only |
| Catalog only | Listed, not checked |

## Privacy

- Your wallet address goes to the vetted RPC endpoints of the networks being scanned (that is how a balance is read) and, for an explicit token lookup, to no one else: market and DEX lookups use the token contract, not your address.
- Wallet addresses are pseudonymized (keyed hash) before anything is stored, and never appear in logs as plain text or in metric labels.
- Portfolio data is never sent to the wallet-connection provider.
- There are no third-party analytics in the app.

## Sources and attribution

Registry facts record their source; a listing or logo is evidence, never a safety claim.

- **Routing provider token lists**: route-supported tokens per network (route capability).
- **Trust Wallet assets** (open repository): curated token lists and token/network logos, copied at exact contract paths and sanitized.
- **CoinGecko** (public API, no key required): exact platform + contract market listings and some network logos.
- **DEXScreener**: DEX pair evidence for an exact network + token, only for explicit lookups.
- **ethereum-lists**: network names, native symbols, explorers and testnet flags by exact chain ID.
- **On-chain reads**: contract code, ERC-20 metadata and balances through the vetted RPC registry.

Logos and marks belong to their owners. Terms and attribution for each source are tracked in the repository and are subject to legal review.
