# Asset and logo provenance, terms and licenses (V1.11)

Every registry fact records where it came from (`sources`, `logoProvenance`, source SHA-256). Raw upstream
snapshots of the 2026-10-06 sync are kept in `evidence/otherbridge-v1-11/<run>/asset-sync/raw/` with request
metadata. Listings, logos and symbols are **evidence, never safety**: "listed on X" never means safe, audited or
verified.

## Sources used

| Source | What is used | How | Snapshot |
| --- | --- | --- | --- |
| Routing provider token lists (`li.quest`) | per-chain route-supported tokens (route capability) | read-only GET, fixed host | 19,472 tokens on 70 chains (`src/assets/sources/routing.generated.json`) |
| Trust Wallet assets repository | per-chain curated `tokenlist.json`; chain and token `logo.png` at exact checksummed paths | `raw.githubusercontent.com/trustwallet/assets/master/…`; chain mapping via wallet-core `registry.json` chain ids | 459 tokens on 11 chains; 343 token logos, 18 chain logos |
| CoinGecko public API | `asset_platforms` (chain id ↔ platform) and `coins/list?include_platform=true` (exact platform + contract); coin images for chain logos by exact coin/platform id | keyless; optional key at sync time only | 7,673 exact listings on 59 chains; 209 chain logos |
| DEXScreener | `tokens/v1/{chainSlug}/{address}`: pairs, liquidity, price, symbol for an EXACT chain + token | runtime import preview / exact-address search, 5-min cache, 60/min budget; 7 bounded requests during sync | evidence only |
| ethereum-lists (`chainid.network`) | chain names, native symbols, explorers, testnet flags by exact chain id | read-only GET | `asset-sync/chains-sources.json` |
| ONEbridge pairs API (`bridge-api.crosstoken.io`) | pair **candidates** only | every pair re-verified on-chain on both chains via two sources each | 2 candidates, 2 confirmed |
| Existing repository logos | previously reviewed local network logos (`public/networks/…`) | hash-pinned | 75 chain logos |
| On-chain | `eth_getCode`, ERC-20 `name/symbol/decimals`, `balanceOf` | vetted data-plane RPC pool only | — |

Not used: CoinMarketCap, Google image search, scraping, arbitrary remote image URLs in the browser.

## Terms / license inventory (technical use; **LEGAL_REVIEW_REQUIRED** — no legal conclusion is made here)

| Item | Technical use in Otherbridge | License / terms (as published by the source) | Attribution in product | Status |
| --- | --- | --- | --- | --- |
| Trust Wallet assets (`trustwallet/assets`) | tokenlists as one curated input; sanitized 64 px PNG logo copies served same-origin | repository license file and contribution terms; logos are third-party brand marks | provenance recorded per logo; docs "Data" page credits sources | LEGAL_REVIEW_REQUIRED (redistribution of third-party marks) |
| CoinGecko API | exact contract listing evidence; chain logo images (sync time) | CoinGecko API terms (attribution requirements for the public/demo API) | docs credit; listing shown as "Market listed" with source | LEGAL_REVIEW_REQUIRED (attribution form, image reuse, commercial plan) |
| DEXScreener API | DEX evidence for exact chain + token; DEX token image only through server-side sanitization | DEXScreener API terms of use and rate limits | evidence labelled "DEX discovered"/"DEX liquidity" | LEGAL_REVIEW_REQUIRED |
| Chain logo sources (official assets, Trust Wallet chain logos, CoinGecko platform images, repository logos) | identity marks for networks | each owner's brand/trademark terms | logo provenance kept in the registry | LEGAL_REVIEW_REQUIRED (trademark use) |
| ethereum-lists `chains` | chain metadata | repository license | provenance in sync evidence | LEGAL_REVIEW_REQUIRED |
| Privy | connect-only external wallet modal (no embedded wallet, no portfolio data) | Privy terms of service / DPA | Privy branding inside its modal | LEGAL_REVIEW_REQUIRED |
| WalletConnect / Reown | wallet connection transport used through the Privy layer | Reown terms; project id terms | none beyond the modal | LEGAL_REVIEW_REQUIRED |
| Public RPC endpoints (BNB Chain, PublicNode, OnFinality, NodeReal public key) | read-only reads; G7 pin sources | each provider's terms / fair use | none | LEGAL_REVIEW_REQUIRED (OnFinality newly added) |

## Privacy (where data goes)

See `PORTFOLIO_DISCOVERY_COVERAGE.md` → *Privacy*. Asset registry requests (`/api/assets`) carry only a chain id
and a query or an exact token address — never a wallet address. Logo images are fetched only by the server.
