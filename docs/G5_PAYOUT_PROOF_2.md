# G5 payout proof 2 — fresh independent recent proof

Result: **PASS** (46/46 checks). Index **98728**. Full machine-readable proof: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/payouts/payout-proof-2.json` (raw headers, receipts, Merkle proof nodes, signatures); RPC log `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/payouts/2-rpc.jsonl`.

| | Source (ONEchain 612055) | Destination (BSC 56) |
|---|---|---|
| Transaction | `0x695c052e752401af212951b666afb80b036bc373a0dd223e76087ab7fe7a8c5e` | `0x25c775e5164b0b445f3f221de0cc22e3e24a3639bc2fd83aefa9f42b39be808b` |
| Block / hash | 45663074 / `0x2491978a2668ab459294bdf5e903cce8c54b5233c0dcef0a6ae83f434f551744` | 125722327 / `0x08d192f94a7e28174377fb9a3ada8ffba935e450f77eb93f53cb8a1e328f023e` |
| Time (UTC) | 2026-10-04T18:13:22.000Z | 2026-10-04T18:13:39.000Z |
| Emitter | proxy `0xb81d6e000000000000000000000000000000c0de` | proxy `0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5` |
| Event | BridgeInitiated(toChainID=56, index=98728) log 19 | CROSS Transfer log 329 → BridgeFinalized(fromChainID=612055, index=98728) log 330 |
| Recipient | `0x6dF82487b830866896Bd2Bd0281e4Fcf6C95d626` | `0x6dF82487b830866896Bd2Bd0281e4Fcf6C95d626` |
| Principal | 101063000000000000000 (101.063 ONE) | 101063000000000000000 (101.063 CROSS) |
| Fees | networkFee 0.18 ONE, exFee 0.0 | — |
| Canonicality | 5510 confirmations on both official endpoints + CrossScan block hash | block ≤ `finalized` tag (125734541) on two operators |
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
