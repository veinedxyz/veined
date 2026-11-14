# Legal review packet — NOT LEGAL ADVICE / REVIEW REQUIRED

Prepared by engineering as input for counsel. It describes how the software behaves; it does not decide legality, jurisdictional availability or regulatory classification. Status: **LEGAL REVIEW NOT_RUN**.

## Product and architecture facts

- **Non-custodial**: Otherbridge never holds user funds or keys. There is no signer, no private key handling and no server-side wallet. The write path (sign/approve/permit/broadcast/deploy) is frozen disabled in code; production release is blocked.
- **No proprietary liquidity**: Otherbridge does not run bridge liquidity, pools, treasury or market making. Bridge/Swap quotes come from third-party route and quote providers accessed read-only from the server; Otherbridge ranks quotes by user outcome (Best value / Cheapest / Fastest) and does not rank by revenue.
- **No principal custody**: funds would move only from the user's own wallet to third-party protocol contracts after the user's own signature — currently impossible (disabled).
- **Fee model**: real Otherbridge fee = **0 bps**, fee collection disabled. The target policy (5 bps) and hard maximum (10 bps) exist only as documentation/configuration constants; quotes carrying a non-zero integrator share are rejected (`docs/FEE_POLICY.md`).
- **Data API**: internal-first, loopback/staging only, billing disabled, no public launch. Plans and usage metering exist for a future, separately approved commercial model.
- **Personal data**: users supply public blockchain addresses explicitly (consent required). Raw addresses are not stored; scan metadata uses a keyed HMAC pseudonym; logs redact addresses; metrics never carry addresses. Public RPC providers necessarily see queried addresses (disclosed in the Portfolio consent text). Retention: `docs/DATA_RETENTION.md`.

## Third-party dependencies for counsel

- Routing/quote infrastructure: identified in `docs/INTERNAL/` provider records (vendor-neutral in public UI per accepted branding policy); terms and attribution obligations to be reviewed there.
- Public RPC operators: machine-readable inventory `src/data/registry/rpc-provenance.json` (165 groups: 4 `APPROVED_FOR_STAGING`, 18 `LEGAL_REVIEW_REQUIRED`, 143 `UNKNOWN`; none `APPROVED_FOR_RELEASE`). Summary in `docs/RPC_PROVENANCE_TERMS.md`. Several operators' terms restrict bots, scraping or commercial use, and Arbitrum's terms pages could not be fetched in the bounded pass (Cloudflare block) — counsel must read them directly.
- Open-source dependency licenses: SBOM and license inventory (442 packages, 0 unknown licenses) in the evidence root (`supply-chain/`).

## Questions for counsel

1. May the product use keyless public RPC endpoints commercially, per operator? Which require agreements, attribution or paid plans?
2. Classification of a future 5 bps fee on third-party routes (if ever enabled) and required disclosures.
3. Data API commercial terms, acceptable use, abuse policy and data-processing terms.
4. Jurisdictions: **no supported jurisdiction is claimed**; geo-restrictions and sanctions screening requirements.
5. Privacy notice for address scanning and provider disclosure; cookie notice (locale cookie only).
6. Attribution obligations for network logos/brand assets (`docs/NETWORK_IDENTITY.md`).

## Release rule

No endpoint may enter the release registry without `APPROVED_FOR_RELEASE` and a recorded `legalReviewRef`; the schema refuses the status without the reference, and the release profile admits nothing else.


## V1.15.1 Swap repair boundary

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Swap Intelligence is now the primary read-only /swap product. Current scoped EVM commands/orders and Solana account/pool/economic proofs are described in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md), [SWAP_PROVIDER_MATRIX.md](SWAP_PROVIDER_MATRIX.md), [SWAP_PROVIDER_SOURCE_INVENTORY.md](SWAP_PROVIDER_SOURCE_INVENTORY.md), [SWAP_TRANSACTION_FIREWALL.md](SWAP_TRANSACTION_FIREWALL.md) and [SWAP_INCIDENT_RUNBOOK.md](SWAP_INCIDENT_RUNBOOK.md). A malicious provider cannot supply a signable payload, URL or signing authority; unknown semantics, pinned deployment drift, missing exact economics or stale binding close review. The durable metrics store contains anonymous bounded aggregates only.

Residual trust: public RPC state may be incorrect or stale; simulation is an economic snapshot and does not prove future execution, signature validity, MEV protection, token safety or source-to-bytecode correspondence. Upgrade headers and exact router code pins close known drift, with a remaining time-of-check/time-of-use boundary. Token-2022 economic extensions and unreviewed CPI/hook/order families stay unsupported. API/RPC terms, copyleft/SDK obligations, provider branding, geographic use and privacy notice require LEGAL_REVIEW_REQUIRED references. Local SDK alias/patch security disposition must be reviewed with the raw root and separate production/dev graphs. No external legal/audit/release gate is self-certified. Real execution and Otherbridge fee collection remain closed/zero.
