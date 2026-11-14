# Position data privacy

Read-only public-address queries are explicit. Default DB position snapshot retention=0 (no financial snapshots persisted). Optional OTHERBRIDGE_DEFI_RETENTION_MS accepts 1,000–86,400,000 ms; expiry cascades financial records and pnpm defi:retention purges expired snapshots. Client scope/wallet identifiers are HMAC pseudonyms in scan metadata. Snapshot payloads may contain public addresses/financial amounts only during opted-in retention. Public event indexing retains public chain data separately.

Ephemeral result cache max128 keys / 30 s; client scope prevents developer client history reuse. APIs do not expose arbitrary cached historical scans. API keys stay server-side. Expensive endpoint scope portfolio:read, cost200, existing durable rate/concurrency quotas, GET only; app consent/origin/body guards apply. Operational metrics have protocol/chain/state only, no wallet/token labels. Owner acceptance evidence masks the explicitly approved public EOA. Monitoring cannot read wallet hashes or snapshots, indexer cannot read financial scans, API cannot rewrite discovery registry.

Public metrics include scans/latency/errors/RPC calls/partial counts and position-count distribution only. No signature, transaction, rewards claim or calldata for execution exists. LEGAL_REVIEW_REQUIRED applies to third-party code/data/logos/source/terms inventory.
