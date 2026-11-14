# Official source and terms inventory

Fetched 2026-10-08T05:31:00.135Z; 73 locally hashed official-source files. All entries preserve original byte hashes and pinned revision, path, URL and fetch date in src/defi/sources/manifest.json. Registry generation rejects hash drift. Source text is not compiled, and local .ts source copies use .txt suffix.

| Repository | Revision | Terms |
|---|---|---|
| aave-dao/aave-address-book | 6b869334c3715b6657d78c4d3306aaf33cd0c0c8 | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| compound-finance/comet | f766f51583c23acc33b2a7824654ef2029a96804 | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| morpho-org/morpho-blue | 8e26ca6a8dbc5089edcd67fb576248810fd2870a | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| morpho-org/metamorpho | ded84e59668155b34d3c24906c4f7461c12828af | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| morpho-org/sdks | 163e8c52695245ba86818a4cbf7db4ec4178c860 | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| Uniswap/contracts | 047d585853f89726c0fdef46bbf633bab8fc9051 | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| Uniswap/v3-core | d0831dc6b8a318df3872b6d68f6de135c9f3ec29 | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| Uniswap/v3-periphery | 0682387198a24c7cd63566a2c58398533860a5d1 | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| lidofinance/core | 1440c830eb1d0916a436468a71cd73bc8b8deffb | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |
| sky-ecosystem/sdai | 2b7acb95289a9eb3a8844206d5712eabfa206efc | LEGAL_REVIEW_REQUIRED (retain original SPDX/license) |

No legal approval concluded. Optional public APIs are not financial truth. Existing price-source/RPC terms remain governed by the accepted release profile. No arbitrary remote protocol logos; deterministic locally rendered monograms.

## Deferred breadth, exact reason

| Family | Reviewed official source | Reason |
|---|---|---|
| Curve | https://docs.curve.finance/developer/amm/stableswap-ng/pools/metapool/ | Metapool, lending wrappers and gauge reward accounting need separately verified pool/deployment/subtype identities and base-pool decomposition. No V2 formula reused. |
| Balancer | https://docs-v2.balancer.fi/concepts/advanced/valuing-bpt/valuing-bpt.html | Preminted/composable BPT actual supply and Vault versions need subtype-specific accounting and deployment registry validation. |
| Aerodrome / Velodrome | https://github.com/aerodrome-finance/contracts ; https://github.com/velodrome-finance/contracts | Stable/volatile/gauge and Slipstream NFT accounting not validated as Uniswap V2/V3 equivalents; no adapter registry admitted. |
| Rocket Pool | https://docs.rocketpool.net/guides/staking/overview | rETH exchange-rate deployment source and chain-specific conversion proof not pinned/admitted in this registry. |
| ether.fi / Renzo | https://etherfi.gitbook.io/etherfi/contracts-and-integrations ; https://docs.renzoprotocol.com/ | Current LRT exchange-rate and withdrawal/queued exposure accounting not independently pinned and tested. Holding an LRT would not imply direct EigenLayer. |
| EigenLayer direct | https://github.com/Layr-Labs/eigenlayer-contracts/blob/main/docs/core/DelegationManager.md | Post-slashing shares and queued withdrawals need current strategy/delegation version accounting and indexed withdrawal data. No old whitepaper assumptions. |
| Spark / Sky debt | https://docs.spark.fi/ ; https://developers.sky.money/ | sDAI ERC4626 is covered separately; Spark lending and legacy Maker/Sky debt generations lack a separately reviewed current adapter. |
| Yearn / Beefy | https://docs.yearn.fi/developers ; https://docs.beefy.finance/developer-documentation | No exact vault registry/standard validation admitted; non-ERC4626 price-per-share/strategy semantics cannot be guessed. |
| Aave V4 / Uniswap V4 / Morpho Vault V2 | Official repositories/deployments | Separate accounting models; V3/V1 logic is not relabeled. |
