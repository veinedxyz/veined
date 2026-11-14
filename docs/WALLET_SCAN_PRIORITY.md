# Wallet scan priority and waves (V1.14.2)

Source: `src/data/portfolio/priority.ts` (`planWaves`, `PRIORITY_REASONS`, `WAVE_LIMITS`, `slotPriority`). Tests:
`tests/unit/v1142-wallet-scan.test.ts` ("wave priority"), `tests/integration/v1142-wallet-scan.test.ts`.

**Priority affects order only.** It never removes a network, never adds one, never turns into a balance, a price or a
coverage state. A priority reason is scheduling evidence, not support status.

## Evidence

| Reason | Source | Bound |
| --- | --- | --- |
| `CURRENT_CHAIN` | the connected wallet's chain (request `priority[0]`) | ≤ 5 with context |
| `RECENT_USER_CONTEXT` | the user's current Bridge / Swap network (request `hints.context`; accepted and tested server-side — the V1.14.2 Portfolio client does not send it yet, the connected chain covers the current context) | ≤ 5 |
| `RECENT_NONZERO` | networks where the same identity held a nonzero, non-spam balance in its previous scan, in value order (request `hints.recent`; the client derives it from the result it is showing for the same identity — cleared on every account, address or mode change) | ≤ 24 |
| `INDEXED_ACTIVITY` | canonical historical transfers of this wallet in the self-hosted index (`store.walletChains`) | — |
| `KNOWN_TOKEN` | networks with exact user-imported token contracts | ≤ 5 networks × 25 |
| `HIGH_CONFIDENCE_PORTFOLIO_CHAIN` | routable networks with Otherbridge's reviewed coverage: curated asset registry, protocol receipt contracts or reviewed DeFi deployments (canonical project metadata; today 22 networks — the reviewed DeFi set) | — |
| `GENERAL_PRIORITY` | routable networks ranked by the accepted chain priority policy (routable first, then TVL) | — |
| `LONG_TAIL` | networks outside the routing catalog | — |
| `DEFERRED_TO_BACKGROUND_SLOW_CHAIN` | a first-page network that exceeded the 2 s first-page chain budget twice within 30 minutes (process-level, chain-only memory) | — |

A priority entry that the client also reports as previous-scan evidence is explained by that evidence (the first
entry stays the connected chain). Indexed activity proves history, never a current balance; a previous nonzero proves
nothing about today — both only move the read earlier.

## Waves

| Wave | Content | Order inside the wave | Read-slot class |
| --- | --- | --- | --- |
| 0 | current chain, then current user context (≤ 5) | client order | 0 (first result) |
| 1 | recent nonzero (client value order), then indexed activity / known token (canonical order), ≤ 24 | as listed | 0 |
| 2 | high-confidence routable networks + the first 8 other routable networks of the accepted policy | canonical | 1 (first page) |
| 3 | every other routable network | canonical | 2 (background) |
| 4 | long tail; deferred slow networks last | canonical | 2 |

The first page is waves 0-2, minus networks quarantined as slow (see below). Example (live, "View another address", no evidence): wave 2 = 30 networks, wave 3 = 32,
wave 4 = 92 (fixture plan census in `chain-census/`).

## First-page rule

The first-page set is every wave 0-2 network except those carrying `DEFERRED_TO_BACKGROUND_SLOW_CHAIN` (a quarantined
network that keeps user evidence is still read in wave 1, but never holds the page). `plan.firstPage.chains` is the size
of that set. `firstPage` is emitted once per scan, at the first of:

1. `WAVES_SETTLED` — every first-page network answered (checked or failed);
2. `CHAIN_BUDGET` — every first-page network still without an answer has been reading for ≥ 2 s (one slow provider
   never holds the page; such a network earns a slow-chain strike);
3. `DEADLINE` — 5 s since the scan started;
4. `ROUND_END` — the round finished first.

`included` lists every network answered at that moment, `outstanding` the first-page networks still reading (both in
the `firstPage` line and the scheduler receipt; no hidden cherry-picking).

## Slow-chain quarantine

`recordChainDuration` measures only wave 0-2 networks against the 2 s budget (a timeout counts as over budget; a fast
answer clears the strikes). Two strikes inside 30 minutes quarantine the network: without user evidence it moves to
wave 4 (lead reason `DEFERRED_TO_BACKGROUND_SLOW_CHAIN`); with user evidence (current chain, context, previous nonzero,
index activity, known token) it keeps its early wave — the user's known value is still read first — and only leaves
the first-page set (the reason is listed after the evidence reason). Once its strikes age out it returns to normal and
is measured again (a network still read in waves 0-2 also clears its strikes with one read inside the budget). The network stays in the plan and is read in every scan.
