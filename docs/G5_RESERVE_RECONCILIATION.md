# G5 reserve reconciliation — BSC CROSS for ONEchain → BSC

Result: **RECONCILED** at BSC block 125745332 (`0x6d4be11cddd8dead290638a265eb6a6f354be9a3d9fb7829d9755eef9f6d05a3`). Spendable reserve for a NEW transfer: **913,929,997.889002214383750352 CROSS** (913929997889002214383750352 base units). Evidence: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476/reserve/` (`bsc-ledger-reconciliation.json`, scan manifest, surplus bisection, historical deltas, pre-funding window, in-flight enumeration).

## Exact payout semantics (BSCBridgeV2 @ 6da2fb2, byte-proven, fork-tested)

- CROSS pair `(612055, CROSS)` is `isOrigin=true`. BSC→ONE `bridgeToken` pulls `value+fee`, forwards `fee` to `dev` in the same call and does `deposited += value`. ONE→BSC finalize pays `CROSS.transfer(to, value)` (100k-gas call) and then `deposited -= value` (checked: a value above `deposited` reverts the whole batch).
- A failed transfer (e.g. insufficient balance) parks the item as pending (`pendingAmount += value`, `deposited` unchanged, index advances); `releasePending` and VERIFIER `manualReleasePendingWithRecipient` later pay and decrement `deposited` exactly once; ADMIN `removePending` drops an obligation without touching `deposited`.
- `burnCrossToDeadWallet` moves CROSS user→dead wallet without touching the bridge balance or `deposited`; ONE then pays native CROSS to the dead wallet (`ONE.minted += value`).
- BSC verifier value thresholds: verificationAmountThreshold = 0, periodTotalValueThreshold = 0 (disabled: no automatic amount delay). BSC executor = none (no extraData settlement path).
- Therefore, for a NEW transfer queued behind every earlier index: **spendable = min(balanceOf(bridge), deposited) − pendingAmount − Σ in-flight**; the route maximum is additionally bounded by ONE `minted` (initiation requires `minted ≥ value`).

## Pinned state

| Quantity | Value (CROSS) |
|---|---|
| Physical balance of the bridge | 913,930,007.889002214383750352 |
| `deposited` | 913,929,997.889002214383750352 |
| `pendingAmount` | 0.0 |
| Active pending records (complete `allPendingIndex` set) | 1: index 20 value 0 status 0 (sum 0) |
| In-flight ONE→BSC (initiated, not yet finalized) | 0 (enumerated True, sum 0.0) |
| Surplus (balance − deposited, not spendable) | 10.0 |
| **Spendable reserve** | **913,929,997.889002214383750352** |
| Route minimum / max by reserve / max by contract (ONE minted) / effective max | 5.0 / 913,929,997.889002214383750352 / 928,707,107.889002214383750352 / 913,929,997.889002214383750352 |

Pending index 20 (value 0, status None) is a legacy record written by the first implementation on 2025-05-21 for a zero-value test initiation (the ONE-side index 20 also has value 0; only the network fee was paid). It has no reserve effect.

## Event-sourced ledger (proxy creation → pinned block)

- Scan: blocks 48753627–125745332 in 1540 hash-pinned 50k-block chunks (contiguous), 139570 bridge-proxy logs; CROSS Transfer logs to/from the bridge for the contiguous prefix up to block 80053626 (74770 logs). The only public historical-log endpoint found is quota-limited; the physical balance after the prefix is therefore reconciled by archive-state bisection (below).
- Initial `deposited` = 20,000,000.0 (initializeBSCBridge crossInitialSupply).
- Deposits 28431 = 1,007,100,636.403720119491405277; payouts 85612 = 113,170,638.514717905107654925 (released from pending 4,013,165.15); dead-wallet burns 1 = 14,777,110.0; fees forwarded 0.0; pending created 4,013,165.15 / removed 0.0; manual releases 1; executor settlements 0; CBU-09 self-payouts 0.
- Computed `deposited` = 913,929,997.889002214383750352; computed `pendingAmount` = 0.0.

| Check | Result |
|---|---|
| DEPOSITED_EXACT | PASS |
| PENDING_EXACT | PASS |
| OPEN_PENDING_SET_EXACT | PASS |
| PREFIX_BALANCE_EQUALS_ARCHIVE | PASS |
| BISECTION_COMPLETE | PASS |
| NO_UNEXPLAINED_LATE_BALANCE_CHANGE | PASS |
| NO_UNCLASSIFIED_PREFIX_TRANSFERS | PASS |
| NO_ANOMALIES | PASS |
| NO_UNKNOWN_EVENT_TOPICS | PASS |
| NO_EXECUTOR_SETTLEMENTS | PASS |
| SURPLUS_EXPLAINED | PASS |
| BALANCE_EXACT | PASS |
| FINALIZE_INDEX_CONTIGUOUS | PASS |
| INITIATE_INDEX_CONTIGUOUS | PASS |
| CROSS_CHAIN_MINTED_MINUS_DEPOSITED_EQUALS_BURNS | PASS |

## Physical balance

- Pre-funding window (archive state): the initializer credited `deposited` = 20,000,000 at block 48753627 without a transfer; the CROSS token owner `0xd68e6d93…` funded 30 + 19,999,970 at blocks 48781968 / 48782186. No payout happened in that window (first finalize at block 49283675). Surplus by block: 48753627: -20,000,000.0; 48781967: -20,000,000.0; 48781968: -19,999,970.0; 48782185: -19,999,970.0; 48782186: 0.0.
- Transfer-log prefix balance at block 80053626 = 63,071,019.029561965740864767; archive `balanceOf` at that block = 63,071,019.029561965740864767 (equal: True).
- Archive-state bisection of s(b) = balance − deposited from block 48782186 (post-funding, s = 0) to 125745332: 140 archive calls, monotonic on a 49-point grid; change points: block 89752453 Δ 10.0 (0xa4327d941b10ca94df000c740a43c87507caab925ad69cfbedf18d187ec80a79); the change deltas sum to the total change: True. Monotonicity follows from the exact code: bridge CROSS only leaves through payouts (with `deposited −= v`), fee forwards inside deposits, or the executor path (absent on BSC; zero executor events), so no compensating pair can hide between samples.
- Surplus decomposition: direct inbound transfers without a bridge event 20,000,010.0 − unfunded initial credit 20,000,000.0 + CBU-09 self-payouts (0) = **10.0** = observed surplus 10.0. The only post-funding direct inbound is 10 CROSS from EOA `0x9589dd33…` (plain ERC-20 `transfer`, tx `0xa4327d94…`, block 89752453).

## Cross-chain reconciliation

- ONE `minted` (block 45673482) − BSC `deposited` = 14,777,110.0 = Σ dead-wallet burns 14,777,110.0 (1 burns): **True**. Both initializers credited 20,000,000 and no transfer was in flight at the ledger pins ({"oneNextInitiate": 98731, "bscNextFinalize": 98731, "bscNextInitiate": 40817, "oneNextFinalize": 40817}).
- ONE side: bridge native balance + `minted` = 1,000,000,000 exactly (fork-tested; read live).

## Historical cross-checks (§31)

Archive state before/after each proven payout block: block 125163152: Δdeposited -12.094599106825003813, Δbalance -12.094599106825003813, Δpending 0 — MATCH; block 125722327: Δdeposited -101.063, Δbalance -101.063, Δpending 0 — MATCH; block 125715362: Δdeposited -8,863.263815353245892608, Δbalance -8,863.263815353245892608, Δpending 0 — MATCH.

## Caps and privileged paths

No per-transfer maximum exists on BSC finalize besides `deposited`/balance; ONE initiation requires `minted ≥ value`; the minimum is read live from the verifier. ADMIN can drop pending obligations, VERIFIER can redirect a pending payout and ADMIN can upgrade instantly (single EOA): these are trust assumptions, monitored by the runtime-drift policy, not modelled away (see G5_LEGACY_RUNTIME_SECURITY_REVIEW.md).
