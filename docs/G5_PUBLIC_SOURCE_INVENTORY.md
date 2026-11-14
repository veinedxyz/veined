# G5 public source inventory (V1.6)

Every public artifact used for a G5 claim, with retrieval time, status, SHA-256 and trust label. Raw bodies: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/g5-sources/`; RPC request/response logs per topic under `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/`.

Trust labels: ONCHAIN_RPC, OFFICIAL_EXPLORER_INDEX, THIRD_PARTY_EXPLORER, OFFICIAL_GIT, CONTENT_ADDRESSED_METADATA, OFFICIAL_DOCS, DERIVED.

| Label | URL / source | Status | SHA-256 / note |
|---|---|---|---|
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api?module=contract&action=getcontractcreation&contractaddresses=0x2827865ad5330faf85` | 200 | `69b30131b31cb46b…` (49253 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/addresses/0x2827865ad5330faf855af8b743c701ae9c818034` | 200 | `a186bb6f834b0b43…` (718 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/smart-contracts/0x2827865ad5330faf855af8b743c701ae9c818034` | 200 | `e4fd3ba6b779d2c9…` (97515 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/addresses/0xb81d6e000000000000000000000000000000c0de` | 200 | `61dba2292f601709…` (725 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/smart-contracts/0xb81d6e000000000000000000000000000000c0de` | 200 | `468528e79a74582a…` (27084 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/transactions/0xc16d6ab26b52d946010003f1fa9747745626e501b115b45659de6c8bf661de7` | 200 | `976eb56ba8af3474…` (50440 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api?module=contract&action=getcontractcreation&contractaddresses=0xb81d6e000000000000` | 200 | `4576ef40278bd470…` (41 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api?module=contract&action=getsourcecode&address=0x2827865ad5330faf855af8b743c701ae9c` | 200 | `66ec4e99da291d33…` (97 B) |
| THIRD_PARTY_EXPLORER | `https://api.etherscan.io/v2/api?chainid=56&module=contract&action=getcontractcreation&contractaddresses=0xac7b` | 200 | `63fe436e88c3d45c…` (172 B) |
| THIRD_PARTY_EXPLORER | `https://bscscan.com/address/0xac7b8ffed19d670930b8caa0693189b33454e8d8` | 403 | `d30f4932d78190e9…` (5731 B) |
| OFFICIAL_DOCS | `https://binaries.soliditylang.org/windows-amd64/list.json` | 200 | `2e9385b913125a5e…` (52435 B) |
| OFFICIAL_DOCS | `https://binaries.soliditylang.org/wasm/list.json` | 200 | `6b728a26fa9c2495…` (51959 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api?module=logs&action=getLogs&fromBlock=0&toBlock=latest&address=0xb81d6e00000000000` | 200 | `aba4dd3e2957d864…` (491 B) |
| DERIVED | `https://chainid.network/chains.json` | 200 | `9d2e61f6a2034f1e…` (1187304 B) |
| OFFICIAL_GIT | `https://raw.githubusercontent.com/DefiLlama/chainlist/main/constants/extraRpcs.js` | 200 | `4901aba1125d0091…` (444348 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/blocks/45663074` | 200 | `0a2a59df2ae1e7f4…` (1040 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/blocks/45411356` | 200 | `8ca1f46956d8dfec…` (1040 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api/v2/blocks/45659942` | 200 | `57b363f721c7f052…` (1040 B) |
| THIRD_PARTY_EXPLORER | `https://skynet.certik.com/projects/cross` | 200 | `33e014edec08cec3…` (910963 B) |
| THIRD_PARTY_EXPLORER | `https://skynet.certik.com/projects/crosstoken` | 404 | `606b8616ad363569…` (120952 B) |
| THIRD_PARTY_EXPLORER | `https://skynet.certik.com/projects/cross-nexus` | 404 | `e8502f8c10251619…` (120952 B) |
| THIRD_PARTY_EXPLORER | `https://skynet.certik.com/projects/nexus-cross` | 404 | `238bdf3909a7e471…` (120952 B) |
| OFFICIAL_EXPLORER_INDEX | `https://www.crossscan.io/api?module=contract&action=getcontractcreation&contractaddresses=0x4a508a3dde9ebe1a6b` | 200 | `e3241329e35a9ab9…` (24673 B) |
| THIRD_PARTY_EXPLORER | `https://sourcify.dev/server/v2/contract/56/0xac7b8ffed19d670930b8caa0693189b33454e8d8` | 404 | `5fc8a908bf8b87df…` (125 B) |
| THIRD_PARTY_EXPLORER | `https://sourcify.dev/server/v2/contract/612055/0x2827865ad5330faf855af8b743c701ae9c818034` | 404 | `b8f11c1173beb32e…` (129 B) |
| THIRD_PARTY_EXPLORER | `https://sourcify.dev/server/v2/contract/56/0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5` | 404 | `1004c610984b8022…` (125 B) |
| THIRD_PARTY_EXPLORER | `https://sourcify.dev/server/v2/contract/56/0x6bf62ca91e397b5a7d1d6bce97d9092065d7a510` | 200 | `1de803921e759377…` (209 B) |
| CONTENT_ADDRESSED_METADATA | `https://ipfs.io/ipfs/QmYddPkn9oBGqBhZXsBUpYzggKNhq8fbe3dGABAUocxaqL` | 429 | `ea9d09308e5c86ba…` (175 B) |
| CONTENT_ADDRESSED_METADATA | `https://dweb.link/ipfs/QmYddPkn9oBGqBhZXsBUpYzggKNhq8fbe3dGABAUocxaqL` | 429 | `ea9d09308e5c86ba…` (175 B) |
| CONTENT_ADDRESSED_METADATA | `https://ipfs.io/ipfs/QmcFRDCCv3aS14tYDZTG5d52VMv9Vj376TkEbh4AnXnU7X` | 429 | `1492d3142cefbfe9…` (175 B) |
| CONTENT_ADDRESSED_METADATA | `https://dweb.link/ipfs/QmcFRDCCv3aS14tYDZTG5d52VMv9Vj376TkEbh4AnXnU7X` | 429 | `1492d3142cefbfe9…` (175 B) |
| CONTENT_ADDRESSED_METADATA | `https://ipfs.io/ipfs/QmVP7TsF3svn1LgCzsTotYtSrkVVcTKpac5atDupVrDTMo` | 429 | `9933f2038f0d2473…` (175 B) |
| CONTENT_ADDRESSED_METADATA | `https://dweb.link/ipfs/QmVP7TsF3svn1LgCzsTotYtSrkVVcTKpac5atDupVrDTMo` | 429 | `9933f2038f0d2473…` (175 B) |
| OFFICIAL_GIT | `https://raw.githubusercontent.com/to-nexus/bridge-contracts/b3b025852a100d6b825a85ab26e7895fde65e633/src/Cross` | 200 | `34f76e02cea8c275…` (6310 B) |
| OFFICIAL_GIT | `https://raw.githubusercontent.com/to-nexus/bridge-contracts/b3b025852a100d6b825a85ab26e7895fde65e633/src/BaseB` | 200 | `d0d3939c8015329f…` (39386 B) |
| OFFICIAL_GIT | `https://raw.githubusercontent.com/to-nexus/bridge-contracts/6da2fb2d7a2fee2414fea894fe521f6362884569/src/BSCBr` | 200 | `7a4d75b818ca332a…` (3809 B) |
| OFFICIAL_GIT | `https://raw.githubusercontent.com/to-nexus/bridge-contracts/6da2fb2d7a2fee2414fea894fe521f6362884569/src/BaseB` | 200 | `dc38b36a957ae2da…` (39360 B) |
| OFFICIAL_GIT | `https://raw.githubusercontent.com/to-nexus/bridge-contracts/6da2fb2d7a2fee2414fea894fe521f6362884569/src/abstr` | 200 | `0e1ec03b37d5de82…` (21953 B) |
| OFFICIAL_GIT | `https://github.com/to-nexus/bridge-contracts` | — | git clone --mirror (all refs) |
| OFFICIAL_GIT | `https://github.com/to-nexus/go-cross` | — | Istanbul header hash rule, archive/sync guidance |
| OFFICIAL_GIT | `https://github.com/to-nexus/cross-token` | — | CROSS token exact build |
| OFFICIAL_DOCS | `https://binaries.soliditylang.org/` | — | solc 0.8.28 (native+wasm) and 0.8.22 binaries, SHA-256 checked against list.json |
| ONCHAIN_RPC | `https://mainnet.crosstoken.io:22001` | — | state=recent only; eth_getLogs ~350k-block ranges; eth_getBlockReceipts historical; tx-hash index pruned (txlookup window) |
| ONCHAIN_RPC | `https://mainnet.onechain.nexus:22001` | — | same as above; used as second ONE endpoint (same organisation: not counted as an independent operator) |
| ONCHAIN_RPC | `https://bsc-dataseed.bnbchain.org` | — | recent state; receipts/blocks historical; eth_getLogs disabled (limit exceeded) |
| ONCHAIN_RPC | `https://bsc-rpc.publicnode.com` | — | recent state only (archive needs token) |
| ONCHAIN_RPC | `https://bsc-mainnet.public.blastapi.io` | — | archive state (getCode/getStorageAt/eth_call at old blocks); getLogs rate-limited |
| ONCHAIN_RPC | `https://bsc-mainnet.nodereal.io/v1/64a9df…` | — | historical eth_getLogs up to 50k blocks |

Negative results recorded honestly: Sourcify has no match for either implementation or the BSC proxy (404); CrossScan has the ONE proxy verified (ERC1967Proxy) but not the implementation; BscScan pages are Cloudflare-blocked (403) and the Etherscan V2 free tier does not cover BSC; public IPFS gateways rate-limited the three metadata CIDs (429). None of these were needed: the metadata was reconstructed and its CID recomputed locally.
