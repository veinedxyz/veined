# V1.17 provider production onboarding

Status: `OWNER_ACTION_READY / EXECUTION_CLOSED`. This is a configuration and evidence handoff, not provider commercial approval or production release. Official public documentation was retrieved on 2026-10-15 UTC; each URL, retrieval time, HTTP status and SHA-256 is recorded in the run's `provider-sources/receipts.json`. Public-source retrieval does not read an owner dashboard. Failed old documentation URLs remain failed receipts; they are not source proof.

The active evidence directory is the single relative path in `.otherbridge/v117-evidence-path.txt`. Run all commands from `D:\Projeler\otherbridge`. Keep every provider key in the production host's server-side secret store, separate from staging. Never put values in chat, screenshots, Git, ZIPs, shell arguments, logs, `NEXT_PUBLIC_*`, or a browser bundle. Provider API access and legal/provider terms approval are separate gates.

## Safe validation and provider kills

`pnpm release:credentials:check --offline` reports configuration presence and policy errors without making provider calls. `pnpm release:credentials:check --out=<relative-evidence-path>.json` performs the minimal supported read-only checks for configured providers and emits fixed status codes and booleans. The command does not request a wallet, sign, submit a signed order, execute a transaction, or print secret values. A `CONFIGURED` value alone is not authentication proof. A rate limit, firewall denial, expired token, incompatible quote or unavailable upstream remains a failed check.

Keep `SWAP_EXECUTION_ENABLED=false`, `BRIDGE_EXECUTION_ENABLED=false`, `G7_EXECUTION_ENABLED=false`, `OTHERBRIDGE_EXECUTION_ENABLED=false`, `OTHERBRIDGE_GLOBAL_KILL=true`, `OTHERBRIDGE_ENABLE_MAINNET_SUBMISSION=false`. These values do not grant execution permission. Validate provider kills without network access in a temporary PowerShell environment, preserving existing values:

```powershell
$savedProviderKills = $env:SWAP_DISABLED_PROVIDERS
try {
  $env:SWAP_DISABLED_PROVIDERS = 'UNISWAP,UNISWAPX,JUPITER_META,JUPITER_ROUTER,TITAN,PANCAKESWAP_X_INTENT,AERODROME_CLASSIC,AERODROME_SLIPSTREAM,PANCAKESWAP_SMART'
  pnpm release:credentials:check --offline
} finally {
  $env:SWAP_DISABLED_PROVIDERS = $savedProviderKills
}
```

Expect `KILLED` for Uniswap/Jupiter/Titan/PCSX and zero attempted requests. `pnpm verify:safety`, `pnpm g7:safety`, and `pnpm g7:pilot:safety` verify the frozen execution boundary. Do not call a pilot, wallet, signed order or execute command as an onboarding test.

## Uniswap — OWNER_INPUT_UNISWAP_API_KEY

Official sources: [current API FAQ](https://developers.uniswap.org/docs/trading/swapping-api/faqs), [supported chains reference](https://developers.uniswap.org/docs/api-reference/get_supported_chains.md), and [live public OpenAPI](https://trade-api.gateway.uniswap.org/v1/api.json).

1. Owner opens [Uniswap Developer Platform](https://developers.uniswap.org/dashboard), using [welcome/sign-up](https://developers.uniswap.org/dashboard/welcome) if necessary. These are the current links published by Uniswap's own FAQ.
2. Create an owner-controlled dedicated `Otherbridge Production` key. Use a different key for staging; do not reuse a shared playground key. Record the production key's nonsecret name and provisioning date.
3. Store only as `UNISWAP_API_KEY` in the production server secret namespace. Otherbridge sends `x-api-key`; JSON calls also use `Content-Type: application/json` and `Accept: application/json`. No browser-prefixed credential exists.
4. Confirm the dashboard's assigned quota. The current documented default is **6 requests/second per key**. Otherbridge's reviewed process-wide origin limiter permits **5 requests/rolling second**, shared by classic and UniswapX. Start with one app process per key/egress budget. Use the dashboard help channel to obtain a higher commercial quota only if the actual aggregate needs it.
5. Run `pnpm release:credentials:check --out=<run>/Uniswap/credentials.json`. The check performs authenticated `GET https://trade-api.gateway.uniswap.org/v1/supported_chains`, verifies required chain coverage (Ethereum, BNB Chain and Base), and performs a representative read-only quote with the reviewed adapter. It must return `READ_ONLY_PASS`; missing configuration stays `OWNER_INPUT_REQUIRED`.
6. Run the offline kill validation above. Preserve a receipt containing only provider/status/chain-coverage booleans, the command/version and timestamp. Verify the existing browser/server-secret checks in the release security evidence. Never attach headers, a raw response, an `.env` file or a key fingerprint derived from the secret.

Blocks: production Uniswap authenticated quotation and external-gate closure. Does not authorize UniswapX signed orders, Permit2, approval or broadcast. Expected owner evidence: production key name, assigned quota, storage namespace, redacted read-only PASS and kill-switch receipt; API terms approval belongs to counsel.

## Jupiter — OWNER_INPUT_JUPITER_API_KEY

Official sources: [setup](https://developers.jup.ag/docs/portal/setup), [organisations and teams](https://developers.jup.ag/docs/portal/organisations), [API keys](https://developers.jup.ag/docs/portal/api-keys), [firewall](https://developers.jup.ag/docs/portal/firewall), [rate limits](https://developers.jup.ag/docs/portal/rate-limits), [analytics](https://developers.jup.ag/docs/portal/analytics), [logs](https://developers.jup.ag/docs/portal/logs).

1. Open [Jupiter Developer Platform](https://developers.jup.ag/portal). Create or select an owner-controlled organisation. Retain at least one owner; use named team membership and least privilege. Create team **Otherbridge Production**, slug `otherbridge-production`; create a separate staging team. Portal team URLs follow `/portal/{org}/{team}`; the actual organisation slug is owner data and is not invented here.
2. In that production team's **API keys**, create key `otherbridge-production-server`. Set product permissions to **Swap only**. The integration objectively calls no Tokens, Price, Portfolio, Trigger, Recurring, Lend, Send, Studio or Prediction API. Add supporting products only after documenting an actual need. Key changes can take about 15 seconds to propagate.
3. Store as `JUPITER_API_KEY` server-side; the request header is `x-api-key`. Swap permission also covers transaction submission at `/tx/v1/submit`, so product permission alone is insufficient to enforce this milestone's read-only boundary.
4. In the production team's **Firewall**, first stage narrow rules with `Log`, inspect matches, then enable `Deny` for this production key on path prefixes `/swap/v2/execute` and `/tx/v1/submit`. Add a key-scoped **Rate limit: 1 request per second** for the read-only key. Both reviewed `/swap/v2/order` and `/swap/v2/build` use `GET`; deny unexpected POST traffic for this key. Keep an explicit rule inventory and review it after provider route changes.
5. Record the selected host's static outbound IP/CIDR and test visibility in request logs. The documented rule builder exposes **positive** `IP/CIDR is any of` matches, not a general negation operator. Do not claim a complete IP allowlist was achieved by a positive-match rule. Do not add a broad `Bypass`: it outranks Deny and bypasses firewall rate limits. If the owner needs an enforceable default-deny IP policy beyond the available builder, obtain Jupiter's exact supported rule configuration through [support](https://developers.jup.ag/docs/resources/support) and attach that vendor reference. Keep the key server-only regardless.
6. Confirm the organisation's plan and shared consumption before choosing quota. Current main quotas are Free **1 RPS**, Developer **10**, Launch **50**, Pro **150**, measured over a **60-second sliding window per organisation**. Separate keys/teams do not create additional plan capacity. Otherbridge itself caps Jupiter at **1 request/rolling second per process**; staging and other teams still consume organisation capacity. Payment or a higher plan is not asserted necessary without actual aggregate need.
7. Run `pnpm release:credentials:check --out=<run>/Jupiter/credentials.json`. Expect `READ_ONLY_PASS` from reviewed read-only `/order` and `/build` quotation requests. Do not call `/execute` or `/submit`, even with a dummy signature. Review product-permission/firewall settings in the owner's dashboard and correlate permitted read-only requests in analytics/logs. The CLI cannot attest hidden dashboard state. Confirm non-Swap products remain unchecked from a redacted permission screenshot; no unrelated product call is required.
8. Run the offline kill check. Expected evidence: organisation/team names, role ownership, key name, Swap-only permission capture, deny/rate rule inventory, assigned quota, static-egress observation, redacted read-only receipt and analytics/log review time. No key values or raw request records enter this bundle.

Blocks: production Jupiter authenticated quoting, verified dashboard restrictions and organisation capacity allocation. The separate Whirlpool drift gate can still reject unsigned route builds after authentication succeeds.

## Titan — OWNER_INPUT_TITAN_WS_ENDPOINT / OWNER_INPUT_TITAN_AUTH_TOKEN

Official sources: [current access paths](https://titan-exchange.gitbook.io/titan/developer-doc/getting-started/api-access), [authentication](https://titan-exchange.gitbook.io/titan/developer-doc/getting-started/authentication), [Direct connection/wire negotiation](https://titan-exchange.gitbook.io/titan/developer-doc/swap-api/reference/direct/connection), [GetInfo limits](https://titan-exchange.gitbook.io/titan/developer-doc/swap-api/reference/direct/get-info), [SDK reference](https://titan-exchange.gitbook.io/titan/developer-doc/resources/sdk), [current platform](https://developer.titan.exchange/).

Current public docs distinguish **self-serve REST API keys** from **enterprise distributor Titan Direct WebSocket JWTs**. A free REST `x-api-key` is not a substitute for the existing reviewed WebSocket token. Titan Direct requires enterprise distributor access; exact connection/stream limits are account-specific. Published REST Sandbox/Build/Scale/Growth RPS does not establish a WebSocket entitlement.

1. Owner requests production **Titan Direct / enterprise WebSocket** access through an existing [Triton](https://docs.triton.one/trading-apis/titan-swap-api) or [QuickNode Titan distributor](https://marketplace.quicknode.com/add-on/titan-swap) account; use Titan's [Developer Platform](https://developer.titan.exchange/) enterprise contact when arranging the commercial entitlement. No message has been sent on the owner's behalf.
2. Ask the vendor to confirm that the issued credential is accepted by **`wss://api.titan.exchange/api/v1/ws`**, supports uncompressed **`v1.api.titan.ag`**, binary MessagePack and current quote requests with `numQuotes=3`, `intervalMs=1000`, `feeBps=0`, unsigned v0 transactions and synthetic public test identity. The reviewed runtime allows only this exact host/path. Do not replace it with a distributor host or REST endpoint. If the vendor cannot provision the accepted endpoint/protocol, retain `TITAN` in `SWAP_DISABLED_PROVIDERS` and attach the vendor's exact incompatibility/access statement; changing the endpoint requires a separate reviewed candidate.
3. Set `TITAN_WS_ENDPOINT=wss://api.titan.exchange/api/v1/ws` (no query, userinfo, fragment or trailing slash) and store the issued JWT as **`TITAN_AUTH_TOKEN`** server-side. The current safe transport appends `?auth=` internally and never emits the URL, token or raw SDK error. Do not paste a signed JWT in documentation. Issuer, expiry, audience (`api.titan.ag`), key binding and rotation/renewal are vendor-controlled; Otherbridge does not mint or sign one.
4. Obtain written numeric bounds for concurrent connections, concurrent streams, quote-start RPS, quote update min/default/max interval, quotes per update, quota reset/burst behavior, session expiry, reconnect/backoff policy and any bound public-key restriction. Public `GetInfo` documentation exposes `settings.connection.concurrentStreams` and `settings.quoteUpdate.{intervalMs,numQuotes}` bounds; there is no universal public account limit to invent. Record only the vendor reference and nonsecret limits.
5. Run `pnpm release:credentials:check --out=<run>/Titan/credentials.json`. It uses the V1.15.1 safe redacting runtime transport, not raw SDK logging. The reviewed runtime retains the uncompressed v1 protocol, 256 KiB maximum frames, 1,232-byte v0 transaction bound, one stream per connection, cancellation/StopStream and bounded reconnect. Reconnect/cancellation/frame/redaction behavior is exercised by deterministic tests; missing entitlement cannot be relabelled a live PASS.
6. Run the offline provider kill validation. Supply vendor compatibility/limit reference, expiry/rotation procedure (without token), read-only quote result, deterministic transport-test reference and redacted kill receipt.

The reviewed SDK oracle remains dev-only `@titanexchange/sdk-ts@0.1.6`, source `7588482454bee284a7437d0bd5fce6c02edfb60f`. Current documentation is research, not permission to upgrade SDK/wire or expose compressed/raw logs. Blocks: Titan production read-only streams; all signature/broadcast paths remain closed.

## PancakeSwap X — ANONYMOUS_QUOTA_SUFFICIENT_FOR_LAUNCH

Source: [current official PCSX overview and quotas](https://developer.pancakeswap.finance/contracts/pcsx/overview). Anonymous gateway quota is **15 requests/second per client IP**, short bursts up to **30**. An integrator key raises the budget to **10,000 requests/second per integrator**, using `X-API-Key`; it grants no extra endpoint/data privilege.

The run's `PCSX/quota-decision.json` calculates the launch envelope from actual evidence and reviewed code:

| Input / calculation | Value and meaning |
| --- | --- |
| Actual production UI refresh sample | 15,154.4 ms between requests; n=1 automatic refresh, synthetic provider-response replay |
| Per-user refresh rate | 1,000 / 15,154.4 = approximately 0.06599 requests/second |
| Planning scenario | 20 simultaneously refreshing users = approximately 1.31975 requests/second; a scenario, not measured production user demand |
| Reviewed upstream quota | `ProviderQuota.take` caps `x.pancakeswap.com` at 5 calls in every rolling 1,000 ms per process, before fetch; no queue/retry storm |
| Provider concurrency | 2 active distinct quote flights per process; identical intentions coalesce; a concurrency cap is not an RPS cap |
| Allowed launch processes | 1, fixed by `productionConfigSchema.processCount` |
| Maximum Otherbridge upstream burst | 5 calls per rolling second from that one app process, below public 15/30 limits |
| Shared-egress pressure | Otherbridge 5 + other tenants' aggregate RPS; owner must establish at most 10 additional steady RPS and at most 25 additional calls in the relevant short burst, with prudent headroom |

The historical 40-concurrent Data API load test measured 400 requests in 3,546 ms (112.80 RPS). It is **Data API capacity evidence**, not PCSX traffic or expected launch users. It is retained as a warning against inferring provider demand from unrelated throughput. Actual PCSX quote receipts can remain `REVIEW_REQUIRED` independently of quota; a key cannot cure an order-validation failure.

**OWNER_INPUT_PCSX_TRAFFIC_QUOTA:** before accepting the launch configuration, the hosting owner records one app process and the static egress IP/NAT tenancy; confirms that no other process, CI runner or unrelated app consumes the remaining anonymous per-IP budget; attaches the host/NAT inventory and rate-limit policy reference. If aggregate load cannot fit the documented quota, request a PCSX integrator key through the PancakeSwap X team via the official documentation contact, keep it confidential and store it as `PCSX_INTEGRATOR_KEY`. That conditional escalation is not a missing launch credential today.

Keep `PCSX_QUOTE_ENABLED` disabled until the owner explicitly opts into read-only quotation. When enabled without a key, `pnpm release:credentials:check` reports `ANONYMOUS_QUOTA_SUFFICIENT`; it does not invent a commercial/authentication PASS or send a signed order. The provider kill is `PANCAKESWAP_X_INTENT`. Existing runtime SDK remains 1.7.2. Legal terms and any upstream build-review gate remain separate.

## Aerodrome / Slipstream — PRODUCTION_CONFIG_READY / NO_PROVIDER_CREDENTIAL_REQUIRED

No Aerodrome API account is required. Read-only Base JSON-RPC supplies chain ID, current block, contract code, EIP-1967 storage slots, pool state and simulation. Production RPC quota/commercial/privacy terms remain in the separate RPC gate; a provider key is not invented.

Current read-only verification in `Aerodrome/pins.json` checked six roles at a single block, with **6 PIN_MATCH**, code present and both accepted EIP-1967 slots unchanged. The accepted pin file hash remains `1b8065c93eadf0c078fe340e7fdb4575173fe769d6853a58f1a42b911c4e0200`. Evidence records the actual block/hash and full observed/expected codehash per role.

| Role | Accepted Base address |
| --- | --- |
| Classic Router | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` |
| PoolFactory | `0x420DD381b31aEf6683db6B902084cB0FFECe40Da` |
| FactoryRegistry | `0x5C3F18F06CC09CA1910767A34a20F771039E37C0` |
| Slipstream SwapRouter | `0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F` |
| Slipstream PoolFactory | `0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef` |
| Slipstream Quoter | `0x514c8B5f54112481E28028F1166Bd78501089259` |

Official pinned source/deployment references: [classic contracts revision 1ba30815](https://github.com/aerodrome-finance/contracts/tree/1ba30815bba620f7e9faa34769ffd00c214c9b82), [Slipstream revision f8717faa](https://github.com/aerodrome-finance/slipstream/tree/f8717faaae6e6717db3c8e3850149c01a79c0603). A live codehash match is a pin check, not an independent source-to-bytecode audit. Kills: `AERODROME_CLASSIC,AERODROME_SLIPSTREAM`. Reproduce public-source/pin research with `node scripts/v117-provider-research.mjs`; it loads no secret files and uses only public GETs and read-only Base RPC.

Pancake Smart likewise uses the frozen local router/RPC integration and has **no separate provider API credential**. Its RPC terms, fixed deployment/source pins, kill `PANCAKESWAP_SMART`, and external release gates still apply. No new network, route family or product feature is activated by this document.
