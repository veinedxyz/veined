# V1.16 owner inputs

Only external actions are listed here. Never provide a wallet private key or seed phrase. Credentials belong in the selected server secret mechanism, never chat, screenshots, logs, bundles or git.

## OWNER_INPUT_UNISWAP_API_KEY

- Action: Obtain a dedicated production Uniswap API key.
- Why: Authenticated Trading API quote validation is not possible without a key.
- Obtain: https://developers.uniswap.org.
- Classification: secret.
- Configure: UNISWAP_API_KEY; production server secret namespace.
- Validate: node scripts/v116-provider-preflight.mjs.
- Impact: Authenticated Uniswap quote onboarding.

## OWNER_INPUT_JUPITER_API_KEY

- Action: Create separate production team/key; restrict to Swap and configure firewall/egress-IP/rate limits.
- Why: Dedicated least-privilege credentials and dashboard controls must be configured by their owner.
- Obtain: https://developers.jup.ag/portal.
- Classification: secret.
- Configure: JUPITER_API_KEY; production server only.
- Validate: node scripts/v116-provider-preflight.mjs.
- Impact: Jupiter onboarding.

## OWNER_INPUT_TITAN_WS_ENDPOINT

- Action: Confirm the vendor-approved endpoint matches the reviewed endpoint.
- Why: Vendor access is not granted by the SDK.
- Obtain: https://github.com/Titan-Pathfinder/titan-sdk-ts.
- Classification: non-secret.
- Configure: TITAN_WS_ENDPOINT=wss://api.titan.exchange/api/v1/ws.
- Validate: node scripts/v116-provider-preflight.mjs.
- Impact: Titan quote stream.

## OWNER_INPUT_TITAN_AUTH_TOKEN

- Action: Obtain a production quote-stream token.
- Why: No token is present in the local environment inventory.
- Obtain: Titan API team via official SDK contact.
- Classification: secret.
- Configure: TITAN_AUTH_TOKEN; production server only.
- Validate: node scripts/v116-provider-preflight.mjs.
- Impact: Titan authenticated quote stream.

## OWNER_INPUT_PCSX_TRAFFIC_QUOTA

- Action: Confirm shared-egress traffic budget; obtain integrator key only if aggregate traffic exceeds anonymous quota.
- Why: Current app caps PCSX at 5 RPS, below documented anonymous 15 RPS; other tenants may share that IP.
- Obtain: https://developer.pancakeswap.finance/contracts/pcsx/overview.
- Classification: non-secret.
- Configure: Traffic plan; optional PCSX_INTEGRATOR_KEY is server-only.
- Validate: node scripts/v116-provider-preflight.mjs.
- Impact: Conditional key requirement; no mandatory integrator key at the current single-process budget.

## OWNER_INPUT_DOMAIN_CONTROL

- Action: Confirm ownership and registrar/DNS control for otherbridge.io.
- Why: Public DNS results cannot establish ownership.
- Obtain: Owner registrar account.
- Classification: non-secret.
- Configure: Domain custody record; no DNS change in V1.16.
- Validate: Review sources/domain-readonly.json.
- Impact: Production origin/TLS/Privy setup.

## OWNER_INPUT_PRIVY_PRODUCTION

- Action: Supply production App ID and verify allowed domain plus connect-only settings.
- Why: Dashboard configuration is outside this repository.
- Obtain: https://dashboard.privy.io.
- Classification: non-secret.
- Configure: NEXT_PUBLIC_PRIVY_APP_ID and dashboard allowed origin https://otherbridge.io.
- Validate: Follow docs/PRIVY_PRODUCTION_CHECKLIST.md.
- Impact: External-wallet connection onboarding.

## OWNER_INPUT_HOSTING

- Action: Select hosting, secret custody mechanism, operator and recovery destinations.
- Why: Hosting and secret manager are owner choices; runtime interface is deployment-neutral.
- Obtain: Owner infrastructure account.
- Classification: non-secret.
- Configure: Deployment environment and restricted secret namespace.
- Validate: Follow docs/SECRET_CUSTODY.md and production config schema.
- Impact: Public hosting; no public deployment authorized.

## OWNER_INPUT_RPC_TERMS

- Action: Approve reviewed RPC operators/quotas with legal references.
- Why: Current LEGAL_REVIEW_REQUIRED entries cannot be release-approved by engineering.
- Obtain: RPC provider agreements and owner/counsel.
- Classification: non-secret.
- Configure: src/data/registry/rpc-provenance.json legalReviewRef through a separately reviewed release change.
- Validate: Production startup must accept only reviewed RPCs.
- Impact: Production RPC profile stays blocked.

## EXTERNAL_SECURITY_AUDIT

- Action: Commission independent security audit against exact RC and hash its signed report.
- Why: Internal review is not independent certification.
- Obtain: Qualified independent auditor.
- Classification: non-secret.
- Configure: Release evidence; externalAuditHashes in future receipt.
- Validate: Verify package hash and audit scope.
- Impact: Owner release decision.

## EXTERNAL_PENTEST

- Action: Commission web/API pentest on an approved private target.
- Why: No external pentest was performed by this milestone.
- Obtain: Independent pentest team.
- Classification: non-secret.
- Configure: Release evidence.
- Validate: audit/OTHERBRIDGE_EXTERNAL_PENTEST_SCOPE.md.
- Impact: Owner release decision.

## LEGAL_PROVIDER_PRIVACY

- Action: Complete provider, OSS license, commercial-use, terms and privacy reviews.
- Why: Technical source review is not legal approval.
- Obtain: Owner/counsel and vendors.
- Classification: non-secret.
- Configure: Signed references in release evidence.
- Validate: legal/RELEASE_LEGAL_REVIEW_CHECKLIST.md.
- Impact: Legal release gate.

## OWNER_RELEASE_APPROVAL

- Action: Decide whether to authorize the exact candidate after external gates close.
- Why: No production approval or valid release receipt is issued here.
- Obtain: Repository owner.
- Classification: non-secret.
- Configure: Separately reviewed future release receipt and trust-root process.
- Validate: Schema plus signature, revocation and exact-artifact validation.
- Impact: Production execution remains CLOSED.

## OWNER_G7_PILOT_APPROVAL

- Action: Separately approve any future real G7 pilot.
- Why: General release approval does not authorize a G7 wallet action.
- Obtain: Repository owner.
- Classification: non-secret.
- Configure: docs/G7_OWNER_RELEASE_RUNBOOK.md.
- Validate: G7 preflight against exact approved artifact.
- Impact: No real G7 in V1.16.

## OWNER_SWAP_PILOT_APPROVAL

- Action: Separately approve provider/chain/wallet/amount for any future Swap pilot.
- Why: Swap and Bridge authorization are independent.
- Obtain: Repository owner.
- Classification: non-secret.
- Configure: docs/SWAP_OWNER_RELEASE_RUNBOOK.md.
- Validate: Quote/firewall/simulation/receipt verification.
- Impact: No real Swap or Bridge in V1.16.
