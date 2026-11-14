# V1.12 request budget and census

Evidence: evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/g7-rpc; final cohort and percentile tables are emitted under g7-soak and g7-final. Preserve preliminary failures as well as successful diagnostic financial reads.

| Trigger | Work | Budget / cache |
| --- | --- | --- |
| Page open / normal health | Current native health snapshot; no G7 ledger or pilot capability | 39 wire reads; method census in lightweight-health-https-methods.json |
| New full dry session | Capability probes, canonical checkpoint anchors, fresh dual state, delta logs, ledger replay, initial financial checks | Module source instance maximum 2,535 wire requests |
| Same-session retry | Fresh pool admission and state; simultaneous retries share one promise | Same source-instance bound; provider cooldown stops immediate wire retries |
| Final diagnostic | Fresh BSC obligations then fresh ONE quote, exact simulations and all financial gates | Never joins an initial/refresh result |

The bound is three times the measured 845-request cold diagnostic session, allowing bounded availability recovery. It is a source-instance traffic bound, not permission to skip a gate or retry indefinitely. Quota exhaustion stops. Typical cached initial+final diagnostics still require about 844 requests because authority/role and dual-simulation reads remain mandatory. Exact per-provider/method count, latency, retries, hits/misses and rate limits are recorded in each rpc-audit.jsonl and SUMMARY. The log history is incremental; state truth is not reused.

HTTP Retry-After seconds and dates are honored. A provider cooldown is shared across local clients, increases exponentially with jitter, and cannot be shortened by an overlapping successful response. HTTP 429 or a quota JSON-RPC response gets no immediate retry or recursive range split. Range-size errors alone may split a bounded range. Contract reverts do not retry. Selected log traffic is serialized with a measured one-second spacing; quote/simulation RPCs remain unpaced so the existing 20-second owner release freshness window is preserved.

A rejected all-method pacing experiment expired the fresh quote; its diagnostic evidence is retained and it was removed. The interrupted first soak found the mixed-token P8 issue and is not counted as acceptance. A fetch-only native-health instrumentation experiment did not observe the Node HTTPS transport; use the separately corrected Node HTTPS audit, not its zero fetch count. The running early census used an incomplete handwritten read-method regex; a verified census must be derived from unchanged G7_READ_METHODS and raw audits, preserving both records.

The final native-health instrument captures both request.write and request.end before transport, refuses any method outside the canonical read allowlist, and records all 39 method names. The earlier HTTPS-only count captured 39 requests but had null method fields; it is not used as proof of method classification.

No declared provider quota is invented. Public endpoints have no guaranteed capacity here. Failover availability and successful retry cadence must be judged from the actual cohort, with every quota, timeout, hash fault and P20 release blocker retained.

## V1.12 final measured evidence

Status: RETURN_FOR_REPAIR. HEAD 8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5. Active accepted baseline is unchanged; proposed baseline 5c895bfc9d511ce7a3a2e220f5f2376e63dee001b4bf900caf78dc24f2d6cbc1 is not activated.

- Live 30-run cohort: 30/30 financially reconciled, 30/30 P20-blocked; DRY_RUN_COMPLETE 0. Requests p50/p95/p99 845/846/848 and duration ms 54406/55549/57242. Rate-limited observations 359; cooldown avoids 267; canonical write-method count 0.
- Final three after tests/build: 3/3 financial checks pass; 3/3 release blocked; DRY_RUN_COMPLETE 0; intent digest unchanged 3/3.
- Unit 905/933 (28 P20-related failures); integration 235/237 (2 P20-related failures); product E2E 206/206. G7 standalone 2 pass/9 fail/1 skipped; pilot product 6 pass/9 fail/3 skipped. READY-dependent failures remain unmasked.
- Production UI: 64 screenshots and axe audits, eight surfaces, four widths, two themes; zero overflow/broken images/page errors/axe violations. 24 locales, 745 keys; RTL ar/fa/he/ur browser coverage.
- First-load gzip bytes: app 274873/290690, landing 143735/150000, docs 144870/150000. Native lightweight health 39 actual wire reads, no full G7 import.
- Actual wallet requests, signatures, approvals, permits, broadcasts, deploys and fee collection: zero. Production execution stays closed.

Machine authority: evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/RESULTS.json. Original failed runs, corrected derived census and raw audits are preserved. Review archive verification is under evidence/otherbridge-v1-12/v112-20261007T100941277Z-de7692/review-bundle/ZIP_VERIFICATION.json.
