# Data API — V1.5 changes (current)

- `/v1/metrics` removed from the public API (404 for every key); operational metrics are internal-only (`docs/MONITORING_ARCHITECTURE.md`).
- Coverage objects add `liveIndexedThrough`, `historicalIndexedFrom` and `integrity` (witness-backed release eligibility); OpenAPI version 1.5.0.
- New error code `SERVICE_UNAVAILABLE` (503) for datastore outages; limiter outages return 503 instead of a misleading 429; non-GET/HEAD methods are refused before request construction (405) and non-origin-form targets with 400.
- Still internal-first, loopback/staging only, billing disabled, not launched.

---

# Otherbridge Data API — product readiness (internal)

Status: internal-first, loopback-only service (`pnpm data:api:dev`, 127.0.0.1:3200). **Not publicly launched. Billing disabled (`billingEnabled = false`). No revenue.**

Target developers: wallets, dashboards and bridge/swap front ends that need "which networks hold this address's assets" with honest coverage, without running their own multi-chain RPC fleet.

## Endpoints (`/v1`, read-only GET)

`/v1/health`, `/v1/openapi.json`, `/v1/docs` (static, script-free), `/v1/chains`, `/v1/chains/{chainId}`, `/v1/chains/{chainId}/coverage`, `/v1/address/{address}/activity`, `/v1/{chainId}/address/{address}/native-balance`, `/v1/{chainId}/address/{address}/token-balances`, `/v1/{chainId}/address/{address}/balances`, `/v1/address/{address}/portfolio?ecosystem=evm|solana&maxChains=&cursor=`, `/v1/{chainId}/token/{token}`, `/v1/metrics` (internal plan only). Non-EVM identities use the explicit `ecosystem` query; addresses are validated per ecosystem. Error envelope: `{"error":{"code","message","requestId"}}` with fixed public messages.

## Coverage and limitations

Coverage is explicit per chain (tier, state, native/token status, indexed window, observed block). Activity covers only indexed windows. FULL_INDEXED currently means three chains with a recent 20,000-block window; `historicalComplete=false` everywhere. No "all chains", "complete history" or "100% accurate" claim is made.

## Auth, plans, usage units

API keys `ob_live_<12-char prefix>_<43-char secret>` are shown once by the admin CLI; only a SHA-256 verifier is stored. Scopes: `chains:read`, `portfolio:read`, `balances:read`, `activity:read`, `tokens:read` (no write scope). Plans (configuration only): internal, developer, starter, pro with requests/minute, requests/day, cost units/day, concurrent requests, max portfolio chains and history depth. Cost units: chains 1, chain 1, coverage 1, native balance 1, token-balance page 2, balances 3, activity page 2, token 1, portfolio 2 + maxChains (pre-charged so one cheap request cannot buy an unbounded scan). Usage events and daily aggregates exist for a future, separately approved metered-billing boundary.

## Before any public launch

Independent API pentest, production limiter/DB/TLS/secret-manager setup, legal/terms review, abuse policy, status page and explicit owner approval. CORS remains disabled unless an explicit per-client origin allowlist is approved.
