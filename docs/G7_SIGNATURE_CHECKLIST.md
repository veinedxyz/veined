# G7 signature checklist — for the LATER owner-approved pilot step (not executed here)

This preparation produced **no** signature, approval, permit or broadcast. Use this list only after a separate, explicit owner instruction. If ANY item differs, **abort** — do not "fix and continue".

## Before the wallet prompt
1. Owner has read the trust model and explicitly accepts: *"I understand that the verified ONEbridge route has centralized upgrade/settlement trust: single admin EOA and 2-of-3 validator EOAs."* (record it in the pilot record).
2. Refresh: run `pnpm g7:prepare <label>` and require **READY_FOR_OWNER_SIGNATURE** with quote age ≤ 60 s. Quote, fees, gas, value and reserve are ephemeral; the package from 2026-10-05T07:16:37.771Z is reviewable, not reusable.
3. If the refreshed minimum is above 5 ONE or msg.value above 5.18 ONE → **OWNER_REAPPROVAL_REQUIRED**, stop.
4. Recompute the intent digest from the refreshed `G7_UNSIGNED_TRANSACTION.json` (`normalizedOwnerIntent` + `intentDigest`) and compare with the refreshed `G7_INTENT_DIGEST.json`; the stable fields (from, to, recipient, chain, selector, pins, trust sets) must equal this preparation.
5. Fetch the **current** nonce in the wallet; the informational nonce (3) is not reserved.

## The wallet confirmation screen must show exactly
| Check | Required |
|---|---|
| Network | **ONEchain, chainId 612055** (not BSC, not a test network) |
| To / interacting contract | **`0xb81d6e000000000000000000000000000000c0de`** (ONEbridge proxy) — nothing else, no token contract |
| Value | **exactly 5.18 ONE** (`5180000000000000000` wei) at the refreshed quote |
| Data | starts with **`0x5fd262de`** (bridgeToken); recipient inside = `0x28136a77ec8ba3d918114712a588b4095ba12a6b`; destination chain 56; extraData empty |
| Approval / token permission | **none** — no approve, no permit, no allowance, no signature request of any other kind |
| Gas | limit ≈ 151,862 (estimate 126,551 + 20 %); max fee ≈ 5 gwei at preparation time; total gas well below 0.00075931 ONE |
| Unexpected interaction | none (no second transaction, no contract deployment, no message signature) |

Abort if the wallet shows a different contract, value, network, an approval, a permit, a typed-data/message signature, or a second transaction.

## After sending (read-only)
- The wallet "submitted" screen is **not** proof. Run `pnpm g7:track --tx <sourceHash>` (one shot, read-only).
- **No automatic retry:** if the source transaction reverts, is rejected, replaced or uncertain — do NOT resend; reconcile first.
- Completion only with: source receipt status 1 on a canonical block, exactly one `BridgeInitiated(toChainID=56)` with the expected recipient/amount, BSC `BridgeFinalized(fromChainID=612055, index)` preceded by `CROSS Transfer(bridge → recipient, amount)` on a finalized block, and an implementation consistent with the drift policy.
