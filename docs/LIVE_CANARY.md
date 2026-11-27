# Live canary: what the video shows and how it relates to this code

This repository is published **disarmed**. Nothing in it can sign, approve or send by default.

> **Update 2026-11-21:** two Base → Arbitrum mainnet Bridges have since been verified.
> - **2026-11-15:** a local copy of this repository ran the first. It was armed with exactly the two files described
>   below and operated by an automated run under the owner's authorization. A policy-restricted local signer signed it.
> - **2026-11-20:** the owner ran the second from their own wallet, on a later, separate local VEINED source.
>
> See [Live evidence](#live-evidence) and [MAINNET_BRIDGE_PROOF_2026-11-21.md](MAINNET_BRIDGE_PROOF_2026-11-21.md).

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

### Update 2026-11-21: verified mainnet Bridges

> **Correction:** the first version of this update said that the owner-armed two-file copy of this repository "was
> never run". That was wrong. It ran the 2026-11-15 Bridge below.

#### 2026-11-15: this repository, owner-armed (the two files above)

**Which code ran it.** A local copy of this repository's source (checkpoint
`4a5043781120d1394655ebea04f53fbf6c4ae11f567c627bc4870dd6598b2e49`) ran one single-use 5 USDC Bridge. The copy was changed in
exactly the two files above:
- `src/security/canary-approval.ts` held the record for an owner-funded test account;
- `src/execution/server/gate.ts` had the wiring flag on.

**Who signed it.** No person signed it in a wallet. An automated headless-browser run operated it, under the owner's
authorization, and a local signer signed it through an injected wallet. That signer was restricted to hard-coded limits: at most 6 USDC in total, and one approval plus one
execution per route.

| | |
|---|---|
| Exact approval (Base) | [`0x2c08e019681554c6c9fe2c86f342732416514d489ef7ca5d5bb8681ad32dc7f8`](https://basescan.org/tx/0x2c08e019681554c6c9fe2c86f342732416514d489ef7ca5d5bb8681ad32dc7f8), block 57,840,416, nonce 2 |
| Base source transaction | [`0x8f828b066f924e6154101bba490bd6d29d42bd06ad3808675f1f46ab7ebde45b`](https://basescan.org/tx/0x8f828b066f924e6154101bba490bd6d29d42bd06ad3808675f1f46ab7ebde45b), block 57,840,464, 2026-11-15 16:01:08 UTC, success |
| Across deposit id | `6460753` |
| Arbitrum fill transaction | [`0x7b28bc8f945fcf7188177178791ec373afee4933b41353f50fe29927f9d1199a`](https://arbiscan.io/tx/0x7b28bc8f945fcf7188177178791ec373afee4933b41353f50fe29927f9d1199a), block 524,505,130, success |
| Amounts | 5.000000 USDC in, **4.980490 USDC** delivered to the same account (cost 39 bps; bounds: ≥ 4.900000 USDC, ≤ 300 bps); allowance 5,000,000 → 0 |

Both chains were re-read on two RPC operators each. The step-9 promise of this document ("the owner signs in their own
wallet") did not apply to this run, because the restricted signer signed instead.

#### 2026-11-20: a later source, owner-signed

The owner ran one single-use Bridge from their own wallet on a later local VEINED source (FastFlow, source checkpoint
`50cfa4e13162c9a8a25ba56ad471e8dfa737f7f4a614daeae3a1a6d727ad2512`, not published here). That source differs from this
repository well beyond the two constants above.

| | |
|---|---|
| Base source transaction | [`0x38be4b805b0f7e37ea22ce3157140acb24e66df9df0e2cd00880d27fea8e6c16`](https://basescan.org/tx/0x38be4b805b0f7e37ea22ce3157140acb24e66df9df0e2cd00880d27fea8e6c16), block 60,122,404, 2026-11-20 22:47:36 UTC, success |
| Across deposit id | `6478337` |
| Arbitrum fill transaction | [`0xa5bb811bc30f6072dc75a953afb18263d4d1485fcb4abd47b5d8167f69d0dde8`](https://arbiscan.io/tx/0xa5bb811bc30f6072dc75a953afb18263d4d1485fcb4abd47b5d8167f69d0dde8), block 526,066,423, success |
| Amounts | 5.000000 USDC in, **4.981152 USDC** delivered to the same account (cost 37.70 bps; bounds: ≥ 4.900000 USDC, ≤ 300 bps) |
| Reconciliation | allowance to the LI.FI Diamond 5,000,000 → 0; nonce 9 → 10; Base USDC −5.000000 and ETH −exact gas cost; the application's journal reached `SETTLED_VERIFIED` only after the fill was verified |
| Guardian | CLEAR; the signed calldata hash equals the reviewed one |

Every value was read independently from two RPC operators per chain. The method, the full list of checks, the
history of the exact approval that this Bridge reused, and the limits are in
[MAINNET_BRIDGE_PROOF_2026-11-21.md](MAINNET_BRIDGE_PROOF_2026-11-21.md). The 2026-11-14 status above remains correct as
history.
