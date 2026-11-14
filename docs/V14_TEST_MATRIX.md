# Otherbridge V1.4 review evidence — self-hosted data plane

Evidence root: `evidence/otherbridge-v1-4/v14-20261004T092419755Z-aede75`. HEAD remains `8973a3d3cc9b796dce9e7f846fb0a06a5ed5cde5` (main); no commit, reset, stash, deployment or DNS change. The final source checkpoint and per-file hashes are in `source-inventory.json` (326 files: src, public, tests, scripts, services, packages, infra, .github and safe root configs). Historical V1/R1/V1.1/V1.2/V1.3 receipts are preserved byte-for-byte (`baseline-preservation.json`: 9,496 prior evidence files verified).

## Acceptance gates

| Gate | Result | Evidence |
|---|---|---|
| D1 Baseline preserved | Accepted V1.3 suites still green inside the larger V1.4 suites; 151 E2E (122 accepted + 29 V1.4) PASS; 18 production controls PASS; protected financial/wallet/history/asset paths unchanged | e2e-full/e2e-results.json, production-smoke/production-smoke.json, baseline-preservation.json |
| D2 Paid portfolio API removed | No portfolio path reads `OTHERBRIDGE_PORTFOLIO_API_KEY`; paid host/path/credential removed from source, build artifact and runtime; live runs record `paidPortfolioCredential: ABSENT` | security-final/security-summary.json (artifact hits 0), gates-final/safety.json, production-v14/production-v14.json |
| D3 Own Data API | Loopback `/v1` (11 paths, OpenAPI 3.1) serves self-hosted chains, coverage, activity, native/token balances, portfolio and token metadata from PostgreSQL + vetted RPC | api/openapi.json, api-final/live-summary.json, api-final/live/*.json |
| D4 40-limit removed | Scheduler has no cap; bounded concurrency/deadline with PENDING + identity-scoped continuation; live UI run checked 150 networks; Data API sample needed 2 pages (121 checked + 29 PENDING, then continuation) | production-v14/production-v14.json, api-final/live-summary.json, tests (unit "no silent cap", integration 1000-chain scheduler) |
| D5 EVM indexer | Tier A (FULL_INDEXED) Arbitrum 42161, Avalanche 43114, Ink 57073: 259,806 ERC20 transfers in 692 contiguous windows; verify-index PASS (missing ranges 0, duplicate log keys 0, orphans 0, checkpoint mismatch none); `historicalComplete=false` reported honestly | data/verify-index.json, data/coverage-final.json, data/indexer-log.jsonl, data/indexer-run-*.out |
| D6 Native scan | 221 endpoints measured, 220 healthy, 154 chains with healthy RPC; admission = URL policy → HTTPS → public DNS pin → chainId → read-only probes; FAILED/PENDING never become zero | data/rpc-health.json, data/rpc-registry.json, src/data/registry/rpc-registry.snapshot.json |
| D7 Portfolio | App consumes the data plane (`source: otherbridge-data-plane`, store postgres); coverage card, per-network coverage list, "never counted as empty" sentence, unverified/suspicious markers, Bridge/Swap balance priority | production-v14/screenshots, e2e-full/screenshots/v14-*.png |
| D8 API auth | `ob_live/test_<prefix>_<secret>` keys stored only as SHA-256 verifiers; scopes enforced; revoked key → 401; wrong/no key → 401; OPTIONS/POST → 405; injection/SSRF-like input → 400; no CORS header | tests/db/postgres.test.ts, tests/integration/v14-*.test.ts, api-final/live-summary.json (negative), api/key-revoke-final.out |
| D9 Metering | Cost units per endpoint group (portfolio pre-charged 2+maxChains), daily usage aggregation without addresses; `billingEnabled=false` | api/usage-final.out, tests/db/postgres.test.ts |
| D10 Rate limiting | Postgres atomic limiter: 200 concurrent consumes across 2 instances → exactly 50 allowed; cost limit 100/10 → 10; concurrency cap 3 of 10 slots; Memory/Store/Fallback fail closed when durable is required | security/rate-limit-concurrency.json, tests/unit/v14-data.test.ts |
| D11 Origin/security | Exact origins, no wildcard, Host match, trusted proxy hop position, `TRUST_PROXY_REQUIRED` and durable limiter required for public deployment; HSTS 1 year | tests/integration/v14-audit.test.ts, docs/SECURITY_ARCHITECTURE.md |
| D12 Dependency blocker | Dev-only high (`braces` via `fast-glob`) removed by tested `tinyglobby` override; audit prod/dev/all = 0/0/0 | security-final/dependency-audit.json, dependency/override-*.json, docs/INTERNAL/DEPENDENCY_HIGH_REPAIR.md |
| D13 Security audit | Full Opus active-source audit; every confirmed finding fixed with regression tests (18 audit regression cases) and retested | docs/OPUS_FINAL_AUDIT.md, tests/integration/v14-audit.test.ts |
| D14 24 locales | 24 × 387 keys (25 new V1.4 keys), schema failures 0; AR/FA/HE/UR `dir=rtl`; 24 production browser locales PASS | gates-final/i18n-schema.json, production-i18n/production-i18n.json, e2e-full/screenshots/v14-synthetic-ar-rtl-portfolio.png |
| D15 Performance | Initial JS gzip 286,964 → 289,367 bytes (+0.84%), inside both V1.3 final+5% and the V1.3 budget (290,690); data services bounded (below) | performance-summary.json, performance-bundle/initial-bundle.json, performance/*.json |
| D16 Write safety | Signatures 0, approvals 0, broadcasts 0, deploys 0, fee collection 0; execution enabled=false; sign/approve/broadcast/deploy=null | production-v14/production-v14.json, production-v13/production-v13.json, gates-final/safety.json |
| D17 ONE G5 | BLOCKED_EXTERNAL_EVIDENCE preserved; accepted funded-address read-only simulation untouched; no repeated research | docs/G5_FINAL_EVIDENCE.md (unchanged) |
| D18 Production | BLOCKED — RELEASE_APPROVAL_REQUIRED; G7 NOT_RUN — USER_APPROVAL_REQUIRED | docs/SECURITY_RELEASE_GATE.md |

## Test results (final run)

| Suite | Result | Evidence |
|---|---|---|
| Format, lint, typecheck, safety, build (`pnpm verify`) | PASS (first final attempt failed on Prettier formatting of `scripts/v14-security.mjs`; formatted, re-run PASS) | gates-final/verify.log, gates-final/verify-attempt1-format.log |
| Unit | 384 PASS (13 files), 0 failed/skipped | gates-final/verify.log, tests/unit-results.json |
| Integration | 99 PASS (7 files), 0 failed/skipped | gates-final/verify.log, tests/integration-results.json |
| DB / migrations (ephemeral PostgreSQL 17 database) | 8 PASS: fresh/repeat migration with checksum-tamper detection; constraints + least-privilege roles; indexer commit/reorg rewind/discovery rebuild over Postgres; concurrent indexer lease race; 100k-row bulk/lookup; verify-index gap/orphan detection; two-pool limiter atomicity; hash-only key verification with immediate revocation | tests/db-final.log, tests/db-results.json |
| E2E full | 151 PASS; skipped/flaky/unexpected 0 | e2e-full/e2e-results.json, e2e-full/e2e.log |
| E2E V1.4 | 29 PASS (also inside the full run) | e2e-v14/e2e-results.json |
| Security scan | 442 packages, 0 unknown licenses, 26 lifecycle entries inventoried, 0 secret/static findings; browser chunks contain no postgres driver, data env, paid host or API-key pattern | security-final/*.json |
| Production smoke (18 accepted controls) | PASS | production-smoke/production-smoke.json |
| Production locales | 24 PASS | production-i18n/production-i18n.json |
| Production V1.3 surfaces | PASS (origin/malformed/oversized/prototype on catalog+portfolio; axe/overflow/brand on 3 surfaces) | production-v13/production-v13.json |
| Production V1.4 live | PASS: live self-hosted scan through the UI, coverage details, selector holdings first, `/networks` shows no wallet tokens, Data API docs page with 0 scripts | production-v14/production-v14.json |
| Clean frozen reproduction | `install --frozen-lockfile --ignore-scripts` + `build` PASS in a fresh copy | repro/reproducibility.json |
| Index integrity | verify-index PASS on 3 Tier A chains | data/verify-index.json |

## Data plane measurements (local machine; bounded behaviour, not an SLA)

- Registry build: 348 real chains in 20 ms; 672-chain synthetic in 1 ms.
- Scheduler: 1,000 chains, peak concurrency 16, 975 ms, 0 pending/failed.
- Token reads: 10,000 candidates through bisecting Multicall3 in 50 RPC calls, 551 ms, 0 unchecked.
- Data API: 400 requests at 40 concurrency, p50 4.9 ms / p95 9.6 ms; 164 × 429 from the plan's 16-slot concurrency cap (intended).
- RPC failure storm: 100 chains timing out → FAILED within 4.0 s, 0 invented holdings.
- Indexer crash/resume: lease blocks a second owner until expiry, then resumes contiguously (verify PASS).
- PostgreSQL: 100,000 transfer inserts in 50 windows 20.5 s; wallet lookups p50/p95 2 ms.

## Live observations

- UI scan of the user's previously supplied public address (masked in screenshots, redacted in JSON): 187 planned, 150 checked, 3 indexed, 89 native-only, 33 catalog-only, 4 FAILED, 0 PENDING; 75 assets on 26 networks; $245.49 from available current prices only.
- Data API: 348 chains (60 ON_DEMAND, 92 NATIVE_ONLY, 193 CATALOG_ONLY, 3 FULL_INDEXED), 155 with vetted RPC, 97 with verified Multicall3; indexed token metadata sample (CHIP on Arbitrum, sources indexed + routing-catalog); token balances of a public contract seen in indexed logs; native BSC balance at an observed block.
- The demo API key was revoked after the run and its plaintext file deleted; evidence shows only the prefix.

## Screenshots (§58)

Portfolio self-hosted state (`production-v14/screenshots/v14-live-self-hosted-portfolio.png`, `e2e-full/screenshots/v14-synthetic-self-hosted-portfolio-1440.png`); progressive scan (`v14-live-progressive-scan.png`, `v14-synthetic-progressive-scan-1440.png`); >40 networks with native-only, catalog-only and indexing/partial states (`v14-synthetic-coverage-over-40-native-catalog-indexing-1440.png`, `v14-live-coverage-details.png`); token discovered by own indexer (`v14-synthetic-indexed-token-1440.png`); Bridge and Swap balance priority (`v14-synthetic-bridge-balance-priority-1440.png`, `v14-synthetic-swap-balance-priority-1440.png`); network selector with holdings (`v14-live-network-selector-holdings.png`, `v14-synthetic-network-selector-holdings-1440.png`); local API docs (`v14-local-data-api-docs.png`); API key CLI with the secret redacted (`v14-api-key-cli-redacted.png`); AR RTL Portfolio (`v14-synthetic-ar-rtl-portfolio.png`); mobile Portfolio (`v14-synthetic-portfolio-mobile-390.png`); data plane unavailable (`v14-synthetic-data-plane-unavailable-1440.png`). All PNGs are indexed with dimensions and SHA-256 in `screenshots-index.json`; the visual review receipt is `visual-review.json`.

## Diagnoses during the run (diagnose → minimum repair → retest)

Admission rejected chains whose precompile balance exceeded 16 hex digits (fixed: 64-digit quantity); price evidence post-dated balances (fixed: pricing starts first); sentinel/mirror native balances (IMPLAUSIBLE_BALANCE, mirror skip); learned range ceiling; requestId redaction; literal bidi characters written by tooling (rewritten as escapes plus a Trojan-Source guard); `verify-safety` default output overwrote a committed receipt (restored from HEAD, hash verified; default moved to `test-results`); pre-existing `boundedBody` timeout returning a truncated body (reject-before-cancel); orphan child processes (launcher kills its child). Full list with dispositions: `docs/OPUS_FINAL_AUDIT.md`.

## Observations and limits

- Synthetic fixture screens prove UI behaviour, not liquidity. Tier A indexes a recent window (`historicalComplete=false`); older token history relies on known-token reads and is labelled as such.
- Portfolio→Bridge keeps the accepted V1.3 behaviour: the action sets the source network and token and leaves the destination unchanged, so the synthetic screenshot shows the honest "Select different networks" notice. `product.tsx` is byte-identical to V1.3.
- E2E server logs contain ECONNRESET "aborted" lines from tests that abort requests deliberately; the same lines appear in accepted V1.3 logs, and every test passed.
- Third-party public RPC endpoint terms, independent security review, pentest, monitoring, IAM/secrets, legal review and owner approval remain release-gate items (`docs/SECURITY_RELEASE_GATE.md`).
