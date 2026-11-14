# Canonical V1.16 incident response

| Severity | Trigger | Immediate action |
|---|---|---|
| SEV-1 | Unauthorized execution possibility, enabled flag or protected baseline mismatch | Global/surface/provider kills; isolate deployment; preserve redacted evidence; rotate affected credentials; escalate to owner; invalidate RC and future receipt |
| SEV-2 | Quote/economic/firewall integrity failure or provider compromise | Kill affected provider/build/review, preserve exact hashes and synthetic reproduction, investigate without funds |
| SEV-3 | Provider/RPC/DB/Data API degradation | Quarantine endpoint, bound retries, show truthful failure/partial state; restore reviewed fallback |
| SEV-4 | UI/nonfinancial defect | Preserve reproduction and candidate identity; repair and rerun affected release gates |

Do not log wallet addresses, raw transactions, provider bodies, headers, cookies or credentials. Record UTC timestamps, RC/source/build/baseline hashes, fixed error codes, affected provider modes, actions and owners. Keep failed evidence immutable. Reopen only after corrective checks, separate owner decision and any required independent review. Prior runbooks SECURITY_INCIDENT_RUNBOOK.md and SWAP_INCIDENT_RUNBOOK.md remain historical/detail references; this document governs V1.16 release invalidation.
