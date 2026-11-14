# Internal dependency and source notices

Technical/legal record only. Not product copy, marketing, a partnership claim, or a UI attribution. Brand-neutral product labels do not conceal or replace the actual dependencies.

| Actual dependency | Pinned version | Installed package license | Role |
| --- | --- | --- | --- |
| `@lifi/sdk` | 4.10.0 | Apache-2.0 | Server-only LI.FI SDK client configuration |
| `@lifi/types` | 18.12.1 | Apache-2.0 | Actual upstream API type definitions |

These entries were read from installed package manifests, not inferred from product labels. Package/import/lockfile identities remain unchanged. Official upstream API: `https://li.quest/v1`. The existing adapter retains its bounded GET transport and provider configuration; no execution provider is enabled. SDK quote actions are not claimed to replace that transport. No Jumper widget, source, or UI was copied.

Official source references: [SDK repository](https://github.com/lifinance/sdk), [types repository](https://github.com/lifinance/types), [SDK configuration](https://docs.li.fi/sdk/configure-sdk), [API documentation](https://docs.li.fi/api-reference/introduction). These are provenance references retained from the previous research, not a newly repeated network audit. Installed license texts are preserved alongside this record. Full original dependency inventory remains in the historical evidence.

Network logo provenance: public `lifinance/types` chain assets, with original source URL, SHA-256, MIME and derived ambient-color notes in the existing asset-sync evidence and `src/routing/generated-assets.json`. Network names/logos identify their respective networks; ownership, endorsement, sponsorship or trademark rights are not implied. Official ONE/BNB source notes remain in the network identity document. No logo or color asset changed in this copy repair.

Raw upstream fixtures and historical evidence preserve original fee and tool names, including LI.FI and Integrator Fee. Public display labels are neutral; amounts, assets and included flags remain exact. Historical documents under `public-brand-history/` are verbatim superseded records, not current public copy. Original instruction-attribution wording in those archives is not adopted as a current claim.

## V1.9 wallet connection layer

- `@privy-io/react-auth` 3.47.0 and `@privy-io/*` dependencies — Apache-2.0 (Privy). Used only for external-wallet
  discovery/connection (connect-only). The modal shows "Protected by privy" (SDK UI, unchanged).
- `@walletconnect/*` 2.21.x/2.22.4 — WalletConnect Community License Agreement (20 Aug 2025); shipped in the lazily
  loaded wallet chunk. Legal review required before public release.
- `@reown/appkit*` 1.8.9 — Reown Community License Agreement (25 Aug 2025); transitive via WalletConnect; legal review
  required before public release.
- `@coinbase/wallet-sdk` 4.3.x — Apache-2.0; used only when the user picks Coinbase Wallet.
- `@metamask/sdk*` 0.32/0.33 — ConsenSys proprietary ("all rights reserved"); installed transitively via
  `x402 > wagmi`, not shipped in any browser chunk; legal review required.
- Wallet logos inside the modal are the SDK's bundled marks or the logo each installed wallet announces itself
  (EIP-6963); Otherbridge ships no wallet logo files.
