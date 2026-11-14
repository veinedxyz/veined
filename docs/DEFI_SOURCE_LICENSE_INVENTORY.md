# DeFi source and license inventory

Every external source Otherbridge V1.14 uses for the DeFi universe and position adapters. Unknown or undecided terms are `LEGAL_REVIEW_REQUIRED`; a detected SPDX id is a hint only. Legal approval is an external gate and is not self-certified.

## Catalog APIs (fetched at sync time; data, never code)

| Source | URL | Use | sha256 (last accepted sync) | Bytes | Terms | Attribution |
| --- | --- | --- | --- | ---: | --- | --- |
| defillama-protocols | https://api.llama.fi/protocols | protocol catalog, categories, chain relations, TVL context | `11fb0c1c52f457b5fa9131aae35719db5447d943267dde9337879eb56d2c7125` | 9262446 | LEGAL_REVIEW_REQUIRED | DefiLlama data — attribution expected (review terms) |
| defillama-chains | https://api.llama.fi/v2/chains | chain catalog, TVL context | `6166466c6b1be973429e94a60a02932f60f9f1498a411dabbf52c5576903ec6b` | 64231 | LEGAL_REVIEW_REQUIRED | DefiLlama data — attribution expected (review terms) |
| defillama-config | https://api.llama.fi/config | chain metadata (categories, chain ids, key labels, parent protocols) | `d3453837403adc4912e8a7c0787da2b6af9860a8b364ad06121adbb4b89dc928` | 8086549 | LEGAL_REVIEW_REQUIRED | DefiLlama data — attribution expected (review terms) |
| defillama-chainlist-chainids | https://raw.githubusercontent.com/DefiLlama/chainlist/92968204cb15c546a559af0fe96655ee7ce50d85/constants/chainIds.js | chain-id cross-check (text-parsed) | `0633608bf56e38c33519ee71fd4005e341d3c89524313716a9ef73e1dbaadade` | 7218 | LEGAL_REVIEW_REQUIRED | DefiLlama data — attribution expected (review terms) |

## Pinned DefiLlama repositories

| Repository | Pinned revision | Use | License state |
| --- | --- | --- | --- |
| DefiLlama/chainlist | `92968204cb15c546a559af0fe96655ee7ce50d85` | chain identity cross-check (constants/chainIds.js parsed as text) | GPL-3.0 (detected; LEGAL_REVIEW_REQUIRED) |
| DefiLlama/DefiLlama-Adapters | `3b0779f2e0cd5db6158565e57405dbc2392fc0a1` | TVL methodology and deployment clues (module paths at the pinned revision); never executed | LEGAL_REVIEW_REQUIRED |
| DefiLlama/dimension-adapters | `701a3a8a6d5dc99dc1342b37737ca1d545bfa28a` | optional volume/fees/revenue context only; never wallet value; never executed | LEGAL_REVIEW_REQUIRED |
| DefiLlama/icons | `ab2c83020ea384025e2fee41b785f2a042e8c857` | logo provenance reference only; logos are never fetched or rendered | LEGAL_REVIEW_REQUIRED |

## Official protocol sources for reviewed adapters (pinned, sha256-checked in src/defi/sources/manifest.json)

| Repository | Revision | Files | Use | Terms |
| --- | --- | ---: | --- | --- |
| aave-dao/aave-address-book | `6b869334c3715b6657d78c4d3306aaf33cd0c0c8` | 17 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| compound-finance/comet | `f766f51583c23acc33b2a7824654ef2029a96804` | 26 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| morpho-org/morpho-blue | `8e26ca6a8dbc5089edcd67fb576248810fd2870a` | 5 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| morpho-org/metamorpho | `ded84e59668155b34d3c24906c4f7461c12828af` | 2 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| morpho-org/sdks | `163e8c52695245ba86818a4cbf7db4ec4178c860` | 2 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| Uniswap/contracts | `047d585853f89726c0fdef46bbf633bab8fc9051` | 10 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| Uniswap/v3-core | `d0831dc6b8a318df3872b6d68f6de135c9f3ec29` | 5 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| Uniswap/v3-periphery | `0682387198a24c7cd63566a2c58398533860a5d1` | 2 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| lidofinance/core | `1440c830eb1d0916a436468a71cd73bc8b8deffb` | 4 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| sky-ecosystem/sdai | `2b7acb95289a9eb3a8844206d5712eabfa206efc` | 3 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| rocket-pool/docs.rocketpool.net | `ff73911625a24a6fe0e67aa1679385ca51542f44` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| coinbase/wrapped-tokens-os | `5697a90f4c47e8d801cedce81444a8464019fe08` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| Layr-Labs/eigenlayer-contracts | `ef8f97992241338cb88335b9d74295e33321b780` | 4 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| etherfi-protocol/smart-contracts | `15ff96d4d5e8e6a19a472cd40a7bcb858c9e7a88` | 4 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| FraxFinance/frax-solidity | `30532c8cefcbf5c7efafcff4369261bd435a4859` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| mantle-lsp/contracts | `bbc4e8bf7d3e3b4ca0c5be07aba409ac66611c76` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| stader-labs/ethx | `9d4a9211431d6c0cdf014bd64d3718cba4ce96ab` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| SwellNetwork/v3-core-public | `5827c4f1294b00f2939e582b1d3ac448f87fa218` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| Kelp-DAO/LRT-rsETH | `3dded885f6f797f5959aff449c3a30c5cbb6ce23` | 2 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| PufferFinance/Deployments-and-ACL | `302c0270f718a7dc20c819419a7dde965e16ce56` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| stakewise/v3-core | `fc70cbe1b3d41bc5f78434830d837aa270ca33bc` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| curvefi/curve-pool-registry | `0bdb116024ccacda39295bb3949c3e6dd0a8e2d9` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| curvefi/metaregistry | `b18e83e08bee8660a5d59f53757fae85b6d25599` | 3 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| balancer/balancer-deployments | `b55dc2b8a46bce8f27aed5a3b03f719f662f860a` | 7 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| aerodrome-finance/contracts | `1ba30815bba620f7e9faa34769ffd00c214c9b82` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| aerodrome-finance/slipstream | `f8717faaae6e6717db3c8e3850149c01a79c0603` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| velodrome-finance/contracts | `b3065d8b6702b14b094f9f6046b752cc9f78c43b` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| velodrome-finance/slipstream | `193a6b85f836a229b76a8df3541a284a2368427b` | 1 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| sushiswap/v2-core | `a349882c918c752d0363e4c6e02dedcbc48b734e` | 5 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| pancakeswap/pancake-developer | `671acffc44b705be33cef339fcf3d2a2274acb63` | 2 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| pancakeswap/pancake-v3-contracts | `986847948755cba528324d41be19480731c36c2a` | 2 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |
| sparkdotfi/spark-address-registry | `98091964e0ef9f74bb2b6da3646f8e6d16448588` | 3 | deployment addresses / ABI / math review | LEGAL_REVIEW_REQUIRED |

## Reviewed catalog links

| DefiLlama id | Slug | Product | Attribution | Adapter version |
| --- | --- | --- | --- | --- |
| 1599 | aave-v3 | Aave V3 Pool | EXACT | 1.1.0 |
| 2929 | sparklend | SparkLend Pool | EXACT | 1.1.0 |
| 2088 | compound-v3 | Compound III Comet | EXACT | 1.0.0 |
| 4025 | morpho-blue | Morpho Blue markets | EXACT | 1.1.0 |
| 4025 | morpho-blue | MetaMorpho vaults | PRODUCT_FAMILY | 1.0.0 |
| 182 | lido | Lido stETH / wstETH | EXACT | 1.1.0 |
| 2197 | uniswap-v2 | Uniswap V2 pairs | EXACT | 1.1.0 |
| 2198 | uniswap-v3 | Uniswap V3 positions | EXACT | 1.1.0 |
| 6716 | spark-savings | Savings DAI (sDAI) ERC-4626 | PRODUCT_FAMILY | 1.0.0 |
| 900 | rocket-pool | Rocket Pool rETH | EXACT | 1.1.0 |
| 3594 | coinbase-wrapped-staked-eth | Coinbase cbETH | EXACT | 1.1.0 |
| 2914 | binance-staked-eth | Binance wBETH (Ethereum) | EXACT | 1.1.0 |
| 2901 | swell-liquid-staking | Swell swETH | EXACT | 1.1.0 |
| 3882 | meth-protocol | Mantle mETH | EXACT | 1.1.0 |
| 1044 | stader | Stader ETHx | EXACT | 1.1.0 |
| 3946 | kelp | Kelp rsETH | EXACT | 1.1.0 |
| 2626 | ether.fi-stake | ether.fi weETH | PRODUCT_FAMILY | 1.1.0 |
| 277 | stakewise-v3 | StakeWise osETH | PRODUCT_FAMILY | 1.1.0 |
| 2221 | frax-ether | Frax sfrxETH (ERC-4626) | PRODUCT_FAMILY | 1.0.0 |
| 4088 | puffer-stake | Puffer pufETH (ERC-4626) | EXACT | 1.0.0 |
| 3107 | eigencloud | EigenLayer restaking | PRODUCT_FAMILY | 1.1.0 |
| 3 | curve-dex | Curve pools and gauges | EXACT | 1.1.0 |
| 2611 | balancer-v2 | Balancer V2 weighted pools | PRODUCT_FAMILY | 1.1.0 |
| 3450 | aerodrome-v1 | Aerodrome basic pools and gauges | EXACT | 1.1.0 |
| 3302 | velodrome-v2 | Velodrome basic pools and gauges | EXACT | 1.1.0 |
| 119 | sushiswap | SushiSwap V2 pairs | EXACT | 1.1.0 |
| 194 | pancakeswap-amm | PancakeSwap V2 pairs | EXACT | 1.1.0 |
| 2769 | pancakeswap-amm-v3 | PancakeSwap V3 positions | EXACT | 1.1.0 |

Third-party JavaScript (DefiLlama adapters, chainlist) is never executed: it is pinned and, where used, parsed as text. Remote logos are never fetched or rendered.
