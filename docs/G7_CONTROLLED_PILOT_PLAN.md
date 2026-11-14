# G7 controlled pilot plan — PREPARED ONLY, NOT EXECUTED

**Status: G7 = NOT_RUN — USER_APPROVAL_REQUIRED.** Nothing in this plan has been signed, approved, permitted or broadcast. Production execution remains globally disabled (`GLOBAL_EXECUTION_ENABLED=false`). This plan requires a separate, explicit owner approval and acceptance of the trust model (single admin EOA, 2-of-3 validator EOAs).

## Route and pins

- ONEchain 612055 proxy `0xb81d6e000000000000000000000000000000c0de` → implementation `0x2827865ad5330faf855af8b743c701ae9c818034` (runtime keccak `0x8bb2e9361035520a62a806cf78ff6f325d32c578a63f35ad49263524361e04bc`, exact build `b3b025852a100d6b825a85ab26e7895fde65e633`).
- BSC 56 proxy `0xa6a1a0c1e6aba5fc6c84e856dcf81506e2be06c5` → implementation `0xac7b8ffed19d670930b8caa0693189b33454e8d8` (runtime keccak `0x47b60de2375276f3ead49ea41f35c58d068d6bd57625d3553db4257476f91f22`, exact build `6da2fb2d7a2fee2414fea894fe521f6362884569`); canonical token CROSS `0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510`.
- Verifier (both chains, identical runtime `0x4d8c535d…`), validator set (3 EOAs, threshold 2), admin and VERIFIER_ROLE sets are pinned in `src/g5/route-pins.ts`; any change → `REVIEW_REQUIRED` → abort.

## Smallest safe amount and exposure

- Amount: the live minimum **5.0 ONE** (one transfer only). Network fee 0.18 ONE, service fee 0.0 ONE → exact `msg.value` **5.18 ONE** (the live code requires exact equality).
- Gas: estimate 126551 at the final pin; budget with the existing 20 % margin at the then-current gas price.
- Maximum financial exposure: 5.18 ONE + gas. No approval, permit or allowance is ever created (native route).
- Reserve at the evidence pin: spendable 913,929,997.889002214383750352 CROSS (block 125745332); the pilot amount is 5.47e-09 of it.

## Preflight (all must hold immediately before any signature; otherwise abort)

1. Owner approval for G7 recorded; external security review status acknowledged (NOT_RUN at V1.6).
2. Fresh pins on both chains equal the G5 pins (implementations, runtime/proxy/verifier/token code hashes, validator set, threshold, admin, VERIFIER_ROLE) — `evaluateRouteDrift` = `VERIFIED_READ_ONLY`.
3. No pause: global, chain, pair initiate/finalize pause all false; `maxExtraDataLength` unchanged; extraData = `0x`.
4. Reserve: `deriveSpendableReserve` verified=true at a fresh pinned block with complete pending set and in-flight enumeration; spendable ≥ amount.
5. Fresh quote ≤ 60 s old: minimum/fee re-read from the verifier at the pinned block; `eth_call` returns true and `eth_estimateGas` succeeds for the exact calldata and value from the funded EOA; recipient = sender EOA (empty code on both chains, never a bridge/token contract).
6. Funded EOA balance ≥ exact value + gas budget; wallet chain = 612055; transaction preview shows `to` = ONE proxy, `value` = exact value, selector `bridgeToken`.

## Abort conditions

Any preflight failure; any drift reason; quote older than 60 s; fee or minimum change between quote and signing; RPC disagreement between the two official ONE endpoints; BSC finalize paused; pending queue non-empty with value > 0 for CROSS; validator/threshold change; implementation upgrade announcement.

## Post-send tracking

1. Source: receipt on ONE (status 1), `BridgeInitiated(toChainID=56, index=i, to=sender, value=amount)` from the proxy; record index i.
2. Destination: watch BSC for `BridgeFinalized(fromChainID=612055, index=i)` preceded by `CROSS Transfer(bridge → sender, amount)`; `nextFinalizeIndex(612055)` passes i; block ≤ `finalized` tag.
3. Produce a payout proof with `scripts/g5-v16-payout-proof.mjs` (header hash + receipt-trie proof + validator signatures) and attach it to the pilot record.

## Recovery plan

- If BSC records `BridgePending` (e.g. TransferFailed/TokenPaused): the record is visible via `getPendingArguments(612055, i)`; `releasePending` is permissionless once the reason clears; otherwise only the operator's VERIFIER/ADMIN roles can act (manual release / removal) — escalate to the operator with the proof.
- If the source tx reverts: only gas is lost (exact-value requirement or fee change); re-quote, do not resend blindly.
- If the destination never finalizes within the observed historical window: keep the record in `SETTLEMENT_PENDING`, re-check validator/threshold/pauses, escalate to the operator; never retry the source transfer.
