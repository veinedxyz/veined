# G7 pilot record — TEMPLATE (transaction fields intentionally empty)

| Field | Value |
|---|---|
| Preparation checkpoint | evidence `evidence/otherbridge-g7-prep/g7prep-20261005T064401Z-0a8ac9/final`; decision 2026-10-05T07:16:37.771Z; intent digest `35f29337683f44fa2b9564ffd60a75d610e998706f93e5ba66f490a14d2e435c`; unsigned package sha256 `7bac954ae07bc7b76e86ba524ae24ce792b3281000b3d75b630986268b8ab6e3` |
| Preparation status | READY_FOR_OWNER_SIGNATURE (preparation only; G7 NOT PASS) |
| Owner approval timestamp | |
| Trust model acceptance (exact sentence + timestamp) | *(not accepted — trustModelAccepted=false at preparation)* |
| Refreshed quote (block, minimum, network fee, service fee, msg.value, age) | |
| Refreshed intent digest | |
| Final wallet preview (network, to, value, data prefix, gas, approvals=none) | |
| Source tx hash | |
| Source receipt (block, hash, status, confirmations) | |
| Bridge index | |
| Destination tx hash | |
| Destination receipt (block, hash, status, finalized) | |
| Final CROSS received | |
| Fees / gas actually paid | |
| Payout proof (path, checks) | |
| Tracker status history (`pnpm g7:track`) | |
| Anomalies | |
| Final result | |

Status progression: SOURCE_PENDING → SOURCE_CONFIRMED → SETTLEMENT_PENDING → DESTINATION_PENDING → COMPLETED, or MANUAL_REVIEW_REQUIRED. Never "failed" because of elapsed time alone; never an automatic second source transaction.
