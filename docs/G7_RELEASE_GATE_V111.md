# V1.11 final G7 release-gate repair

Status: **OTHERBRIDGE V1.11 FINAL G7 RELEASE-GATE REPAIR — READY_FOR_OWNER_RETRY**. Read-only work only: no
`eth_sendTransaction`, signature, approval, permit, broadcast, deploy or fee collection. Evidence: `evidence/otherbridge-v1-11/g7gate-20261006T135310Z-f42f11/`.

## 1. verify-safety regex repair (`scripts/verify-safety.mjs`, protected)

Minimum diff, two hunks (`evidence/otherbridge-v1-11/g7gate-20261006T135310Z-f42f11/verify-safety.diff`):

1. Raw-provider pattern: the literal `0x08` (backspace) after `\.ethereum` became a real RegExp word boundary `\b`.
   Before, `.ethereum` property access on any object other than `window` (`g.ethereum`, `globalThis.ethereum`,
   `x?.ethereum?.request`) was never detected.
2. Signer-surface pattern: `\beth_sign\b`, `wallet_sendCalls` and `wallet_grantPermissions` added, so the static scan
   covers every method of the adapter's frozen `FORBIDDEN_WALLET_METHODS` list (the new tests showed these three were
   not detected).

No exemption was added or widened. Before `206d0550…` (= the reviewed V1.9 baseline) → after `3ac26156…`.

**Regression tests** — `tests/unit/verify-safety-regression.test.ts` runs the real script against a temporary copy of
the scanned tree with exactly one injected change per case (37 cases): raw `window.ethereum`, `.ethereum` on any
object, optional `?.ethereum`, `globalThis.ethereum`, `"ethereum" in window`, EIP-6963 discovery, a new provider path
inside the Privy layer; the presence-only detection accepted only in the Privy layer, only once, only as the exact
reviewed literal (no wildcard construct, one file per exemption); every deny-list wallet method, local key helpers, a
second `eth_sendTransaction`, the canonical send outside the submission boundary, routing write calls, Privy signing
hooks, the Privy SDK outside the layer, a data-plane signing surface; and script integrity (no control characters, a
real `\.ethereum\b`). On the unfixed script **9 failed** (`regression-before-fix.log`); after the fix **37/37**.

## 2. Protected baseline (re-reviewed, updated)

`.otherbridge/g7-protected-baseline.txt` → `evidence/otherbridge-v1-11/g7gate-20261006T135310Z-f42f11/preflight/protected-hashes.json` (SHA-256 `199749d5f613e891f51cf0005567eeff90730cdbf3d375590ba8db9965a5d2c2`),
review record `evidence/otherbridge-v1-11/g7gate-20261006T135310Z-f42f11/g7-rebaseline/PROTECTED_REBASELINE_REVIEW.json` with per-file diffs in `g7-rebaseline/diffs/`.
Protected files: **42 → 99** — the previous 42 (only `verify-safety.mjs` changed) plus **57 G7 files** newly
protected: `src/g7/*`, `src/server/g7-local-pilot.ts`, `scripts/g7-pilot/**`, the G7 launchers/scans/builders
(`scripts/g7-*`), `tests/g7-pilot/*` and the G7 unit tests. Any later change to them fails `g7:safety`
(`protected-file-changed`, proven by a tamper probe: `checks/tamper-probe.json`). The reviewed dependency
`src/components/dialog.ts` (`trapDialog`, focus handling only) is recorded but not protected (shared UI).

| File | Before | After | Reason | Security impact | Regression tests |
| --- | --- | --- | --- | --- | --- |
| `scripts/g7-pilot-safety.ts` | `c81e9169a596…` | `d02fb5a85547…` | V1.11: the app shell (server-side pilot gate) moved from src/app/layout.tsx to src/app/(app)/layout.tsx; the exact-path allowlist follows it. | Same allowlist size, exact paths; the root layout (also used by landing/docs) is no longer allowed to reference the pilot. | pnpm g7:safety (0 findings); pnpm g7:pilot:safety (0 findings); scripts/verify-safety.mjs (PASS) |
| `scripts/g7-pilot/dry-acceptance.ts` | — (new) | `a1c631ea8fd7…` | V1.11: N consecutive fresh READ-ONLY dry-run sessions (pnpm g7:dry-acceptance). | Mode is hard-coded 'dry-run' (arm suppressed); records a write-method census (0). | pnpm g7:dry-acceptance: 10/10 DRY_RUN_COMPLETE (V1.11) + fresh release-gate dry preflight |
| `scripts/g7-pilot/preflight.ts` | `75545672737d…` | `8f527a0f3bb8…` | V1.11: BSC pin from selectCommonPin (phase A and B), phase-B floor = phase-A pin, bounded per-source finalized re-check, no re-pin around a hash disagreement, diagnostics on a failed preflight. | Gate composition P1–P20/S1–S8 unchanged; every critical BSC read still dual-source at one pin; no new write path; failures stay BLOCKED. | tests/unit/g7-pilot.test.ts (76, fixture preflight gates P1–P20/S1–S8 + one-shot session); tests/unit/g7-common-pin.test.ts (19); tests/unit/g7-pin-invariants.test.ts (11); pnpm g7:dry-acceptance: 10/10 DRY_RUN_COMPLETE (V1.11) + fresh release-gate dry preflight |
| `scripts/g7-pilot/product/local-pilot-bridge.tsx` | `6c2c8f5c3a88…` | `8aa3bfaa8052…` | V1.11: owner copy 'Safety check needs another attempt' (only when the single failing gate is X0) with Advanced details; RPC consensus row in Safety details; `\b429\b` word boundaries restored (a literal 0x08 had slipped in). | Display only: state stays BLOCKED, buttons and the single send path are unchanged, no wallet request. | tests/g7-pilot/product-pilot.spec.ts + product-runtime.spec.ts (pnpm g7:product-pilot:e2e, 15) |
| `scripts/g7-pilot/session.ts` | `9a5bf45d057b…` | `bfee04f35c1b…` | V1.11: the session snapshot carries the failed preflight's diagnostics (read-only display data). | None on the financial path: one extra read-only snapshot field; state machine, lock and arm unchanged. | tests/unit/g7-pilot.test.ts (76, fixture preflight gates P1–P20/S1–S8 + one-shot session); tests/g7-pilot/product-pilot.spec.ts + product-runtime.spec.ts (pnpm g7:product-pilot:e2e, 15) |
| `scripts/g7-product-pilot.ts` | `73aa21fae41e…` | `e3f78363e344…` | V1.11: '/' became the public landing page; the launcher prints and warms /bridge. | None: the session token stays in the URL fragment; same gate env and runtime. | tests/g7-pilot/product-pilot.spec.ts + product-runtime.spec.ts (pnpm g7:product-pilot:e2e, 15) |
| `scripts/verify-safety.mjs` | `206d05504013…` | `3ac2615630a7…` | Release-gate repair: the raw-provider pattern contained a literal 0x08 (backspace) where the RegExp word boundary \b was intended, so `.ethereum` property access on any object other than `window` was never detected. Replaced by a real \b. The signer-surface pattern now also covers eth_sign, wallet_sendCalls and wallet_grantPermissions (parity with the adapter's frozen FORBIDDEN_WALLET_METHODS list; the new regression tests showed they were not detected). | Stricter only. No exemption added or widened: the presence-only allowlist (one exact expression, one file, one occurrence) and the adapter deny-list exemption are unchanged. Current src/ produces no new finding. | tests/unit/verify-safety-regression.test.ts (37: 9 failed on the unfixed script, 37/37 after); pnpm g7:safety (0 findings); pnpm g7:pilot:safety (0 findings); scripts/verify-safety.mjs (PASS) |
| `src/g7/common-pin.ts` | — (new) | `03ab87e7a682…` | V1.11 P0 (owner retry failed with X0 'block not found'): canonical COMMON finalized BSC pin across two independent operator groups. | Stricter than the single-endpoint pin it replaces: >= 2 independent operator groups (same group never pairs), exact finalized block hash agreement incl. the logs witness, only `finalized`/explicit heights <= each source's own finalized head (no latest/pending/safe), step-down <= 16, age <= 30 s, never below the phase-A floor, hash disagreement fails closed at once, no pair => RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE (BLOCKED, no wallet request). | tests/unit/g7-common-pin.test.ts (19); tests/unit/g7-pin-invariants.test.ts (11); pnpm g7:dry-acceptance: 10/10 DRY_RUN_COMPLETE (V1.11) + fresh release-gate dry preflight |
| `src/g7/policy.ts` | `81748a4f2203…` | `affaeb5cfe28…` | V1.11: BSC_STATE_SOURCES (the V1.6 pair + OnFinality fallback), BSC_LOGS_WITNESS (NodeReal logs-only) and BSC_PIN_POLICY (chain 56, 30 s, 16 blocks, 8 s probe). | One additional vetted read-only state source of an independent operator group (OnFinality; LEGAL_REVIEW_REQUIRED for its terms). No gate, financial constant, pilot scope, amount, address or fee changed. | tests/unit/g7-common-pin.test.ts (19); tests/unit/g7-pin-invariants.test.ts (11) |
| `src/g7/rpc.ts` | `938262b2ccc8…` | `ac19d5a1db6e…` | V1.11: the vetted URL allowlist includes the BSC fallback source; optional per-call timeout for pin probes; 'block not found' is a transient (bounded) retry. | Allowlist stays exact URLs; read-method allowlist unchanged; no write method; retries are bounded reads of the same request. | tests/unit/g7-common-pin.test.ts (19); tests/unit/g7-pin-invariants.test.ts (11); tests/unit/g7-pilot.test.ts (76, fixture preflight gates P1–P20/S1–S8 + one-shot session) |
| `tests/g7-pilot/product-live-routes.spec.ts` | `6de9b701f26d…` | `c471075d1cef…` | V1.11: app routes start at /bridge. | Test only. |  |
| `tests/g7-pilot/product-runtime.spec.ts` | `5af5ad756a96…` | `45de52a30a6c…` | V1.11: app routes start at /bridge. | Test only. | tests/g7-pilot/product-pilot.spec.ts + product-runtime.spec.ts (pnpm g7:product-pilot:e2e, 15) |
| `tests/unit/g7-common-pin.test.ts` | — (new) | `dd0018c80311…` | V1.11: common-pin regression suite. | Test only. |  |
| `tests/unit/g7-pin-invariants.test.ts` | — (new) | `11c69345b688…` | Release gate: common-pin security invariants pinned as tests. | Test only. |  |
| `tests/unit/verify-safety-regression.test.ts` | — (new) | `424557508676…` | Release gate: end-to-end regression tests of verify-safety.mjs. | Test only. |  |

## 3. Common-pin invariants (unchanged, now pinned by `tests/unit/g7-pin-invariants.test.ts`)

- minimum two independent operator groups; same-group sources never pair; a single source never passes
- exact canonical finalized block hash agreement (state pair + logs witness)
- no latest/unfinalized substitution: `finalized` tag or explicit heights ≤ each source's own finalized head
- bounded step-down (≤ 16), stale limit (≤ 30 s), never below the phase-A floor
- hash disagreement ⇒ `RPC_FINALIZED_HASH_DISAGREEMENT`, fail closed at once (no other pair is tried)
- no independent pair ⇒ `RPC_CONSENSUS_TEMPORARILY_UNAVAILABLE` (BLOCKED, no wallet request)

## 4. Results (final state)

| Check | Result |
| --- | --- |
| `verify-safety` | PASS |
| `g7:safety` / `g7:pilot:safety` | PASS, 0 findings; 99 protected files checked, all unchanged |
| common-pin + invariants + verify-safety regression + G7 unit suites | 190/190 |
| unit / integration | 870/870 / 237/237 |
| G7 standalone harness | 11 passed (+1 opt-in live test skipped, as in the baseline) |
| G7 in-product fixture suite | 15/15 |
| format / lint / typecheck | PASS |
| Fresh READ-ONLY G7 dry preflight | 3/3 consecutive DRY_RUN_COMPLETE; BSC common pins 126,073,084–126,073,501 (age 3–4 s, bnb-chain-bsc-dataseed + allnodes-publicnode); read-only RPC methods only; write methods 0; wallet requests 0 |
| Financial intent digest | `4eecb9784961717f8464be8f9a650004974e328239f614211ad51bdf65aac869` (unchanged in all 6 records) |

Remaining blocker: the owner's own manual G7 retry (`pnpm g7:product-pilot`, confirmation in the wallet by hand).
