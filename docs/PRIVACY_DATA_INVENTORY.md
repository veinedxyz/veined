# Privacy data inventory — actual implementation

| Data | Purpose / processor | Storage | Retention | Deletion |
|---|---|---|---|---|
| Public wallet identifiers | Explicit Portfolio/DeFi/quote reads; RPC/provider sees query | Browser and ephemeral request; public-chain index stores public events | Raw scan requests not retained; public index retained | Browser clear; retained public chain facts not globally erasable |
| Wallet pseudonyms | Scan attribution without plain address; Otherbridge HMAC | Postgres balance/scan metadata | Balance 24h; Portfolio scans 7d | pnpm data:retention |
| DeFi positions | Explicit read-only scan; Otherbridge/RPC | Cache max128 / 30s; DB financial snapshots default OFF | Optional snapshots 1s–24h | pnpm defi:retention; expiry cascade |
| Quote requests/builds | Compare providers and review unsigned result | Bounded in-process coordinator/build maps | Quote TTL20s, cache2s; maps bounded128; cleared on restart | Expiry and process restart |
| Token imports | User-requested token metadata and warnings | Browser local storage plus metadata registry | Until removal/registry retention policy | User removes import/clears local storage |
| Provider health | Availability and failure diagnosis | Aggregate local SQLite and metrics | SQLite hourly48h; bounded enum labels | Rolling prune; operator metric retention |
| Auth/connection | External-wallet connect-only; Privy/WalletConnect | SDK connection hints in browser; no app auth session cookie | User browser storage lifecycle | Disconnect/clear browser storage; epoch invalidates reviews |
| API auth | Developer API client/key hashes/scopes | Postgres | Until revoked and operational retention policy | Revoke key; owner policy for client records |
| IP/rate-limit | Abuse limits; trusted proxy attribution | Hashed bucket key; no IP in usage rows | Buckets2d / slots expiry | Retention purge |
| API usage | Metering/errors | Client/key id, group/status/cost/latency | Events30d; aggregates400d | Retention purge |
| Logs/metrics | Operations/security | Structured redacted stdout; Prometheus | Operator log guidance <=14d; local Prometheus3d | Operator deletion/rotation |
| Backups | Recovery | Outside repository; production encrypted | Owner-selected; local prune explicit and keeps >=3 | Owner-authorized prune only |

Source policy: DATA_RETENTION.md, DEFI_PRIVACY.md, PRIVY_DATA_FLOW.md, src/swap/server/health.ts. Privy and RPC/provider retention must be reviewed as independent processor obligations. Jupiter's current platform documentation describes its own logging; that does not alter Otherbridge local retention. No wallet-address metric label, secret, raw transaction or provider body is intentionally logged. Native human review of public legal copy remains external.
