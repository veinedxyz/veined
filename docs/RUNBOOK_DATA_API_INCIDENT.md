# Runbook — Data API incident

The Data API is internal-first and not publicly launched (`publicApiEnabled=false`, billing off).

| Symptom | Safe checks | Fail-closed behaviour | Operator action | Recovery condition |
|---|---|---|---|---|
| `OtherbridgeDatabaseDown` | DB container health, disk, connections | `/v1/health` reports `degraded`; keyed requests return 503 `SERVICE_UNAVAILABLE`; unauthenticated/failed-auth traffic 503 `RATE_LIMIT_UNAVAILABLE`; the app refuses API calls through the durable limiter (503); pages keep rendering; no holdings are invented | restore DB service; if storage is lost follow `RUNBOOK_BACKUP_RESTORE.md` | health `ok`, alert cleared |
| `OtherbridgeDurableLimiterUnavailable` | limiter tables, DB health | requests refused (503) — never served without the limiter | as above | metric stops increasing |
| `OtherbridgeDataApi5xxElevated` | `api_requests_total{status_class="5xx"}` by group, `docker logs` (redacted) | errors use fixed public messages; no stack or host leaks | identify the group; roll back the last change if needed | ratio < 5 % |
| `OtherbridgeRateLimitSaturation` | `api_rate_limited_total` by group, usage tables | per-client minute/day/cost/concurrency limits; anonymous bucket | contact the client; adjust plan only with approval | ratio back to baseline |
| Suspected key leak | `api_keys` prefix, `last_used_at`, usage events (no wallets, no IPs) | — | `pnpm data:key:revoke --key <prefix>` (immediate: revoked keys get 401); issue a new key out of band | — |
| Data API process down | container/process status | the app is unaffected (in-process data plane); ingress returns 502 for the API host | restart | `/v1/health` ok |

Evidence to preserve: request IDs from error envelopes, Prometheus history, redacted logs. Never log or paste API keys; only the 12-character prefix identifies a key.
