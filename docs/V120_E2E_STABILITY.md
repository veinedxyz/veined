# V1.20 E2E stability

Evidence run: `evidence/veined-v1-20/20261025T110040038Z/`. The final gate receipt and Turkish report in `final/` record measured acceptance; this document describes the implementation and preserved investigation.

## V1.19 failure classification

The initial 299/332 result did not represent 33 interchangeable memory flakes. Thirty failures were reproducible Swap overflow cases at 360/390/768px, two themes and five locales. The accepted V1.19 correction constrained the negative atmosphere inset at the application boundary. Two Landing failures expected the obsolete `/bridge` destination after the CTA moved to `/app`; the accepted assertion already matches `/app`. One Ukrainian Portfolio navigation trace contains `net::ERR_NO_BUFFER_SPACE` while fetching Next's development JavaScript. This supports resource exhaustion in that case, but does not prove RAM alone caused it. Historical samples reached 0.325GB and 0.692GB free physical memory. All historical failures remain untouched.

## V1.20 repairs

- The deterministic whole-spec greedy partition remains in `scripts/e2e-chunks.mjs`. One worker, zero retries, existing test and server timeouts are retained.
- Each chunk starts a fresh development server on the VEINED-only test origin `http://127.0.0.1:3126`. TCP readiness refuses an occupied port rather than reusing another application's server. The regular `pnpm dev` command is unchanged; milestone tests do not use its shared port 3100.
- The runner registers its Playwright PID and the test-server PIDs. `e2e-monitor.ps1` discovers descendants and records PID, parent and creation time. It measures owned Node/Chromium working sets separately from host free memory and commit headroom.
- `e2e-cleanup.ps1` checks PID **and creation time** before stopping a registered process. It batches the initial live-process inventory so already-exited browser children do not require individual CIM queries. It verifies no registered process remains and the port is free. The controlled lifecycle check creates an unrelated decoy and confirms it survives.
- Every second the guard checks the latest memory sample (sampled approximately every two seconds plus CIM collection time), stopping below 1GiB free physical memory, below 2GiB commit headroom, or above 4GiB owned Node/Chromium working set. The Next development process has a 2048MiB old-space heap limit. Frozen checks use one Vitest worker and a 3072MiB Node old-space limit. These are sampled working-set and heap limits, not a continuous whole-host memory guarantee. A guard stop is a failed/incomplete run, never a pass.
- Before each guarded chunk, two host-memory observations five seconds apart must both show at least 5GiB free physical RAM and 8GiB commit headroom. The runner waits up to ten minutes without stopping other processes; insufficient or unavailable telemetry fails admission. This reduces startup pressure but cannot prevent another project allocating memory during a running chunk. The in-run limits remain unchanged.
- Failure-only request diagnostics retain local request paths and browser error reasons without collecting query strings or credentials.
- Coverage acceptance checks actual result identities against the discovery plan, including no missing, duplicate, extra, skipped, retried or flaky tests. Source binding covers runtime, tests, harnesses and assets; documentation is excluded from that E2E-specific digest. Full frozen reproduction binds the entire source inventory.

## Discovered hydration defect

Prerendering Portfolio exposed a real input race: the address field could accept typing before React attached handlers; hydration then lost the address. The initial targeted V1.20 run preserved 29 passes and three failures. The repair keeps meaningful server HTML visible but disables address inputs, mode buttons and Scan until the hydration snapshot becomes ready. No financial calculation, provider rule or timeout changed.

The new browser regression deliberately holds JavaScript requests, verifies the meaningful first view and disabled form, releases scripts, then verifies the entered value persists. The original progressive Portfolio tests remain unchanged.

An additional production-preview diagnosis passes 11 unchanged/extended tests: all four V1141 cases, the V1142 watch-address/render-census/RTL cases and all four V120 cases. These tests use synthetic API fixtures and never replace the complete development-server suite.

## Preserved diagnostic attempts

`checks/targeted/` holds the hydration failures. `checks/targeted-repair/` records refusal when another repository owned port 3100. The temporary 3122 diagnostic in `checks/targeted-repair-isolated/` was stopped after the existing local-test Host policy correctly rejected its fixture requests; this attempt is not an accepted run. Port configurability was reverted without broadening application security policy. The other application's process was not stopped. Process-lifecycle development attempts are retained alongside the passing check.

`checks/targeted-repair-standard/` was stopped by the host-memory guard at 0.323GB free RAM, with owned Node/Chromium memory peaking at 1.81GB. Five completed assertions appeared in its console before abortion, but the final reporter was unavailable; they are not counted as accepted coverage. Shared host contention remains visible, rather than being labelled a successful rerun.

The first large visual matrix (`qa-final/`, retained as a failed attempt) found 12 real 360px Landing/Docs overflows across both themes and EN/TR/AR. The 148px minimum lockup is retained; the mobile marketing header now uses compact spacing and a language-code button without its decorative globe. All controls remain available. The repaired full matrix is in `qa-accepted/`.

## Accepted sequences

Sequence 1 is a complete independent `e2e-chunks run` in this workspace. Sequence 2 is another complete invocation inside a new frozen source copy after clean frozen-lockfile installation and mandatory gates. Both must independently discover and pass at least 332 tests. Targeted diagnostic successes cannot fill holes in either sequence. Counts, memory extrema, cleanup receipts, source digests and any new failures are authoritative in each `e2e-summary.json` and the final report. An incomplete or failed sequence requires `RETURN_FOR_REPAIR`.

## Preserved pre-isolation full sequence

The complete post-repair, pre-isolation sequence in `checks/e2e-sequence-1/` passes **336/336**, with zero failures, retries, skips, flakes, missing or duplicate tests. Its tested source is `ec745fbc63397a2bb0abd00c461842e9ac930053ccfaf0bf430c6fe2b2942892`. All ten cleanup checks pass with zero remaining registered processes and a free test port. Peak sampled owned Node+Chromium working set is **3.387GiB**. This historical run does not count as either acceptance sequence after the isolation change.

One sample in chunk 3 records **0.250GiB host free RAM**, with 19.925GiB commit headroom and 3.082GiB owned working set. The short dip was between five-second guard checks; it was retained rather than omitted and did not cause a test failure. Other chunks' minimum free memory ranges from 3.252 to 6.840GiB. This distinguishes controlled, restarted test-process memory from remaining shared-host contention. The independent frozen sequence's complete measurements remain authoritative in its summary and the final report.

## Explicit test isolation after owner steering

The owner explicitly prohibited stopping or modifying video-archive-platform, port-3100 services, other projects, or other agents. No such process was stopped. The earlier frozen reproduction was stopped only within its recorded VEINED process tree before applying this change; partial logs remain in `reproduction/` and are not an accepted reproduction.

`src/server/e2e-origin.mjs` accepts only a canonical `http://127.0.0.1:<port>` origin, a nonprivileged port other than 3100, and no credentials, path, query, fragment, alternate host or wildcard. The synthetic Host override requires all five explicit conditions: `NODE_ENV=development`, `OTHERBRIDGE_MODE=local-test`, mainnet submission `false`, `OTHERBRIDGE_E2E_ISOLATED=1`, and a valid `OTHERBRIDGE_E2E_ORIGIN`. Invalid partial opt-in fails closed without falling back to port 3100. Production always retains `mainnet-readonly` and refuses the synthetic Host branch.

The test launcher sets the existing exact `OTHERBRIDGE_APP_ORIGINS` configuration to that single test origin. `src/proxy.ts` and `src/server/origin-policy.ts` remain byte-identical to preflight: production CSP/CORS/origin rules have not been broadened. Twenty-eight new unit cases verify invalid origins, required flags, production rejection, unchanged CSP and mismatched Host/Origin rejection. A live synthetic health request on 3126 succeeds, while the same request carrying origin 3100 is rejected. Cookie URL literals in historical browser fixtures are host-scoped and send no traffic to port 3100; the network-image assertion now derives its expected origin from Playwright's baseURL.

Production smoke and locale test processes use their own explicit origin on 3127 and refuse occupied ports. Protected G7 suites retain their own existing isolated launcher ports and all 107 protected files remain unchanged.

The first isolated full invocation in `checks/e2e-isolated-sequence-1/` stopped before test results when Windows briefly locked the memory sample file (`EBUSY`). Its owned processes were cleaned up and its logs remain a failed attempt. The sampler reader now retains the previous sample during a transient lock and rejects a sample age above 15 seconds; unexpected read errors stop the owned runner through its cleanup path. This does not retry browser tests or relax memory limits.

The immediate follow-up `checks/e2e-isolated-sequence-1b/` correctly refused port 3126 because the prematurely aborted run had started its own Next child after the last sampler snapshot. The server registration, parent chain and creation times identified this as VEINED's own failed-run process; only that tree was stopped. No other project's process was selected.

The complete isolated invocation `checks/e2e-isolated-sequence-1c/` records **305 passes and 31 unreported/not-run cases**, not a pass. Its seventh chunk was stopped at 0.700GiB host free RAM, while owned Node/Chromium used 1.947GiB and commit headroom remained 22.060GiB. Console assertions completed before the guard are not promoted to coverage without the final reporter. All ten cleanup receipts pass. The new admission step follows this observed shared-host pressure; the existing in-run limits are not relaxed.

The first isolated reproduction in `reproduction-isolated/` exposed a harness environment leak: local DB credentials were passed to every gate, making the replay integration fixture use persistent PostgreSQL rate-limit counters. Three assertions correctly received 429 instead of their expected application result (353/356 passed). The production limiter and financial tests are unchanged. The reproduction now explicitly scopes those six DB variables to the DB suite only; unit/integration fixtures, browser servers, installs and bundle checks receive no DB credentials. The original failed reproduction is preserved, including its passing independent checks, and cannot count as accepted.

The second isolated reproduction (`reproduction-isolated-2/`) passes unit 1698, integration 356 and DB 38 after that scope repair. Its production locale check nevertheless stops on Thai navigation after 23 completed locales with `net::ERR_NO_BUFFER_SPACE`. This is a resource/transport failure, not proof of a Thai translation defect or RAM as the sole cause. A later read-only host census showed 126 TIME_WAIT connections and a 16384-port ephemeral range; this does not reconstruct conditions at failure and is not treated as causal proof. The incomplete 24-locale gate remains failed.

The locale harness now starts and closes a fresh Chromium process for each language, keeps all 24 locales and all existing assertions, and writes explicit partial failure receipts. In the explicitly enabled V1.20 Windows reproduction environment (`OTHERBRIDGE_TEST_RESOURCE_ISOLATION=1`), it uses the same two-sample memory admission as E2E before each language. Other environments do not acquire a new PowerShell dependency for locale checks. No automatic browser-test retry or timeout increase was added.

The next complete sequence targets are `checks/e2e-isolated-sequence-1d/` and `reproduction-isolated-3/e2e-sequence-2/`; a target path is not a PASS declaration. The authoritative final receipt/report identifies the two actually accepted sequences, or records the remaining failure. Each must independently pass the complete discovery set from the final tested source. Actual counts, memory, cleanup and source equality are mandatory; diagnostic runs and earlier partial/3100 passes cannot substitute for them. Independent frozen checks run before the next full E2E attempts so a resource-constrained E2E cannot prevent completion of unrelated gates.
