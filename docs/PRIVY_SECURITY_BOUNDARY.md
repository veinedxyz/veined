# Privy security boundary (V1.9)

## What Privy is trusted with

| Privy does                                                     | Privy does not                                                                                                   |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Detect installed EVM wallets (EIP-6963 / injected), list them   | Choose which wallet signs (explicit user selection only)                                                         |
| Show the connect modal (names, bundled official logos)         | Decide routes, amounts, recipients, fees, limits, freshness, simulation, firewall or execution policy           |
| Run the wallet's account-permission request (connect-only)     | Create, hold, export or recover a wallet (embedded wallets off in config, dashboard and CSP)                     |
| Provide an EIP-1193 handle to the chosen external wallet       | Sign anything: no `useSignMessage`, `useSignTypedData`, `useSendTransaction`, `useLogin`, SIWE/SIWS hook is used |
| WalletConnect pairing for mobile wallets                       | Receive portfolio, holdings, balances, history, amounts, routes, geography or risk data                          |

Everything Privy hands over is re-checked: the wallet object is normalized (EVM, external, not embedded/smart);
its address is confirmed by the wallet's own `eth_accounts`; the chain is read from the wallet; the EIP-1193 handle
is wrapped by `WalletProviderAdapter`, which exposes no generic `request()`.

## Guarantees and where they are enforced

| Guarantee                                                                 | Enforcement                                                                                                                                                    |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No signature during connection (no `personal_sign`/SIWE)                  | `useConnectWallet` (connect-only) only; browser tests record every wallet request (only `eth_requestAccounts`, `wallet_requestPermissions` for MetaMask, reads) |
| No signing method reachable from application code                         | Adapter has no generic request; deny list; `verify-safety.mjs` forbids the method names in `src/` outside the documented deny list                              |
| One financial call, gated and canonical                                    | `sendCanonicalTransaction` (8-field equality, frozen canonical values, live identity, session chain, revocation, single-flight); scans count exactly one literal |
| Only the active, explicitly chosen wallet can act                          | Controller selection from `onSuccess`; per-epoch adapters; the store revokes on every change                                                                    |
| Account/chain change after review cannot reach the wallet                  | Re-bind → new epoch → old adapter revoked → `WALLET_SESSION_STALE`; product and pilot invalidate reviews/armed state                                           |
| No embedded wallet                                                         | `createOnLogin: "off"` (ETH + SOL), `showWalletUIs: false`, embedded client/connector refused, CSP blocks the `auth.privy.io` embedded-wallet iframe         |
| No email/social/passkey login                                              | `loginMethods: ["wallet"]` + dashboard OFF ([PRIVY_SETUP.md](PRIVY_SETUP.md)); tests assert the modal shows none                                                |
| No fallback to `window.ethereum`                                           | Raw discovery removed; scans forbid `window.ethereum`/EIP-6963 in `src/` (one presence-only test in the layer); missing App ID / outage → `unavailable`         |
| No remote wallet image                                                     | Icons: inline data URI or bundled component only; no `next/image`; CSP `img-src` adds only the WalletConnect registry used inside Privy's own modal          |
| CSP stays strict                                                           | Exact origins only when an App ID is configured; production `style-src` = nonce + one pinned SVG style hash; `style-src-attr 'none'`; no `unsafe-*`, no `*`   |
| G7 one-shot cannot be reset by the wallet layer                            | Server-side exclusive lock file (`.otherbridge/g7-pilot-lock.json`); reconnect, reload, other tabs and disconnect only create new client epochs               |

## G7 pilot and Privy

- Only `0xb6Ded1B18464aED61DB794dFC5cb031B45a7cA2c` is authorized; the superseded `0x28136a77…2a6b` is refused by
  the server (`WALLET_ACCOUNT_NOT_OWNER_EOA`) and by the adapter (`WALLET_ACCOUNT_MISMATCH`, canonical `from`).
- Principal exactly 5 ONE, network fee ≤ 0.18 ONE, service/Otherbridge fee 0, maximum debit ≤ 5.18075931 ONE,
  receive exactly 5 canonical CROSS, ONEchain 612055 → BSC 56, no MAX, no approval/permit — all unchanged and
  still enforced server-side and re-verified in the browser.
- The pilot's single wallet request now passes canonical (server-released) and reviewed transactions to
  `sendCanonicalTransaction` with the `g7-local-pilot` gate.
- **Because V1.9 changed the signing path, the earlier G7 READY state is STALE.** The pilot's own safety gate
  failed closed (BLOCKED) until the changed protected files were reviewed and re-baselined; a fresh live
  read-only preflight is mandatory before any owner action. See [G7_PILOT_HARNESS.md](G7_PILOT_HARNESS.md).
- A live G7 run additionally needs a real Privy App ID (no injected fallback exists).

## Residual risks (accepted, documented)

| Risk                                     | Why it remains / mitigation                                                                                                                                                                       |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Privy SDK or its dependency compromise   | Pinned exact version and lockfile, audited tree, connect-only API surface, adapter re-checks, canonical comparison and wallet-side confirmation. A compromised SDK runs in the page and could show a fake modal; it still cannot change what the server releases, and the wallet displays the real transaction. |
| Malicious wallet extension               | Same page privileges as the SDK; it can lie about names/icons. Otherbridge never trusts names, binds to `eth_accounts`, and the user confirms in the wallet.                                     |
| Time of check / time of use in the wallet | An account switch after the last identity read but before the wallet shows the prompt is decided by the wallet (it signs only for its current account and chain id in the request).            |
| WalletConnect relay availability         | Mobile connections depend on WalletConnect; an outage only prevents connecting.                                                                                                                   |
| SDK upgrades                             | Exact pin; the SVG style-hash test and the import/config scans fail on drift and force review.                                                                                                    |
