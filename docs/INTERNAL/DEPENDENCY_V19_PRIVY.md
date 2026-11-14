# V1.9 dependency record — `@privy-io/react-auth`

Evidence: `evidence/otherbridge-v1-9/v19-20261005T131224Z-2c32cd/deps` and `…/supply-chain`.

## Selection

- Registry check (2026-10-05): dist-tags `latest = 3.47.0` (published 2026-10-02); newer pre-releases only as
  `beta`/`snapshot`. Chosen: **3.47.0**, pinned exactly (`"@privy-io/react-auth": "3.47.0"`), lockfile updated.
- Compatibility: peer `react`/`react-dom` `^18 || ^19` (repo: 19.3.0); Next 16.3.8 App Router (client boundary,
  `ssr: false`); the SDK pins its own `viem@2.56.5` (separate copy; the application keeps `viem@2.57.2`). Optional
  peers (`@solana/kit`, `permissionless`, Abstract, Farcaster) are not installed and not used.
- No other direct dependency changed; no unrelated upgrade.

## Audit

| Stage                                     | prod                 | dev | all                 |
| ----------------------------------------- | -------------------- | --- | ------------------- |
| Before install                            | –                    | –   | 0                   |
| After install                             | 1 high, 3 moderate   | 0   | 1 high, 3 moderate  |
| After `ws` override                       |                      |     | 2 moderate          |
| After `uuid` override (final)             |                      |     | **1 moderate**, 0 high, 0 critical |

- **High GHSA-96hv-2xvq-fx4p** (and moderate GHSA-58qx-3vcg-4xpx), `ws` 8.18.x via
  `@walletconnect/* > viem > ws/isows`: fixed by the semver-compatible override `'ws@>=8.0.0 <8.21.0': '8.21.3'`
  (8.21.3 published 2026-08-07). `ws` is a Node-only transport; browsers use the native WebSocket.
- **Moderate GHSA-w5hq-g745-h8pq**, `uuid` 8.3.2/9.0.1 via `x402 > wagmi > @wagmi/connectors > @metamask/sdk` and
  `eth-block-tracker`: override `'uuid@<11.1.1': '11.1.1'` (callers use only the named `v4` export, present in
  11.x with CJS and ESM builds). None of these packages ships in the browser bundle.
- **Remaining moderate GHSA-vcc3-ghjq-m6fr**, `decode-uri-component@0.2.2` via `@walletconnect/utils >
  query-string@7`. The only fixed release (0.5.0) is ESM-only with a default export; `query-string@7` calls it via
  CommonJS `require` → an override would break WalletConnect at runtime. Impact: CPU denial of service when
  decoding a maliciously malformed percent-encoded string; WalletConnect parses URIs it generated itself or
  receives through its encrypted relay. **Accepted as residual (moderate), not silently**: revisit when
  WalletConnect moves to `query-string@9`.

## Install-time scripts

Denied (`allowBuilds: false`, nothing executed): `@reown/appkit` (postinstall version check), `bufferutil`,
`utf-8-validate`, `keccak` (native addons with pure-JS fallbacks), `unrs-resolver` (pre-existing). Full list,
including `prepare` scripts (never run for registry tarballs): `supply-chain/lifecycle-inventory.json`.

## Licenses

Packages 484 → 942 in the lockfile (+458 added, 0 removed; `supply-chain/dependency-diff.json`). Installed
license inventory: `supply-chain/license-inventory.json` (901 package versions).

- `@privy-io/*`: Apache-2.0 (`@privy-io/api-base` has no `license` field; its LICENSE file is Apache-2.0).
- **WalletConnect `@walletconnect/{core,sign-client,types,universal-provider,utils,ethereum-provider}` ≥2.21 and
  Reown `@reown/appkit*` 1.8.9**: *WalletConnect / Reown Community License Agreement* (August 2025), not an
  OSI license. This code ships in the lazily loaded wallet chunk. **LEGAL REVIEW REQUIRED before any public
  release** (added to the release gate; no change to code).
- `@metamask/sdk*` 0.32/0.33 (ConsenSys, all rights reserved) and `@metamask/eth-json-rpc-provider` (no license
  field): installed transitively via `x402 > wagmi`, **not shipped** in any browser chunk (verified by bundle
  scan). Same legal-review item.

## Bundle impact

First-load JS gzip 290,224 → 285,971 B (budget 290,690 B unchanged); the SDK graph (26 files, ~700 KB gzip) loads
only after the first *Connect wallet* click. See `docs/WALLET_CONNECTION_ARCHITECTURE.md` §Performance.
