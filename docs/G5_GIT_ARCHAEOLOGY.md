# G5 Git archaeology — to-nexus/bridge-contracts

Full mirror clone (all 95 refs; 361 commits; `dev` = `3a8347cd005d00e50af9194204a55da69f96ddfc`). Raw output: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/git/git-archaeology.json`.

## Timeline relevant to the live implementations

| When (UTC) | Event | Evidence |
|---|---|---|
| 2025-04-16 | `v1.0.0` tag (8848679): first bridge release (CrossBridge/BSCBridge, runs 162, no viaIR) | git |
| 2025-04-28 12:27 | BSC proxy `0xa6a1…06c5` created with impl `0xd9a946f7…` and `initializeBSCBridge(..., crossInitialSupply=20,000,000e18)` | BSC creation tx `0x68d24b70…` |
| 2025-04-28 12:39 | ONE predeployed proxy initialized: `initializeCrossBridge(..., crossInitialSupply=20,000,000e18)` | ONE block 452398 tx `0x8031581f…` |
| 2025-10-02 | BSC upgraded to `0x68ceaecf…` (BSCBridgeV2 reinitializer(2)); BridgeVerifier `0x4a508a3d…`/`0xf4dc7ff0…` deployed from `23a66d7` era | BSC Upgraded tx `0x82162d31…`; CrossScan |
| 2026-01-08/09 | CertiK CBU-29…32 fixes; `v1.0.3` tag `b3b0258` (11:50 KST) | git |
| 2026-01-09 06:02 | ONE impl `0x2827865a…` created (tx `0xc16d6ab2…`) | ONE block 22464737 |
| 2026-01-09 08:35/08:36 | ONE proxy and BSC proxy upgraded (ONE → `0x2827865a…`; BSC → `0x71f6901b…`) | Upgraded logs |
| 2026-04-14 13:52 | BSC impl `0xac7b8ffe…` created; upgraded at 13:55 | BSC blocks 92497755 / 92498159 |
| 2026-04-14 21:52 KST | master merge `6da2fb2` (PR #38: INITIATOR_ROLE permit batch + extraData) | git |
| 2026-09-09 | `test/legacy/CrossBridgeLegacy.sol` introduced as "frozen copy" (a194972) | git |
| 2026-09-16 | the "frozen" file edited (`address to` added) in 82b7c0f | git |
| 2026-10-02 | `release/v1.1`: CertiK 2026-09 audit fixes CBU-03/09/10/11 (not deployed) | git |

## Exact-build commits (from the byte-for-byte reproduction)

- ONE implementation: `b3b025852a100d6b825a85ab26e7895fde65e633` (`v1.0.3`); identical source class: `543d560` (2026-01-08), `dacf1d0` (2026-01-08), `f14ff63` (2026-01-08, refs/heads/legacy/dev, refs/pull/35/head), `6b38d00` (2026-01-08, refs/heads/fix/audit-260108, refs/pull/33/head), `b3b0258` (2026-01-09, refs/tags/v1.0.3), `1105a2f` (2026-01-09), `45c07b1` (2026-01-09), `41f770c` (2026-01-09, refs/heads/deploy/260109).
- BSC implementation: `6da2fb2d7a2fee2414fea894fe521f6362884569`; identical source class: `4af9682` (2026-04-14, refs/heads/feature/permit-extradata-2, refs/pull/37/head), `713827d` (2026-04-14), `2e2cba9` (2026-04-14, refs/pull/38/head), `6da2fb2` (2026-04-14), `f719ce5` (2026-06-09, refs/heads/feature/bridge-bot-set-receipient-script, refs/pull/39/head), `b6be327` (2026-08-12, refs/pull/41/head), `f7661bc` (2026-08-12, refs/heads/docs/readme-external-en-ko, refs/pull/40/head), `99d9288` (2026-08-12, refs/heads/master).
- Both use OpenZeppelin contracts `acd4ff74…` and contracts-upgradeable `3d5fa5c2…` (submodule pins identical across the class).

## The "frozen exact code" claim (test/legacy/CrossBridgeLegacy.sol)

- Introduced by `a19497279f2f66eabc7aa427d354b35dbb28c41a`: "feat: introduce CrossBridgeLegacy as a frozen copy of CrossBridge for testing purposes". The banner names implementation `0x2827865a…`: True.
- At introduction, after reverting only the contract name and import paths, the body was identical to the live `src/CrossBridge.sol` of `b3b0258`: **True** (and to the pre-unification file: True; live CrossBridge.sol unchanged until unification: True).
- The current file (3a8347c) is NOT identical any more: 82b7c0f (2026-09-16) added `address to` to _checkFinalizeAmount to compile against the newer BaseBridge; the current file is therefore NOT a byte-for-byte copy of the live source body anymore.
- It imports the current `src/BaseBridge.sol`, which differs from the live build (231 diff lines). Compiling the frozen file today cannot reproduce the live runtime. Conclusion: the comment is correct provenance for the CrossBridge.sol *body* only; exact equivalence rests solely on the original `b3b0258` tree reproduced byte-for-byte (see G5_BUILD_PROVENANCE_ONE.md).

## Deployment / upgrade scripts

No Forge `broadcast/` artifacts are committed; no live implementation address appears in any script. Script paths ever committed: `script/BSCBridgeV2/BSCBridgeV2.s.sol`, `script/Bridge.s.sol`, `script/BridgeBotDeploy.s.sol`, `script/BridgeBotSetConfig.s.sol`, `script/BridgeBotSetRecipient.s.sol`, `script/BridgeCross.s.sol`, `script/BridgeEthereum.s.sol`, `script/BridgeExecutorDeploy.s.sol`, `script/BridgeSetValidator.s.sol`, `script/CrossBridgeDeploy.s.sol`, `script/CrossBridgeV2Deploy.s.sol`, `script/CrossMintableERC20V2.s.sol`, `script/CrossMintableERC20V2Code.s.sol`, `script/ForwardLibVerify.s.sol`, `script/HyperMintableERC20Code.s.sol`, `script/Implementation.s.sol`, `script/Multicall.sol`, `script/PriceFeed.s.sol`, `script/SwapBridgeRouterDeploy.s.sol`, `script/check/Check.s.sol`, `script/deploy/.env_base_bridge`, `script/deploy/.env_bsc_bridge`, `script/deploy/.env_cross_bridge`, `script/deploy/.env_price_feed`, `script/deploy/BSCBridge.s.sol`, `script/deploy/Bridge.s.sol`, `script/deploy/BridgeVerifier.s.sol`, `script/deploy/CrossBridge.s.sol`, `script/deploy/CrossMintableERC20V2.s.sol`, `script/deploy/Implementation.s.sol`, `script/deploy/PriceFeed.s.sol`, `script/deploy/SwapBridgeRouter.s.sol`, `script/deploy_v2/Bridge.s.sol`, `script/deploy_v2/CrossMintableERC20V2Code.s.sol`, `script/deploy_v2/Implementation.s.sol`, `script/deploy_v2/PriceFeed.s.sol`, `script/temp/CrossBridgeV2Temp.s.sol`, `script/test/verifier-settings-diff.test.sh`, `script/upgrade/BSCBridgeV2.s.sol`, `script/usdt_deploy/CrossMintableERC20V2.s.sol`, `script/verifier-settings-diff.sh`, `script/verifier/BridgeVerifier.s.sol`.
Live addresses mentioned anywhere in history: `2827865ad5…`: 2 commit(s); `ac7b8ffed1…`: 0 commit(s); `a6a1a0c1e6…`: 0 commit(s) (only the legacy banner).
