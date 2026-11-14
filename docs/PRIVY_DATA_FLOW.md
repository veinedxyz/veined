# Privy data flow and network inventory (V1.9)

What leaves the browser because of the Privy external-wallet layer, to whom, and why. Measured with the real
`@privy-io/react-auth@3.47.0` SDK against deterministic Privy/WalletConnect doubles (no App ID exists yet), plus
static inventory of the SDK bundle. The live inventory with a real App ID is part of the W18 acceptance
([PRIVY_SETUP.md](PRIVY_SETUP.md) §8).

## When anything is sent

Nothing at all until the user presses **Connect wallet**: the Privy SDK is a lazily loaded chunk
(`src/features/wallet/privy/layer.tsx`), so pages that are only read never load it and never contact Privy or
WalletConnect. Without `NEXT_PUBLIC_PRIVY_APP_ID` the chunk is never loaded and the CSP admits no third-party
origin.

## Privy (`https://auth.privy.io`)

Measured requests during a complete connect → change wallet → disconnect cycle:

| Request                                         | Content                                                                                                                                                                                                                         |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/apps/{appId}`                      | App configuration (public). Headers carry the App ID and SDK version.                                                                                                                                                         |
| `POST /api/v1/analytics_events` (once per load) | `event_name: "sdk_initialize"`, a random per-browser `client_id`, a timestamp and the **client configuration** (login methods `["wallet"]`, embedded wallets off, supported chain ids, WalletConnect on, Coinbase `eoaOnly`). |

Not observed in any connect, account change, chain change, change-wallet or disconnect flow: no wallet address,
no wallet name, no chain of the connected wallet, no transaction, no amount, no route. Privy necessarily sees the
client IP address and user agent of these two requests. `Referrer-Policy: no-referrer` is set for the whole site.

**Never sent to Privy by Otherbridge (enforced by construction):** Otherbridge calls no Privy API other than
`PrivyProvider`, `useConnectWallet`, `useWallets`, `usePrivy` (ready flag) and `useModalStatus` (focus
restoration) — enforced by `scripts/verify-safety.mjs`. There is no Privy user, no login, no custom metadata,
no `linkedAccounts`, no `useUser`/`useSetCustomMetadata`, so holdings, portfolio, token balances, transaction
history, amounts, bridge routes, geographic data or risk scores have no path to Privy. Portfolio and history
stay in Otherbridge's own read-only API and the browser's local storage exactly as before.

**Session storage:** `sessions.cookieWriteBehavior = "never"` (no Privy cookies). The SDK keeps its own
connection hints in `localStorage` (`privy:*` keys: recently connected connectors); Otherbridge never reads them
and never restores a session from them — after a reload the user is disconnected until they choose a wallet
again.

**Embedded-wallet iframe:** the SDK tries to mount `https://auth.privy.io/apps/{appId}/embedded-wallets`. The CSP
blocks it on purpose (`frame-src` excludes `auth.privy.io`): embedded wallets are off, and blocking the iframe
removes Privy's key-holding surface from the page entirely. Connect-only works without it (measured).

## WalletConnect (only when the user picks WalletConnect or a wallet without an installed extension)

| Origin                                   | Purpose                                                                                  |
| ---------------------------------------- | ---------------------------------------------------------------------------------------- |
| `https://explorer-api.walletconnect.com` | Public wallet registry listing (names/logos) fetched by the Privy modal; images from it. |
| `wss://relay.walletconnect.org` / `.com` | Encrypted WalletConnect relay (pairing and session messages between page and phone).     |
| `https://verify.walletconnect.org` / `.com` | WalletConnect Verify (domain attestation iframe).                                     |
| `https://pulse.walletconnect.org`        | WalletConnect SDK telemetry (connect/pairing events, no transaction content).           |

The WalletConnect project id is Privy's (or the one configured in the Privy dashboard); Otherbridge ships none.
The relay sees the dapp origin, the pairing topic and encrypted payloads; the mobile wallet sees the dapp name/URL
and, at signing time, the exact transaction the user is asked to confirm.

## Coinbase Wallet SDK (only when the user picks Coinbase Wallet)

With the extension installed the SDK talks to it in-page. Without it, the SDK (configured `eoaOnly`) opens a
`https://keys.coinbase.com` popup (a separate window, not governed by this page's CSP) which links the Coinbase
Wallet mobile app. Privy's generic guidance also lists `wss://www.walletlink.org` (legacy relay); it was not used
by SDK 4.3.2 in `eoaOnly` mode in our measurement and is **not** in the CSP. If the live acceptance proves it is
required, add it as an exact origin after review.

## CSP (exact origins, only with a valid App ID)

`src/proxy.ts` `PRIVY_CSP`:

- `connect-src`: `https://auth.privy.io`, `wss://relay.walletconnect.org`, `wss://relay.walletconnect.com`,
  `https://explorer-api.walletconnect.com`, `https://pulse.walletconnect.org`,
  `https://verify.walletconnect.org`, `https://verify.walletconnect.com`
- `frame-src`: `https://verify.walletconnect.org`, `https://verify.walletconnect.com` (not `auth.privy.io`)
- `img-src`: `https://explorer-api.walletconnect.com` (registry logos shown inside the Privy modal)
- unchanged: `script-src 'self' 'nonce-…' 'strict-dynamic'` (the SDK is part of the npm bundle; no remote
  script), production `style-src 'self' 'nonce-…'` and `style-src-attr 'none'` (the modal's styled-components
  read the request nonce from `<meta property="csp-nonce" nonce>`), `object-src 'none'`,
  `frame-ancestors 'none'`.

Deliberately **not** added although Privy's general CSP guide lists them: `'unsafe-inline'` styles (replaced by
the nonce), `https://challenges.cloudflare.com` (captcha — no email/SMS login), `https://*.rpc.privy.systems`
(wildcard; embedded-wallet RPC, not used), `https://auth.privy.io` in `frame-src` (embedded-wallet iframe).

## Wallet icons

The header shows the connected wallet's icon only if it is inline image data (EIP-6963 requires a `data:` URI)
or a component bundled in the Privy SDK. Remote icon URLs are never loaded by Otherbridge and no wallet image
host is added to any allowlist (`next/image` is not used at all).
