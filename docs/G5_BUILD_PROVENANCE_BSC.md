# G5 build provenance — BSC (56) BSCBridgeV2 implementation

Result: **EXACT BUILD EQUIVALENCE = PASS** (full deployed runtime byte equality after substituting only the compiler-declared immutables; initcode equality; metadata CID equality). Evidence root: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476`.

## Live deployment

| Field | Value |
|---|---|
| Chain / implementation | 56 / `0xac7b8ffed19d670930b8caa0693189b33454e8d8` |
| Pinned block / hash | 125729556 / `0xf0d644e7d1f33e99fd75bdf6a8477f504baf54c96dd232f93d86d77ecd60bb3b` |
| Runtime bytes | 24407 |
| Runtime keccak256 | `0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22` |
| Runtime SHA-256 | `0d5c1b3c1f259511143b4a0e246448ae1b17f8c9b17db895f8c495f8533fcac0` |
| RPC agreement | 2 source(s) identical implementation + hash: True |
| CBOR footer | solc 0.8.28, IPFS `QmcFRDCCv3aS14tYDZTG5d52VMv9Vj376TkEbh4AnXnU7X` |
| Creation tx | `0x2e4b8cfec53d1fa182c8e33a6d8222985585aee834a6f89fd5bf3e79f36b450c` (block 92497755, 2026-04-14T13:52:50Z, creator `0x22c1522276855b028c31a731ba10d125811af37c`) |
| Creation data sources | BSC archive eth_getCode bisection (BlastAPI); eth_getTransactionByHash/Receipt from BNB Chain official + BlastAPI (identical input) |
| Installed in proxy by | Upgraded(0xac7b8ffe…) block 92498159, tx `0x48d20ea112446578cfc1c8db459e6e2b25aff02c2cc1a5c1f7e2b279372a78ea` (BSC eth_getBlockReceipts (BNB Chain official)) |

## Exact source

- Repository: https://github.com/to-nexus/bridge-contracts (full mirror clone, all refs).
- Build commit: `6da2fb2d7a2fee2414fea894fe521f6362884569`; compilation target `src/BSCBridgeV2.sol:BSCBridgeV2`.
- Byte-identical source trees (same blobs for every metadata source and same lib pins) exist at 8 commits: `4af9682`, `713827d`, `2e2cba9`, `6da2fb2`, `f719ce5`, `b6be327`, `f7661bc`, `99d9288`. The SOURCE is unique; which of these commits the operator checked out is not distinguishable and does not matter for byte equivalence.
- Dependencies (git submodule pins): `lib/openzeppelin-contracts` @ `acd4ff74de833399287ed6b31b4debf6b2b35527`; `lib/openzeppelin-contracts-upgradeable` @ `3d5fa5c24c411112bab47bec25cfa9ad0af0e6e8`.
- 49 source files are listed in the compiler metadata; every file's keccak256 was recomputed from the exact Git blob bytes (no CRLF conversion) and equals the metadata value. Full list with git blob ids, keccak256 and SHA-256: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/build/bsc/reproduction.json`.

## Compiler and settings

- Compiler: `0.8.28+commit.7893614a`; official native binary `solc-windows-amd64-v0.8.28+commit.7893614a.exe` SHA-256 `76a71001309810aafd0462d9b2f2612bf19b89550c866140edca26e533de06bc` and official wasm `soljson-v0.8.28+commit.7893614a.js` SHA-256 `72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146` (both equal to binaries.soliditylang.org list.json).
- Settings (from metadata): optimizer enabled=True runs=1, viaIR=True, evmVersion=prague, metadata.bytecodeHash=ipfs, libraries={}, 12 remappings (forge auto-detected + remappings.txt).
- Libraries / link references: none (`{}`).
- Immutables: astId 636 @ 3116 (+32) = `000000000000000000000000ac7b8ffed19d670930b8caa0693189b33454e8d8` — UUPSUpgradeable.__self = address(this) (the implementation address); astId 636 @ 3557 (+32) = `000000000000000000000000ac7b8ffed19d670930b8caa0693189b33454e8d8` — UUPSUpgradeable.__self = address(this) (the implementation address). The value is exactly the implementation's own address; initcode equality independently proves it is constructor-derived (`address(this)`).

## Reproduction (independent of forge)

- Standard JSON input (minimal, rebuilt from metadata): `build/bsc/standard-json-input.json` SHA-256 `a23403607286fd55feb7a5a7080381b898f696f798dcb64f04b5630d0679bdfa`.
- Metadata: `build/bsc/metadata.json` SHA-256 `9c9378f9514055eb82464656d822f57a45358df5faa2d8ef3b81b9560426f9a6`; recomputed IPFS CIDv0 `QmcFRDCCv3aS14tYDZTG5d52VMv9Vj376TkEbh4AnXnU7X` == live CBOR `QmcFRDCCv3aS14tYDZTG5d52VMv9Vj376TkEbh4AnXnU7X`: **True**.
- Native solc output SHA-256 `bf32b9f8c30e6e23a885f242ea20e4d01598593971ad98263ccc90772652c72d`; soljson output SHA-256 `bf32b9f8c30e6e23a885f242ea20e4d01598593971ad98263ccc90772652c72d`.
- Compiled runtime after immutable substitution: keccak256 `0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22`, SHA-256 `0d5c1b3c1f259511143b4a0e246448ae1b17f8c9b17db895f8c495f8533fcac0`.
- FULL RUNTIME BYTE EQUALITY: native **True**, soljson **True**, forge **True**.
- INITCODE EXACT EQUALITY with the on-chain creation input (no constructor arguments): native **True**, soljson **True** (initcode keccak256 `0x6e8dab6d66526a72b6a638c6190f982f1b323c0633a986b0ec6df0ef3c74d363`).

Re-run: `python scripts/g5-v16-repro.py <chain> <checkout> <source> <contract> <liveRuntimeHex> <creationInputHex> <outRel>` (checkout = git worktree of the build commit with recursive submodules; sources are read from Git blobs). Metadata-stripped or prefix equality are NOT used for acceptance; they are only reported as diagnostics.

Machine-readable: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/manifests/deployment-build-equivalence-bsc.json`.
