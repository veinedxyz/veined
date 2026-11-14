# Live canary: what the video shows and how it relates to this code

This repository is published **disarmed**. Nothing in it can sign, approve or send by default.

A real transaction can only run on a local, owner-armed copy of the same source. That copy differs from this repository in exactly two files and three constants:

| File | Public (this repo) | Owner-armed local copy |
|---|---|---|
| `src/security/canary-approval.ts` | `OWNER_CANARY_APPROVAL = null`, `OWNER_CANARY_KEY_SHA256 = null` | the owner's record (account, exact amount, minimum output, gas budget, validity window, single use) and the SHA-256 digest of the owner's app key |
| `src/execution/server/gate.ts` | `CANARY_LIVE_WIRING = false` | `true` |

Everything else in the copy is byte-identical: source checkpoint `4a5043781120d1394655ebea04f53fbf6c4ae11f567c627bc4870dd6598b2e49`. The record holds the owner's public address and a key digest; it contains no secret. The app owner key is not a wallet key: it only lets the owner start their own single-use canary.

## Scope (fixed in code)
- **Route:** Base (8453) Circle USDC → Arbitrum (42161) Circle USDC, via the LI.FI Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE` (AcrossFacetV4).
- **Amount:** at most 5 USDC, single use.
- **Accounts:** sender = recipient = refund address = the owner's connected account.
- **Approval:** `approve(LI.FI Diamond, exact amount)` only.
- **Minimum output:** the owner's absolute minimum, plus a 300 bps total-cost bound. Both must hold.
- **Not in scope:** this is not a NEAR Intents transfer, and it is not a general Swap. Same-chain Swap execution is not part of this submission.

## The path a transaction must pass (server-side, before the wallet is asked)
1. Server-side LI.FI quote.
2. Calldata decoded and bound to the quote: target, selector, token, amount, recipient, destination chain, output, fill deadline.
3. **Guardian** verdict, computed on the server and attested. BLOCK stops here, with 0 wallet calls.
4. Simulation on two independent RPC operators. A disagreement fails closed.
5. Exact-amount allowance.
6. Gas budget.
7. The owner's record and key.
8. Single-use journal.
9. The owner signs in their own wallet. A fresh live-wallet re-read happens at the last instant.
10. Source receipt.
11. Destination fill, read at final blocks.
12. Balance and allowance reconciliation. An uncertain result is shown as PENDING or UNKNOWN, never as success, and is never re-sent automatically.

## Reproduce safely
- **Without funds (default):** follow `HACKATHON.md`.
  - The canary panel shows the real state: implementation present, activation disabled, owner record absent.
  - The positive behaviour is covered by the test-only suites (`tests/fixtures/g14-closure/positive-*.test.ts`, run through `vitest.positive.config.mts`) on a local fake chain.
- **Owner-armed (real funds, your own risk):**
  1. Generate your own 32-byte key.
  2. Put its digest and your own record into the two constants above, on a local copy only, and set the wiring flag.
  3. Run it locally.
  4. Never commit or deploy that copy.

## Live evidence
**Status at publication (2026-11-14T19:07Z): no live transaction yet.** The owner-armed run had not taken place when this commit was made, so this repository makes no live-transaction claim. If a run takes place, a later commit adds its on-chain evidence here: the Base source transaction, the Across deposit id, the Arbitrum fill transaction and the reconciliation, each with explorer links built from the real hashes and verified by independent read-only RPC reads from two operators per chain. Same-chain Swap execution is **not** part of this submission.
