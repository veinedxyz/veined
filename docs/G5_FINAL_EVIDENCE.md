# G5 V1.6 — PASS (current)

Gates: A PASS · B PASS · C PASS · D PASS · E PASS · F PASS · G PASS · H PASS · I PASS · J PASS. Evidence `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476`; decision `manifests/G5_DECISION.json`; closure [G5_FINAL_AUTONOMOUS_CLOSURE](G5_FINAL_AUTONOMOUS_CLOSURE.md). The V1.2 blockers listed below (exact build, spendable reserve, second payout proof) are closed by V1.6 evidence; the accepted funded-address simulation is refreshed at the final pin. Historical text below is preserved unchanged.

---

# G5-A5 funded public address — PASS_READ_ONLY_SIMULATION

Current result: **POSITIVE_SIMULATION**. G5-A5 = **PASS_READ_ONLY_SIMULATION**; overall G5 = **BLOCKED**. Existing V1.2 and all prior evidence remain preserved. This work closes only the current source-side read-only simulation prerequisite.

Actual observation: 2026-10-03T10:01:24.887Z–2026-10-03T10:01:30.147Z (UTC), public ONEchain address and BSC recipient `0x28136a77ec8ba3d918114712a588b4095ba12a6b`. Valid 20-byte EVM address; source `eth_getCode=0x` at the pinned block (empty-code EOA observation, no ownership/key-control claim); destination code also `0x`. Balance is recorded only inside the evidence directory in `balance.json`, `exact-msg-value.json` and the raw RPC payloads. No wallet connection or funding was used.

Evidence: `evidence/otherbridge-v1-2/g5-funded-address-20261003T095753072Z/`. `request-response.json` retains exact requests and actual adapter-extracted result/error payloads; it does not claim to be an unfiltered HTTP capture. `live-state.json`, `pinned-block.json`, `pair-reads.json`, `fee-reads.json`, `calldata.json`, `eth-call.json`, `eth-estimateGas.json`, `negative-control.json`, `canonical-recheck.json`, `evidence-audit.json` and `SHA256_MANIFEST.json` bind the observation.

| New observation | Actual value |
|---|---|
| ONE chain/block | 612055 / 45547156 (`0x2b6fe94`) |
| ONE block hash | `0x10bc4696569e79ec41483adc2b7168764e1903a028c6711af42555bc3da31193` |
| BSC chain/block | 56 / 125464778 (`0x77a70ca`) |
| BSC block hash | `0x4e63073c794326d92eb94bd6f57b20780da63049951c193628e127446d3c4c7f` |
| Source proxy / current implementation | `0xb81d6e000000000000000000000000000000c0de` / `0x2827865ad5330faf855af8b743c701ae9c818034` |
| Implementation Keccak-256 | `0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc` |
| Source verifier | `0x4a508A3dde9EBE1A6b3C347fE4aCed78500d2818` |
| Native sentinel / remote CROSS | `0x0000000000000000000000000000000000000001` / `0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510` |
| Combined pause | false (both proxies, both pair flags and BSC finalize pause freshly read) |
| Live minimum / network fee / service fee | 5 ONE / 0.18 ONE / 0 ONE |
| Exact msg.value | 5.18 ONE = `5180000000000000000` base units = `0x47e30e8e20860000` |
| eth_call | success, ABI bool true |
| eth_estimateGas | success, 126551 (`0x1ee57`) |
| Current node gas-price suggestion / estimated cost | 4000000000 wei / 0.000506204 ONE |

Both positive RPC methods use the **same explicit pinned ONE block**, real public `from`, exact source proxy `to`, identical `bridgeToken(56,nativeSentinel,address,liveMinimum,currentNetworkFee,currentServiceFee,0x)` calldata and exact value. No state override is supplied. Gas cost is separate from msg.value; the observed balance covers both the estimate and the existing quote policy's 20% gas margin. The gas-price suggestion is a current `eth_gasPrice` read without a block-tag parameter. Both pinned block hashes were canonically reread after the simulations. This is point-in-time node evidence, not a light-client proof or destination payout guarantee.

Adversarial control: live minimum minus one wei (`4999999999999999999` base units), with fees independently recalculated for that amount and matching exact value. Pinned `eth_call` and `eth_estimateGas` both return RPC code 3, `execution reverted`, data `0x58e88785`, decoded as `BaseBridgeInvalidAmount()`. This establishes the expected contract rejection. The error-signature label is observed diagnostic compatibility and does not establish exact deployed source/build provenance.

32 bounded actual RPC requests, one supplied public address, no history scan or retries required. The isolated opt-in probe and its config were added; no existing application/ABI/registry/verifier source changed. **253 unit / 46 integration / 1 live evidence probe PASS**; repaired typecheck, targeted lint/format and safety retest exit 0. The first import-name typecheck failure and safety wrapper filename collision are retained, with repairs and final receipts. Probe PASS alone is not G5 PASS; the independent evidence audit checks the actual positive and adversarial payloads.

Remaining blockers are unchanged: **exact deployment source/build for both implementations; same-version spendable reserve and complete pending/obligated reserve reconciliation; a second independent canonical ONE archive payout proof**. ReserveEvidence remains verified=false. Financial execution remains enabled=false with sign/approve/broadcast/deploy=null and source/destination write registry=null. Real signatures=0, approvals=0, broadcasts=0, deploys=0. G7, production release, V2 and V3 were not opened.

The complete pre-existing evidence text below is historical and preserved unchanged. Its former A5 blocker and item 4 in the old closure list are superseded only by the new funded-address evidence above. Source/build, reserve and archive blockers remain current.

---

# Otherbridge V1.2 — G5 final evidence

G5 = **BLOCKED**. This milestone authorizes public read-only research and local verification only. Successful probe tests verify the observer and safety boundary; they do not mean that G5 passed.

Evidence root: `evidence/otherbridge-v1-2/v12-20261003T080544442Z-eb1c84/g5/`. All timestamps are UTC. The current native observation ran 2026-10-03 08:06:53–08:07:03; independent pair/token/history reads followed at 08:08:43–08:08:50. Candidate investigation finished at 08:24:28.

## Deployment identity — PASS at observed blocks

ONEchain chain ID 612055 proxy `0xb81d6e000000000000000000000000000000c0de` resolves through EIP-1967 to implementation `0x2827865ad5330faf855af8b743c701ae9c818034`. BSC chain ID 56 proxy `0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5` resolves to implementation `0xac7b8ffed19d670930b8caa0693189b33454e8d8`.

| Runtime | Keccak-256 of decoded bytes |
|---|---|
| ONE proxy | `0x0dac1e1deb9381d1139c43a9d49d022a4786242e90744abd0f77bf85375b548b` |
| ONE implementation | `0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc` |
| BSC proxy | `0x25b30cfa97d56a7b846443ce92558cf31d86e95966c5afa22dacb0213c52ff9b` |
| BSC implementation | `0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22` |

Pinned source block 45540286 (`0xb534d048028c4b25d87130cd2608c063f9790a7ac02f69c9a1c004c34a15f0c9`) and destination block 125449514 (`0x2e5b9ce1fe97f3eeb44e93a429d01f23199fa7b5a03f16ad371fd06f018bedec`) provide explicit observation context. Raw chain IDs, slots, code and calls are in `current-native/native-live-readonly.json`. The independently fetched official pair API agrees with these proxy addresses and ONE native sentinel `0x0000000000000000000000000000000000000001` → BSC CROSS `0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510`. Token code, hash, symbol, name, decimals 18 and total supply are preserved in `extra/independent-token-pair-history.json`.

## Source/build equivalence — BLOCKED

`deployment-build-equivalence.json` binds current live hashes to preserved R1 compilation inputs/results. The official current revision remains `3a8347cd005d00e50af9194204a55da69f96ddfc`. Previously tested revisions `34019062c601a6b78812a983dce0b4dc003a9c2f`, `36e27b9ffe52f7888f56d0ad70a0bdbc2b569471` and the current revision, solc 0.8.28+commit.7893614a and their recorded optimizer/viaIR/dependency settings produced mismatched full runtime and executable prefixes, or compiler errors. Those exact experiments were not repeated without new evidence; originals and SHA-256 hashes are included under `reused-build-evidence/`.

The official [contract repository](https://github.com/to-nexus/bridge-contracts/tree/3a8347cd005d00e50af9194204a55da69f96ddfc) contains a legacy test contract whose behavior was explicitly adapted. Its foundry settings or a matching ABI are insufficient to prove the deployed build. Current repository history/tags/tree and source requests are preserved in `research/requests.json`. Bounded metadata requests returned rate limits/fetch failures; explorer endpoints returned 404/403. These failures are recorded, not bypassed. No source/build match was found.

Exact compiler version, optimizer, viaIR, EVM version, metadata/CBOR settings, dependencies, source paths, libraries, immutables and deployed revision are **unverified deployment provenance**. The UUPS `__self` substitution and metadata stripping in prior experiments are diagnostics, not acceptance evidence.

## ABI and current route

Read selectors and event layouts successfully decoded current pair, minimum, pause, fees and the proven historical sample. This establishes observed read compatibility only. Minimum was 5 ONE, network fee 0.18 ONE, service fee 0, paused false. The 12 ONE public-account quote failed `INSUFFICIENT_GAS_OR_BALANCE`. The bounded 5 ONE candidate attempt returned `RPC_ERROR` on a pinned implementation-code read; its transport call audit is in `candidates/public-candidates.json`. A single bounded fresh 5 ONE retest at 08:59 returned `INSUFFICIENT_GAS_OR_BALANCE` with successful read calls, resolving the transient read error without proving executability (`final-current/quote-retest.json`). No positive current end-to-end quote/simulation is established; A5 is BLOCKED. A revert or historical ABI decode cannot establish current executability or write compatibility.

## Reserve — BLOCKED, verified=false

Observed conservative bound: `913571641965111153887911413` CROSS base units. This is neither proven spendable liquidity nor a maximum executable transfer. Exact same-version implementation accounting, payout limits and complete pending/obligated reserve reconciliation remain absent. The explicit `ReserveEvidence` model therefore returns `verified:false` with the missing proof; UI retains the warning and production write rejection. Custody, total supply and historical payouts do not resolve this blocker.

## Historical payout evidence

Index 98483 is freshly revalidated using canonical finalized receipts and explicit proxy/token event policy: source `0xa6d46ef91f760e68d999d1128ef2eee67e42dc7e05faea2d5ecec242c3a82a05` block 45411356; destination `0xb37fdb02cdf4ec49531368857f696d911f95619f938397099a86b06e4d55db1f` block 125163152. BSC CROSS transfer log 199 precedes BridgeFinalized log 200, amount `12094599106825003813`, with matching recipient/index/route. Full evidence is in `current-native/native-live-readonly.json`.

A distinct official-history sample, index 92555, has destination receipt `0x5b5971eecb1e8fda6137f3dedab377082c49fb11fb2d673f19ea309cf97d6e6b`, but public ONE nodes return no source receipt for `0xa7acdd111e585156cbc6f23ea694c9f6db9b95b01b7fc9d48bb7857e7f694df4`. Indices 82484 and 40595 likewise lack source receipts. They remain TRACKING_UNAVAILABLE and do not count as independent completed payouts. Candidate/log requests were bounded: three history candidates, two 1000-block source pages, maximum three public accounts; no fabricated account, unlimited scan or transaction was used.

## Minimal information required to close G5

1. Authoritative deployment Standard JSON/metadata and exact sources/dependency revisions/settings/library addresses/immutable values for both current implementations, reproducibly matching full runtime bytes.
2. Same-version payout and reserve semantics plus complete pinned-block custody/pending/obligation reconciliation proving spendable reserve.
3. Canonical ONE archive receipt/block proof for a second independent payout candidate.
4. A bounded positive current simulation/quote from a publicly evidenced eligible account, requiring no funding, wallet connection, signature or broadcast.

Real signatures, approvals, broadcasts and deployments: **0**. G7 = NOT_RUN — USER_APPROVAL_REQUIRED. Production release = BLOCKED — RELEASE_APPROVAL_REQUIRED. No V2/V3 work was opened.
