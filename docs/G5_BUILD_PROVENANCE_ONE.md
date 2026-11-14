# G5 build provenance — ONEchain (612055) CrossBridge implementation

Result: **EXACT BUILD EQUIVALENCE = PASS** (full deployed runtime byte equality after substituting only the compiler-declared immutables; initcode equality; metadata CID equality). Evidence root: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476`.

## Live deployment

| Field | Value |
|---|---|
| Chain / implementation | 612055 / `0x2827865ad5330faf855af8b743c701ae9c818034` |
| Pinned block / hash | 45666340 / `0x0a7a4bd537cb14ac5ce99fad6f9c1908289011f8587584c4dd60ef4feba7de45` |
| Runtime bytes | 24225 |
| Runtime keccak256 | `0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc` |
| Runtime SHA-256 | `20d0e79679c06863292af1adaa76824147492fcbf4f5e7e2d7b91574582252d6` |
| RPC agreement | 1 source(s) identical implementation + hash: True |
| CBOR footer | solc 0.8.28, IPFS `QmYddPkn9oBGqBhZXsBUpYzggKNhq8fbe3dGABAUocxaqL` |
| Creation tx | `0xc16d6ab26b52d946010003f1fa9747745626e501b115b45659de6c8bf661de7d` (block 22464737, 2026-01-09T06:02:30Z, creator `0xc360f136d479b1a479e91e2f00b163911b7a4a41`) |
| Creation data sources | ONE RPC eth_getBlockByNumber(22464737,true) input (ONCHAIN_RPC); CrossScan creation_bytecode/raw_input (OFFICIAL_EXPLORER_INDEX) - byte-identical |
| Installed in proxy by | Upgraded(0x2827865a…) block 22473937, tx `0xbc3d0b0f6c75574391295a16f569e09e974f962f0494fa823ffe1a0604f7d85c` (ONE eth_getLogs + CrossScan logs) |

## Exact source

- Repository: https://github.com/to-nexus/bridge-contracts (full mirror clone, all refs).
- Build commit: `b3b025852a100d6b825a85ab26e7895fde65e633`; compilation target `src/CrossBridge.sol:CrossBridge`.
- Byte-identical source trees (same blobs for every metadata source and same lib pins) exist at 8 commits: `543d560`, `dacf1d0`, `f14ff63`, `6b38d00`, `b3b0258`, `1105a2f`, `45c07b1`, `41f770c`. The SOURCE is unique; which of these commits the operator checked out is not distinguishable and does not matter for byte equivalence.
- Dependencies (git submodule pins): `lib/openzeppelin-contracts` @ `acd4ff74de833399287ed6b31b4debf6b2b35527`; `lib/openzeppelin-contracts-upgradeable` @ `3d5fa5c24c411112bab47bec25cfa9ad0af0e6e8`.
- 49 source files are listed in the compiler metadata; every file's keccak256 was recomputed from the exact Git blob bytes (no CRLF conversion) and equals the metadata value. Full list with git blob ids, keccak256 and SHA-256: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/build/one/reproduction.json`.

## Compiler and settings

- Compiler: `0.8.28+commit.7893614a`; official native binary `solc-windows-amd64-v0.8.28+commit.7893614a.exe` SHA-256 `76a71001309810aafd0462d9b2f2612bf19b89550c866140edca26e533de06bc` and official wasm `soljson-v0.8.28+commit.7893614a.js` SHA-256 `72ef580a6ec5943130028e5294313f24e9435520acc89f8c9dbfd0139d9ae146` (both equal to binaries.soliditylang.org list.json).
- Settings (from metadata): optimizer enabled=True runs=1, viaIR=True, evmVersion=prague, metadata.bytecodeHash=ipfs, libraries={}, 12 remappings (forge auto-detected + remappings.txt).
- Libraries / link references: none (`{}`).
- Immutables: astId 636 @ 3137 (+32) = `0000000000000000000000002827865ad5330faf855af8b743c701ae9c818034` — UUPSUpgradeable.__self = address(this) (the implementation address); astId 636 @ 3576 (+32) = `0000000000000000000000002827865ad5330faf855af8b743c701ae9c818034` — UUPSUpgradeable.__self = address(this) (the implementation address). The value is exactly the implementation's own address; initcode equality independently proves it is constructor-derived (`address(this)`).

## Reproduction (independent of forge)

- Standard JSON input (minimal, rebuilt from metadata): `build/one/standard-json-input.json` SHA-256 `70c61f29b02b7420c7aaea7a55a73854c4ef80d02535e343fd6eb7cc85a74139`.
- Metadata: `build/one/metadata.json` SHA-256 `0fc08bc6098f0cb9093065bcf3e8643d6d31562b7850fdf63e7f099fc69ec6a3`; recomputed IPFS CIDv0 `QmYddPkn9oBGqBhZXsBUpYzggKNhq8fbe3dGABAUocxaqL` == live CBOR `QmYddPkn9oBGqBhZXsBUpYzggKNhq8fbe3dGABAUocxaqL`: **True**.
- Native solc output SHA-256 `fe802d32ddc7955291fd4bb74badd1131d6b93f27aa4db08193fc681fe404044`; soljson output SHA-256 `fe802d32ddc7955291fd4bb74badd1131d6b93f27aa4db08193fc681fe404044`.
- Compiled runtime after immutable substitution: keccak256 `0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc`, SHA-256 `20d0e79679c06863292af1adaa76824147492fcbf4f5e7e2d7b91574582252d6`.
- FULL RUNTIME BYTE EQUALITY: native **True**, soljson **True**, forge **True**.
- INITCODE EXACT EQUALITY with the on-chain creation input (no constructor arguments): native **True**, soljson **True** (initcode keccak256 `0x0e76f55ca118f9ef61ba45be22a78dceaea1f108e5af6e57e602e4cb306f266e`).

Re-run: `python scripts/g5-v16-repro.py <chain> <checkout> <source> <contract> <liveRuntimeHex> <creationInputHex> <outRel>` (checkout = git worktree of the build commit with recursive submodules; sources are read from Git blobs). Metadata-stripped or prefix equality are NOT used for acceptance; they are only reported as diagnostics.

Machine-readable: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/manifests/deployment-build-equivalence-one.json`.
