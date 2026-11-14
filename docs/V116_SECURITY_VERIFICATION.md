# V1.16 security verification map

| Property | Primary evidence |
|---|---|
| One flag / malformed / stale / cross-surface receipt cannot activate execution | tests/unit/v116-release.test.ts; tests/integration/v116-chaos.test.ts; immutable G7/safety scans |
| Wrong RC/source/build/pin cannot inherit authority | src/release/startup.ts and receipt.ts, v116-verify source map, final manifests and negative archive verification |
| Protected drift or self-rebaseline rejected | active 107-file hash plus fixed accepted baseline digest; disposable-copy drift tests |
| Unknown API/RPC/WS, redirects and private hosts refused | transport/egress, origin registry, existing SSRF and schema integration tests |
| No provider secret in public output | actual built JS/source maps and client-reference census; known env comparison without copying env |
| No log secret/body leakage | field-name and string redaction tests; sanitized ops outputs |
| Kills and provider outage fail closed | nine modes, pre-dispatch/late-response kills, all-failure chaos tests |
| Wallet account/chain/disconnect epoch invalidates review | existing Swap controller and G7 session/E2E tests |
| Firewall/economic equality | existing EVM/Solana hostile mutations, strict CPI checks, 71 no-egress local fork cases |
| CSP/CORS/headers | production smoke, 128 responsive theme/locale page checks, real private TLS ingress |
| No fee, wallet/signature/broadcast/deploy | structural invariant tests and final action counters; local VM-only funding/approvals are distinct |

Connect-only application state is not an application authentication cookie. Public locale/theme preferences are not sensitive session cookies. Privy dashboard domain, embedded-wallet and signer controls require owner evidence; local source keeps these capabilities off. HSTS applies to TLS production-like ingress, not claimed from plain localhost HTTP.

