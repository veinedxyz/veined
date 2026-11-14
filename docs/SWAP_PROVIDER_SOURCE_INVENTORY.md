# Current official Swap source inventory

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Retrieved during the V1.15.1 run beginning 2026-10-14 UTC. Exact timestamps/status/hash records: [receipts](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/receipts.json) and [additional official protocol/account receipts](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/delivery-source-receipts.json). Failed/404 retrievals remain research failures and are not accepted source proof.

| Canonical repository | Execution-time pinned revision | Source |
|---|---|---|
| Uniswap/universal-router | 802fe4c18f47300e0f183e2a42e9146ec2ea9fc3 | [Pinned tree](https://github.com/Uniswap/universal-router/tree/802fe4c18f47300e0f183e2a42e9146ec2ea9fc3) |
| Uniswap/v4-periphery | 9969eec44cfdf07e24b41de47f40276a58401976 | [Pinned tree](https://github.com/Uniswap/v4-periphery/tree/9969eec44cfdf07e24b41de47f40276a58401976) |
| Uniswap/UniswapX | eb7ce077036258b9510b42ad37aa920cf3aaf308 | [Pinned tree](https://github.com/Uniswap/UniswapX/tree/eb7ce077036258b9510b42ad37aa920cf3aaf308) |
| pancakeswap/pancake-developer | 671acffc44b705be33cef339fcf3d2a2274acb63 | [Pinned tree](https://github.com/pancakeswap/pancake-developer/tree/671acffc44b705be33cef339fcf3d2a2274acb63) |
| pancakeswap/infinity-universal-router | 1b6d479e1f76361f5950d1168d9392361e73a1e8 | [Pinned tree](https://github.com/pancakeswap/infinity-universal-router/tree/1b6d479e1f76361f5950d1168d9392361e73a1e8) |
| pancakeswap/infinity-periphery | 56a7a4f5076d57d5ed90c38a00421ecbac0d649c | [Pinned tree](https://github.com/pancakeswap/infinity-periphery/tree/56a7a4f5076d57d5ed90c38a00421ecbac0d649c) |
| aerodrome-finance/contracts | 1ba30815bba620f7e9faa34769ffd00c214c9b82 | [Pinned tree](https://github.com/aerodrome-finance/contracts/tree/1ba30815bba620f7e9faa34769ffd00c214c9b82) |
| aerodrome-finance/slipstream | f8717faaae6e6717db3c8e3850149c01a79c0603 | [Pinned tree](https://github.com/aerodrome-finance/slipstream/tree/f8717faaae6e6717db3c8e3850149c01a79c0603) |
| jup-ag/docs | 1de8fd08f9ae17b38b9c4f07eb29637d6e2182a7 | [Pinned tree](https://github.com/jup-ag/docs/tree/1de8fd08f9ae17b38b9c4f07eb29637d6e2182a7) |
| Titan-Pathfinder/titan-sdk-ts | 7588482454bee284a7437d0bd5fce6c02edfb60f | [Pinned tree](https://github.com/Titan-Pathfinder/titan-sdk-ts/tree/7588482454bee284a7437d0bd5fce6c02edfb60f) |
| orca-so/whirlpools | cc683ec92acb5e7606caa3d8e514d9383e9c7c11 | [Pinned tree](https://github.com/orca-so/whirlpools/tree/cc683ec92acb5e7606caa3d8e514d9383e9c7c11) |

Universal Router recommended 2.1.2 is explicitly pinned; captured official sunset guidance identifies older 2.0/2.1.1 as scheduled for 2026-10-21. The V4 dependency used by that router is its exact recorded submodule revision 545a5d2a87228167edde48f3b9eda122d1e3c4d6, not a floating v4-periphery HEAD. Infinity CL/BIN use their current official source action layouts. Jupiter primary API is Swap V2 /order and /build, with on-chain program IDL as the authoritative current instruction definition. Titan production uses v1.api.titan.ag uncompressed protocol at wss://api.titan.exchange/api/v1/ws; SDK 0.1.6 is a dev-only oracle. PCSX current V3/V4 formats are SDK 1.7.2 and current MultiReactor docs. Anonymous PCSX price requests have a documented quota; legal/onboarding and opt-in remain separate.

| Runtime package | Exact pinned version | Declared package license |
|---|---|---|
| @msgpack/msgpack | 3.1.3 | ISC |
| @pancakeswap/pcsx-sdk | 1.7.2 | NOT_DECLARED / LEGAL_REVIEW_REQUIRED |
| @pancakeswap/smart-router | 7.8.0 | NOT_DECLARED / LEGAL_REVIEW_REQUIRED |
| @pancakeswap/swap-sdk-core | 1.6.1 | MIT |
| @pancakeswap/swap-sdk-evm | 1.3.0 | NOT_DECLARED / LEGAL_REVIEW_REQUIRED |
| @solana/web3.js | 1.99.0 | MIT |
| @uniswap/uniswapx-sdk | 3.1.3 | MIT |
| decode-uri-component | 0.5.0 | MIT |
| source-map-js | 1.2.2 | BSD-3-Clause |
| ws | 8.21.3 | MIT |

Dev-only: @titanexchange/sdk-ts 0.1.6 and compatibility typings. The complete dependency SBOM/license inventory is in dependencies/; declared identifiers do not grant commercial approval. The local @pancakeswap/sdk 5.9.3 patch removes only unused Solana barrel exports/imports while preserving EVM serialization/math and WSOL metadata; exact patch hash and frozen lock bind this change. jayson 5.0.0 removes the vulnerable stream-json introducer. Production provider graph excludes bigint-buffer/stream-json; compatibility graph is reported separately.

| ABI/IDL or reviewed source artifact | SHA-256 |
|---|---|
| src/swap/server/jupiter-idl.generated.json | 81d6842de2ad32253835239afd3730939d03058389358868878278a801069567 |
| src/swap/server/deployment-pins.generated.json | 1b8065c93eadf0c078fe340e7fdb4575173fe769d6853a58f1a42b911c4e0200 |
| src/swap/server/solana-program-pins.generated.json | 6f8ba9e7cf12631e2118f75b8c8401cbde8d5574e0af9c507e838957584a6301 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/pancakeswap--infinity-periphery--src__pool-bin__interfaces__IBinRouterBase.sol | d0172f9436b5706d1f455f93dccac8ad5dd6bfd2ee6bfe424b93c757ab268971 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/pancakeswap--infinity-periphery--src__pool-cl__interfaces__ICLRouterBase.sol | ced98dc737ad2e7357a861cfca62cf2903486969d8daa4d9f37d6ac4b8ded114 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/pancakeswap--infinity-periphery--src__libraries__Actions.sol | 47da7f412133c53d960465a57fef76a489236f59ed0d496ef34f435e0efbf358 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/aerodrome-finance--slipstream--contracts__periphery__interfaces__ISwapRouter.sol | 262cab2399023b2ebf4649b1ce9c7bedd71278c9b5fffa40ea957784aff90048 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--src__libraries__Actions.sol | 6e8981fcc1fe709e71f85befa2e8656fac6601a565d8ce677b41cff24a838437 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--src__interfaces__IV4Router.sol | a577e593bd1948ffcf9ce26964ae1e47bafcf6dffcd40baeb700bcb902367a53 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--universal-router--contracts__base__Dispatcher.sol | 5f40089555d35d6ece37d61476c48280a8029062eb1dda17855eb7fe517a9882 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--universal-router--contracts__libraries__Commands.sol | 688122afcc28bd7b03c489de8e26212277ad923f0e87016541129862c5ead0b3 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/pancakeswap--infinity-universal-router--src__base__Dispatcher.sol | cb43115907ef044eaddbcff6a9868a9dbe12e6bfeaae1435b06d938c9feeb923 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/pancakeswap--infinity-universal-router--src__libraries__Commands.sol | 5cbca9bed32e7c55c20cd28460d34504721039aac714133b9786b94545e873eb |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__interfaces__IV4Router.sol | a577e593bd1948ffcf9ce26964ae1e47bafcf6dffcd40baeb700bcb902367a53 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__libraries__Actions.sol | c5f2579951a1d7ca38b6f417db330965875f02efa812a5a487773a51b116e33d |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__interfaces__IV4Router.sol | a577e593bd1948ffcf9ce26964ae1e47bafcf6dffcd40baeb700bcb902367a53 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__libraries__ActionConstants.sol | 8e88393dd8b50b25b818e2f6c246aae5cfe63106b56b6e0609869e599c81ec79 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__libraries__Actions.sol | c5f2579951a1d7ca38b6f417db330965875f02efa812a5a487773a51b116e33d |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__libraries__PathKey.sol | 0c00bae5a64829334a0b5d5541807faf7d18dff5a667cd74cadf9effaf5f0885 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/Uniswap--v4-periphery--pinned--src__V4Router.sol | fb02f27ececb6884c0f40ea31056965f600b4ccc063b5cba3fd77c2b770db389 |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/orca-so--whirlpools--programs__whirlpool__src__instructions__swap.rs | 0d5b23ba9226a7c741bf1a8de949d80504c5b0cdb0d422bd9fe2b168ed8808ee |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/orca-so--whirlpools--programs__whirlpool__src__instructions__v2__swap.rs | 0ee94b1a24c60dc8f2a472f8037fc72eeaecf7b6d128f173eae230098830530e |
| evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/sources/orca-so--whirlpools--programs__whirlpool__src__state__whirlpool.rs | 4845d76fe436368683807104d8b893109f7b4e7ca6a7279c5cc256d7a981cec0 |

The raw current on-chain Jupiter IDL source account is C88XWfp26heEmDkmfSzeXP7Fd7GQJ2j9dDTUsyiZbUTa at observed slot 456778161; raw IDL SHA-256 82a3907455712fa9c2104d1b8fb8a2649cc4d96789d4c16a572ed343981b9f4e. Generated representation has a separate hash above. Current decoder models eight route instructions and 170 Swap variants; economic review is admitted only for independently supported exact-in route/pool families. Current Orca pool layout is source-pinned separately from the current deployed program account/header pins.

| Chain / role | Accepted address | Runtime Keccak-256 | Source block |
|---|---|---|---|
| 1 / wrapper | 0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2 | 0xd0a06b12ac47863b5c7be4185c2deaad1c61557033f56c7d4ea74429cbb25e23 | 0x18f9fbd |
| 1 / uniswap | 0x23617e59a5925b2a4bf75d73ff6711cd0b29de85 | 0x55e6b334152096d60367d7ab24241948b31e8d0e66adc8b81cba049a19f9d2ac | 0x18f9fbd |
| 1 / pancake | 0x65b382653f7c31bc0af67f188122035461ec9c76 | 0xdb8dfdb9e10400c36fae415f58c5d4a6a573b28e2bd1e25a6328623a2112d3f6 | 0x18f9fbd |
| 1 / Uniswap | 0x000000000022d473030f116ddee9f6b43ac78ba3 | 0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131 | 0x18f9fbd |
| 1 / PancakeSwap | 0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768 | 0xb29cb67ee041882c3a6f4235375bd6e4d197f0526f0bb5479c49dd1c87d36c98 | 0x18f9fbd |
| 1 / manager | 0x000000000004444c5dc75cb358380d2e3de08a90 | 0x785f1014552b7ce7d5fb7d0c970ca60edee94fd00425d7ca21609acac7ce1293 | 0x18f9fbd |
| 1 / quoter | 0x52f0e24d1c21c8a0cb1e5a5dd6198556bd9e1203 | 0x06de58fa119c5deaa7a667fb92d3894e25d9160e62fb82c8d86d43b47eefe441 | 0x18f9fbd |
| 1 / stateView | 0x7ffe42c4a5deea5b0fec41c94c136cf115597227 | 0xd7947778589cf4aac9a092a4451292a2056380941635ab7006d3c691d8dfd878 | 0x18f9fbd |
| 56 / wrapper | 0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c | 0xb7d84205eaaf83ce7b3940c6beaad6d22790255e34a9a2b486aa8cdfff118fe6 | 0x79a8a26 |
| 56 / uniswap | 0xdc264714f68d84cf29bc605589405e78bdbe7c9f | 0xe867d0c9a826a351e9d8cefc0fa947d71a497b9ecb0395380814a064fc8465a4 | 0x79a8a26 |
| 56 / pancake | 0xd9c500dff816a1da21a48a732d3498bf09dc9aeb | 0x475a0fac42fef6f5939a066498de529e7b79906eccfbb147ace899c8d21a898b | 0x79a8a26 |
| 56 / Uniswap | 0x000000000022d473030f116ddee9f6b43ac78ba3 | 0x48774d936722dd7002887f307f58bcddb3eeabad39149e7dcb5c08e4ebe3310f | 0x79a8a26 |
| 56 / PancakeSwap | 0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768 | 0xb8e27757651b074ffccdca43caff003b9f071d45ee74c379fad1a5a67ecaf9d6 | 0x79a8a26 |
| 56 / manager | 0x28e2ea090877bf75740558f6bfb36a5ffee9e9df | 0x48752321ee7abf0d2a17c30679df9a1ddd14dc75d28b26e2509b76396145a005 | 0x79a8a26 |
| 56 / quoter | 0x9f75dd27d6664c475b90e105573e550ff69437b0 | 0xaa14bdb3b2246fb3d795e19c7ca78e8908539f593344b9ff971ce3bdf2d06d08 | 0x79a8a26 |
| 56 / stateView | 0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4 | 0x5bbb9e82e49709fea04b2f873a6ad149a983ddf7eafc86f0fe79ad0a8c512d2b | 0x79a8a26 |
| 56 / cl | 0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b | 0x3caf72836cb6603c6af03bba1578ec70ece8c3e5b1d0ef73667b5fbd74b02a0f | 0x79a8a26 |
| 56 / bin | 0xc697d2898e0d09264376196696c51d7abbbaa4a9 | 0x9e95edb558f2fb05a0d5a96b57cd59400d39b1b7c02a4fc7a8a158b3d092835f | 0x79a8a26 |
| 56 / vault | 0x238a358808379702088667322f80ac48bad5e6c4 | 0x678bab6ace02b3fc508054b194f3f70190a0621f51bcae69be33cc5416031908 | 0x79a8a26 |
| 8453 / wrapper | 0x4200000000000000000000000000000000000006 | 0x8a3a1f6a9f9dce633117adee5b458245835a8645a8c8726a26382a4622508b1c | 0x322752a |
| 8453 / uniswap | 0xd6145b2d3f379919e8cdeda7b97e37c4b2ca9c40 | 0x816c75fe7f6ccf8fe8b14825091e8dff301fe7ffd4b962f89b2981a747facc08 | 0x322752a |
| 8453 / pancake | 0xd9c500dff816a1da21a48a732d3498bf09dc9aeb | 0xff0f54623048c027945896b2d5f07c2ed4e9ab5055f257991f5f88a71ad82822 | 0x322752a |
| 8453 / Uniswap | 0x000000000022d473030f116ddee9f6b43ac78ba3 | 0xa67739abc3ede9dbdc0491636c67d6a14ac07fab9030c3f509b1eb7b11dff8ed | 0x322752a |
| 8453 / PancakeSwap | 0x31c2f6fcff4f8759b3bd5bf0e1084a055615c768 | 0xa1d9069bd00ed3f3a4e7fa14cc96bda1ebdda625cf6e4c616b6fae4965684a6e | 0x322752a |
| 8453 / manager | 0x498581ff718922c3f8e6a244956af099b2652b2b | 0x83b2af6e9f3158defc2811cbcb0db71ecf8b2ba2abea39c39e370ac5c6f43eb6 | 0x322752a |
| 8453 / quoter | 0x514c8b5f54112481e28028f1166bd78501089259 | 0x4c4c43e0024343e65597f0f0a1b829aaf69e5a6c0a0148fb63d28ff5730be551 | 0x322752a |
| 8453 / stateView | 0xa3c0c9b65bad0b08107aa264b0f3db444b867a71 | 0xbbd5859677ef5491143133e8ed2b8faa0272f6fc2cbae94c53e79cc8c0538545 | 0x322752a |
| 8453 / cl | 0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b | 0x3caf72836cb6603c6af03bba1578ec70ece8c3e5b1d0ef73667b5fbd74b02a0f | 0x322752a |
| 8453 / bin | 0xc697d2898e0d09264376196696c51d7abbbaa4a9 | 0x9e95edb558f2fb05a0d5a96b57cd59400d39b1b7c02a4fc7a8a158b3d092835f | 0x322752a |
| 8453 / vault | 0x238a358808379702088667322f80ac48bad5e6c4 | 0x678bab6ace02b3fc508054b194f3f70190a0621f51bcae69be33cc5416031908 | 0x322752a |
| 8453 / router | 0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43 | 0x8efb4345abb93beb898eb5674f03118003594d744fcb9eb0f261cf942b609146 | 0x322752a |
| 8453 / factory | 0x420dd381b31aef6683db6b902084cb0ffece40da | 0xe2a176e5d2bcfb214b784ec6d6733708a6376a464f203cc265c284c9f349fea3 | 0x322752a |
| 8453 / registry | 0x5c3f18f06cc09ca1910767a34a20f771039e37c0 | 0xd4a9f98ebd41e4c4e7ae646f1a1f8eaa1205100906f34299a3cd7e4ed567c929 | 0x322752a |
| 8453 / slipstream | 0x698cb2b6dd822994581fea6ea4fc755d1363a92f | 0xfedc4e21e1097b0ec1b4f1aa901cf645c22f9e5d297727b0f37275ee1d083df4 | 0x322752a |
| 8453 / clFactory | 0xf8f2eb4940cfe7d13603dddd87f123820fc061ef | 0x4961963494e47f363617ab9a0f3999a28b33c519e51392952db06350cce700bd | 0x322752a |

The generated list records 35 observed deployments and two zero EIP-1967 slots per accepted deployment. Runtime verification requires exact routers and singleton manager/state-view pins. Capture alone is not an audited source-to-bytecode proof. Future drift requires explicit source/deployment review and no auto-activation.

| Solana program | Loader / ProgramData | Observed program-account digest | Deployment snapshot slot |
|---|---|---|---|
| ComputeBudget111111111111111111111111111111 | NativeLoader1111111111111111111111111111111 / builtin/non-upgradeable | 005950c007e8e550a16beddf836f0082d26d197f5f645ff7c04a5c8d171cf8a1 | 456788797 |
| ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL | BPFLoader2111111111111111111111111111111111 / builtin/non-upgradeable | 6804554e69fd3a58caa191dc4a58f4c67223d30ca28ab8987f39fc18d2f7374d | 456788798 |
| TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA | BPFLoaderUpgradeab1e11111111111111111111111 / 3gvYRKWyXRR9xKWe1ZjPhLY5ZJRN7KDB4rFZFGoJfFk2 | 5b31219b7bc4060b1638b933be5f50df3400109acfef12408a196d57ad119748 | 456788799 |
| 11111111111111111111111111111111 | NativeLoader1111111111111111111111111111111 / builtin/non-upgradeable | c94b792a6d8b25d3e53ea94d8b80111735ed80d6a7dc8deb937cd342707f5f03 | 456788799 |
| JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4 | BPFLoaderUpgradeab1e11111111111111111111111 / 4Ec7ZxZS6Sbdg5UGSLHbAnM7GQHp2eFd4KYWRexAipQT | 77969e6c064ab31f68250951941ad20690dfc23e97870e63006ccdad39c8a47e | 456788799 |
| whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc | BPFLoaderUpgradeab1e11111111111111111111111 / CtXfPzz36dH5Ws4UYKZvrQ1Xqzn42ecDW6y8NKuiN8nD | 5ba0ae1569444542b67322d0f333b289d738efead363c02436c7869cf33c2928 | 456788801 |
| TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb | BPFLoaderUpgradeab1e11111111111111111111111 / DoU57AYuPFu2QU514RktNPG22QhApEjnKxnBcu4BHDTY | bae3e5d63e30c0c3e6fe788b9e027bf003ca5e5bb46d3a9627e034bb3002ea5c | 456788802 |

Upgradeable programs additionally pin the complete 45-byte ProgramData deployment slot/authority header before and after simulation. Program-account digest is not described as an ELF implementation hash. Current accepted Jupiter program: JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4; independently decoded AMM: whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc. SPL, Token-2022, ATA, System and ComputeBudget are bounded explicit categories. Unknown programs stay closed.

Every repository/API/RPC/SDK license and commercial-use/branding/attribution term remains LEGAL_REVIEW_REQUIRED until counsel records a reference. Credentials: Uniswap/Jupiter keys and Titan endpoint/auth absent in this task; PCSX opt-in absent by default. No key value is captured. No independent audit or commercial approval is claimed.
