# V1.5 test matrix (pre-release hardening)

Evidence root: `evidence/otherbridge-v1-5/v15-20261004T131452Z-64ebac/`. All results are local engineering results; none is an independent external review. Final-candidate reruns (after the self-review and final-acceptance repairs) are under `final/`.

## Baseline (GOAL §85) — preserved, counts increased

| Suite | V1.4 accepted | V1.5 | Evidence |
|---|---|---|---|
| Unit (vitest) | 384 | 473 PASS | `final/tests/unit.json` |
| Integration | 99 | 215 PASS | `final/tests/integration.json` |
| DB / migrations (ephemeral PostgreSQL) | 8 | 16 PASS | `final/tests/db.json` (creates and drops its own database) |
| E2E (Playwright, 360/390/768/1440, light/dark) | 151 | 151 PASS (0 skipped/flaky/unexpected) | `final/e2e/e2e-results.json`, axe + identity checks |
| 24-locale production | PASS | PASS (24/24, RTL `ar`/`fa`/`he`/`ur`) | `final/production-i18n/` |
| Production controls / V1.4 read-only boundaries | 18 | PASS | `final/production-smoke/`, `final/production-v13/`, `final/production-v14/` |
| Clean reproduction | PASS | PASS (attempts 1–5 kept as evidence) | `repro/reproducibility.json` |
| `pnpm verify` (format, lint, typecheck, unit, integration, safety, build) | PASS | PASS | `final/verify.log` |
| Dependency/security gates | PASS | PASS (0 vulnerabilities, 0 findings, 442 packages, 0 unknown licenses, lockfile unchanged) | `supply-chain/` |

No test was removed. One V1.3 unit fixture gained the new `registryDigest` field because simulation proofs are now bound to the exact registry entry.

## New V1.5 coverage (GOAL §86)

| Area | Tests | Where |
|---|---|---|
| Witness digest (domain separation, every bound field, order independence, count/window binding) | unit | `tests/unit/v15-witness.test.ts` |
| Log normalization rejection (malformed, out of range, duplicates, block-hash split, oversize) | unit | same |
| Omission / addition / mutation (data, topic, address, tx, logIndex, removed) | unit + integration | `tests/unit/v15-witness.test.ts`, `tests/integration/v15-witness.test.ts` |
| Mismatch → no commit; edge block-hash mismatch; fork between calls | integration | `tests/integration/v15-witness.test.ts` |
| Third endpoint 2-of-3 tiebreak (primary wrong / witness wrong / all differ → halt) | integration | same + Drill A |
| No independent witness (same operator group, unknown provenance, aggregator) → `required` refuses, `best-effort` marks development-only | integration | same |
| Range limits, bisection, oversize responses not treated as endpoint faults | integration | same |
| Release eligibility blockers (no witness, unwitnessed windows, unresolved, integrity, lagging, terms) | unit + DB | `tests/unit/v15-witness.test.ts`, `tests/db/v15.test.ts` |
| Witness persistence, halt/resume, backfill lease, re-verification, CHECK constraints, role grants | DB | `tests/db/v15.test.ts` |
| CSP header exactness (production and development), nonce entropy, no `unsafe-inline`/`unsafe-eval` in production | unit | `tests/unit/v15-csp.test.ts` |
| Inline style/script attempts in a real browser (style attribute, `<style>` without nonce, inline handler, `javascript:` URL) | browser | `scripts/v15-csp.mjs` → `csp/csp-results.json` |
| Visual/responsive regressions after removing inline styles | E2E + screenshots | `e2e-full/`, `csp/screenshots/`, `staging/screenshots/` |
| Data API docs hashed stylesheet | unit + browser | `tests/unit/v15-csp.test.ts`, `csp/csp-results.json` |
| Metrics schema, label validation, address/secret rejection, series cap, token auth, constant-time compare | integration | `tests/integration/v15-adversarial.test.ts` |
| Alert rule loading and unit tests (21 rules) | promtool | `monitoring/promtool.log` |
| Alert fire/clear on real targets | drills | `drills/drill-a-rpc-log-mismatch.json`, `staging/staging-smoke.json` |
| Backup create / hash / verify / restore / corruption (5 cases) / resume | live drills | `backup/` |
| Staging hardened config, proxy trust, origin, durable limiter, DB roles, health, metrics token, Grafana auth | live smoke (32 checks) | `staging/staging-smoke.json` |
| Configuration schema (weak DB password, non-TLS external DB, booleans, deployment marker, metrics token, invariant deviation) | integration + Drill C | `tests/integration/v15-adversarial.test.ts`, `drills/drill-c-d.json` |
| Firewall property mutations (seeded PRNG: calldata, selector, chain, recipient, amount, approval, registry drift, simulation block) | unit | `tests/unit/v15-firewall.test.ts` |
| API/path weirdness (encoded traversal, double slashes, absolute-form targets, TRACE/CONNECT, oversized headers, duplicate Host, CL/TE conflicts) | integration + raw socket | `tests/integration/v15-adversarial.test.ts`, `security/data-api-raw-socket.json` |
| SQL/RPC malicious fixtures (injection strings in every parameter, hostile JSON-RPC payloads, wrong chainId, giant/negative numbers) | integration | `tests/integration/v15-adversarial.test.ts` |
| Static policy (no inline-style sinks, no public metrics route, no write RPC names, invariants frozen) | script | `security/v15-static-policy.json`, `scripts/verify-safety.mjs` |

## Live / operational

| Check | Result | Evidence |
|---|---|---|
| Witness on live chains | Ink and World Chain: MATCH on all committed windows; Arbitrum/Avalanche: no independent operator (development only) | `data/verify-index-local-with-480.json`, `data/witness-records.jsonl` |
| Advisory cross-check of committed windows | PASS | `witness/advisory-cross-check.json` |
| Tier A assessment (top-25 routable EVM) | World Chain promoted; others not | `witness/tier-a-assessment.json` |
| Witness cost | ×1.9 RPC calls per window | `performance/witness-cost.json` |
| Data API load | 400/400 internal (p50 331 ms, p95 582 ms); developer plan 3×200 / 397×429 | `performance/data-api-load.json` |
| Initial JS bundle | 289,894 B gzip (+0.18 % vs V1.4 289,367) | `final/performance/initial-bundle.json` |
| Restore time | final drill: restore 33.3 s, total 40.1 s (earlier 28.5 s); staging restore + restart 38.4 s | `final/backup/`, `backup/restore-drill.json`, `drills/drill-c-d.json` |
| Final staging acceptance | smoke 32/32, crash/resume PASS, backup + verify PASS, Ink engineering-eligible live, World Chain witnessed and catching up | `final/staging/` |
| Release-profile refusals | release registry 0 endpoints; `rpc:seed-snapshot` and `--witness best-effort` refused | `final/release-profile/` |
| Executor self-review | 12 defects + 6 residual items repaired with regression tests | `self-review/SELF_REVIEW.md` |

## Residual engineering risks (not blockers for external review)

- Chains with one independent operator cannot be release-eligible; Arbitrum and Avalanche remain `FULL_INDEXED_DEVELOPMENT`.
- Undisclosed shared backing between two declared-independent operators cannot be ruled out from public information.
- Next.js build IDs differ between clean builds (documented in reproduction evidence); source, lockfile and output policy are reproducible.
- Local measurements only; no production-scale load, latency or restore SLO has been established.
