# Verified mainnet Bridge canary: Base → Arbitrum, 5 USDC (2026-11-21)

**What this is:** one real, owner-controlled, single-use Bridge. It was run by the owner from their own wallet, on a local copy of a later VEINED source, after the NEAR Hackathon submission. It is documented here with on-chain evidence read independently from two RPC operators per chain.

**What this is not:** this repository did not perform it. The public execution gate stays **closed**, and the owner-armed canary in this repository stays **disarmed**. See [Which source ran this](#which-source-ran-this-and-which-did-not).

Date: 2026-11-21 in Türkiye (UTC+3). The Base source block is timestamped **2026-11-20 22:47:36 UTC**.

## Result

| | |
|---|---|
| Route | Base (8453) Circle USDC → Arbitrum One (42161) Circle USDC, through the LI.FI Diamond (AcrossFacetV4) and the Across SpokePool |
| Source transaction (Base) | [`0x38be4b805b0f7e37ea22ce3157140acb24e66df9df0e2cd00880d27fea8e6c16`](https://basescan.org/tx/0x38be4b805b0f7e37ea22ce3157140acb24e66df9df0e2cd00880d27fea8e6c16) |
| Source block | 60,122,404 (`0x382c2df2…5d35`), 2026-11-20 22:47:36 UTC, status **success** |
| Destination fill (Arbitrum One) | [`0xa5bb811bc30f6072dc75a953afb18263d4d1485fcb4abd47b5d8167f69d0dde8`](https://arbiscan.io/tx/0xa5bb811bc30f6072dc75a953afb18263d4d1485fcb4abd47b5d8167f69d0dde8) |
| Destination block | 526,066,423 (`0x24f67385…b8a6`), 2026-11-20 22:47:36 UTC, status **success** |
| Sender = recipient = refund | `0xb6ded1b18464aed61db794dfc5cb031b45a7ca2c` (the owner's own account) |
| Input | **5.000000 USDC** (Base USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`) |
| Delivered | **4.981152 USDC** (Arbitrum native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`) |
| Route cost | 0.018848 USDC = **37.70 bps**: LI.FI fee 0.012500 USDC + Across relay fee 0.006348 USDC |
| Owner's bounds | at least 4.900000 USDC delivered, total cost ≤ 300 bps, exactly 5 USDC, single use |
| Across deposit id | `6478337` |
| LI.FI transaction id | `0x72ced393db620df64cddd5fda0bf8be8c55ac4dd53bce96f60bab108035158fa` |
| Gas of the Bridge transaction | 170,670 gas × 0.008 gwei + L1 data fee 10,008,465,139 wei = **1,375,368,465,139 wei** (≈ 0.0000013754 ETH) |
| Gas of the earlier exact approval | 417,816,553,610 wei ([`0xfd4d4f24…0fa1`](https://basescan.org/tx/0xfd4d4f24561529a60a38ca956cffa6c83d2df3746262228c537000d1d77a0fa1), see [History](#history-two-transactions-one-allowance)) |

## How it was verified

The reads used plain JSON-RPC calls with a separate script, not the application's own code path. Each value below was read from **two independent public operators per chain**, and both operators agreed:

- **Base:** `base-rpc.publicnode.com` and `mainnet.base.org`.
- **Arbitrum One:** `arb1.arbitrum.io/rpc` and `arbitrum.drpc.org`.

The first observation was at 2026-11-20 23:00:42 UTC: Base head 60,126,338, Arbitrum head 526,069,124. Finality is covered in its own section below.

### Source (Base)
- **Transaction:** from the owner to the LI.FI Diamond `0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE`.
  - Nonce 9, value 0, EIP-1559 (type 2).
  - Selector `0x1794958f` (AcrossFacetV4 `swapAndStartBridgeTokensViaAcrossV4`).
  - Calldata: 1,444 bytes, keccak `0xb54a2ddb…b1d7`.
- **Receipt:** status 1, 7 logs. USDC transfers:
  - owner → Diamond: 5,000,000 (6 decimals);
  - Diamond → LI.FI fee wallet `0xc06ebbefd94032b85424d51906e2a335efae264b`: 12,500;
  - Diamond → Across SpokePool `0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64`: 4,987,500.
- **Across `FundsDeposited`:**
  - deposit id 6478337, destination chain 42161;
  - depositor = recipient = owner, no exclusive relayer;
  - input 4,987,500 Base USDC, output 4,981,152 Arbitrum USDC;
  - quote timestamp 22:45:59 UTC, fill deadline 2026-11-21 01:17:27 UTC.
- **LI.FI transaction id:** appears both in the calldata and in the Diamond's own log.
- **Contract identity:**
  - Base USDC reports `USD Coin` / `USDC` / 6 decimals, and its code hash equals the pinned value.
  - The Diamond's code hash equals the pinned Base value.
  - The Diamond routes the selector to AcrossFacetV4 `0xAd3f1634a917924cBb54A0F76e43ca035D2B6BCd`.
- **Fees the wallet set:** gas limit 328,589, max fee 0.01018 gwei, priority fee 0.003 gwei, effective price 0.008 gwei. All of these are inside the owner-approved fee envelope.

### Destination (Arbitrum One)
- **Fill transaction:** sent to the Arbitrum Across SpokePool `0xe35e9842fceaCA96570B734083f4a58e8F7C5f2A`, status 1.
- **`FilledRelay`:**
  - origin chain 8453, deposit id **6478337** (the deposit above);
  - relayer `0x394311a6aaa0d8e3411d8b62de4578d41322d1bd`, repayment chain 8453;
  - output 4,981,152 Arbitrum USDC, recipient = the owner.
- **USDC transfer:** relayer → owner, **4,981,152**.
- **Contract identity:** Arbitrum USDC reports `USD Coin` / `USDC` / 6 decimals, and its code hash equals the pinned value.

### After the transaction (Base)
Before = block 60,122,403, after = block 60,122,404. Both operators agree on every value.

- **Allowance** to the LI.FI Diamond: 5,000,000 before, **0** after. It was still 0 at the head at observation time.
- **Nonce:** 9 before, 10 after; at observation, latest = pending = 10, so there is no other transaction.
- **Owner's Base balances:** USDC −5.000000, ETH −1,375,368,465,139 wei, exactly the transaction cost.
- **Owner's Arbitrum USDC:** +4.981152 at the fill block. This delta comes from one operator only: the second (`arbitrum.drpc.org`) does not serve historical state. The fill receipt and logs were confirmed on both operators.

### Advisory cross-check
The LI.FI status API reports `DONE` / `COMPLETED` (tool `across`) with the same receiving transaction, the same amounts and the same transaction id. It is advisory only; the on-chain reads above are the evidence.

## Guardian's place in the run

The application's server-side Bridge review computes a **Guardian** verdict on its own facts: chains, assets, recipient, route and price impact. The levels are CLEAR, CAUTION, HOLD and BLOCK.

- **Enforcement:** HOLD and BLOCK make the review not-ready, and the prepare step refuses anything whose Guardian verdict is HOLD or BLOCK.
- **The Guardian rule code:** `src/guardian/*.ts` (10 files) is byte-identical between the source that ran this and this repository's `main`. The Bridge engine, wallet runtime and activation code are not.

The local single-use journal of the run records (summarized; the journal itself is not published):

1. **Review:** Guardian **CLEAR**, digest `4411141b…11a7`. Findings: `EXECUTION_CLOSED:INFO`, `ASSET_EVIDENCE:PASS` ×2, `RECIPIENT_SELF:PASS`.
   - Ready, step EXECUTE, no problems, expected output 4,981,152, cost 37 bps.
   - Simulated on two operators: USDC −5,000,000, allowance after 0.
2. **Authorization and prepared transaction:** the authorization was bound to that review, and the prepared transaction to the same calldata hash.
3. **On chain:** the calldata hash of the transaction **equals** `0xb54a2ddb…b1d7`. The signed bytes are exactly the bytes Guardian reviewed.

Not exercised live: a CAUTION, HOLD or BLOCK verdict. Those paths are covered by tests, not by a live transaction.

## Journal reconciliation (local, summarized)

The application's single-use journal records the full sequence:

- review → authorization → nonce → use → prepared;
- dispatch `SENT` with the source hash;
- receipt: status 1, 170,670 gas, 0.008 gwei, L1 fee 10,008,465,139 wei (all equal to the chain);
- deposit: id 6478337, output 4,981,152;
- **settled `SETTLED_VERIFIED`:** fill `0xa5bb811b…`, delivered 4,981,152, code `FILLED_TO_OWNER`.

The application shows completion only after the destination fill is verified on both destination operators. Its state matches the independent reads above.

## History: two transactions, one allowance

1. **2026-11-19 23:14:07 UTC, exact approval.** `approve(LI.FI Diamond, 5 USDC)`, [`0xfd4d4f24…0fa1`](https://basescan.org/tx/0xfd4d4f24561529a60a38ca956cffa6c83d2df3746262228c537000d1d77a0fa1), nonce 8, Base block 59,698,358.
   - It succeeded on chain.
   - The wallet had replaced the application's priority fee (2,500,000 wei above a fixed 2,000,000 wei cap), so the application's fee policy of that time classified the receipt as a discrepancy and froze the Bridge step. Nothing else was sent.
2. **A bounded reconciliation.** The owner reviewed and approved it.
   - Fee policy v4: the wallet's priority fee may not exceed the attested max fee, and every other bound is unchanged.
   - It allowed exactly one Bridge step that reuses exactly the existing 5 USDC allowance: no new approval, no top-up, nonce 9.
   - It was valid until 2026-11-21 11:05:16 UTC.
3. **2026-11-20 22:47:36 UTC, the Bridge** documented above.

## Which source ran this, and which did not

- **This repository** is the NEAR Hackathon submission (tag `hackathon-submission`, release candidate rc28, source checkpoint `4a5043781120d1394655ebea04f53fbf6c4ae11f567c627bc4870dd6598b2e49`), plus later documentation commits.
  - It did **not** perform this transaction.
  - This run was **not** "this repository plus the two activation constants" described in [LIVE_CANARY.md](LIVE_CANARY.md).
- **The run used a later local VEINED source** (FastFlow, source checkpoint `50cfa4e13162c9a8a25ba56ad471e8dfa737f7f4a614daeae3a1a6d727ad2512`). Before the owner's approval, it was frozen, qualified and independently reviewed.
  - It is **not published** in this repository.
  - It differs from rc28 well beyond two constants: wallet runtime, Bridge engine, fee policy, reconciliation and the one-click flow.
- **The 2026-11-14 statement in LIVE_CANARY.md stays correct as history:** "no live transaction yet" at publication. This Bridge is a later development.

## What this does not prove

- **Other actions:** same-chain Swap execution, general multichain live execution, any NEAR transfer or NEAR Intents transfer, or any other route, token, amount or chain.
- **Readiness:** production readiness, an audit, or a public execution path. This was one owner, one wallet, one local machine and one single-use authorization.
- **Wallets:** compatibility with wallets other than the owner's.
- **Guardian outcomes:** a live CAUTION, HOLD or BLOCK outcome.

## Limits and remaining risks

- **Reads:** public RPC operators, two per chain, rather than a light client. The Arbitrum balance delta came from one operator, and finality was observed as described below.
- **Relayer:** Across fill speed and relayer behaviour are outside VEINED's control. A slow fill would have been shown as pending and refund-tracked, never resent.
- **Evidence published here:** only the parts needed to reproduce the on-chain checks. Local journals, approval records, keys, machine paths and logs are not published.

## Finality

**2026-11-20 23:06:10 UTC:**
- **Both blocks:** canonical, with unchanged hashes on all four operators.
- **Base:** the source block was not yet below the operators' `finalized` head (60,122,058).
- **Arbitrum:** the fill block was already below one operator's `finalized` head (526,067,029). The other operator reported 526,066,102.

**2026-11-20 23:08:49 UTC: both blocks are final on all four operators.**
- Base `finalized` head 60,124,039 ≥ 60,122,404.
- Arbitrum `finalized` head 526,067,029 ≥ 526,066,423.
- Both block hashes are unchanged.
