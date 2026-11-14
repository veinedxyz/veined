# Privy production checklist

Otherbridge is external-wallet connect-only. Code configuration: src/features/wallet/privy/config.ts; measured data flow: PRIVY_DATA_FLOW.md. The SDK supports features outside this project's scope; none are enabled for release convenience.

Owner dashboard checks: dedicated production App ID; allowed domain otherbridge.io; canonical https://otherbridge.io origin; external wallet connectors only; email/social login OFF; embedded Ethereum/Solana wallet creation OFF; delegated signer OFF; session signer OFF; server-controlled wallet execution OFF. Save non-secret review reference only.

The App ID is intentionally public; tokens are not. CSP admits only the exact Privy/WalletConnect origins in src/proxy.ts when an App ID is valid. It excludes the embedded-wallet iframe. SDK cookieWriteBehavior remains never; no app auth cookie is issued in connect-only mode. Secure/HttpOnly/SameSite are therefore N/A for an app session cookie; proxy/dashboard cookies must be separately reviewed if introduced.

Test connection/account change/chain change/disconnect and review invalidation using the existing mock wallet suites. No real extension prompt is allowed in V1.16. Dashboard settings and live domain verification remain OWNER_INPUT_PRIVY_PRODUCTION. Official setup: https://docs.privy.io/basics/react/setup. A failed historical embedded-wallet documentation URL is retained in the source receipt, not treated as proof.
