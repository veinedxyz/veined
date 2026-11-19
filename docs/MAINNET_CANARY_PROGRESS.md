# VEINED — Mainnet canary and multichain engineering progress

**Evidence date: 19 November 2026.** This document reports verified owner-operated local results and a separately qualified engineering candidate. The public branch containing this file remains **disarmed** and is not the source of the local live candidate. No public trading release or production deployment is claimed.

## First owner-operated Base Swap — completed

A real wallet-approved Base mainnet Swap was submitted and settled through the VEINED local manual-wallet flow.

| Item | Observed result |
|---|---|
| Network | Base, chain ID 8453 |
| Transaction | [0x87ae3e7105fd9497c20db401f21256dd91bfed7d0f21abdc745137251d9512e5](https://basescan.org/tx/0x87ae3e7105fd9497c20db401f21256dd91bfed7d0f21abdc745137251d9512e5) |
| Router | Uniswap V3 SwapRouter02 |
| Input | **1.000000 USDC** (Base native USDC) |
| Output | **0.000556250359153438 WETH** |
| Receipt | Success in block **59509398**; token-transfer amounts checked |
| Independent read-only checks | Base PublicNode and Coinbase RPC agreed on receipt, canonical block hash and USDC/WETH transfer logs at the recorded verification time |
| Wallet control | The owner manually confirmed the operation; no agent wallet signing |

The earlier exact-token approval remains separate historical evidence, including a documented legacy wallet-fee policy discrepancy. Its authority is not automatically reusable.

**Scope:** this is evidence for one owner-operated Base Swap, not a claim that all supported wallets, networks or swap routes have passed genuine-wallet mainnet testing.

## Base → Arbitrum Bridge — engineering qualified, owner-gated

The separately developed Base 8453 → Arbitrum One 42161 canary is **not yet a completed owner-operated Bridge**.

- Proposed source: exactly **5 USDC** on Base.
- Destination: native Circle USDC on Arbitrum, minimum **4.90 USDC**.
- Planned route: LI.FI Diamond / Across; current quotes, simulation and liquidity must be rechecked before owner use.
- Allowance is separate from the successful Swap. A bounded **5 USDC** approval may be required before the Bridge transaction; no unlimited approval.
- The UI distinguishes Base approval, source deposit and verified Arbitrum destination fill. Source confirmation alone is **not** settlement.
- Any real financial action requires a separate valid owner decision and manual wallet confirmation. No unattended transaction or auto-resubmission is authorized.

The qualified local engineering source was reported as SHA-256 `8ca65e48a70b703b96dac921984eab3ddcbdaf4f2ecb8d8c7f2e195a0be75a99`, with financial manifest SHA-256 `0a15dc1c7210d6f9f038c80840dc9f31875a49559983522175b53cb1d9850ea0`. **These source bytes are not published by this documentation commit**, and the public development branch must not be mistaken for that build.

## Multichain status (engineering, not public financial availability)

| Network | Evidence and current boundary |
|---|---|
| Base | One genuine owner-wallet Swap completed; Bridge owner canary not yet executed |
| Arbitrum One | Two-operator reads, live quotes and source-account simulation reported; own-source Swap and reverse Bridge only synthetically tested |
| BNB Smart Chain | Read-only capabilities; Binance-Peg USDC (18 decimals) is distinct from Circle-issued USDC; no authorized live lane |
| Solana | Separate non-EVM wallet adapter with synthetic checks; real signing and live routes not enabled |
| Robinhood Chain | Mainnet read-only route research; no owner-authorized Swap/Bridge, contracts and token policies still gated |
| Other preserved networks | Previous architecture and evidence retained; not promoted to mainnet execution by this work |

The local candidate reports classification of **23 routes**: **1 ready for owner canary**, **3 synthetic-execution pass**, **17 verified read-only**, **1 unsupported**, **1 blocked for security**. Classification is route-specific and must never be interpreted as 23 production-ready routes.

## Qualification evidence and limitations

The local multichain engineering report recorded, on its final source bytes:

- Financial regression: **3,075/3,075**.
- Security scanner mutations: **545/545**.
- Negative-boundary tests: **59/59**.
- Manifest checks: **41/41**.
- Real route with synthetic-wallet browser E2E: **4/4**.
- Build, TypeScript and selected scanner profiles: PASS.
- Full historical run: **6,342 tests**, with **563 inherited baseline failures** and **0 new candidate-specific regressions** reported. This is **not** a globally green full suite.
- Five clean-context review reports found no remaining release-blocking defect within the examined scope; this is **not** an external audit certification. A dedicated Mythos 5.2 review was **not** performed.
- Genuine-wallet coverage in this stage is limited; EVM wallet interoperability otherwise includes representative and synthetic tests. WalletConnect and many brand-specific combinations remain unverified.

This progress note does not include operational journals, environment secrets, live authorization digests or private signing material. Full local financial runtime source, transaction authority and deployment remain separate owner-gated release matters.

For the runnable **disarmed** code currently in this branch, follow the [README](../README.md). The preserved NEAR Hackathon submission on `main` and immutable tags is unchanged.
