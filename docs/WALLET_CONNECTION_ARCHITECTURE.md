# Wallet connection architecture (V1.9 — Privy external wallets, connect-only)

## Flow

```
Privy external wallet (modal: discovery, connection, logos, WalletConnect/mobile)
  → ExternalWalletController (src/features/wallet/controller.ts)
      explicit selection only · normalize · bounded identity bind · epochs
  → normalized Otherbridge wallet session (src/features/wallet/store.ts, one store)
  → Otherbridge route intent (Bridge / Swap / Portfolio / Activity, unchanged)
  → runtime / reserve / fee / quote verification (unchanged server gates)
  → transaction firewall (unchanged)
  → canonical transaction (server)
  → user review (unchanged)
  → WalletProviderAdapter.sendCanonicalTransaction → external wallet eth_sendTransaction
```

Privy is **only** the discovery/connection/modal/metadata layer. Transaction intent, routes, amounts, recipients,
firewall, runtime pins, reserve, quote freshness, simulation, G7 limits, fee policy, one-shot lock and the
production execution policy never read anything from Privy except the connected address and chain, and those are
re-read from the wallet itself before any financial call.

## Modules

| Module                                   | Role                                                                                                                                                                                                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/features/wallet/privy/config.ts`    | Pure connect-only configuration (`loginMethods: ["wallet"]`, embedded wallets off, `showWalletUIs: false`, Coinbase `eoaOnly`, WalletConnect on, no `defaultChain` → no automatic chain switch on connect, `cookieWriteBehavior: "never"`) and App ID validation (`^[a-z0-9]{25}$`, the SDK's own length rule).          |
| `src/features/wallet/privy/load.ts`      | Two-stage lazy loader: the first-load bundle only references this tiny module.                                                                                                                                                                                                                                             |
| `src/features/wallet/privy/layer.tsx`    | Mounted once at the product root after the first "Connect wallet" click (`ssr: false`). Wires `PrivyProvider`, `useConnectWallet` (onSuccess → explicit selection), `useWallets` (connector removal only), `usePrivy().ready`, `useModalStatus` (focus restoration). Ready timeout → `unavailable`. Error boundary → `unavailable`. |
| `src/features/wallet/controller.ts`      | Framework-free lifecycle: `select()` (the wallet the user picked), `#bind()` (bounded `eth_accounts`/`eth_chainId`, competing events abort), `accountsChanged` → re-bind to the confirmed account, `chainChanged` → re-bind, `disconnect` → clear, `syncConnected()` → clear when the connector is gone.               |
| `src/features/wallet/session.ts`         | Normalization (EVM boundary, embedded/smart-account refusal, CAIP-2 chain, bounded labels), icon sanitizing, explicit active-wallet selection, session fingerprint.                                                                                                                                                       |
| `src/features/wallet/adapter.ts`         | The single provider adapter (see below).                                                                                                                                                                                                                                                                                  |
| `src/features/wallet/store.ts`           | The one session store (`useSyncExternalStore`). Revokes the previous adapter on every identity change. Nothing persisted.                                                                                                                                                                                                 |
| `src/features/wallet/provider.ts`        | Low-level bounded reads, single-flight requests, error mapping, `bindExternalWallet`. The raw `discover()` (window.ethereum + EIP-6963) and `connect()` (`eth_requestAccounts`) paths were removed.                                                                                                                        |

## Normalized session

`status · address · chainId · walletClientType · walletName · walletIcon · walletId · connectorType · chainType
("ethereum") · provider (adapter | null) · isEmbedded (always false) · epoch · reason`

- **Active wallet = explicit selection.** Only `useConnectWallet`'s `onSuccess` wallet becomes active. Privy's
  connected/linked list order is never used as signer selection; the list only tells the controller that the
  active connector disappeared (e.g. a WalletConnect session ended).
- **EVM boundary.** `type === "ethereum"`, a 20-byte hex address and an `eip155:<id>` chain are required. A
  Phantom Solana identity is `WALLET_NOT_EVM`; `privy`/`privy-v2`/embedded connectors/imported are
  `EMBEDDED_WALLET_REFUSED`; `coinbase_smart_wallet`/`base_account` are `SMART_WALLET_REFUSED`.
- **Identity binding.** Privy's reported address must equal the wallet's own `eth_accounts[0]`; any
  `accountsChanged`/`chainChanged`/`disconnect` during the bind aborts it. An `accountsChanged` event is never
  trusted on its own: the session moves to `connecting` (no provider, no address) and re-binds to the account the
  wallet confirms.
- **Epochs.** Every identity change increments the epoch and creates a new adapter; the store revokes the old
  one. Product, Swap, Portfolio, Activity and the G7 pilot invalidate quotes, reviews, simulations, balances and
  armed state on any change.

## Single provider adapter

`WalletProviderAdapter` (no generic `request()`):

| Capability                                      | Rule                                                                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read("eth_accounts" \| "eth_chainId")`         | bounded (8 s), allowlist only                                                                                                                                                                     |
| `identity()`                                    | live account must equal the session account                                                                                                                                                       |
| `switchChain(id)` / `addChain(id)`              | only the internal `TRUSTED_CHAINS` registry (ONEchain 612055, BSC 56, local 31337); add-chain parameters (ONEchain only) come only from the registry; no user RPC URL                              |
| `watchCanonicalCross()`                         | fixed canonical CROSS parameters                                                                                                                                                                  |
| `sendCanonicalTransaction(canonical, request, {gate})` | gate ∈ {`otherbridge-submission`, `g7-local-pilot`}; field-by-field equality of `chainId, from, to, value, data, gas, maxFeePerGas, maxPriorityFeePerGas` (identical key sets, identical strings); well-formed hex; `from` = session account; chain = session chain = live chain; live identity re-read; not revoked before and after the read; one at a time; the **frozen canonical** object is what the wallet receives |
| everything else                                 | impossible (no method); `personal_sign`, `eth_sign`, `eth_signTypedData*`, `eth_signTransaction`, `eth_sendRawTransaction`, `wallet_sendCalls`, `wallet_grantPermissions`, `eth_requestAccounts` are documented in `FORBIDDEN_WALLET_METHODS` |

Static gates (`scripts/verify-safety.mjs`, `scripts/g7-pilot-safety.ts`): exactly one `eth_sendTransaction`
literal in the application (inside `sendCanonicalTransaction`), `sendCanonicalTransaction(` called only by
`src/features/bridge/submission.ts` and the pilot's `wallet-send.ts`, no `window.ethereum`/EIP-6963 access in
`src/`, `@privy-io/react-auth` imported only by the layer and only its connect-only hooks.

## Surfaces

- **Header**: disconnected → *Connect wallet* (opens the Privy modal); connected → wallet icon, name, short
  address, network → account dialog with **Change wallet** and **Disconnect**.
- **Bridge (ONEchain → BSC)**: same session; *Switch to source* is a separate action through the adapter; every
  change invalidates the quote and review. Real submission stays disabled (global gate unchanged).
- **Swap / multichain Bridge**: receive the same `account`/`walletRevision`/`walletChain` as before.
- **Portfolio**: the connected address fills the EVM identity; holdings never go to Privy.
- **Activity**: same address; history is local and survives disconnect.
- **G7 local pilot**: receives the session adapter and the wallet id; identity, chain, authorization and the one
  send go through the adapter (see [G7_PILOT_HARNESS.md](G7_PILOT_HARNESS.md)).

## Failure modes

| Condition                                  | Behaviour                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_PRIVY_APP_ID` missing/invalid | SDK never loaded; *Wallet connection is temporarily unavailable.*; CSP has no third-party origin   |
| Privy not ready within 20 s / outage       | session `unavailable`, same message; read-only app works; no injected fallback                     |
| SDK chunk fails to load / layer throws     | `unavailable` (loader catch / error boundary)                                                       |
| Wallet rejects connection                  | Privy shows *Please try connecting again / Retry*; session stays disconnected                       |
| Late wallet answer after the modal closed  | no session (Privy does not report it; measured)                                                     |
| Wallet locked (`accountsChanged []`)       | session cleared (`WALLET_LOCKED`)                                                                   |

## Performance

The Privy SDK and its dependency graph load only after the first *Connect wallet* click (two-stage loader).
Initial JS gzip: before 290,224 B → after **285,971 B** (−4,253 B; budget 290,690 B unchanged). The first
attempt measured 295,709 B because the home portfolio summary imported `detectedValue` from the portfolio model,
whose address codecs/hash libraries are now shared with the Privy graph; `detectedValue` moved to the
dependency-free `src/portfolio/value.ts` (re-exported unchanged by the model). Lazy chunk sizes are in
[V19_TEST_MATRIX.md](V19_TEST_MATRIX.md).
