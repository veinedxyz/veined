# G7 controlled pilot — preparation report (V1.7, PREP ONLY)

**G7_PREP = READY_FOR_OWNER_SIGNATURE** (2026-10-05T07:16:37.771Z). This is **not** G7 PASS and not a mainnet pilot. Real signatures 0 · approvals 0 · permits 0 · broadcasts 0 · deploys 0 · fee collection 0 · wallet prompts 0 · execution-gate changes 0. Evidence root: `evidence/otherbridge-g7-prep/g7prep-20261005T064401Z-0a8ac9` (final observation set: `evidence/otherbridge-g7-prep/g7prep-20261005T064401Z-0a8ac9/final/phase-b/attempt-1`). Owner card: [G7_OWNER_APPROVAL_CARD](G7_OWNER_APPROVAL_CARD.md) · checklist: [G7_SIGNATURE_CHECKLIST](G7_SIGNATURE_CHECKLIST.md) · record: [G7_PILOT_RECORD_TEMPLATE](G7_PILOT_RECORD_TEMPLATE.md).

## Gates (final observation set)
| Gate | Status | Reasons |
|---|---|---|
| P1 G5_CURRENT_DECISION_STILL_VALID | PASS | — |
| P2 SOURCE_RUNTIME_DRIFT_FREE | PASS | — |
| P3 DESTINATION_RUNTIME_DRIFT_FREE | PASS | — |
| P4 AUTHORITY_SET_DRIFT_FREE | PASS | — |
| P5 ROUTE_REGISTRATION_VALID | PASS | — |
| P6 ROUTE_UNPAUSED | PASS | — |
| P7 FEE_AND_MINIMUM_FRESH | PASS | — |
| P8 RESERVE_FRESH_AND_VERIFIED | PASS | — |
| P9 PENDING_OBLIGATIONS_ACCEPTABLE | PASS | — |
| P10 SOURCE_EOA_VALID | PASS | — |
| P11 SOURCE_EOA_FUNDED | PASS | — |
| P12 RECIPIENT_VALID | PASS | — |
| P13 UNSIGNED_CALLDATA_EXACT | PASS | — |
| P14 ETH_CALL_POSITIVE | PASS | — |
| P15 ESTIMATE_GAS_POSITIVE | PASS | — |
| P16 NEGATIVE_CONTROLS_PASS | PASS | — |
| P17 TRANSACTION_FIREWALL_PASS | PASS | — |
| P18 DUAL_RPC_CONSENSUS_PASS | PASS | — |
| P19 QUOTE_FRESHNESS_PASS | PASS | — |
| P20 NO_WRITE_PATH_EXECUTED | PASS | — |

## What was re-verified fresh (not taken from V1.6)
- Dual-RPC pins: ONE `45710058` (`0x80088acf0fb461a03538b84dcb51a678851abe4b1193d8f37e1b7b4ce18cdd10`) on both official endpoints; BSC finalized `125826663` (`0xde0021d2c5e8381d4b5b5d85cbe676023c157f402c591a7758fff3ade1d532c7`) on BNB Chain official + PublicNode. All critical values identical per source.
- Runtime: EIP-1967 implementation slots, implementation/proxy/verifier/token code hashes equal the G5 pins; admin/beacon slots zero; live dispatcher still contains `bridgeToken` (`0x5fd262de`).
- Authority: every role set of both bridges and both verifiers, threshold, dev, executor, price feed, circuit-breaker thresholds equal the V1.6 snapshot; admin/validator/VERIFIER_ROLE accounts still have empty code; no Upgraded/Role/Threshold/Verifier/Pause/Pair event on either proxy or verifier since the V1.6 snapshot pins.
- Pauses: global, chain, pair and finalize pauses false on both chains.
- Fees: minimum 5 ONE, network fee 0.18 ONE, service fee 0 ONE read from the live verifier at the pinned block; msg.value = integer sum = 5.18 ONE.
- Reserve: incremental event-sourced ledger from the accepted V1.6 pin 125745332 to 125826663: 37 + 0 bridge logs, 15 + 0 CROSS transfers, 5 deposits, 10 payouts, 0 unclassified, 0 anomalies; deposited / pendingAmount / balance / open pending set / index ranges exact. Spendable 913927728.855791322580189858 CROSS, effective maximum 913927728.855791322580189858 CROSS, valued pending 0 (legacy index 20 value 0 only), in-flight 0 (enumerated).
- Simulation (no state override, pinned block, both endpoints): eth_call true/true, estimateGas 126551/126551; negative controls: belowMinimumByOneWei → `0x58e88785` BaseBridgeInvalidAmount(); msgValueMinusOneWei → `0x943892eb` BaseBridgeInvalidValue(5180000000000000000,5179999999999999999); networkFeeBelowRequiredByOneWei → `0x58e88785` BaseBridgeInvalidAmount(); zeroRecipient → `0x8219abe3` BaseBridgeCanNotZeroAddress(); unsupportedTokenCrossOnOne → `0x2a612de6` RegistryNotExistToken(0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510); unsupportedDestinationChain97 → `0x2a612de6` RegistryNotExistToken(0x0000000000000000000000000000000000000001).
- Calldata: viem encoding = independent hand-written encoding; independent decoder + viem decoder agree with the intent; keccak256 `0xf447d8f5aa67a595e4e4afc77f3bdf73e36b14d1766eba8ce5b35081b7215ff5`.
- Firewall: existing `compareIntent` + G7 route checks PASS; 31/31 hostile mutations rejected (to=BSC bridge proxy: INTENT_MISMATCH; to=ONE implementation (proxy bypass): INTENT_MISMATCH; to=unrelated address: INTENT_MISMATCH; value+1wei: INTENT_MISMATCH; value-1wei: INTENT_MISMATCH; recipient=third party: INTENT_MISMATCH; recipient=BSC bridge (CBU-09): INTENT_MISMATCH; destinationChain=97: UNSUPPORTED_ROUTE; destinationChain=1: UNSUPPORTED_ROUTE; amount+1wei (value adjusted): INTENT_MISMATCH; amount-1wei (value unchanged): INTENT_MISMATCH; networkFee-1wei (value adjusted): INTENT_MISMATCH; networkFee+1wei (value adjusted): INTENT_MISMATCH; serviceFee+1wei (value adjusted): INTENT_MISMATCH; selector flipped: SELECTOR_MISMATCH; extraData=0x01: EXTRA_DATA_NOT_EMPTY; sourceToken=CROSS: UNSUPPORTED_ROUTE; trailing calldata byte: BAD_LENGTH; chainId=56: INTENT_MISMATCH; from=other account: INTENT_MISMATCH; platformFeeBps=1 (intent): SCHEMA_REJECTED; platformFeeBps=5 (context): PLATFORM_FEE_NONZERO; approval requested (spender=proxy): REGISTRY_MISMATCH; approval requested (context): APPROVAL_NOT_ALLOWED_FOR_NATIVE_ROUTE; minimumOutput+1: INTENT_MISMATCH; outputToken=wrapped substitute: INTENT_MISMATCH; quote expired (now=expiresAt): QUOTE_EXPIRED; quote age>60s: QUOTE_EXPIRED; route pins digest drift: ROUTE_PINS_DRIFT; implementation hash drift: IMPLEMENTATION_HASH_DRIFT; registry entry runtime hash drift: IMPLEMENTATION_HASH_DRIFT). Production SimulationGate still refuses with `EXECUTION_PAUSED` (global kill ON, empty registry, GLOBAL_EXECUTION_ENABLED=false).

## Settlement time (historical observation, not guarantee)
10 recent ONE→BSC CROSS transfers in the scanned windows: min 14 s, median 19 s, p90 27 s, max 27 s; accepted V1.6 proofs 20 s / 17 s / 14 s. Tracking policy (historical observation-derived policy, not a guarantee or SLA): normal observation window 300 s, escalation after 1800 s, source canonical after ≥ 64 confirmations; elapsed time alone never means failed.

## Post-send procedures prepared (not started)
- `pnpm g7:track --tx <sourceHash>`: one-shot read-only observer (no background job, no resend, no release). Dry run on a past public transfer: `evidence/otherbridge-g7-prep/g7prep-20261005T064401Z-0a8ac9/track/historical-dry-run-0xb4011e21-20261005T070447236Z.json` → COMPLETED.
- No automatic retry: revert/rejection/replacement/uncertainty → MANUAL_REVIEW_REQUIRED, reconcile first.
- BridgePending: inspect `getPendingArguments(612055, index)`; `releasePending` only when its reason has cleared and only as a NEW, separately owner-approved write; never automatic.
- Admin escalation: preserve source/destination proofs, prepare a support packet; nobody is contacted automatically; no admin/operator call is signed.

## Tests and safety
- Typecheck / lint / format: typecheck exit 0, lint exit 0, format-check exit 0
- Unit (all, incl. 37 G7): 566 passed (566) (V1.6 baseline 529 preserved)
- Integration: 216 passed (216) (V1.6 baseline 216 preserved)
- G7 tests against the final delivered artifacts: 37 passed (37)
- verify-safety (existing static boundary): exit 0
- G7 static safety scan: exit 0 (0 findings; app does not import src/g7)
- Not re-run (unchanged app/UI/data plane; src/g7 not imported by the app): E2E (151), DB (16), production build/smoke, staging - V1.6 results stand
- Logs: evidence/otherbridge-g7-prep/g7prep-20261005T064401Z-0a8ac9/tests/final

## Unchanged external statuses
INDEPENDENT_EXTERNAL_SOURCE_REVIEW = NOT_RUN · WEB_API_PENTEST_EXTERNAL = NOT_RUN · TRANSACTION_FIREWALL_EXTERNAL_REVIEW = NOT_RUN · LEGAL_REVIEW = NOT_RUN · OWNER_RELEASE_APPROVAL = NOT_RUN · trustModelAccepted = false · Production execution = DISABLED · G7 = NOT_RUN (preparation READY only).
