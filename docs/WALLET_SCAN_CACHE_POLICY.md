# Wallet scan cache policy (V1.14.2)

Source: `src/data/portfolio/chain-cache.ts`, `src/data/portfolio/provider.ts`, `src/data/portfolio/scheduler.ts`.
Tests: unit "wallet-chain cache", integration "identity-safe cache and single-flight".

| Class | Content | Key | TTL / bound | Never |
| --- | --- | --- | --- | --- |
| Static chain metadata | registry, endpoints, Multicall3 code-hash verification | data plane (owner object) + chain | plane state; Multicall3 proof 1 h (accepted) | wallet data |
| Provider health | endpoint health / cooldown | endpoint | accepted health model | — |
| Price evidence | routing upstream prices per chain | chain | 5 min (accepted; equals the price freshness window) | a balance |
| **Wallet chain result** | one exact successful network read | data plane + keyed wallet pseudonym + chain + exact imported contracts + price eligibility + result epoch | **15 s**, ≤ 5,000 entries | a failure, a timeout, `FAILED` / `PENDING` coverage, a partial token read (`TOKEN_READ_INCOMPLETE`, tokens `FAILED`) |
| Single flight | an identical network read already running | same key | while running (bounded by the 7 s per-network timeout) | aborted by one caller |
| Slow-chain memory | first-page budget overruns | chain only | 2 strikes / 30 min, ≤ 5,000 chains | wallet data; a support or coverage state |
| Previous-nonzero hint | networks with value in the identity's previous scan | client memory (the result it shows) | until the identity changes | persisted, shown as current |
| Read slots | process-wide concurrent network reads | — | hard maximum 48 | — |

## Rules

* **No cached failure becomes zero.** Only `cacheable` results are stored: coverage neither `FAILED` nor `PENDING`,
  reason `NONE`, tokens not `FAILED`. A failed network is read again by the next scan.
* **Identity isolation.** Keys use `walletPseudonym` (HMAC with the configured `OTHERBRIDGE_DATA_PSEUDONYM_KEY`;
  per-process key in development); a raw address never enters a key, a metric label or a log. Tables are owned by the
  data plane object, so entries never cross planes / endpoint sets.
* **Freshness.** Every holding keeps the `observedAt` / `observedBlock` of the read that produced it, so a 15 s cache
  hit is never presented as newer than it is. An explicit "Check again" sends `fresh: true` and skips the result cache
  (an identical running read is still joined).
* **Abort safety.** The shared read is bounded by its own timeout, never by one caller's signal: an account switch or
  a closed tab only stops that caller waiting.
* **Continuation cursor (v2).** `base64url(JSON{v:2, s: identity scope, g: scan generation, p: digest(catalog version,
  planned network set), r: round, e: expiry (10 min), pending})` + `.` + HMAC tag (`keyedTag("wallet-continuation")`,
  timing-safe compare). Rejected: wrong identity (`CONTINUATION_SCOPE_MISMATCH`), tampered body or tag, changed
  catalog / plan, expired, malformed, > 40,000 chars (`INVALID_CONTINUATION`). A valid cursor only narrows the
  server-computed plan; it can never add a network, choose an RPC or move to another wallet. No server state is kept
  per cursor (replays are bounded by the route rate limit and the 15 s result cache).
* **Privacy / persistence.** No new table, no migration: the wallet scan stores nothing new. The accepted
  `recordBalanceSnapshot` / `recordScanRun` (pseudonymous) are unchanged.
* **Test hooks.** `clearWalletResultCacheForTests` (new result epoch), `clearWalletCachesForTests`,
  `clearPortfolioPriceCacheForTests`.
