# G5 legacy runtime security review (V1.6, internal)

**This is an internal executor review, not an independent external audit.** `INDEPENDENT_EXTERNAL_SECURITY_REVIEW = NOT_RUN`.

Evidence root: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476` (security/, fork-tests/, build/).

## Scope — exactly what runs on chain

| Component | Address | Exact source (byte-for-byte reproduced) |
|---|---|---|
| ONE bridge implementation | `0x2827865ad5330faf855af8b743c701ae9c818034` | to-nexus/bridge-contracts `b3b0258` (v1.0.3) `src/CrossBridge.sol` |
| BSC bridge implementation | `0xac7b8ffed19d670930b8caa0693189b33454e8d8` | `6da2fb2` `src/BSCBridgeV2.sol` |
| BridgeVerifier (ONE `0x4a508a3d…`, BSC `0xf4dc7ff0…`, identical runtime) | — | `23a66d7` `src/BridgeVerifier.sol` (runs 162, no viaIR, cancun) — `build/verifier/` |
| BSC CROSS token | `0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510` | to-nexus/cross-token `contracts/CrossToken.sol`, OZ 5.1.0, solc 0.8.22, runs 200, paris — `build/token/` |
| Proxies | ONE `0xb81d…c0de` (genesis predeploy), BSC `0xa6a1…06c5` | OZ ERC1967Proxy (CrossScan-verified for ONE; BSC proxy runtime hash pinned) |

Not build-verified (read live only): PriceFeed `0xf90d3aF823D8aCCc91C36c29B2691977f8171423` (feeds the verifier's minimum / network-fee computation; its output is re-read and simulated per quote and has no reserve effect).

## Method

1. Manual review of the exact live sources (payout, accounting, signature, pending, pause, fee, upgrade paths).
2. Slither 0.11.3 (pinned, isolated venv) on both exact trees: `security/slither-one.json`, `security/slither-bsc.json` (57 / 55 results; triage below).
3. Local fork tests on live state (forge 1.5.1; in-memory forks; final run at ONE block 45672585 and BSC block 125743423; local-only keys/impersonation): 22/22 PASS (20 behavioural tests + 2 fork-pin records) — `fork-tests/fork-tests-final.log`.
4. Read-only `eth_call` probes of 11 privileged/initialization paths per chain from an unprivileged address: 22/22 revert with the expected exact-ABI errors — `security/privileged-path-probes.json`.
5. Diff of every upstream fix made after the live builds (release/v1.1, audit/certik-260922*) and classification.
6. Live role/trust enumeration — `security/role-holders.json`.
7. Selector matrix: live dispatcher selectors == exact-build ABI on both chains (58/58, 56/56) — `security/abi-selector-matrix.json`.

## Findings

| ID | Severity (internal) | Finding | Affects ONE→BSC native route? | Otherbridge handling |
|---|---|---|---|---|
| G5-SR-01 | **High (trust/centralization, not a code bug)** | One EOA `0x22c1…f37c` holds DEFAULT_ADMIN+ADMIN on both bridges and both verifiers: instant UUPS upgrade, verifier swap, threshold change, `removePending`. Settlement = 2-of-3 validator EOAs (same three on both chains). `VERIFIER_ROLE` (single EOA `0xe7ba…5b`) can release any pending item to any recipient. No timelock or multisig is observable on chain. | Yes — the route's safety reduces to these keys. | Runtime-drift policy pins implementation/proxy/verifier code, validator set, threshold, admin and VERIFIER_ROLE sets; any change → `REVIEW_REQUIRED`, non-executable. Must be accepted explicitly by the owner before any G7. |
| G5-SR-02 | Medium (CBU-09 class, fixed upstream only after the live builds) | Live code accepts `to == bridge` on ONE initiation and pays it on BSC finalize: `deposited` drops while the balance does not (stranded credit). Fork-proven on both sides. | Only for a user who sets the bridge as recipient. | Quotes require recipient = the connected empty-code EOA; V1.6 adds an explicit `isBridgeContract` guard (`UNSUPPORTED_ACCOUNT`). |
| G5-SR-03 | Low (CBU-11 class) | Live native path requires `msg.value == value + fee` exactly; fee movement between quote and send reverts (gas loss only). Fork-proven (+1/−1 wei both revert). | Yes (liveness/gas only). | Exact-value calldata from a ≤60 s quote, re-simulated at a pinned block. |
| G5-SR-04 | Low (liveness) | A finalize larger than `deposited` reverts the whole batch (checked subtraction) and stalls the ONE→BSC index queue until operator action. ONE `minted` exceeds BSC `deposited` by the dead-wallet burn total (≈14.78M CROSS, sitting in dead wallets on ONE), so this needs a transfer of ≈ the whole circulating supply. Fork-proven. | Not for any realistic amount. | Reserve model bounds the route maximum by `min(balance, deposited) − pending − in-flight`. |
| G5-SR-05 | Medium on ONE (not route-relevant) | `permitBridgeTokenBatch` is public on the live ONE build (INITIATOR_ROLE gating exists only in the BSC build): a holder of someone's ERC-20 permit can bridge that owner's tokens to the same owner address with chosen chain/value. | No — native route uses no permits. | Otherbridge never requests permits/approvals for this route. |
| G5-SR-06 | Info | Amount-based circuit breakers are disabled on both verifiers (verificationAmountThreshold = 0, periodTotalValueThreshold = 0; constructor values were $3M / $30M per 6h); ONE `crossSupplyLimit` = 1e27 (whole supply). Only manual pause remains. | Yes (no automatic delay of large payouts). | Read live each snapshot; reported in the route snapshot. |
| G5-SR-07 | Info | Slither High items triaged: `arbitrary-send-eth` = paying the validator-signed recipient / dev fee (intended); `reentrancy-eth` = every external state-changing entry point is `nonReentrant` (transient guard) and value calls are gas-capped at 100k; `msg-value-loop` (ONE native permit batch) = not exploitable: `safePermit` calls `allowance/permit` on `address(1)` (precompile, no code) and reverts — fork-proven (`test_NativePermitBatchDoubleCountImpossible`). Medium items (ignored approve(0) return, burn return in executor fallback, uninitialized `remaining`=0) are intended/benign. | — | — |
| G5-SR-08 | Info | Upgrade, initialization and role paths are closed to non-holders (22/22 probes revert: `InvalidInitialization`, `AccessControlUnauthorizedAccount`, `UUPSUnauthorizedCallContext`). | — | Continuous drift monitoring. |
| G5-SR-09 | Info | CROSS token: no mint, no pause/blacklist, not upgradeable; `burn` is owner-only on the owner's own balance; `burnFrom` needs allowance. Bridge-held CROSS cannot be moved or burned by token-level privilege. | — | Token runtime hash pinned. |

Upstream fixes after the live builds (not deployed): CBU-03 (value-limit whitelist bypass via executor — the whitelist does not exist in the live builds: N/A), CBU-09 (G5-SR-02), CBU-10 (HyperMintableERC20 only: N/A), CBU-11 (G5-SR-03). CertiK Skynet lists "CROSS - Bridge Audit", "CROSS - Bridge Update" and "Cross- bridge-contracts - Audit" for the project; finding details were not retrieved and no claim is made from them. No public incident specific to this bridge was found (bounded web search, recorded in the source inventory).

**Critical: 0. High: 1 (G5-SR-01, trust model, not exploitable without the admin/validator keys). Unresolved route risk: settlement and upgrade authority are single-key / 2-of-3 EOA controlled; G5 PASS is point-in-time and depends on the drift monitor.**

## Fork-test inventory (local only)

BSC (exact BSCBridgeV2 behind the live proxy): finalize decrements `deposited` and balance exactly once; duplicate finalize rejected; out-of-order index rejected; non-validator signatures rejected; payout above `deposited` reverts the batch even when the balance covers it; the full `deposited − pending` is payable; insufficient balance → `TransferFailed` pending, index advances, release pays and decrements once, second release reverts; ADMIN `removePending` drops an obligation without touching `deposited`; VERIFIER manual release redirects to any recipient; finalize-pause parks as `TokenPaused`, global pause reverts; bridge-as-recipient creates a surplus; outbound deposit increases `deposited` by value and forwards the fee to `dev`.

ONE (exact CrossBridge behind the live proxy): native initiation decrements `minted` by value, forwards the fee to `dev`, keeps `bridge balance + minted = 1,000,000,000 CROSS`; below-minimum, ±1 wei msg.value, low network fee, zero recipient, unknown chain and paused pair all revert; bridge-as-recipient is accepted (CBU-09); native permit batch impossible.
