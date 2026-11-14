# R1 native read-only evidence and the remaining G5 gap

2 October 2026. This record is not a submission, fund-movement, audit or deployment approval. The real reader is on the `native-service.ts` → typed bounded `read-only.ts` → public RPC path; quote/health/track are wired to the real API handler. The write registry remains null and production submission=false.

## Runtime and ABI trace

Public bridge repository ref: `3a8347cd005d00e50af9194204a55da69f96ddfc`; official skill ref: `8ef4f05a88c053e42b8e17d37feff4207884f618`. The raw commit/ref records and the Solidity/ABI contents are under `evidence/otherbridge-v1/repair-r1/sources/`. A blob SHA was not used as a commit.

| Chain | Proxy / implementation | Keccak-256, decoded runtime bytes |
|---|---|---|
| ONE 612055 proxy | 0xb81d6e000000000000000000000000000000c0de | 0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b |
| ONE implementation | 0x2827865ad5330faf855af8b743c701ae9c818034 | 0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc |
| BSC 56 proxy | 0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5 | 0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b |
| BSC implementation | 0xac7b8ffed19d670930b8caa0693189b33454e8d8 | 0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22 |

Each real snapshot re-reads the implementation slot and the full code of the proxy and the implementation at a specific block number. The hash is not applied to the hex ASCII text; the hex is first decoded into a byte array. `live/discovery.json` contains the full raw runtime; `native-live-c/native-live-readonly.json` records the current chain/block/hash/slot/code/pair/fee/finality reads between 2026-10-02T04:48:12–04:48:22Z. ONE latest block 45441964, BSC latest block 125231111. The matching of the pins is not verified Solidity source-build or audit evidence.

The old frontend's six-field TokenPair and the old event layout did not match today's observation. The seven-field pair (`localToken, remoteToken, isOrigin, paused, pendingAmount, deposited, minted`) and the BridgeInitiated/BridgeFinalized/BridgePending decoder were tested against real raw public ABI responses and logs. `live/discovery.json` also contains the old, incorrect pair interpretation; **that interpretation is not authoritative**. The corrected raw responses are in `live/corrected-discovery.json` and `live/corrected-fresh.json`.

## Fee, limit, reserve and quote

Native source pair origin=false; the outgoing amount is bounded by the minted accounting. `crossSupplyLimit` is the reverse-direction native finalize check; it is not used as an outgoing max. Verifier getTokenConfig/calculateFee and the denominator, source/destination pair pause, destination finalize pause and token balance are actually read. The public source `BaseBridge._initiateBridge` requires exact `msg.value = amount + networkFee + exFee` for native; historical public calldata/event/value also show this relationship.

Current observation: minimum 5 ONE, network fee 0.18 ONE, service rate 0 and paused=false. `min(destination.deposited, tokenBalance) - pendingAmount` is a conservative accounting upper bound that does not go below zero; it is further narrowed by the source minted limit. **It is not an exact spendable reserve or a verified max.** Until the source-build/contract version matches, the related accounting semantics are not considered verified. The quote uses real eth_call + eth_estimateGas + gasPrice; there is an explicit 20% margin on a successful estimate, and there is no fixed gas/simulation fallback.

The 12 ONE quote of the selected historical public EOA returned `INSUFFICIENT_GAS_OR_BALANCE` because of the current insufficient balance. For another candidate, at most two 1000-block source log pages were read; no other suitable native EOA was found. No funds were moved or requested. The deterministic quote test uses real pair/fee ABI records, and the funded balance/gas simulation transport double is explicitly stated; this test is not live positive quote evidence.

## Public source → destination payout example

- Source hash: `0xa6d46ef91f760e68d999d1128ef2eee67e42dc7e05faea2d5ecec242c3a82a05`; block 45411356, 2026-10-01T20:18:04Z; BridgeInitiated index 98483.
- Destination hash: `0xb37fdb02cdf4ec49531368857f696d911f95619f938397099a86b06e4d55db1f`; block 125163152, 2026-10-01T20:18:24Z; canonical CROSS Transfer log index 199, BridgeFinalized log index 200.
- Beneficiary is the same public EOA `0x680ea0e0cb5c52b54f47f118067bd49e6e9be898`; net amount `12094599106825003813`. The source native input/value/fee/event, chain/token/recipient/index and the destination bridge→beneficiary payout log all match together.

`live/public-settlement.json` contains the raw receipts/transactions/canonical blocks/finalized headers/decoded logs/request records. The public history API is only a destination hash hint; its state/status does not count as evidence. The service inspects at most 3×20 history items per owner; an old record that is not found remains pending/unverified. The import/storage destination hash is also a hint and does not block recovery to correct public receipt evidence. Unrelated swap records in the API are disregarded. BSC getLogs was observed to be closed/archive access restricted; the protection was not bypassed, and the example was verified with a keyless direct receipt read.

## Finality trust model

Instead of an arbitrary 3/5 confirmations, the `eth_getBlockByNumber("finalized", false)` response of both nodes and the canonical hash of the receipt block are used. The BSC finalized tag is defined in the [official API documentation](https://docs.bnbchain.org/bnb-smart-chain/developers/json_rpc/bsc-api-list/). The [go-cross node sources](https://github.com/to-nexus/go-cross) were stored with the pinned `go-cross-ref.json`; `api_backend.go` binds the finalized tag to CurrentFinalBlock, and `blockchain.go` updates the safe/finalized header on the Istanbul canonical insertion path. This is a read-only policy that trusts RPC/node responses; it is not an independent light-client/validator proof.

## Remaining narrow external information

Solc `0.8.28+commit.7893614a` was verified against the official binary SHA-256; OpenZeppelin core `acd4ff74de833399287ed6b31b4debf6b2b35527` and upgradeable `3d5fa5c24c411112bab47bec25cfa9ad0af0e6e8` were pinned. `34019062c601a6b78812a983dce0b4dc003a9c2f`, `36e27b9ffe52f7888f56d0ad70a0bdbc2b569471` and current Legacy `3a8347cd005d00e50af9194204a55da69f96ddfc` were tried with optimizer=1, viaIR true/false. The Standard JSON sources/settings/dependencies and the full compiler results are in `compile-input-*.json`, `runtime-source-comparison-b.json`, `runtime-source-comparison-current.json`. No full runtime or executable prefix match was found; some non-IR versions produced stack-too-deep. The current non-legacy CrossBridge additionally contains a linked ForwardLib; its hash is not used as deployment evidence. The Legacy/UUPS immutable address substitution is a diagnostic assumption, and no positive source match is claimed.

Last bounded retry `sources/metadata-retry-c.json`: requests to each chain's runtime CBOR IPFS CID returned 429; the Sourcify full/partial metadata addresses returned 404 (6 requests, 8-second timeout per request, 1 MiB response limit). The old request/failed compile outputs have been preserved. Selector/view success is not substituted for a source match.

Minimum operator information required: for these two implementations, the exact solc Standard JSON input/metadata actually used in the deployment (compiler, optimizer/viaIR/EVM/metadata settings, source paths/contents, dependency and linked-library/immutable information) or a verified-source record that produces exact runtime equality with them; the native outgoing/destination pending-deposited reserve semantics of the same version. No private key, user funds or signing authority is required. Without this information **G5 BLOCKED**, the write gate is closed; G7/G8 were not run.

## 2 October checkpoint-review continuation

New actual probe at07:11:25Z–07:11:36Z (continue-checkpoint-d/live-readonly/) matched pinned current implementations and observed historical index98483 payout again. Main public EOA quote rejected INSUFFICIENT_GAS_OR_BALANCE; two bounded1000-block pages found one additional native EOA below the probe amount. No successful live quote claimed. Accounting bound913509237704937756235899803 remains unverified. Earlier compiler mismatch/IPFS429/Sourcify404 evidence retained without rerunning same failed combinations. Source-build and spendable-reserve G5 BLOCKED. Current tracker searches max3x20 history even after stored HELD/reorg evidence; exhausted search is explicitly bounded, not proof of non-delivery. [EIP-1193](https://eips.ethereum.org/EIPS/eip-1193) was reread for accountsChanged grant ordering and4001 semantics; permission/rejection code changes are verified with isolated provider doubles, not physical wallets.
