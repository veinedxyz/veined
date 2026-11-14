# Networks

{{BRAND}} keeps one canonical chain identity per network: internal ID, chain ID, official and short name, environment, ecosystem, native symbol, explorer and logo with its provenance.

## Mainnet and testnet

Every network has an environment: **mainnet**, **testnet**, **devnet**, **local** or **unknown**. The catalog lists {{MAINNETS}} mainnets and {{TESTNETS}} testnets today.

- The network selector opens on **Mainnets**; **Testnets** is a separate section with a testnet badge on every row.
- Search stays inside the active section unless you turn on **Search all networks**.
- A route never combines mainnet and testnet networks, and testnet assets never count toward portfolio value.
- When no source can decide a network's environment it is **unknown** — never assumed to be mainnet.

## Catalog

The catalog combines the routing provider's network list, the custom ONEbridge network and an active network catalog (networks with locked value). A listed network does not guarantee a route or full portfolio coverage: each network shows what works there — Bridge and Swap quotes, portfolio coverage and wallet support.

## Logos

Logos follow a fixed priority, matched by exact chain ID only (never by name):

1. a verified local asset (reviewed earlier, e.g. the official ONEchain and BNB Chain marks);
2. the chain's official asset;
3. the exact Trust Wallet chain asset;
4. another approved curated source (CoinGecko asset platform or the catalog's own CoinGecko ID);
5. a generated {{BRAND}} monogram.

External images are downloaded only by the sync job on the server, through an HTTPS host allowlist with public-DNS checks, size limits and full PNG decoding; they are re-encoded without metadata and served from {{BRAND}}'s own domain. {{CHAIN_LOGOS}} of {{CHAINS}} networks have a real logo today; the rest use the monogram — the coverage report never pretends otherwise.
