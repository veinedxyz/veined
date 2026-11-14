# G5 payout proof 1 — revalidated accepted proof (index 98483)

Result: **PASS** (46/46 checks). Index **98483**. Full machine-readable proof: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/payouts/payout-proof-1.json` (raw headers, receipts, Merkle proof nodes, signatures); RPC log `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/payouts/1-rpc.jsonl`.

| | Source (ONEchain 612055) | Destination (BSC 56) |
|---|---|---|
| Transaction | `0xa6d46ef91f760e68d999d1128ef2eee67e42dc7e05faea2d5ecec242c3a82a05` | `0xb37fdb02cdf4ec49531368857f696d911f95619f938397099a86b06e4d55db1f` |
| Block / hash | 45411356 / `0xec04ff8a1a627e84ccbf83b2133edfcd6e6e08ec9c78e909c546726294695db5` | 125163152 / `0x83ee73f3a73a9a884fbb144e402a2a85c3d8707bad22547b438e4194e579985d` |
| Time (UTC) | 2026-10-01T20:18:04.000Z | 2026-10-01T20:18:24.000Z |
| Emitter | proxy `0xb81d6e000000000000000000000000000000c0de` | proxy `0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5` |
| Event | BridgeInitiated(toChainID=56, index=98483) log 5 | CROSS Transfer log 199 → BridgeFinalized(fromChainID=612055, index=98483) log 200 |
| Recipient | `0x680eA0e0CB5c52B54f47F118067BD49E6e9BE898` | `0x680eA0e0CB5c52B54f47F118067BD49E6e9BE898` |
| Principal | 12094599106825003813 (12.094599106825003813 ONE) | 12094599106825003813 (12.094599106825003813 CROSS) |
| Fees | networkFee 0.18 ONE, exFee 0.0 | — |
| Canonicality | 257245 confirmations on both official endpoints + CrossScan block hash | block ≤ `finalized` tag (125734578) on two operators |
| Implementation at block | `0x2827865a…` (only Upgraded event ≤ block: 22473937) | `0xac7b8ffed19d670930b8caa0693189b33454e8d8` read from archive state at the block |
| Validators | — | 2 valid distinct signers ≥ threshold 2 (EIP-712 recovered from public calldata) |

Cryptographic binding: on each chain the block header was re-encoded and hashed to the reported block hash (ONE uses go-cross Istanbul filtered-extra hashing), the full block receipt list was re-encoded and its Patricia trie root recomputed to equal the header `receiptsRoot`, and a Merkle proof for the target receipt was generated and verified with `@ethereumjs/mpt` 10.1.3 (the stored proof re-verifies offline in `tests/unit/v16-g5.test.ts`).

## Checks

- PASS — source.chainId
- PASS — source.blockHashAgreesAcrossRpcs
- PASS — source.receiptsIdenticalAcrossRpcs
- PASS — source.headerHashRecomputed
- PASS — source.txInBlock
- PASS — source.receiptStatusSuccess
- PASS — source.receiptsRootRecomputed
- PASS — source.receiptMerkleProofVerifies
- PASS — source.exactlyOneBridgeInitiatedFromProxy
- PASS — source.toChainID=56
- PASS — source.index
- PASS — source.fromToken=nativeSentinel
- PASS — source.toToken=CROSS
- PASS — source.txTo=proxy
- PASS — source.calldata=bridgeToken(56,native,to,value,fees)
- PASS — source.msgValue=value+networkFee+exFee
- PASS — source.eventFrom=txFrom
- PASS — source.confirmations>=64
- PASS — source.explorerBlockHashAgrees
- PASS — dest.chainId
- PASS — dest.blockHashAgreesAcrossRpcs
- PASS — dest.receiptIdenticalAcrossRpcs
- PASS — dest.headerHashRecomputed
- PASS — dest.receiptsRootRecomputed
- PASS — dest.receiptMerkleProofVerifies
- PASS — dest.receiptStatusSuccess
- PASS — dest.txTo=proxy
- PASS — dest.exactlyOneBridgeFinalizedForIndex
- PASS — dest.fromChainID=612055
- PASS — dest.toToken=CROSS
- PASS — dest.canonicalCrossTransferBridgeToRecipient
- PASS — dest.transferPrecedesFinalized
- PASS — dest.noPendingEventForIndex
- PASS — dest.blockFinalized(finalized tag)
- PASS — dest.implementationAtBlock=exactBuildImpl
- PASS — dest.domainSeparatorMatchesLive
- PASS — dest.signedArgsMatchEvent
- PASS — dest.signersAscendingUnique
- PASS — dest.validSignatures>=threshold
- PASS — bind.sameIndex
- PASS — bind.sameRecipient
- PASS — bind.samePrincipal
- PASS — bind.sameToken
- PASS — bind.routeDirection
- PASS — bind.sourceBeforeDestination
- PASS — bind.signedValueEqualsSourceValue

Trust classes: source — ONCHAIN_RPC x2 (to-nexus official endpoints) + OFFICIAL_EXPLORER_INDEX block hash + header/receipt-trie recomputation (DERIVED); destination — ONCHAIN_RPC x2 operators (BNB Chain official, NodeReal) + archive state (BlastAPI) + header/receipt-trie recomputation (DERIVED).
Historical settlement evidence only; it is not a guarantee for future transfers.
