# G7 pilot runtime stability — production-like local runtime (supersedes the dev-server launcher)

- **Runtime.** `pnpm g7:product-pilot` no longer runs `next dev`/Turbopack. It serves a separate **local-g7-pilot**
  production artifact (`.next-g7-pilot`, built by `pnpm g7:product-pilot:build`, rebuilt automatically when stale)
  with the Next.js production runtime in the launcher process on `127.0.0.1:3197`: no dev overlay or indicator, no
  HMR/websocket surface, no Turbopack/Jest workers or other child processes, React production build, strict
  production CSP. Details and measurements: [G7_PILOT_RUNTIME_STABILITY.md](G7_PILOT_RUNTIME_STABILITY.md).
- **Artifacts are separate.** The public `next build` (`.next`) always folds the pilot constant to `"0"`: no pilot
  module in client or server output (checked by `pnpm g7:artifacts:check`). `next.config.ts` builds the
  `local-g7-pilot` profile only into its own directory and lets only the launcher (`OTHERBRIDGE_G7_LOCAL_PILOT=1`)
  serve it; the flag without the profile, the profile in `next dev`/`next start`, or an unknown profile fail closed.
  The server gate opens only for bundle constant `"1"` + production runtime + flag + launcher origin + exact Host.
  The launcher refuses an artifact whose manifest, BUILD_ID or source digest does not match (never serves stale code).
- **Lifecycle.** A busy 3197 is explained, never forced: our running session (identity + runtime record), our hung
  launcher, or another application (pid/name; never stopped). No random port: Privy allows only 127.0.0.1:3197.
  `pnpm g7:product-pilot:stop` stops only a launcher it can prove is ours (instance id + control token, or pid + start
  time + command line); it refuses while a wallet request is in flight unless `--force` (the one-shot lock is never
  touched). The launcher watches its launch wrappers (pnpm's `cmd.exe`, pnpm, the terminal shell) and shuts down when
  one disappears; Ctrl+C / SIGTERM / SIGHUP / Ctrl+Break and session expiry (idle session → `EXPIRED`, then stop after
  60 s; an armed run keeps observing) shut down gracefully and remove `.otherbridge/g7-pilot-runtime-3197.json`.
- **Scope, gates, one-shot lock, quote ≤ 20 s at the wallet request, firewall and send path are unchanged.**

| Command | What it does |
| --- | --- |
| `pnpm g7:product-pilot` | Builds the local-g7-pilot artifact if missing/stale, then serves the normal product with the pilot on `127.0.0.1:3197` (production runtime). |
| `pnpm g7:product-pilot --dry-run` | Same; the final step never releases the wallet request. |
| `pnpm g7:product-pilot:build [--profile local-g7-pilot-test] [--measure]` | Builds a pilot artifact (`.next-g7-pilot` / `.next-g7-pilot-test`). |
| `pnpm g7:product-pilot:stop [--force]` | Stops the running launcher of this checkout after verifying it. |
| `pnpm g7:artifacts:check` | Proves the public `.next` has no pilot module and each pilot artifact has it. |
| `pnpm g7:product-pilot:e2e` | Fixture suites on the production runtime (`product-pilot`, `product-runtime`); `product-live-*` are opt-in live dry runs. |

---

# V1.9 — the pilot now connects through the Privy wallet layer (G7 READY = STALE)

- **Connection.** *Connect wallet* in the pilot Bridge card opens the Privy external-wallet modal (connect-only, no
  signature). There is no injected-provider fallback: the real (non-fixture) pilot needs a real
  `NEXT_PUBLIC_PRIVY_APP_ID` in `.env.local` ([PRIVY_SETUP.md](PRIVY_SETUP.md)). Today none exists, so a real owner
  run is **not possible** until the App ID is configured and the W18 live wallet acceptance passes.
- **Signing path.** Identity reads and the single wallet request go through the session's `WalletProviderAdapter`:
  `requestWalletConfirmationOnce(adapter, canonical = armed server tx, reviewed = reviewed tx, sessionId)` →
  `sendCanonicalTransaction(..., { gate: "g7-local-pilot" })`, which compares `chainId, from, to, value, data, gas,
  maxFeePerGas, maxPriorityFeePerGas`, re-reads the live account/chain and refuses a revoked (stale) session. Any
  account change, chain change, disconnect or reconnect creates a new epoch; the old adapter is revoked, the review
  confirmations reset, and the server-side preflight runs again after a network switch.
- **Fixture/test wallet.** Fixture mode accepts only the wallet whose Privy wallet id (EIP-6963 rdns) is
  `invalid.otherbridge.g7-mock`; real mode refuses it.
- **Scope unchanged.** Authorized EOA `0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c` only; `0x28136a77…2a6b` refused;
  exactly 5 ONE principal, network fee ≤ 0.18 ONE, service/Otherbridge fee 0, maximum debit ≤ 5.18075931 ONE,
  receive exactly 5 CROSS, ONEchain 612055 → BSC 56, no MAX, no approval/permit; one-shot lock
  `.otherbridge/g7-pilot-lock.json` (exclusive create, survives reconnect/reload/tabs/disconnect; never deleted).
- **STALE → fresh validation required.** V1.9 changed protected signing-path files (`submission.ts`,
  `wallet/provider.ts`, `verify-safety.mjs`, `pnpm-lock.yaml`, `.env.example`). The pilot's safety gate failed closed
  (every session BLOCKED) until the reviewed change set was re-baselined (`evidence/otherbridge-v1-9/…/g7-rebaseline`).
  Before any owner action: configure the App ID, pass W18, run `pnpm g7:product-pilot --dry-run` (fresh mainnet
  read-only preflight P1–P20 + S1–S8 through the Privy-connected wallet), then a separate explicit owner approval.

---

# G7 controlled pilot — inside the normal Otherbridge Bridge screen (local only, one shot, human-signed)

Scope (owner-approved): exactly **one** `bridgeToken(56, native sentinel, pilot EOA, 5 ONE, fresh network fee, 0, 0x)`
from the authorized pilot EOA **`0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c`** on ONEchain 612055 to the ONEbridge proxy
`0xb81d6e000000000000000000000000000000c0de`, recipient the same EOA on BSC 56 (canonical CROSS
`0x6bf62ca91e397B5A7d1D6bCe97D9092065d7A510`), Otherbridge fee 0, through the owner's own injected wallet.
The principal is always exactly 5 ONE, whatever the wallet balance.

The earlier pilot EOA `0x28136a77ec8ba3d918114712a588b4095ba12a6b` is **SUPERSEDED_BY_G7_PILOT_EOA_CHANGE**: its V1.7
package, owner card, checklist and pilot evidence are preserved byte-identical (hashes in
`G7_SUPERSEDED_BY_G7_PILOT_EOA_CHANGE.json`) and are never used as the active approval.

| Command                           | What it does                                                                                                                                                         |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm g7:product-pilot`           | Opens the **normal Otherbridge product** on `127.0.0.1:3197` with the local pilot: Bridge → Connect wallet → ONEchain → BSC → 5 ONE → Review → **Review in wallet**. |
| `pnpm g7:product-pilot --dry-run` | Same, but the final step never releases the wallet request.                                                                                                          |
| `pnpm g7:pilot`                   | Standalone technical page, dry run only (diagnostics). Its live real mode is retired.                                                                                |
| `pnpm g7:pilot:safety`            | Static scan of the pilot, the in-product module and the three `src/` gate files.                                                                                     |
| `pnpm g7:product-pilot:e2e`       | In-product mock-wallet E2E (fixture data). `pnpm g7:pilot:e2e`: standalone page E2E.                                                                                 |

## How it stays local and fail-closed

- **Production unchanged.** `GLOBAL_EXECUTION_ENABLED=false`, the write registry, kill switch and 0 bps fee policy are untouched. `next build` / `next start` refuse `OTHERBRIDGE_G7_LOCAL_PILOT` (next.config.ts), and the pilot client module is behind a build-time constant that is `"0"` in every normal build, so production bundles contain no pilot control.
- **Server-decided.** `src/server/g7-local-pilot.ts` opens the pilot panel only for a development runtime + `OTHERBRIDGE_G7_LOCAL_PILOT=1` + the launcher's `127.0.0.1` origin + the exact Host. No query parameter, cookie or browser state can enable it.
- **One process, loopback only.** The launcher serves the product and the pilot API (`/g7-pilot/api/*`) on `127.0.0.1`: exact Host and Origin, per-run bearer token (URL fragment only), per-claim CSRF, no CORS, `no-store`, product CSP with `frame-ancestors 'none'`.
- **Single write path.** The only send-transaction call is `scripts/g7-pilot/product/wallet-send.ts` (`requestWalletConfirmationOnce`, outside `src/`, so `src/features/bridge/submission.ts` stays the app's only write boundary).

## Product flow and checks

The Bridge card keeps the normal product look with a small `CONTROLLED PILOT · LOCAL ONLY · 5 ONE AUTHORIZED` badge. The amount is locked to 5 ONE (no MAX). Any other connected account sees _“This wallet is not authorized for the G7 pilot.”_ A wrong network shows a separate **Switch to ONEchain** step; once the wallet is on ONEchain the full preflight runs again. The review dialog shows You pay / Network fee / Otherbridge fee / Estimated gas / Maximum wallet debit / You receive / From / Recipient / Approval, with **Safety details** (runtime pins, authority, reserve, pending, simulation, firewall, RPC consensus, calldata hash, intent digest, exact wallet request) behind an expandable section. **Review in wallet** unlocks only after both checkboxes and the exact phrase `G7 5 ONE` (subtext: _One transaction · 5 ONE · no approval_).

On the click: fresh final mainnet preflight (reviewed gates P1–P20 + owner-scope gates S1–S8: G5, runtime/proxy/verifier pins, validators, threshold, admin, VERIFIER_ROLE, pauses, pair, minimum ≤ 5 ONE, network fee ≤ 0.18 ONE, service fee 0, reserve, pending, in-flight, balance, `eth_call`, `eth_estimateGas`, dual RPC, firewall, maximum debit ≤ 5.18075931 ONE). The server recomputes the intent digest, which must equal the reviewed one. The one-shot lock `.otherbridge/g7-pilot-lock.json` is created exclusively **before** the parameters are released, and the browser re-verifies them independently. The single wallet request is made only if the quote is ≤ 20 s old. Any bound exceeded → `OWNER_REAPPROVAL_REQUIRED`; rejection → `USER_REJECTED`; uncertain provider result → `MANUAL_REVIEW_REQUIRED`; no retry, no automatic resend, no `releasePending`.

Tracking in the Bridge card: Submitted → Confirming on ONEchain → ONEchain confirmed → Bridging → BSC finalized → Completed. Completed (G7 PASS) requires source status 1 on a canonical block, the mined transaction byte-identical to the armed one, exactly one `BridgeInitiated` with the exact recipient/amount/index, `BridgeFinalized(612055, index)` preceded by the exact canonical CROSS `Transfer(bridge → recipient, 5 CROSS)` on a finalized BSC block.

Evidence per run: `evidence/otherbridge-g7-product-pilot/<mode>-<timestamp>-<id>/` (RPC audit, every preflight with its observations, session journal, launcher log, startup report; never the session token).
