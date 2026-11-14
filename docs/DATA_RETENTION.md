# Data retention — V1.5 additions (current)

| Data | Retention |
|---|---|
| `indexed_window_witnesses` (public chain evidence, endpoint IDs, digests) | retained with the indexed data; rewound windows keep their historical witness rows as evidence |
| `ops_backup_events` | retained (operational audit; no secrets) |
| Witness dispute diagnostics (`witness-disputes.jsonl`) | evidence artifacts only (bounded key diffs, no raw responses); keep per incident policy |
| Backups | outside the repository; local prune is a dry run by default (`--apply --yes` to delete, keep ≥ 3); production retention and encryption policy are release items |
| Service logs | operator log store; local guidance ≤ 14 days |

---

# Data retention

| Data | Identifier stored | Retention (`pnpm data:retention`) |
|---|---|---|
| Indexed public chain events (`erc20_transfers`, windows, checkpoints, discovery, tokens) | Public on-chain data | Retained; rewound only for unfinalized reorgs |
| Native/token balance snapshots | Keyed HMAC wallet pseudonym (`OTHERBRIDGE_DATA_PSEUDONYM_KEY`) | 24 hours |
| Portfolio scan runs/coverage | Keyed pseudonym of the scanned identity, counts, per-chain state | 7 days |
| API usage events | Client id, key id, endpoint group, status, cost units, latency bucket, request id — no wallet, no IP | 30 days |
| API usage daily aggregates | Client id, day, group, counts | 400 days |
| Rate-limit buckets / concurrency slots | Hashed client attribution only (IPs are SHA-256 truncated and only behind trusted proxies) | 2 days / expiry |
| Logs | Structured; wallet addresses, API keys and DB URLs redacted; request id kept for correlation | Operator log policy (not persisted by the app) |

Raw wallet scan requests are never retained. Without a configured pseudonym key a random per-process key is used, which makes development pseudonyms unlinkable across restarts; public production configuration requires a stable ≥32-character secret (`dataConfig` fails closed otherwise). Public network services necessarily observe queried public addresses; this is disclosed in the Portfolio consent text.
