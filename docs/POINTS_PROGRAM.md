# VEINED weekly points, referrals and leaderboard

Status: **isolated implementation for owner playtest**. The program is closed by default, production refuses the
placeholder policy, simulation and in-memory storage, and no production verifier is registered (real execution is
CLOSED). Nothing here signs, sends or pays anything: points are off-chain ledger entries.

## 1. Accounting

- Smallest unit: 1 unit = 0.000001 point. Every amount, weight and allocation is a `bigint`; no floating point.
- Weekly pool: exactly **200,000 points = 200,000,000,000 units**, referral commissions included. Not configurable.
- Referral commission: exactly **10%** (`commissionBps` is the literal 1000 in the policy schema).

For a season, every eligible activity and approved task completion becomes a weight line `w` (after caps). Let `R`
be the lines whose account has an eligible referrer, `B = 10,000` and `c = 1,000`:

```
D        = Σ w·B + Σ_{l∈R} w·c          (the commission reserve is part of the denominator)
amount_l = ⌊P · w·B / D⌋                (the referred user keeps all of it)
comm_l   = ⌊amount_l · c / B⌋           (exactly ⌊10%⌋ of the referred user's final line reward)
```

Because `amount_l ≤ P·w·B/D` and `comm_l ≤ P·w·c/D`, `Σ amount + Σ comm ≤ P`. The result never exceeds the pool
and never increases it. The rounding residual `P − Σ` is below 1 unit per reward line plus 1.1 units per commission
line (floor of a floor); it is recorded with the calculation and stays **undistributed** (never redistributed,
never carried into another week). Example: a referred user's line earning 500 points gives the referrer 50 more
points; the referred user keeps 500 (`tests/unit/points-allocation.test.ts`).

A week without qualified activity awards nothing; the whole pool is recorded as undistributed with
`PENDING_OWNER_DECISION`. The only available decision is `RETAINED_UNALLOCATED`; undistributed points never enlarge a
later week.

## 2. Weight policy (`src/points/policy.ts`)

Versioned, append-only registry; each season freezes the version and hash in force when it opens and refuses drift.
The registered `draft-1` is a **placeholder** (status `DRAFT_PLACEHOLDER`) for playtest only:

| Field | draft-1 placeholder |
|---|---|
| Category base weight (SWAP/TRADE/BRIDGE) | 100 / 100 / 100 |
| Volume coefficient, mode | 10 per √USD, `sqrt-capped` |
| Per-activity volume cap | $100,000 |
| Minimum eligible volume | $10 |
| Category multiplier | 1.0× each |
| Max eligible activities per account per season | 200 |
| Account activity weight cap per season | 100,000 |
| Account task weight cap per season | 50,000 |
| Finality: default confirmations, grace after close | 12, 6 hours |
| Referral commission on tasks | off (owner approval required) |
| Live-season participation hint | off |
| Public leaderboard size, account masking | 100, masked |

Bounded volume weighting: volume is capped per activity and, in `sqrt-capped` mode, concave. A $500M swap counts
as $100k, and 100,000× the volume of a $1,000 swap earns less than 10× its weight.

## 3. Activity verification (`src/points/engine.ts`)

- Only **trusted server-side verifiers** ingest events. There is no public ingestion API. Simulation trusts
  `simulated-verifier` and `fixture`; production trusts none until the owner opens real execution.
- Eligible: SWAP/TRADE with outcome `SETTLED`; BRIDGE with `COMPLETED` **and** a verified destination. Quotes,
  unsigned intents, pending, failed, reverted and cancelled operations are stored as REJECTED and never weigh.
- Deduplication: unique event id; one live record per `operationKey` across all categories (a swap can never also
  count as a trade). Exact replays are no-ops; a replay with different content is refused (`CONFLICT`).
- Finality: an event is ELIGIBLE only when finalized or with enough confirmations; otherwise PENDING_FINALITY.
  A changed block hash or number is a reorganization: the event becomes REVERSED (never deleted). The same
  transaction re-included later may be reported under a new event id.
- Late data: activity for a season that is already calculating/under review is refused (`SEASON_CLOSED`); finality
  reached after finalization is `LATE_FINALITY`. Neither is ever silently added.

## 4. Referrals

- A code (8 characters, Crockford base32, random) is available to accounts with at least one verified eligible
  activity and no exclusion flag. One code per account.
- Invitation link: `/points?ref=CODE`. The code is remembered only in the invitee's browser.
- **Binding proof**: a binding is created only when the invitee's own **first verified activity** carries the code in
  its server-side attribution. The wallet layer is connect-only (no signatures), so the on-chain transaction itself is
  the proof of control; nobody can bind someone else's wallet.
- One parent per account, forever. No self-referral. Accounts with earlier verified activity cannot be referred
  later. Cycles are refused (also unreachable under the prior-activity rule). Excluded referrers gain nothing.
- Commission: 10% of the referred account's referral-eligible activity lines from the binding onward, inside the
  200,000. Commissions are never commissioned again (no grandparent), never apply to tasks (unless separately
  approved), sign-ups, logins or invitations.

## 5. Seasons and visibility

- Season `n` covers `[start + (n−1)·7d, start + n·7d)` in UTC; Europe/Istanbul is used for display and operations.
- The live season shows **only a countdown**. Public projections (`src/points/views.ts`) read published season
  snapshots, the schedule, referral relations and task status only; they never call the preview or read the ledger of
  an unpublished season. The Points page is client-only (no server-rendered data), and every API answer is
  `Cache-Control: no-store`.
- Week 1: countdown only. Week 2: published week 1 leaderboard and rewards; week 2 hidden. Week 3+: the latest
  published week plus the archive; the live week hidden. A finalized but unpublished week stays hidden.

## 6. Settlement (`src/points/settlement.ts`)

`OPEN → CALCULATING → REVIEW_PENDING → FINALIZED → PUBLISHED`

- Preview: admin-only, any time, never persisted.
- Calculate (operator): after close + finality grace; under a lease lock with a fencing token; idempotent on the input
  hash. An abandoned `CALCULATING` state is recovered only after its lease expires.
- Finalize (approver, must differ from the calculator): re-derives the result from current inputs; a stale input hash
  (`CALCULATION_STALE`) or a different result (`RESULT_NOT_REPRODUCIBLE`) is refused. The season compare-and-set, the
  ledger insert and the weekly budget check commit as one unit; in Postgres the ledger is also immutable and
  budget-checked by deferred trigger.
- Publish (approver): makes the week public.
- Reject (approver): returns a review to OPEN; the rejected calculation id is kept.
- Post-publication reversal: an operator proposes a clawback correction (negative entries for the reversed activity,
  its commission and any task completion built on it); a different approver applies it. The published ranking is not
  recalculated; the leaderboard is marked amended and the freed points join the week's undistributed balance.

## 7. Periodic tasks

Criteria are verified-activity predicates only (category, networks, minimum per-event volume, count), so login,
sign-up, wallet-connect or browsing tasks cannot be expressed. Drafts need a different approver; start times cannot be
in the past. Each event completes a task at most once; per-user and global limits are enforced atomically. Tasks can
require review, can be cancelled (voiding unpaid completions), and reversed events void their completions. Task
weights are never shown to users for the live season.

## 8. Administration

- `/admin/points` (outside the wallet shell, `noindex`) and `POST /api/admin/points`.
- Principals come only from the owner-provided `VEINED_ADMIN_PRINCIPALS` JSON (`[{id, roles, tokenSha256}]`); none
  are built in; unset or invalid closes the admin surface. Generate entries offline with
  `node scripts/points-admin-token.mjs <id> <roles>`. The bearer token is held only in the tab's memory.
- Roles: `viewer` (dashboard, explain), `operator` (calculate, flag, task drafts, correction proposals, simulation),
  `approver` (finalize, publish, reject, task approval, completion review, corrections, undistributed decision).
- Every state change and every refused access is in the append-only, hash-chained audit log.

## 9. Configuration

| Variable | Meaning |
|---|---|
| `VEINED_POINTS_ENABLED` | `true` to run the program (default closed) |
| `VEINED_POINTS_SEASON_ONE_STARTS_AT` | ISO UTC instant of the season 1 boundary |
| `VEINED_POINTS_ACTIVATED_AT` | ISO UTC instant from which activity can count (default: season 1 start) |
| `VEINED_POINTS_POLICY_VERSION` | registered policy version |
| `VEINED_POINTS_FROZEN_CONFIG_SHA256` | owner-frozen hash of the configuration; any drift closes the program |
| `VEINED_POINTS_STORE` / `VEINED_POINTS_DATABASE_URL` | `postgres` and its URL (production requires durable storage) |
| `VEINED_POINTS_SIMULATION` | `1` for the isolated playtest (refused in production) |
| `VEINED_ADMIN_PRINCIPALS` | owner-approved admin principals |

The frozen hash covers program id, season 1 start, activation, week length, display time zone, pool, decimals,
commission and the policy version and hash (`configDigest` in `src/points/config.ts`).

## 10. Storage

`MemoryPointsStore` (tests, playtest) and `PostgresPointsStore` implement one contract in which every critical step is
a single atomic operation. Schema proposal: `src/points/migrations/0001_weekly_points.sql` (own `veined_points`
schema, own version table and advisory lock; up-only; never applied implicitly; connecting to an unmigrated
database is refused). It has been applied only to throwaway test databases.
