# G7 owner approval card — NOT SIGNED · NOT BROADCAST

**G7_PREP = READY_FOR_OWNER_SIGNATURE (preparation only — G7 is NOT PASS)** · prepared 2026-10-05T07:16:37.771Z · evidence `evidence/otherbridge-g7-prep/g7prep-20261005T064401Z-0a8ac9/final`
Quote/fee/gas values are **ephemeral: MUST_REFRESH_BEFORE_SIGNING** (`pnpm g7:prepare` again right before the wallet prompt).

| Field | Value |
|---|---|
| FROM | `0x28136a77ec8ba3d918114712a588b4095ba12a6b` (public EOA; empty code observed — ownership not proven until the owner signs) |
| TO CONTRACT | `0xb81d6e000000000000000000000000000000c0de` — ONEbridge proxy (CrossBridge @ `b3b0258`) |
| NETWORK | ONEchain, chainId **612055** |
| DESTINATION NETWORK | BNB Smart Chain, chainId **56** |
| RECIPIENT | `0x28136a77ec8ba3d918114712a588b4095ba12a6b` (same EOA as FROM; empty code on BSC) |
| AMOUNT | **5 ONE** (= live route minimum) |
| NETWORK FEE | 0.18 ONE (bridge fee to the operator's dev address); service fee 0 ONE |
| OTHERBRIDGE FEE | **0** |
| EXACT msg.value | **5.18 ONE** (`0x47e30e8e20860000`) — the contract requires this exact value |
| ESTIMATED GAS | 126,551 gas × 4 gwei ≈ 0.000506204 ONE; gas limit 151,862 (+20 %), max fee 5 gwei |
| MAXIMUM EXPOSURE | **5.18075931 ONE** (msg.value + gas limit × max fee) |
| EXPECTED RECEIVE | **5 CROSS** canonical CROSS `0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510` on BSC |
| TRUST MODEL | **Centralized:** admin 0x22c1…f37c (single EOA, instant upgrade) · validators 3 EOAs, threshold **2-of-3** · VERIFIER_ROLE 0xe7ba…3f5b · **trustModelAccepted = false** |
| RUNTIME HASH STATUS | ONE impl `0x2827…8034` `0x8bb2e936…` = pin · BSC impl `0xac7b…e8d8` `0x47b60de2…` = pin · proxies, verifiers, CROSS token = pins · route-pin digest `5c4411ace2dd6c19…` = expected |
| RESERVE STATUS | verified=true at BSC finalized block 125826663; spendable 913927728.855791322580189858 CROSS; valued pending 0; in-flight 0 |
| QUOTE AGE | 13.5 s at READY (limit 60 s); quote 2026-10-05T07:16:24.255Z → expires 2026-10-05T07:17:24.255Z |

> The bridge contract/build/reserve/settlement route was technically verified at the current pins, but settlement and upgrade authority are controlled by EOAs. This is a centralized trust assumption, not a trustless bridge.
>
> Köprü kontratı/build/rezerv/settlement rotası mevcut pinlerde teknik olarak doğrulandı; ancak settlement ve upgrade yetkisi EOA'lar tarafından kontrol ediliyor. Bu merkezi bir güven varsayımıdır, trustless bir köprü değildir.

Approvals/permits: **none** (native route). Signature: **null**. Transaction hash: **null**. Broadcast: **false**.
Intent digest (sha256): `35f29337683f44fa2b9564ffd60a75d610e998706f93e5ba66f490a14d2e435c`.
Owner decision still required — trust acceptance sentence (not set by this preparation):
*"I understand that the verified ONEbridge route has centralized upgrade/settlement trust: single admin EOA and 2-of-3 validator EOAs."*
