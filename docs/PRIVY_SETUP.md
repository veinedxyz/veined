# Privy setup — external wallets, connect-only (V1.9)

Otherbridge uses Privy **only** to discover and connect the user's own external EVM wallet (MetaMask, Rabby,
Phantom EVM, Coinbase Wallet, WalletConnect wallets, other EIP-6963 extensions). Privy is not a login system,
not a wallet provider and not a source of truth for any financial decision. Without a valid App ID the product
works read-only and "Connect wallet" shows *Wallet connection is temporarily unavailable.* — there is no fallback
to an injected provider.

Status at delivery: **no Privy App ID exists for this repository** → `CODE_READY / PRIVY_LIVE_CONFIG_REQUIRED`.

## 1. Create the Privy app

1. Open the Privy Dashboard (`https://dashboard.privy.io`) and create a new app (name e.g. `Otherbridge local`).
2. Do not create or download an App Secret for this milestone: the browser never needs one, and no server code
   uses Privy.

## 2. Enable external wallets (connect-only)

1. Dashboard → your app → **Login methods** (side bar).
2. Turn **External wallets / Wallet** **ON** (Ethereum).
3. Leave *Sign-in with Ethereum* options at their defaults; Otherbridge never calls a login/SIWE flow. The
   application uses `useConnectWallet()` (connect-only), which connects a wallet **without** a message signature.
   The code-level guarantees are listed in [PRIVY_SECURITY_BOUNDARY.md](PRIVY_SECURITY_BOUNDARY.md).

## 3. Disable every other login method

Still under **Login methods**:

| Method                        | Required setting |
| ----------------------------- | ---------------- |
| Email                         | OFF              |
| SMS                           | OFF              |
| Socials tab — Google          | OFF              |
| Socials tab — Apple           | OFF              |
| Socials tab — Twitter / X     | OFF              |
| Socials tab — Discord         | OFF              |
| Socials tab — GitHub          | OFF              |
| Socials tab — Telegram        | OFF              |
| (all other social providers)  | OFF              |
| Passkeys                      | OFF              |
| Farcaster                     | OFF              |

The client additionally pins `loginMethods: ["wallet"]`, so a dashboard mistake cannot add another method to the
Otherbridge UI — but keep the dashboard aligned; the app config is fetched by the SDK.

## 4. Disable embedded wallet creation

1. Dashboard → **Wallets** / **Embedded wallets**: set *Create embedded wallets on login* (Ethereum **and**
   Solana) to **Off / Do not create**. Do not enable server wallets, session signers, delegated actions, smart
   wallets, gas sponsorship (paymaster), funding / on-ramp or Privy swap/bridge features.
2. Independently of the dashboard, the client pins `embeddedWallets.ethereum.createOnLogin = "off"`,
   `embeddedWallets.solana.createOnLogin = "off"`, `showWalletUIs = false`, never calls any create/sign/send hook,
   refuses any `walletClientType` `privy`/`privy-v2` or embedded connector, and the CSP **does not allow the
   Privy embedded-wallet iframe** (`frame-src` excludes `https://auth.privy.io`).

## 5. Allow the local origin

1. Dashboard → **Configuration → App settings → Domains** (allowed origins / app client origins).
2. Add exactly the local origins you use, for example `http://localhost:3100` and `http://127.0.0.1:3100`
   (development), `http://127.0.0.1:3101` (local production preview) and `http://127.0.0.1:3197` (local G7 pilot
   launcher).
3. **No wildcard origins.** Do not add production domains in this milestone (no DNS/production setup).

## 6. Copy the App ID

1. Dashboard → **Configuration → App settings → Basics** → **App ID**.
2. It is a public 25-character identifier (Privy's SDK rejects anything else; Otherbridge validates
   `^[a-z0-9]{25}$`). It is not a secret, but it is still never hard-coded in the repository.

## 7. Configure Otherbridge

Create (or edit) the git-ignored `.env.local` in the repository root:

```
NEXT_PUBLIC_PRIVY_APP_ID=<the 25-character App ID>
```

Restart `pnpm dev` / rebuild (`NEXT_PUBLIC_*` values are compiled into the client bundle and the CSP is derived
from the same variable). Nothing else is needed: no App Secret, no WalletConnect project id (Privy's default is
used unless one is set in the Privy dashboard), no RPC URL.

## 8. Live acceptance (W18) — only with a real App ID

Run once the App ID exists (no transaction, no signature):

1. `pnpm dev`, open `http://127.0.0.1:3100`, press **Connect wallet**: the Privy modal lists the installed
   extensions with their real logos; choose MetaMask (and repeat with Rabby, Phantom EVM, Coinbase Wallet).
2. Confirm in the wallet's own activity that the connection asked only for account access (no signature
   request, no `personal_sign`/SIWE).
3. Header shows wallet icon, name, short address and network; **Change wallet** and **Disconnect** work.
4. WalletConnect: choose WalletConnect, scan the QR with a mobile wallet (or open the deep link on a phone),
   confirm the session appears and that Disconnect ends it.
5. Record the browser network inventory (DevTools → Network, filter third-party) and compare it with
   [PRIVY_DATA_FLOW.md](PRIVY_DATA_FLOW.md) §CSP; any additional required origin must be added as an exact
   origin in `src/proxy.ts` (`PRIVY_CSP`) and reviewed — never a wildcard, never `unsafe-inline`.
6. Confirm the CSP report shows no blocked request that breaks the connect flow. The embedded-wallet iframe
   (`auth.privy.io`) is intentionally blocked; if a future SDK version requires it for connect-only, treat that as
   a security review item, not a configuration tweak.

Only after these steps may the status move to `READY_FOR_REVIEW` for the wallet layer. The G7 pilot additionally
needs a fresh live dry run and the owner's separate approval (see [G7_PILOT_HARNESS.md](G7_PILOT_HARNESS.md)).
