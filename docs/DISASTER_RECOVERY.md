# Disaster recovery

Recovery starts with execution CLOSED, global kill ON and affected provider kills ON. Preserve exact source/build/config/DB manifest and redacted incident evidence before changes. Incident owner: repository owner until a production operator is designated. Targets are measured in the current local drill, not promised production RTO/RPO.

| Event | Recovery | Validation / stop condition |
|---|---|---|
| Bad app candidate | Start the previously verified immutable candidate with its matching config in isolation; route traffic only after smoke | Recheck hashes/CSP/safety; never mix a newer build with an older receipt |
| DB corruption | Verify encrypted backup manifest/checksum; restore to a NEW isolated DB, never overwrite live DB | Migration checksums, grants/indexes and read-only app/Data API checks; discrepancy stops promotion |
| Bad migration | Retain old DB; restore compatible backup to separate DB; rehearse forward repair | Do not apply destructive down migrations or assume newer schema backward compatibility |
| RPC outage | Quarantine endpoint; use only reviewed fallback; expose PARTIAL/FAILED | No invented zero balances or fabricated routes |
| Provider compromise | Kill affected modes, preserve sanitized response digests, rotate keys, invalidate RC if pins/integrity changed | Re-review runtime/program/pool pins before reenabling read-only calls |
| API key leak | Kill, revoke, rotate in correct namespace, restart, read-only validation | No leaked value in incident package |
| Domain/TLS failure | Disable public entrypoint at selected host; restore known config/certificate only with owner authority | Check canonical origin, certificate, CAA/DNSSEC and Privy allowlist |
| Malicious route/response | Reject at schema/firewall/simulation, kill provider, preserve hashes/mutation fixture | No execution, no raw secret-bearing response log |
| Monitoring outage | Treat visibility as unknown; keep financial gates closed, restore monitoring auth/targets/rules | Synthetic alert fire and clear plus scrape authentication |

Backup commands: pnpm data:backup:create; pnpm data:backup:verify --id <id>; pnpm data:backup:restore-test --id <id>. Inspect the service's exact CLI before use. Current release rehearsal receipt is under operations/restore1/backup; public production backup custody/retention is an owner hosting action. Rollback does not change DB state in place. All future production recovery actions require their own operator authorization.
