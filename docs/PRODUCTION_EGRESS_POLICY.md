# Production egress policy

Application callers never supply arbitrary RPC/API/WebSocket targets. Release config binds exact reviewed origins. Transport rejects redirects, userinfo, fragments, unknown paths and signed execution endpoints. No arbitrary private/internal target is accepted.

| Boundary | Allowed destination / proof |
|---|---|
| Swap HTTP | Uniswap /v1/quote; PCSX /order-price/get-price; Jupiter /swap/v2/order and /build only |
| Swap RPC | Exact RPC_ORIGINS map; read-method allowlist; release legal approval required |
| Titan | wss://api.titan.exchange/api/v1/ws; v1.api.titan.ag; auth query confined to transport, never logs; redirects off |
| Portfolio/DeFi | Reviewed registry endpoints with SSRF validation, bounded calls, provenance and release approval |
| Metadata/logos/prices | Existing src/assets and data transport allowlists; no user-provided redirect destinations |
| Wallet services | Exact Privy/WalletConnect browser origins in CSP, only after explicit connect |

Hosting egress firewall should mirror the source allowlists; the application policy remains mandatory even with a network firewall. DNS/IP rebinding, private address literals, IPv6, redirects and oversized responses are covered by existing SSRF/mutation tests and V1.16 transport tests. Unknown deployed code/program/API shapes return REVIEW_REQUIRED; source refresh never auto-activates a new pin. External RPC terms remain a production gate.
