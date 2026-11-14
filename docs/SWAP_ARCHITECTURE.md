# V1.15.1 canonical Swap architecture

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Browser SwapIntent → /api/swap → bounded QuoteCoordinator → untrusted providers → normalized immutable quotes → progressive rank/sticky refresh → server stored quote → unsigned build → actual command/order/v0 economic decode → independent pool/program proof → exact economic simulation → canonical review digest → EXECUTION_CLOSED.

Model/ranking/client and the lazy Swap UI are browser-safe. Heavy SDKs and credentials stay server-only through the isolated swap-providers graph; source-map/URI patches are pinned through production aliases without changing the protected root lock. Titan transport never imports its logging SDK in production. Health persistence uses strict anonymous SQLite aggregates. Build/review/provider kills and cancellation are separate from the permanently closed execution gate.

The API accepts strict intent/reference data, never a client transaction or user URL. Exact-origin/no-store/rate/size/schema limits apply. Current capabilities and unsupported semantics are in SWAP_PROVIDER_MATRIX.md; the older architecture below records retained concepts and historical behavior.

---

# Swap V1.3

`/swap` is a first-class read-only surface. A network, different sell/buy tokens, amount and independent validated addresses are selected. Explicit swap mode requires source chain equal destination chain; bridge mode retains its existing different-chain rule. Cross-chain routes with exchange steps remain Bridge routes.

The approved server adapter reads available token metadata, requests current same-chain quotes, normalizes fees/steps and removes raw transaction/typed-data payloads. Two documented objective queries can discover actual alternatives. Economically equivalent responses are deduplicated. One returned valid route remains one route. No theoretical token connection becomes an executable transaction.

The existing binding now additionally covers mode and portfolio revision. Wallet/account/chain/token/amount/address/slippage/catalog/preference changes invalidate pending responses and review. Quotes expire in 30 seconds; excessive price impact is excluded, warnings remain visible, and no old response can reopen review. Portfolio actions prefill the source network/token but do not select a destination or submit a transaction.

Review includes expected/minimum receive, route costs/gas, impact, slippage, duration, material protocol names, spender and bounded input amount, zero Otherbridge fee, timestamps and address/chain binding. Unavailable destination gas, exact signature count, allowance and wallet readiness remain unknown. Real signing/approval/permit/broadcast execution stays closed in every environment.
