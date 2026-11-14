# Incident drill report (V1.5, 2026-10-04)

Local technical drills run by the engineering executor. **This is not an external incident-response audit.** Evidence: `evidence/otherbridge-v1-5/v15-20261004T131452Z-64ebac/drills/`, `staging/`, `backup/`.

## Drill A — RPC log-set mismatch (`scripts/v15-drill-a.ts`, `drills/drill-a-rpc-log-mismatch.json`)

Setup: ephemeral PostgreSQL database, migrations + grants, synthetic chain served by three synthetic operators, ops exporter (monitor role) scraped by the local Prometheus/Alertmanager profile.

| Step | Expected | Observed |
|---|---|---|
| Primary omits one Transfer event; only two independent operators | no commit, chain paused | `HALTED`, `LOG_CONSENSUS_UNRESOLVED:78-102`, 0 windows, 0 transfers stored; dispute diff: 1 log only in the witness set (27 vs 28) |
| Fault removed, worker runs again | still paused until operator resume | `HALTED` |
| Alerts | critical alerts visible | Alertmanager active: `OtherbridgeLogWitnessMismatch{chain=910001}` and `OtherbridgeIndexHalted{chain=910001}` |
| Operator resume, third operator added, primary omits again | 2-of-3 tiebreak commits the complete set, primary quarantined | 4 windows trusted, 1 tiebreak (`TIEBREAK_MATCH_WITNESS`), omitted event committed, primary removed from ranking; verify: 0 gaps/duplicates/orphans/hash issues/disputed windows |
| Recovery | halt alert clears | `OtherbridgeIndexHalted` cleared (mismatch alert intentionally stays for its 1 h window) |
| Evidence | preserved | 5 witness records with endpoint IDs and digests; ephemeral DB dropped afterwards |

## Drill B — database unavailable (staging, `staging/staging-smoke.json`)

PostgreSQL container stopped: Data API `/v1/health` → `degraded`; keyed request → 503 `SERVICE_UNAVAILABLE`; app Portfolio API → 503 `RATE_LIMIT_UNAVAILABLE` with no holdings in the response; Bridge page still served (200); `OtherbridgeDatabaseDown` fired; after restart requests → 200 and the alert cleared.

Finding fixed during the drill: before the fix the anonymous limiter outage made `/v1/health` answer 429 and unknown datastore errors answer 500. Now an unavailable limiter still serves cached health/static docs, refuses unauthenticated traffic with 503, and datastore connection errors map to 503 `SERVICE_UNAVAILABLE` (regression tests in `tests/integration/v15-adversarial.test.ts`).

Additional: Data API container stopped → ingress 502 for the API host, app Portfolio unaffected (200), `OtherbridgeMetricsTargetDown` fired, recovery 200.

## Drill C — bad release/runtime configuration (`drills/drill-c-d.json`)

| Case | Result |
|---|---|
| Data API, public mode, memory limiter | exit 1 (`DURABLE_RATE_LIMIT_REQUIRED`) |
| Data API, missing pseudonym key | exit 1 (`PSEUDONYM_KEY_REQUIRED`) |
| Data API, deployment marker `Production` | exit 1 (`OTHERBRIDGE_DEPLOYMENT_ENV`) |
| Data API, weak metrics token | exit 1 |
| Indexer, `--witness yes` | exit 1 (`OTHERBRIDGE_INDEX_WITNESS_INVALID`) |
| App with `REAL_EXECUTION=true`, `REAL_OTHERBRIDGE_FEE=true`, `OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION=true`, `OTHERBRIDGE_MODE=local-test`, `OTHERBRIDGE_FEE_BPS=10`, memory limiter | `/api/bridge` → `mainnet-readonly`, `submission:false`; Portfolio API → 503; invariant metrics unchanged |

## Drill D — restore into staging (`drills/drill-c-d.json`)

Writers stopped → backup (`20261004T1…-staging`) → verify → PostgreSQL switched to a **new** volume → `pg_restore` → `db:migrate` (roles, checksums, grants) → restored counts equal to the manifest → services restarted → `verify-index` PASS before and after, health ok, API key created before the backup works, app 200, indexer resumed (`CURRENT`, witness `MATCH`), new backup taken. Previous volume kept. Restore + restart: 38.4 s (local measurement).

Finding fixed during the drill: the drill script's own evidence redaction replaced the one-time drill key in memory, producing a correct 401; the script now keeps that value unredacted in memory only.

## Restore drill on the local data plane (`backup/restore-drill.json`)

Isolated new instance, 28.5 s `pg_restore`, Data API read-only on the copy (active key 200, revoked 401), no plaintext key in the dump, `verify-index` PASS, indexer resumed with 5 witnessed windows, fresh balance at a newer block, all five corruption cases refused before any target existed, source unchanged, drill instance removed.

## Final acceptance drills (final candidate, `final/`)

- **Indexer crash/resume** (`final/staging/crash-resume.json`): PostgreSQL stopped under load → the fail-fast indexer exited after 21.6 s → restarted by the `unless-stopped` policy → resumed from its checkpoints 6.7 s after the database was healthy again (Ink and World Chain advanced, Arbitrum/Avalanche stayed paused without an independent witness) → `verify-index` PASS.
  Finding fixed: the first final run showed the indexer staying down after the DB-outage drill because staging used `restart: "no"`; long-running services now use `unless-stopped` (migrate stays one-shot).
- **Restore** (`final/backup/restore-drill-20261004T170546Z-local-74b6ee.json`): isolated instance, restore 33.3 s, total 40.1 s, schema/row counts/structure equal, secret-scan probe PASS; five corruption cases refused before any target existed; source unchanged.
  Finding fixed: the structure comparison used key-order-sensitive JSON; aggregate key order differs between source and restored copy, which produced a false `structure:false` (fail-closed). Aggregates are now ordered and the comparison is canonical; the failed attempt is kept as evidence.
- **Staging smoke** (`final/staging/staging-smoke.json`): 32/32 PASS including DB-down and Data-API-down drills; every service up afterwards without manual action.

## Lessons / follow-ups

- Alerts that are window-based (`LogWitnessMismatch`) stay active for an hour by design; operators acknowledge in Alertmanager rather than silencing rules.
- Chains without an independent witness (Arbitrum, Avalanche) are correctly paused under `required` and page via `OtherbridgeIndexerStalled`; production would need a second vetted operator or a contractual endpoint.
- A real incident-response exercise with on-call humans, disclosure channel and communications is still a release gate item.
- Orchestrator restart policies are part of the recovery design: every fail-fast service must run under one.
