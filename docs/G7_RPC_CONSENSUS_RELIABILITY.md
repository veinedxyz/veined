# G7 RPC consensus reliability (V1.11 P0 repair)

Status: **G7 READY_FOR_OWNER_RETRY** (read-only dry acceptance only). No real G7 transaction was made. Real
signatures, approvals, permits, broadcasts, deploys and fee collection all remain **0**. The global execution gate
is unchanged and production execution stays closed.

## 1. Owner symptom and exact failing gate

Owner symptom (2026-10-06): *"Route review required — a fresh safety check failed. No wallet request is possible."*

The message was not the problem; it was the honest result of a fail-closed preflight. The failing path:

| Step | Before V1.11 (`scripts/g7-pilot/preflight.ts`, before copy in `preflight/g7-before/`) |
| --- | --- |
| BSC pin | `pinBsc()` read `eth_getBlockByNumber("finalized")` from **one** endpoint only (`ENDPOINTS.bsc[0]`, bsc-dataseed). |
| State reads | `readBoth("bsc")` then read every critical BSC value at that block from **both** independent endpoints. |
| Lagging endpoint | The second operator (PublicNode) had not yet served that newest finalized block → `block not found` / null header. |
| Retry | Each of the 3 attempts re-pinned to an even newer `finalized` block of the same leading endpoint, so the lagging endpoint never caught up. |
| Gate | The preflight threw → `failedOutcome` → **X0 PREFLIGHT_EXECUTION FAIL** (the single failing gate); when reads did succeed but the second source's finalized head was below the pin, `bscFinalizedOk=false` → **P8 `BSC_RESERVE_PIN_NOT_FINALIZED`**. |

This is ordinary public-RPC lag (BSC ≈ 0.45 s blocks; independent operators disagree on the newest finalized head
by a few blocks for short periods). The independent-source requirement was correct; the pin choice was not.

## 2. Repair: canonical common finalized pin

New module `src/g7/common-pin.ts` (`selectCommonPin`), used by `pinBsc()` for every phase-A and phase-B BSC read:

1. Every vetted state source reports `eth_chainId`, its own `finalized` header and its head (`eth_blockNumber`).
   A wrong chain id, an unreachable/timed-out/rate-limited source or a malformed header is excluded (never a vote).
2. Pairs are formed only from **different operator groups**, in the vetted order
   (`BSC_STATE_SOURCES` in `src/g7/policy.ts`: `bnb-chain-bsc-dataseed`, `allnodes-publicnode`, `onfinality`).
3. Candidate = the **lower** of the two finalized heads (and of the logs witness' finalized head) — the highest block
   both can serve. Never above either source's own finalized head; `latest`/`pending` are never used.
4. If a source cannot serve that header yet (`block not found` from a load-balanced backend), step down at most
   `maxStepDown = 16` blocks.
5. Both sources must return the **identical block hash**; the logs witness (`nodereal-logs-only`) must serve the
   same hash (it never votes on state).
6. The pin must be recent: block timestamp age ≤ `maxPinAgeSec = 30`; it is never below the caller's floor (phase B
   floor = the run's phase-A pin, so ledger deltas only move forward).
7. A hash disagreement at a finalized height → **`RPC_FINALIZED_HASH_DISAGREEMENT`**, fail closed immediately (no
   other pair is tried — a disagreement is a safety signal, not lag).
8. If no independent pair can pin → **`RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE`** → BLOCKED, no wallet request.

All critical BSC state reads of the run (`readSide` for reserve, pair, pending, roles, code hashes, logs window,
simulations) use that single pin. After the reads each source is re-checked to still report a finalized head ≥ pin
(`stillFinalized`, 3 tries, 600 ms apart); otherwise the run fails closed.

### RPC fallback

`BSC_STATE_SOURCES` comes from the vetted provenance inventory with operator group, chain id and capabilities
(finalized tag, archive state at recent blocks). Health/lag is measured per selection (`SourceHealth`: chain id,
finalized, head, lag in blocks, failure class). One stale or rate-limited endpoint no longer blocks G7: the next
independent pair is tried. Two sources of the same operator group never count as independent. OnFinality's public
endpoint is new in the vetted list: **LEGAL_REVIEW_REQUIRED** for its terms before any production use (it is used
only by this local, read-only pilot preflight).

### Rate limits

The logs witness is NodeReal's public key, which has a usage quota (HTTP 429 / `-32005 maximum API usage limit`).
`classifyPinFailure` classifies quota/429/"too many requests" as `RATE_LIMITED` (never as success). The owner copy
says the source is temporarily limiting requests. The dry acceptance runner paces sessions (`--pause-ms`, default
45 s); an unpaced 10-session burst hit the quota after session 6 (recorded, see §5).

## 3. Owner-facing error

`retryableStop()` in `scripts/g7-pilot/product/local-pilot-bridge.tsx` — only when the single failing gate is the
retryable X0 data-source condition:

- Title: **Safety check needs another attempt**
- Body: *A BSC data source has not caught up yet. No wallet request was made.* (rate-limited and timeout variants)
- **Advanced details**: failing gate, reason code, chain, data sources (operator groups), last verified BSC pin
  (block + age), "Wallet request: None was made".

Any other failing gate keeps the existing BLOCKED review message. Safety details gained a row
"RPC consensus (BSC common finalized pin)".

## 4. Change record (§39 protected files)

Minimum diff; G7 financial logic (`src/g7/prep.ts` gates P1–P20/S1–S8, `decoder.ts`, `ledger.ts`, `track.ts`,
intent, firewall, wallet-send, launch/supervisor) is **unchanged** (identical SHA-256).

| File | Change | Before SHA-256 | After SHA-256 |
| --- | --- | --- | --- |
| `src/g7/common-pin.ts` | new (374 lines) | — | `03ab87e7a6829f9682d3a310414377848af4d0dd28b4726168dc7e8a71fbe450` |
| `src/g7/policy.ts` | +23: `BSC_STATE_SOURCES`, `BSC_LOGS_WITNESS`, `BSC_PIN_POLICY` | `81748a4f…4dbbe0` | `affaeb5c…e377f1` |
| `src/g7/rpc.ts` | +13 −5: vetted URLs from the source list, optional per-call timeout, "block not found" transient | `938262b2…1595c` | `ac19d5a1…81f26` |
| `scripts/g7-pilot/preflight.ts` | +78 −22: `pinBsc` → `selectCommonPin`, pin inside the retry, floor for phase B, diagnostics | `75545672…37dad` | `8f527a0f…238fc` |
| `scripts/g7-pilot/session.ts` | +1: snapshot carries `diagnostics` | `9a5bf45d…a648` | `bfee04f3…8334` |
| `scripts/g7-pilot/product/local-pilot-bridge.tsx` | +108 −2: `retryableStop`, Advanced details, RPC consensus row | `6c2c8f5c…47764` | `8aa3bfaa…` (see list) |
| `scripts/g7-product-pilot.ts` | +4 −3: app route `/bridge` (landing owns `/`) | `73aa21fa…83d0f` | `e3f78363…878d2` |
| `scripts/g7-pilot-safety.ts` | +4 −2: pilot gate allow-list follows `src/app/(app)/layout.tsx` | `c81e9169…9491541` | `d02fb5a8…900245` |
| `scripts/g7-pilot/dry-acceptance.ts` | new (dry runner, `pnpm g7:dry-acceptance`) | — | `a1c631ea…c2503` |
| `tests/unit/g7-common-pin.test.ts` | new (regression suite) | — | `dd0018c8…0b0253` |
| `tests/g7-pilot/product-live-routes.spec.ts`, `product-runtime.spec.ts` | `/` → `/bridge` | see list | see list |

Full hashes: `evidence/otherbridge-v1-11/<run>/preflight/g7-files-before.sha256` (40 files) and
`evidence/otherbridge-v1-11/<run>/g7/g7-files-after.sha256`. `src/components/dialog.ts` `trapDialog` (used by the
pilot card for focus trapping) changed only in its focusable selector and visibility filter.

**Protected baseline:** updated after the independent review accepted V1.11 — see
[G7_RELEASE_GATE_V111](G7_RELEASE_GATE_V111.md) (99 protected files incl. the complete G7 code, per-file review record).

**Security impact:** stricter or equal. Before, the pin was chosen by one source; now two independent operators
must both serve the pin with an identical hash and the logs witness must agree. No single-source pass, no
`latest`, no relaxed gate, no new write method (the pin probes use `eth_chainId`, `eth_getBlockByNumber` with
`finalized` or an explicit number, and `eth_blockNumber` — all already in `G7_READ_METHODS`).

## 5. Regression tests and acceptance

`tests/unit/g7-common-pin.test.ts` (19 cases): endpoint A ahead / B behind, block not found (bounded step-down),
older common pin only while recent, hash disagreement (immediate fail), witness disagreement, wrong chain id,
timeout, 429/quota, recovered endpoint, no independent pair (`RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE`), same operator
group, floor, witness down, read-only method/tag allow-list, failure classification.

Live read-only dry acceptance (`pnpm g7:dry-acceptance`, real `PilotSession` in `dry-run` mode: start → final →
arm → `DRY_RUN_COMPLETE`, wallet send suppressed):

| Run | Sessions | Result | Notes |
| --- | --- | --- | --- |
| `g7-dry-trial` | 1 | 1/1 DRY_RUN_COMPLETE | first run on the repaired code |
| `g7-dry-early` | 10, unpaced | 6/10 | sessions 7–10 stopped at X0 `RATE_LIMITED` (NodeReal public quota) — truthful fail-closed, recorded |
| `g7-dry-paced` | 10 consecutive, 45 s pause | **10/10 DRY_RUN_COMPLETE** | pins 126039978…126041xxx, age 3–4 s, pair bnb-chain-bsc-dataseed + allnodes-publicnode |
| `g7-dry-aborted-protected-file` | 2 | 2/2 BLOCKED at P20 `STATIC_SAFETY_SCAN_FAILED` | a documentation edit to the protected `.env.example`; reverted, run stopped — the gate works |
| `g7-dry-final-a` | 10 consecutive, 45 s pause | **10/10 DRY_RUN_COMPLETE** | before a one-character regex fix in the pilot card |
| `g7-dry-final` | 10 consecutive on the final G7 code, 45 s pause | **10/10 DRY_RUN_COMPLETE** | pins 126,058,731 … 126,060,480, age 3–11 s, pair bnb-chain-bsc-dataseed + allnodes-publicnode; intent digest `4eecb978…` in all 20 records |

Every session: write-method calls 0, wallet requests 0, signatures 0, broadcasts 0. The intent digest is unchanged.
`pnpm g7:safety` and `pnpm g7:pilot:safety`: PASS, 0 findings.

## 6. Remaining limits

- Public endpoints only; quotas and lag still exist. When no independent pair can pin, G7 stays BLOCKED with the
  retry message — by design.
- The NodeReal logs witness is a single required source for logs; if it is rate limited, the run is blocked
  (`WITNESS_UNAVAILABLE` / `RATE_LIMITED`) rather than reading logs from one state source.
- OnFinality terms: LEGAL_REVIEW_REQUIRED.
