# DeFi global coverage

Catalog `u20261011T044714Z-d1c35a` (generated 2026-10-11T04:47:17.935Z, sha256 `eee4b2cc3163bd472ea2c13b1c9ff6ed1009b2a046b2f593d9efae84a64a9cab`).
Coverage is keyed by protocol + chain + product/version + adapter version. Catalog breadth is universal; accounting support is reviewed per deployment. A cataloged protocol without an adapter is CATALOG_ONLY — never a checked zero.

## Universe

| Metric | Value |
| --- | ---: |
| chainsSeen | 659 |
| chainsMapped | 487 |
| chainsUnmapped | 172 |
| chainCatalogRows | 468 |
| canonicalChains | 613 |
| protocolsSeen | 8694 |
| protocolsMapped | 8693 |
| protocolsUnmapped | 1 |
| activeProtocols | 7813 |
| deprecatedProtocols | 881 |
| removedUpstreamProtocols | 1 |
| categoriesSeen | 102 |
| protocolChainRows | 14966 |

## Protocol headline coverage (best per-chain state; every cataloged protocol counted once)

| State | Protocols |
| --- | ---: |
| UNSUPPORTED | 1216 |
| PARTIAL_POSITION | 14 |
| CATALOG_ONLY | 6569 |
| DEPRECATED | 881 |
| FULL_POSITION | 13 |
| NEEDS_REVIEW | 2 |

## Protocol-chain coverage rows

| State | Rows |
| --- | ---: |
| UNSUPPORTED | 2753 |
| PARTIAL_POSITION | 71 |
| NOT_CHECKED | 204 |
| CATALOG_ONLY | 12040 |
| DEPRECATED | 1344 |
| FULL_POSITION | 43 |
| NEEDS_REVIEW | 6 |

TVL-weighted (DefiLlama protocol-chain TVL context, active protocols, $590.65B): FULL 10.49%, PARTIAL 4.71%. This is never a wallet value.

## Reviewed adapter rows

| Protocol | Chain | Product | Adapter | State | Reason | Deployments |
| --- | --- | --- | --- | --- | --- | --- |
| Curve DEX | Arbitrum | Curve pools and gauges | 1.1.0 | PARTIAL_POSITION | CURVE_REWARDS_NOT_EXACT | curve-42161 |
| Curve DEX | Arc | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Aurora | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Avalanche | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Base | Curve pools and gauges | 1.1.0 | PARTIAL_POSITION | CURVE_REWARDS_NOT_EXACT | curve-8453 |
| Curve DEX | BSC | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Celo | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Corn | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Ethereum | Curve pools and gauges | 1.1.0 | PARTIAL_POSITION | CURVE_REWARDS_NOT_EXACT | curve-1 |
| Curve DEX | Etherlink | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Fantom | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Fraxtal | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Gnosis | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Harmony | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Hyperliquid L1 | Curve pools and gauges | 1.1.0 | NOT_CHECKED | CHAIN_ID_UNKNOWN | — |
| Curve DEX | Ink | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Kava | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Mantle | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Monad | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Moonbeam | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | OP Mainnet | Curve pools and gauges | 1.1.0 | PARTIAL_POSITION | CURVE_REWARDS_NOT_EXACT | curve-10 |
| Curve DEX | Plasma | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Plume Mainnet | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Polygon | Curve pools and gauges | 1.1.0 | PARTIAL_POSITION | CURVE_REWARDS_NOT_EXACT | curve-137 |
| Curve DEX | Robinhood Chain | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Sonic | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Stable | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | TAC | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Taiko | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | Unichain | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | X Layer | Curve pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Curve DEX | XDC | Curve pools and gauges | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| SushiSwap | Arbitrum | SushiSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | sushiswap-v2-42161 |
| SushiSwap | Arbitrum Nova | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Arc | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Avalanche | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Base | SushiSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | sushiswap-v2-8453 |
| SushiSwap | Bittorrent | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Blast | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Boba | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Boba\_Bnb | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | BSC | SushiSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | sushiswap-v2-56 |
| SushiSwap | Celo | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | CORE | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Ethereum | SushiSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | sushiswap-v2-1 |
| SushiSwap | Fantom | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Filecoin | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Fuse | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Gnosis | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | HAQQ | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Harmony | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Heco | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Hemi | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Katana | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Kava | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Linea | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Metis | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Moonbeam | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Moonriver | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | OKTChain | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | OP Mainnet | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Palm | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Polygon | SushiSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | sushiswap-v2-137 |
| SushiSwap | Polygon zkEVM | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Rootstock | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Scroll | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | SKALE Europa | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | CHAIN_ID_UNKNOWN | — |
| SushiSwap | Sonic | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | Telos | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | ThunderCore | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| SushiSwap | ZetaChain | SushiSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Lido | Ethereum | Lido stETH / wstETH | 1.1.0 | FULL_POSITION | EXACT_SHARE_CONVERSION_AND_WITHDRAWAL_QUEUE | lido-1 |
| Lido | Moonbeam | Lido stETH / wstETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Lido | Moonriver | Lido stETH / wstETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Lido | Solana | Lido stETH / wstETH | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Lido | Terra Classic | Lido stETH / wstETH | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| PancakeSwap AMM | Aptos | PancakeSwap V2 pairs | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| PancakeSwap AMM | Arbitrum | PancakeSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | pancakeswap-v2-42161 |
| PancakeSwap AMM | Base | PancakeSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | pancakeswap-v2-8453 |
| PancakeSwap AMM | BSC | PancakeSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | pancakeswap-v2-56 |
| PancakeSwap AMM | Ethereum | PancakeSwap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | pancakeswap-v2-1 |
| PancakeSwap AMM | Linea | PancakeSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM | Monad | PancakeSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM | opBNB | PancakeSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM | Polygon zkEVM | PancakeSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM | Robinhood Chain | PancakeSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM | ZKsync Era | PancakeSwap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| StakeWise V3 | Ethereum | StakeWise osETH | 1.1.0 | PARTIAL_POSITION | OSETH_ONLY_VAULT_STAKES_NOT_READ | lst-oseth-1 |
| StakeWise V3 | Gnosis | StakeWise osETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Rocket Pool | Ethereum | Rocket Pool rETH | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-reth-1 |
| Stader | BSC | Stader ETHx | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Stader | Ethereum | Stader ETHx | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-ethx-1 |
| Stader | Fantom | Stader ETHx | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Stader | Hedera | Stader ETHx | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Stader | Near | Stader ETHx | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Stader | Terra2 | Stader ETHx | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Aave V3 | Arbitrum | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-42161 |
| Aave V3 | Avalanche | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-43114 |
| Aave V3 | Base | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-8453 |
| Aave V3 | BSC | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-56 |
| Aave V3 | Celo | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-42220 |
| Aave V3 | Ethereum | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-1 |
| Aave V3 | Fantom | Aave V3 Pool | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Aave V3 | Gnosis | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-100 |
| Aave V3 | Linea | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-59144 |
| Aave V3 | Mantle | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-5000 |
| Aave V3 | MegaETH | Aave V3 Pool | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Aave V3 | Metis | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-1088 |
| Aave V3 | Monad | Aave V3 Pool | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Aave V3 | OP Mainnet | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-10 |
| Aave V3 | Plasma | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-9745 |
| Aave V3 | Polygon | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-137 |
| Aave V3 | Scroll | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-534352 |
| Aave V3 | Soneium | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-1868 |
| Aave V3 | Sonic | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-146 |
| Aave V3 | X Layer | Aave V3 Pool | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Aave V3 | ZKsync Era | Aave V3 Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | aave-v3-324 |
| Compound V3 | Arbitrum | Compound III Comet | 1.0.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | compound-42161-usdc, compound-42161-usdc-e, compound-42161-usdt, compound-42161-weth |
| Compound V3 | Base | Compound III Comet | 1.0.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | compound-8453-aero, compound-8453-usdbc, compound-8453-usdc, compound-8453-usds, compound-8453-weth |
| Compound V3 | Ethereum | Compound III Comet | 1.0.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | compound-1-usdc, compound-1-usds, compound-1-usdt, compound-1-wbtc, compound-1-weth, compound-1-wsteth |
| Compound V3 | Linea | Compound III Comet | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Compound V3 | Mantle | Compound III Comet | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Compound V3 | OP Mainnet | Compound III Comet | 1.0.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | compound-10-usdc, compound-10-usdt, compound-10-weth |
| Compound V3 | Polygon | Compound III Comet | 1.0.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | compound-137-usdc, compound-137-usdt |
| Compound V3 | Ronin | Compound III Comet | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Compound V3 | Scroll | Compound III Comet | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Compound V3 | Unichain | Compound III Comet | 1.0.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | compound-130-usdc, compound-130-weth |
| Uniswap V2 | Arbitrum | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-42161 |
| Uniswap V2 | Arc | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | Avalanche | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-43114 |
| Uniswap V2 | Base | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-8453 |
| Uniswap V2 | BSC | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-56 |
| Uniswap V2 | Celo | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-42220 |
| Uniswap V2 | Ethereum | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-1 |
| Uniswap V2 | Ink | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | Monad | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | OP Mainnet | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-10 |
| Uniswap V2 | Polygon | Uniswap V2 pairs | 1.1.0 | PARTIAL_POSITION | PAIR_DISCOVERY_INDEX_OR_HELD_LP | uniswap-v2-137 |
| Uniswap V2 | Robinhood Chain | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | Tempo | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | Unichain | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | X Layer | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V2 | Zora | Uniswap V2 pairs | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | 0G | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Arbitrum | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-42161 |
| Uniswap V3 | Arc | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Avalanche | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-43114 |
| Uniswap V3 | Base | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-8453 |
| Uniswap V3 | Blast | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | BOB | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Boba | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | BSC | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-56 |
| Uniswap V3 | Celo | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-42220 |
| Uniswap V3 | Ethereum | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-1 |
| Uniswap V3 | Etherlink | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Filecoin | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Gnosis | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | GOAT | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Hemi | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Ink | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Lens | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | LightLink | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Linea | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-59144 |
| Uniswap V3 | Lisk | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Manta | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Mantle | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | MegaETH | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Monad | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Nibiru | Uniswap V3 positions | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Uniswap V3 | OP Mainnet | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-10 |
| Uniswap V3 | Plasma | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Polygon | Uniswap V3 positions | 1.1.0 | FULL_POSITION | NFT_ENUMERATION_EXACT_PRINCIPAL_AND_FEES | uniswap-v3-137 |
| Uniswap V3 | Redbelly | Uniswap V3 positions | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Uniswap V3 | Robinhood Chain | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Rootstock | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Saga | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Scroll | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Sei | Uniswap V3 positions | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Uniswap V3 | Sonic | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Taiko | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Telos | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Tempo | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | Unichain | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | World Chain | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | X Layer | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Uniswap V3 | XDC | Uniswap V3 positions | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Uniswap V3 | ZKsync Era | Uniswap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Frax Ether | Ethereum | Frax sfrxETH (ERC-4626) | 1.0.0 | PARTIAL_POSITION | SFRXETH_ONLY | erc4626-sfrxeth-1 |
| Frax Ether | Fraxtal | Frax sfrxETH (ERC-4626) | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Balancer V2 | Arbitrum | Balancer V2 weighted pools | 1.1.0 | PARTIAL_POSITION | WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED | balancer-v2-42161 |
| Balancer V2 | Avalanche | Balancer V2 weighted pools | 1.1.0 | PARTIAL_POSITION | WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED | balancer-v2-43114 |
| Balancer V2 | Base | Balancer V2 weighted pools | 1.1.0 | PARTIAL_POSITION | WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED | balancer-v2-8453 |
| Balancer V2 | Ethereum | Balancer V2 weighted pools | 1.1.0 | PARTIAL_POSITION | WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED | balancer-v2-1 |
| Balancer V2 | Fraxtal | Balancer V2 weighted pools | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Balancer V2 | Gnosis | Balancer V2 weighted pools | 1.1.0 | PARTIAL_POSITION | WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED | balancer-v2-100 |
| Balancer V2 | Mode | Balancer V2 weighted pools | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Balancer V2 | Polygon | Balancer V2 weighted pools | 1.1.0 | PARTIAL_POSITION | WEIGHTED_POOLS_ONLY_STAKED_BPT_NOT_CHECKED | balancer-v2-137 |
| Balancer V2 | Polygon zkEVM | Balancer V2 weighted pools | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| ether.fi Stake | Arbitrum | ether.fi weETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| ether.fi Stake | Base | ether.fi weETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| ether.fi Stake | Berachain | ether.fi weETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| ether.fi Stake | Ethereum | ether.fi weETH | 1.1.0 | PARTIAL_POSITION | WEETH_CONVERSION_ONLY | lst-weeth-1 |
| ether.fi Stake | OP Mainnet | ether.fi weETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| ether.fi Stake | Scroll | ether.fi weETH | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM V3 | Arbitrum | PancakeSwap V3 positions | 1.1.0 | PARTIAL_POSITION | STAKED_POSITIONS_NOT_CHECKED | pancakeswap-v3-42161 |
| PancakeSwap AMM V3 | Base | PancakeSwap V3 positions | 1.1.0 | PARTIAL_POSITION | STAKED_POSITIONS_NOT_CHECKED | pancakeswap-v3-8453 |
| PancakeSwap AMM V3 | BSC | PancakeSwap V3 positions | 1.1.0 | PARTIAL_POSITION | STAKED_POSITIONS_NOT_CHECKED | pancakeswap-v3-56 |
| PancakeSwap AMM V3 | Ethereum | PancakeSwap V3 positions | 1.1.0 | PARTIAL_POSITION | STAKED_POSITIONS_NOT_CHECKED | pancakeswap-v3-1 |
| PancakeSwap AMM V3 | Linea | PancakeSwap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM V3 | Monad | PancakeSwap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM V3 | opBNB | PancakeSwap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM V3 | Polygon zkEVM | PancakeSwap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM V3 | Robinhood Chain | PancakeSwap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| PancakeSwap AMM V3 | Solana | PancakeSwap V3 positions | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| PancakeSwap AMM V3 | ZKsync Era | PancakeSwap V3 positions | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Swell Liquid Staking | Ethereum | Swell swETH | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-sweth-1 |
| Binance staked ETH | BSC | Binance wBETH (Ethereum) | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Binance staked ETH | Ethereum | Binance wBETH (Ethereum) | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-wbeth-1 |
| SparkLend | Ethereum | SparkLend Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | sparklend-1 |
| SparkLend | Gnosis | SparkLend Pool | 1.1.0 | FULL_POSITION | ACCOUNT_LEVEL_PROTOCOL_VIEWS | sparklend-100 |
| EigenCloud | Ethereum | EigenLayer restaking | 1.1.0 | PARTIAL_POSITION | LST_STRATEGIES_EXACT_NATIVE_AND_QUEUED_PARTIAL | eigenlayer-1 |
| Velodrome V2 | BOB | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Celo | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Fraxtal | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Ink | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Lisk | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Mode | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | OP Mainnet | Velodrome basic pools and gauges | 1.1.0 | PARTIAL_POSITION | RECEIPT_DISCOVERY_ONLY | velodrome-v2-10 |
| Velodrome V2 | Soneium | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Superseed | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Swellchain | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Velodrome V2 | Unichain | Velodrome basic pools and gauges | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Aerodrome V1 | Base | Aerodrome basic pools and gauges | 1.1.0 | PARTIAL_POSITION | RECEIPT_DISCOVERY_ONLY | aerodrome-v2-8453 |
| Coinbase Wrapped Staked ETH | Ethereum | Coinbase cbETH | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-cbeth-1 |
| mETH Protocol | Ethereum | Mantle mETH | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-meth-1 |
| Kelp | Ethereum | Kelp rsETH | 1.1.0 | FULL_POSITION | EXACT_PROTOCOL_CONVERSION_OR_REPORTED_RATE | lst-rseth-1 |
| Morpho Blue | 0G | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | 0G | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Abstract | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Abstract | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Arbitrum | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-42161 |
| Morpho Blue | Arbitrum | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-42161 |
| Morpho Blue | Arc | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Arc | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Avalanche | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Avalanche | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Base | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-8453 |
| Morpho Blue | Base | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-8453 |
| Morpho Blue | Bitlayer | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Bitlayer | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Botanix | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Botanix | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | BSC | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-56 |
| Morpho Blue | BSC | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-56 |
| Morpho Blue | Celo | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-42220 |
| Morpho Blue | Celo | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-42220 |
| Morpho Blue | Citrea | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Citrea | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Corn | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Corn | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Ethereum | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-1 |
| Morpho Blue | Ethereum | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-1 |
| Morpho Blue | Etherlink | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Etherlink | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Flare | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Flare | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Fraxtal | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-252 |
| Morpho Blue | Fraxtal | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-252 |
| Morpho Blue | Gnosis | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Gnosis | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Hemi | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Hemi | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Hyperliquid L1 | Morpho Blue markets | 1.1.0 | NOT_CHECKED | CHAIN_ID_UNKNOWN | — |
| Morpho Blue | Hyperliquid L1 | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | CHAIN_ID_UNKNOWN | — |
| Morpho Blue | Ink | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-57073 |
| Morpho Blue | Ink | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-57073 |
| Morpho Blue | Kaia | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Kaia | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Katana | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Katana | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Linea | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-59144 |
| Morpho Blue | Linea | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-59144 |
| Morpho Blue | Lisk | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Lisk | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | MegaETH | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | MegaETH | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Mode | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-34443 |
| Morpho Blue | Mode | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-34443 |
| Morpho Blue | Monad | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Monad | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Morph | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Morph | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | OP Mainnet | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-10 |
| Morpho Blue | OP Mainnet | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-10 |
| Morpho Blue | Pharos | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Pharos | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Plume Mainnet | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Plume Mainnet | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Polygon | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-137 |
| Morpho Blue | Polygon | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-137 |
| Morpho Blue | RISE | Morpho Blue markets | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Morpho Blue | RISE | MetaMorpho vaults | 1.0.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Morpho Blue | Robinhood Chain | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Robinhood Chain | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Scroll | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-534352 |
| Morpho Blue | Scroll | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-534352 |
| Morpho Blue | Sei | Morpho Blue markets | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Morpho Blue | Sei | MetaMorpho vaults | 1.0.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Morpho Blue | Soneium | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-1868 |
| Morpho Blue | Soneium | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-1868 |
| Morpho Blue | Sonic | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-146 |
| Morpho Blue | Sonic | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-146 |
| Morpho Blue | Stable | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Stable | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | TAC | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | TAC | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Tempo | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Tempo | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Unichain | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-130 |
| Morpho Blue | Unichain | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-130 |
| Morpho Blue | World Chain | Morpho Blue markets | 1.1.0 | PARTIAL_POSITION | MARKET_DISCOVERY_REQUIRES_LOCAL_INDEX | morpho-blue-480 |
| Morpho Blue | World Chain | MetaMorpho vaults | 1.0.0 | PARTIAL_POSITION | VAULT_DISCOVERY_REQUIRES_FACTORY_INDEX | morpho-vault-480 |
| Morpho Blue | XDC | Morpho Blue markets | 1.1.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Morpho Blue | XDC | MetaMorpho vaults | 1.0.0 | UNSUPPORTED | UNSUPPORTED_VM | — |
| Morpho Blue | Zircuit | Morpho Blue markets | 1.1.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Morpho Blue | Zircuit | MetaMorpho vaults | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Puffer Stake | Ethereum | Puffer pufETH (ERC-4626) | 1.0.0 | FULL_POSITION | ERC4626_CONVERSION | erc4626-pufeth-1 |
| Spark Savings | Arbitrum | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Spark Savings | Avalanche | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Spark Savings | Base | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Spark Savings | Ethereum | Savings DAI (sDAI) ERC-4626 | 1.0.0 | PARTIAL_POSITION | ONLY_REVIEWED_VAULTS_READ | erc4626-sdai-1 |
| Spark Savings | OP Mainnet | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Spark Savings | Robinhood Chain | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Spark Savings | Unichain | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |
| Spark Savings | X Layer | Savings DAI (sDAI) ERC-4626 | 1.0.0 | NOT_CHECKED | NO_REVIEWED_DEPLOYMENT_ON_CHAIN | — |

## Categories

| Raw category | Product category | Protocols | Headline coverage |
| --- | --- | ---: | --- |
| Dexs | dex | 2141 | PARTIAL_POSITION 8, CATALOG_ONLY 1570, DEPRECATED 217, UNSUPPORTED 345, FULL_POSITION 1 |
| Yield | yield | 677 | CATALOG_ONLY 505, DEPRECATED 108, UNSUPPORTED 63, PARTIAL_POSITION 1 |
| Lending | lending | 653 | CATALOG_ONLY 387, DEPRECATED 139, UNSUPPORTED 123, FULL_POSITION 3, PARTIAL_POSITION 1 |
| Derivatives | derivatives | 456 | CATALOG_ONLY 370, DEPRECATED 36, UNSUPPORTED 50 |
| Launchpad | launchpad | 325 | CATALOG_ONLY 282, DEPRECATED 17, UNSUPPORTED 26 |
| Interface | services | 320 | CATALOG_ONLY 318, UNSUPPORTED 2 |
| Liquid Staking | liquid-staking | 298 | CATALOG_ONLY 129, FULL_POSITION 7, PARTIAL_POSITION 3, DEPRECATED 33, UNSUPPORTED 126 |
| Farm | farm | 251 | CATALOG_ONLY 205, DEPRECATED 25, UNSUPPORTED 21 |
| CDP | cdp | 232 | CATALOG_ONLY 158, UNSUPPORTED 40, DEPRECATED 34 |
| Yield Aggregator | yield | 232 | CATALOG_ONLY 166, DEPRECATED 44, UNSUPPORTED 22 |
| DEX Aggregator | dex-aggregator | 197 | CATALOG_ONLY 191, UNSUPPORTED 4, DEPRECATED 2 |
| RWA | rwa | 184 | CATALOG_ONLY 157, DEPRECATED 11, UNSUPPORTED 15, NEEDS_REVIEW 2 |
| Bridge | bridge | 177 | UNSUPPORTED 34, DEPRECATED 20, CATALOG_ONLY 123 |
| Reserve Currency | stablecoin | 138 | CATALOG_ONLY 88, DEPRECATED 48, UNSUPPORTED 2 |
| Prediction Market | prediction | 131 | CATALOG_ONLY 109, DEPRECATED 5, UNSUPPORTED 17 |
| Services | services | 129 | CATALOG_ONLY 109, DEPRECATED 11, UNSUPPORTED 9 |
| Algo-Stables | stablecoin | 124 | CATALOG_ONLY 90, DEPRECATED 28, UNSUPPORTED 6 |
| Canonical Bridge | bridge | 95 | CATALOG_ONLY 87, DEPRECATED 5, UNSUPPORTED 3 |
| Gaming | gaming | 93 | CATALOG_ONLY 75, DEPRECATED 8, UNSUPPORTED 10 |
| Risk Curators | yield | 93 | CATALOG_ONLY 91, UNSUPPORTED 2 |
| Chain | chain | 86 | CATALOG_ONLY 58, UNSUPPORTED 24, DEPRECATED 4 |
| SoFi | services | 86 | DEPRECATED 3, CATALOG_ONLY 73, UNSUPPORTED 10 |
| Onchain Capital Allocator | yield | 85 | CATALOG_ONLY 79, UNSUPPORTED 6 |
| Indexes | yield | 83 | CATALOG_ONLY 61, DEPRECATED 10, UNSUPPORTED 12 |
| CEX | cex | 80 | UNSUPPORTED 80 |
| Staking Pool | liquid-staking | 78 | CATALOG_ONLY 57, UNSUPPORTED 16, DEPRECATED 5 |
| Liquidity Manager | yield | 76 | CATALOG_ONLY 64, DEPRECATED 6, UNSUPPORTED 6 |
| Options | options | 75 | CATALOG_ONLY 67, DEPRECATED 3, UNSUPPORTED 5 |
| NFT Marketplace | nft-finance | 70 | CATALOG_ONLY 57, UNSUPPORTED 9, DEPRECATED 4 |
| Cross Chain Bridge | bridge | 59 | CATALOG_ONLY 55, DEPRECATED 3, UNSUPPORTED 1 |
| Privacy | services | 48 | CATALOG_ONLY 41, UNSUPPORTED 6, DEPRECATED 1 |
| Gamified Mining | farm | 46 | CATALOG_ONLY 38, UNSUPPORTED 7, DEPRECATED 1 |
| Leveraged Farming | yield | 46 | DEPRECATED 8, CATALOG_ONLY 34, UNSUPPORTED 4 |
| Synthetics | derivatives | 44 | DEPRECATED 8, CATALOG_ONLY 28, UNSUPPORTED 8 |
| Basis Trading | yield | 42 | CATALOG_ONLY 32, DEPRECATED 3, UNSUPPORTED 7 |
| Luck Games | prediction | 42 | CATALOG_ONLY 33, UNSUPPORTED 7, DEPRECATED 2 |
| Payments | services | 39 | CATALOG_ONLY 29, UNSUPPORTED 7, DEPRECATED 3 |
| AI Agents | services | 38 | CATALOG_ONLY 37, UNSUPPORTED 1 |
| Trading App | services | 38 | CATALOG_ONLY 36, UNSUPPORTED 2 |
| NFT Lending | nft-finance | 32 | CATALOG_ONLY 26, UNSUPPORTED 5, DEPRECATED 1 |
| Insurance | insurance | 31 | CATALOG_ONLY 28, UNSUPPORTED 3 |
| Telegram Bot | services | 31 | CATALOG_ONLY 29, UNSUPPORTED 2 |
| Liquid Restaking | liquid-restaking | 29 | DEPRECATED 2, CATALOG_ONLY 20, FULL_POSITION 2, UNSUPPORTED 5 |
| Crypto Card Issuer | services | 28 | CATALOG_ONLY 28 |
| Developer Tools | services | 27 | CATALOG_ONLY 27 |
| Token Locker | launchpad | 25 | CATALOG_ONLY 19, UNSUPPORTED 6 |
| Options Vault | options | 22 | CATALOG_ONLY 11, UNSUPPORTED 7, DEPRECATED 4 |
| Physical TCG | nft-finance | 21 | CATALOG_ONLY 20, UNSUPPORTED 1 |
| Uncollateralized Lending | lending | 21 | CATALOG_ONLY 18, DEPRECATED 2, UNSUPPORTED 1 |
| Bridge Aggregator | bridge | 17 | DEPRECATED 1, CATALOG_ONLY 16 |
| Yield Lottery | yield | 16 | CATALOG_ONLY 12, UNSUPPORTED 4 |
| Governance Incentives | services | 15 | CATALOG_ONLY 9, UNSUPPORTED 5, DEPRECATED 1 |
| Oracle | services | 15 | DEPRECATED 1, CATALOG_ONLY 12, UNSUPPORTED 2 |
| Ponzi | other | 15 | CATALOG_ONLY 12, DEPRECATED 2, UNSUPPORTED 1 |
| Domains | services | 14 | CATALOG_ONLY 14 |
| Restaking | restaking | 14 | PARTIAL_POSITION 1, CATALOG_ONLY 8, UNSUPPORTED 4, DEPRECATED 1 |
| Liquidity Automation | yield | 12 | CATALOG_ONLY 11, UNSUPPORTED 1 |
| CeDeFi | cex | 10 | UNSUPPORTED 7, CATALOG_ONLY 3 |
| DePIN | services | 10 | CATALOG_ONLY 9, UNSUPPORTED 1 |
| Wallets | services | 10 | CATALOG_ONLY 10 |
| Anchor BTC | liquid-staking | 9 | CATALOG_ONLY 7, UNSUPPORTED 2 |
| Foundation | services | 9 | CATALOG_ONLY 9 |
| MEV | services | 9 | CATALOG_ONLY 9 |
| DAO Service Provider | services | 8 | DEPRECATED 1, CATALOG_ONLY 6, UNSUPPORTED 1 |
| Dual-Token Stablecoin | stablecoin | 8 | CATALOG_ONLY 5, UNSUPPORTED 2, DEPRECATED 1 |
| OTC Marketplace | services | 8 | CATALOG_ONLY 7, UNSUPPORTED 1 |
| Restaked BTC | restaking | 8 | UNSUPPORTED 5, DEPRECATED 1, CATALOG_ONLY 2 |
| Bridge Aggregators | bridge | 7 | CATALOG_ONLY 7 |
| DCA Tools | services | 7 | DEPRECATED 1, UNSUPPORTED 1, CATALOG_ONLY 5 |
| Partially Algorithmic Stablecoin | stablecoin | 7 | UNSUPPORTED 2, CATALOG_ONLY 4, DEPRECATED 1 |
| Decentralized BTC | liquid-staking | 6 | CATALOG_ONLY 3, UNSUPPORTED 3 |
| Meme | gaming | 6 | CATALOG_ONLY 6 |
| Stablecoin Issuer | stablecoin | 6 | CATALOG_ONLY 6 |
| Stablecoin Wrapper | stablecoin | 6 | CATALOG_ONLY 5, UNSUPPORTED 1 |
| Treasury Manager | yield | 6 | UNSUPPORTED 1, CATALOG_ONLY 5 |
| Charity Fundraising | services | 5 | CATALOG_ONLY 4, DEPRECATED 1 |
| Decentralized AI | services | 5 | CATALOG_ONLY 4, UNSUPPORTED 1 |
| NftFi | nft-finance | 5 | CATALOG_ONLY 5 |
| Block Builders | services | 4 | CATALOG_ONLY 4 |
| Identity & Reputation | services | 4 | CATALOG_ONLY 4 |
| Interest Rate Derivatives | derivatives | 3 | CATALOG_ONLY 3 |
| Liquidations | services | 3 | CATALOG_ONLY 1, DEPRECATED 1, UNSUPPORTED 1 |
| NFT Automated Strategies | nft-finance | 3 | CATALOG_ONLY 3 |
| Portfolio Tracker | services | 3 | CATALOG_ONLY 2, DEPRECATED 1 |
| Security Extension | services | 3 | CATALOG_ONLY 3 |
| Volume Boosting | services | 3 | CATALOG_ONLY 3 |
| Bug Bounty | services | 2 | DEPRECATED 2 |
| CDP Manager | cdp | 2 | CATALOG_ONLY 1, DEPRECATED 1 |
| Coins Tracker | services | 2 | CATALOG_ONLY 2 |
| Collateral Management | lending | 2 | CATALOG_ONLY 2 |
| Staking Rental | liquid-staking | 2 | UNSUPPORTED 1, CATALOG_ONLY 1 |
| Chain Bribes | services | 1 | CATALOG_ONLY 1 |
| Collateral Markets | lending | 1 | CATALOG_ONLY 1 |
| DOR | services | 1 | CATALOG_ONLY 1 |
| Exotic Options | options | 1 | UNSUPPORTED 1 |
| Mining Pools | services | 1 | CATALOG_ONLY 1 |
| NFT Launchpad | nft-finance | 1 | CATALOG_ONLY 1 |
| Onchain Voting | services | 1 | CATALOG_ONLY 1 |
| Private Investment Platform | rwa | 1 | CATALOG_ONLY 1 |
| Secondary Debt Markets | lending | 1 | CATALOG_ONLY 1 |
| ve-Incentive Automator | services | 1 | CATALOG_ONLY 1 |
| Video Infrastructure | services | 1 | CATALOG_ONLY 1 |
