# G5 final autonomous closure — G5 AUTONOMOUSLY VERIFIED

Decision: **G5 = PASS** (observed 2026-10-04T21:30:58.451052+00:00). Machine-readable: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/manifests/G5_DECISION.json`. Every gate below is computed by `scripts/g5-v16-decision.py` from evidence booleans only.

| Gate | Status | Key evidence |
|---|---|---|
| A_LIVE_DEPLOYMENT_IDENTITY | PASS | {"one": {"block": 45673416, "blockHash": "0xc6c6982939b7c464888d6a95e16935c306c95f5d0a9c4b8e7b255c32a051f859", "sourcesAgreeing": 2, "implementation": "0x2827865ad5330faf855af8b743c701ae9c818034", "runtimeKeccak256": "0x8bb2e9361035520a62a806cf78ff6f325d32c578 |
| B_ONE_EXACT_SOURCE_BUILD_EQUIVALENCE | PASS | {"commit": "b3b025852a100d6b825a85ab26e7895fde65e633", "compiler": "0.8.28+commit.7893614a", "settings": {"enabled": true, "runs": 1, "viaIR": true, "evmVersion": "prague"}, "fullRuntimeEqual": true, "initcodeEqual": true, "metadataCidEqual": true, "standardJs |
| C_BSC_EXACT_SOURCE_BUILD_EQUIVALENCE | PASS | {"commit": "6da2fb2d7a2fee2414fea894fe521f6362884569", "compiler": "0.8.28+commit.7893614a", "settings": {"enabled": true, "runs": 1, "viaIR": true, "evmVersion": "prague"}, "fullRuntimeEqual": true, "initcodeEqual": true, "metadataCidEqual": true, "standardJs |
| D_RESERVE_ACCOUNTING_SEMANTICS | PASS | {"source": "exact BSCBridgeV2@6da2fb2 (byte-proven)", "forkTests": "22 tests passed, 0 failed, 0 skipped", "historicalDeltaCases": 3, "historicalAllMatch": true} |
| E_PINNED_SPENDABLE_RESERVE_RECONCILIATION | PASS | {"pinnedBlock": 125745332, "physicalCrossBaseUnits": "913930007889002214383750352", "deposited": "913929997889002214383750352", "pendingAmount": "0", "activePendingSum": "0", "inFlightCount": 0, "spendableReserveBaseUnits": "913929997889002214383750352", "ledg |
| F_PAYOUT_PROOF_1 | PASS | {"index": "98483", "source": "0xa6d46ef91f760e68d999d1128ef2eee67e42dc7e05faea2d5ecec242c3a82a05", "destination": "0xb37fdb02cdf4ec49531368857f696d911f95619f938397099a86b06e4d55db1f", "checks": "46/46"} |
| G_PAYOUT_PROOF_2 | PASS | {"index": "98728", "source": "0x695c052e752401af212951b666afb80b036bc373a0dd223e76087ab7fe7a8c5e", "destination": "0x25c775e5164b0b445f3f221de0cc22e3e24a3639bc2fd83aefa9f42b39be808b", "checks": "46/46"} |
| H_CURRENT_POSITIVE_READONLY_SIMULATION | PASS | {"pinnedBlock": 45673526, "minimum": "5000000000000000000", "networkFee": "180000000000000000", "serviceFee": "0", "exactMsgValue": "5180000000000000000", "estimateGas": 126551} |
| I_NEGATIVE_CONTROL | PASS | {"controls": ["belowMinimumByOneWei: BaseBridgeInvalidAmount()", "wrongMsgValue(minus 1 wei): BaseBridgeInvalidValue(5180000000000000000,5179999999999999999)", "networkFeeBelowRequired: BaseBridgeInvalidAmount()", "unsupportedDestinationChain(97): RegistryNotE |
| J_RUNTIME_DRIFT_RECHECK | PASS | {"one": {"from": 45666340, "to": 45673691, "events": 0, "noDrift": true}, "bsc": {"from": 125729556, "to": 125745889, "events": 0, "noDrift": true}} |

## What was produced without operator e-mail

- Exact deployment builds of both live implementations reproduced byte-for-byte (full runtime after legitimate UUPS `__self` immutable substitution, initcode equal to the on-chain creation input, metadata CID equal) with official native and wasm solc 0.8.28, from the official Git history: ONE `b3b0258` (v1.0.3) `CrossBridge`, BSC `6da2fb2` `BSCBridgeV2`; additionally BridgeVerifier (`23a66d7`) and the CROSS token (to-nexus/cross-token, OZ 5.1.0, solc 0.8.22).
- Complete EIP-1967 histories of both proxies; implementation active at every proof block.
- Event-sourced BSC reserve ledger reconciled exactly at the pinned block, physical balance classified (pre-funding window, one 10 CROSS direct transfer), cross-chain identity ONE minted − BSC deposited = Σ dead-wallet burns.
- Three canonical payout proofs (indices 98483, 98728, 98727) with recomputed block-header hashes (incl. ONEchain Istanbul hashing), receipt-trie Merkle proofs against `receiptsRoot`, recovered validator signatures, and archive-verified implementation at the destination block. Old pruned candidate 92555 was not needed: public ONE nodes prune the tx-hash index but still serve `eth_getBlockReceipts`.
- Fresh positive read-only simulation and six negative controls at the final pin; runtime-drift recheck between the evidence pins and the final pins.

## Self-review (§93)

1. A Git comment was not treated as equivalence: the frozen legacy file was shown to differ today; equivalence rests on byte equality of the original tree.
2. Metadata-stripped/prefix equality is never used for acceptance; full runtime + initcode + CID equality is.
3. Implementations were verified at each historical proof block (archive state on BSC, complete Upgraded history on ONE).
4. Reserve uses the exact semantics with pending and in-flight obligations, not the token balance.
5. All pending indices were enumerated (`allPendingIndex`, complete set; legacy index 20 value 0).
6. Fees (forwarded to dev in-call) and the initial supply (unfunded credit later funded by the token owner) explain every balance delta; one direct 10 CROSS transfer is classified.
7. Source and destination index, recipient, principal and token are identical in each proof; source-destination are not same-value coincidences (index binding + validator-signed args).
8. Receipts are bound to canonical headers by recomputed hashes; BSC blocks are below the `finalized` tag on two operators; ONE blocks agree on two official endpoints and the official explorer index (same organisation — labelled).
9. Explorer data is labelled OFFICIAL_EXPLORER_INDEX / THIRD_PARTY and never substituted for RPC where RPC was available.
10. No current-implementation assumption for old payouts: each proof checks the implementation at its block.
11. The positive simulation is from the final pin; no state override; no signing.
12. Real transactions: 0 signatures, 0 approvals, 0 permits, 0 broadcasts, 0 deploys, 0 fee collection.
13. The route gate was strengthened (settlement-trust pins, verifier/token code pins, in-flight obligations), never weakened.

## Unchanged external statuses

INDEPENDENT_EXTERNAL_SOURCE_REVIEW = NOT_RUN · WEB_API_PENTEST_EXTERNAL = NOT_RUN · TRANSACTION_FIREWALL_EXTERNAL_REVIEW = NOT_RUN · LEGAL_REVIEW = NOT_RUN · OWNER_RELEASE_APPROVAL = NOT_RUN · G7 = NOT_RUN — USER_APPROVAL_REQUIRED · Production execution = DISABLED.

Route risk (not a G5 evidence gate, disclosed): Settlement and upgrade authority are EOA-controlled (single admin EOA; 2-of-3 validator EOAs); G5 is point-in-time and enforced by the runtime-drift policy (see docs/G5_LEGACY_RUNTIME_SECURITY_REVIEW.md G5-SR-01).
