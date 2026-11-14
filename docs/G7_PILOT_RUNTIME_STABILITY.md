# G7 product pilot — runtime stability repair

Status: **READY_FOR_OWNER_RETRY** (2026-10-06). Evidence: `evidence/otherbridge-g7-runtime-stability/stab-20261006T073601Z-1b0eec`
(`final/` suites and builds, `live/` final live dry run, `live-attempt-1/` the fail-closed first attempt). No real
transaction, signature, approval, permit or broadcast was made by this work; the production execution gate is unchanged.

## 1. What went wrong (2026-10-06 owner session)

| Symptom | Root cause |
| --- | --- |
| `pnpm g7:product-pilot` failed with `EADDRINUSE` on 127.0.0.1:3197 | The previous launcher (`node … g7-product-pilot.ts`) outlived the wrapper that started it. On Windows, killing pnpm does not kill its grandchildren; the launcher kept 3197 as an orphan. The crashed start also left an evidence directory with only `SESSION_CREATED` (the session was created before the port bind). |
| Wrong process tracked | The PID that was visible (pnpm / the background shell) was not the process holding the port; nothing recorded the launcher's own PID. |
| Next.js / Turbopack / Jest worker child-process errors, low memory | The pilot ran `next dev` (Turbopack, on-demand compilation, build workers) inside a machine that had ~1–3 GB free. Each first visit of a route compiled it; worker processes died under memory pressure. |
| Swap / Portfolio / Activity / Networks / Help slow or broken in the pilot | Same dev runtime: on-demand compilation per route under memory pressure, plus the development CSP only allowed the HMR websocket on `ws://127.0.0.1:3100`, so the dev client on 3197 could never connect its HMR socket. |

## 2. What changed

### Runtime: production-like, separate artifact

- `pnpm g7:product-pilot` = `g7-pilot-build.ts --profile local-g7-pilot --if-stale && g7-product-pilot.ts`.
  The launcher serves the **local-g7-pilot** artifact with `next({ dev: false })` in its own process: no dev server,
  no Turbopack, no build/render workers (verified: 0 child processes), no dev overlay/indicator, no HMR, no websocket
  upgrade (refused), React production build, strict production CSP.
- **Two artifacts, never mixed.** `next.config.ts` (`g7BuildProfile`):
  - production-public: default `next build`/`next start` → `.next`, bundle constant `"0"` in every phase.
  - local-g7-pilot: `OTHERBRIDGE_BUILD_PROFILE=local-g7-pilot` → `.next-g7-pilot`, constant `"1"`; built only without
    the runtime flag, served only with `OTHERBRIDGE_G7_LOCAL_PILOT=1` (the launcher). `local-g7-pilot-test` =
    `.next-g7-pilot-test` with the test-only Privy App ID for the fixture suites.
  - Refused: the pilot flag without a profile (public build/start/dev), a pilot profile in `next dev` or `next start`,
    a pilot build with the runtime flag set, unknown profiles.
- **Server gate** (`src/server/g7-local-pilot.ts`): bundle constant `"1"` (compile-time; `"0"` in public builds, so
  no runtime environment can open it there) + `NODE_ENV=production` + flag + launcher `127.0.0.1` origin + exact Host.
- **Freshness.** The build writes `otherbridge-build-profile.json` (profile, BUILD_ID, source digest of `src/`,
  `public/`, the pilot module, build config, lockfile and `.env*`). The launcher refuses a missing, foreign or stale
  artifact (`BUILD_REQUIRED`); `pnpm g7:product-pilot` rebuilds it first when needed. `next build` rewrites
  `next-env.d.ts`/`tsconfig.json` for a custom `distDir`; the build script restores both byte-identical.
- **Public artifact proof.** `pnpm g7:artifacts:check`: the public `.next` has 0 client/server files with pilot-module
  strings and no pilot manifest; each pilot artifact has the module and its manifest.

### Process lifecycle

- **Port first.** The port is bound before any session, evidence or lock exists. `EADDRINUSE` is explained:
  - `OTHERBRIDGE_PILOT_RUNNING` — our session (identity endpoint `GET /g7-pilot/runtime` + runtime record): pid,
    session, mode, state, start/expiry; use it or stop it;
  - `OTHERBRIDGE_PILOT_UNRESPONSIVE` — our launcher holds the port but does not answer;
  - `OTHERBRIDGE_PILOT_OTHER_CHECKOUT` — another checkout's launcher;
  - `PORT_HELD_BY_OTHER_PROCESS` — another application (pid, name). **Never stopped.**
  The OS probe (`scripts/g7-pilot/os-probe.ts`) is read-only: PowerShell `Get-NetTCPConnection`/`Get-CimInstance`
  (lsof/ps elsewhere) through a shell-less `execFile`; it never signals a process.
- **No random port.** Privy's allowed origins are exact (`127.0.0.1:3197`); another port would break the wallet
  connection, so the launcher never changes the port by itself.
- **Runtime record** `.otherbridge/g7-pilot-runtime-3197.json` (git-ignored): the launcher's own pid and start time,
  instance id, per-run control token, session, evidence, artifact, watched wrappers. Only the writing instance
  removes it; a stale record is reported and replaced.
- **Orphan guard.** At start the launcher records its launch wrappers (direct parent, then pnpm's `cmd.exe`, pnpm,
  the terminal shell) and checks them every 2 s; when one disappears it shuts down gracefully
  (`LAUNCH_WRAPPER_EXITED`). On POSIX a changed parent pid also counts.
- **Graceful shutdown** on SIGINT (Ctrl+C), SIGTERM, SIGHUP (terminal closed), SIGBREAK (Ctrl+Break), the stop
  command, session expiry and an uncaught exception: journal `SHUTDOWN`, stop timers, remove the runtime record,
  close the server and Next, exit (hard deadline 8 s).
- **Stop command** `pnpm g7:product-pilot:stop [--port] [--force]`: (1) our instance answers → token-protected
  `POST /g7-pilot/runtime/shutdown` (loopback, exact Host, no Origin, control token; refused with
  `WALLET_REQUEST_IN_FLIGHT` while a wallet request is in flight unless `--force`); (2) our recorded pid is alive but
  silent → stopped only if its command line names `scripts/g7-product-pilot.ts` and its start time equals the
  recorded one; a reused pid is never touched; (3) otherwise the owner is explained and left alone. No kill by name.
- **Session expiry.** An idle session past its 90 min lifetime becomes `EXPIRED` (no capability) and the launcher
  stops 60 s later. A run that armed keeps observing (tracking/detection windows) and stops when they end.
- **Safety scan** (`pnpm g7:pilot:safety`) covers the new files: one fixed shell-less `execFile` import, liveness
  probes `process.kill(pid, 0)` only, the stop command's single kill after the ownership check, the build script
  cannot set the runtime flag, and a behavioural check of the whole `g7BuildProfile` matrix.

### UI: lazy dialog bodies

The wallet and review dialog bodies moved to `src/components/product-dialogs.tsx`, loaded on hover/focus/click of
their openers; the dialog opens only after its body rendered (`flushSync`), so there is no empty frame. Swap,
Portfolio, Activity, Networks and Help remain separate route chunks (verified loading in production).

### Unchanged

Pilot scope (authorized EOA, exactly 5 ONE, ≤ 0.18 ONE network fee, service/Otherbridge fee 0, ≤ 5.18075931 ONE
maximum debit, 5 CROSS, ONEchain 612055 → BSC 56), gates P1–P20/S1–S8, one-shot lock, quote ≤ 20 s at the wallet
request, server re-verification of the canonical intent, browser re-verification, the single send path, firewall,
`GLOBAL_EXECUTION_ENABLED=false`, write registry, kill switch, 0 bps fee policy, the 42 protected files.

## 3. Measurements (Windows 11, 32 GB RAM, 1–6 GB free during the runs; reported, no hard SLA)

Final live dry run (`live/`): `pnpm g7:product-pilot --dry-run` exactly as the owner starts it, real Privy App ID,
real read-only mainnet preflight, Playwright Chromium with a recording EIP-6963 wallet, real Privy connect-only modal.

| Measurement | Value |
| --- | --- |
| Runtime | Next.js production runtime, `.next-g7-pilot` build `oG7i9FjJRcJrFQnDxubmV`, one process (pid 44448) |
| Child processes of the pilot server | **0** (no Turbopack, Jest/render workers, test runners) |
| Startup (artifact fresh) | 31.6 s wall; Next ready ≈ 1 s, the rest is the read-only mainnet preflight; warm Bridge render 167 ms |
| Server RSS (2 s samples, whole run) | 187–226 MB; OS peak 243 MB; working set 225 MB / private 267 MB after the run |
| Idle RSS (after 60 s idle) | 224 MB |
| Soak: 10 full route cycles | 208 → 213 → 219 → 220 → 221 → 221 → 224 → 225 → 226 → 227 → 225 MB, idle 224 MB (warm-up, no growth trend); cycle 288–395 ms |
| First Bridge render (page load → pilot card) | 390 ms |
| Swap / Portfolio / Activity / Networks / Help / back to Bridge | 371 / 270 / 98 / 79 / 90 / 78 ms |
| Fresh final preflight (click → dry-run complete) | 14.3 s; quote age at decision 6.2 s, at arm 6.2 s |
| local-g7-pilot build | 18.5 s (warm cache) – 40.2 s (first); build tree peak 1.35–1.84 GB, 9 processes (build time only) |
| Public builds | 13–21 s, peak 1.33–1.63 GB |
| Fixture pilot (test artifact, `product-runtime`) | first Bridge 396 ms; routes 75–390 ms; RSS 206 MB, peak 287 MB, 0 children |
| Initial JS (gzip, live config, TR first visit) | **289,535 B** (V1.10 289,823 B; −288 B); budget 290,690 B; margin 1,155 B |
| Repeated start while running | refused in ≈ 4 s, exit 3, `OTHERBRIDGE_PILOT_RUNNING`, first session untouched |
| Stop command | graceful, ≈ 1.6 s; runtime record removed; port free |
| pnpm wrapper killed | launcher shut itself down in ≈ 0.6 s (`LAUNCH_WRAPPER_EXITED`) |

Memory investigation: one Next server in the launcher process (no duplicate server, no file watcher, no HMR); the
Privy layer mounts once at product level and survives route changes; the pilot card clears its poll/tick timers on
unmount and claims once per Bridge visit (14 claims for 14 visits in the live run; the development runtime's
StrictMode double claims are gone); no test runner or worker is started by the launcher.

## 4. Tests (final tree)

| Suite | Result |
| --- | --- |
| Unit / integration | 737/737 (724 + 13 new) / 223/223 |
| format, lint, typecheck, i18n (24 × 484), verify-safety, `g7:safety`, `g7:pilot:safety` | PASS, 0 findings; protected files 42/42 identical |
| E2E (dev test server, 9 specs) | 181/181 — run in six chunks after the first full run was stopped by Claude Code's low-memory guard (83 passed, 6 worker/Chromium start failures 0xC0000142/"Target crashed", 92 not run) |
| Privy E2E (MetaMask, Rabby, Phantom, Coinbase doubles; inventory/CSP) | 18/18 (part of the 181) |
| G7 standalone pilot (fixture) | 11/11 (+1 opt-in live spec skipped) |
| G7 in-product pilot on the production runtime (fixture) | `product-pilot` 10/10, `product-runtime` 5/5 |
| Public builds: no App ID / test App ID / live config | PASS; artifact check: 0 pilot files in `.next` (client and server), no pilot manifest |
| Strict CSP acceptance, production smoke, V1.9 production checks (no App ID / test App ID), 24 production locales | 16 pages PASS, PASS, PASS/PASS, 24/24 |
| local-g7-pilot build + artifact check | PASS (pilot module in exactly 1 client chunk, manifest present) |
| Final live dry run (real Privy, routes, fresh final preflight, arm suppressed) + live soak | 2/2 (attempt 2; see §5) |

New regression tests: `tests/g7-pilot/product-runtime.spec.ts` (all routes in pilot mode without dev tooling,
console/CSP errors or workers; busy port by a foreign process; repeated start; stop command; orphaned wrapper;
session expiry; restart with a stale page/Privy session + account change + disconnect/reconnect),
`tests/unit/g7-pilot-runtime.test.ts` (ancestry, runtime record/token, identity/port probe, fixture-only test
arguments, build manifest freshness, marker scan), `expireIfDue` and the profile matrix in `tests/unit/g7-pilot.test.ts`,
and the opt-in `tests/g7-pilot/product-live-routes.spec.ts`. One existing test was made deterministic:
`product.spec.ts` U01 ran axe while the 0.16 s theme colour transition was still running (it measured a
mid-transition frame, #d1d3d1 on #56755f); it now waits for running animations to finish (final colours #fff on
#3e604a).

## 5. Known remaining issues

- **Public BSC RPC lag.** Live attempt 1 failed closed: `bsc-rpc.publicnode.com` answered `block not found` for the
  freshly pinned finalized block in all three re-pinned attempts of the final preflight → `BLOCKED`, no wallet
  request. 0 occurrences in the 10 other sessions of 2026-10-05/06. The pilot card offers **Check again** (a full
  fresh read-only check) — the owner can retry without restarting; the gate logic itself was not changed.
- **Server unreachable under an open page.** If the pilot server stops while a page is open, that page cannot load
  lazy chunks; Next's built-in error screen then uses an inline style that the strict CSP refuses (unstyled error).
  Opening the fresh session URL recovers fully (tested). Pre-existing product behaviour, not pilot-specific.
- **Memory headroom.** Builds peak at 1.3–1.8 GB; on this machine (WSL VM, browsers) the first full E2E run was stopped
  by the low-memory guard. The pilot server itself stays near 0.2 GB.
- **Owner's own wallet extension.** Real Privy was exercised with a recording wallet; the owner's MetaMask/Rabby is
  checked by the product at connect time (external, non-embedded, exact EOA, chain 612055).
- **Port is fixed** to the Privy-allowed 127.0.0.1:3197 by design (no automatic alternative port).
