# V1.17 owner gate pack

Production execution: **CLOSED**. All16 V1.16 blockers retain their exact original IDs. Internal engineering acceptance is reported in the final run evidence; this action manifest does not certify external approval. No provider key, DNS/account password, token or wallet secret belongs in this packet.

Immutable technical base: `OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3`, checkpoint `11bea158a16dc3f0528c4b6a9c24950728e1f26a3a3be86c2ca3ba5cabd5fcb9`. Audit ZIP SHA-256: `1ca5636aa97c3bd35e7338a282ee7ec576c6a85c9527bde5ebd7c7bd33eb928e`. V1.17 is a separately hashed supplement; the base ZIP is referenced without duplication.

Run `pnpm release:credentials:check` after safe server-side configuration; `--offline` reports presence only. Run `pnpm release:external-gates`; exit2 is expected external incompleteness, exit1 is invalid configuration/input. No command enables execution. Schema-valid external documents remain subject to independent authenticity/report/scope verification. See [validator contract](../docs/V117_EXTERNAL_GATE_VALIDATION.md).

| Priority | Exact action ID | Category | Status |
|---|---|---|---|
| P0 | OWNER_INPUT_UNISWAP_API_KEY | OWNER_INPUT | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_JUPITER_API_KEY | OWNER_INPUT | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_TITAN_WS_ENDPOINT | PROVIDER_ONBOARDING | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_TITAN_AUTH_TOKEN | OWNER_INPUT | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_PCSX_TRAFFIC_QUOTA | PROVIDER_ONBOARDING | CONDITIONAL_OWNER_ACTION |
| P0 | OWNER_INPUT_DOMAIN_CONTROL | DOMAIN_CONTROL | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_PRIVY_PRODUCTION | OWNER_INPUT | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_HOSTING | HOSTING_DECISION | OWNER_ACTION_REQUIRED |
| P0 | OWNER_INPUT_RPC_TERMS | RPC_COMMERCIAL_TERMS | OWNER_ACTION_REQUIRED |
| P0 | EXTERNAL_SECURITY_AUDIT | EXTERNAL_SECURITY_AUDIT | OWNER_ACTION_REQUIRED |
| P1 | EXTERNAL_PENTEST | EXTERNAL_PENTEST | OWNER_ACTION_REQUIRED |
| P1 | LEGAL_PROVIDER_PRIVACY | LEGAL_REVIEW | OWNER_ACTION_REQUIRED |
| P2 | OWNER_RELEASE_APPROVAL | OWNER_RELEASE_APPROVAL | OWNER_ACTION_REQUIRED |
| P2 | OWNER_G7_PILOT_APPROVAL | OWNER_G7_PILOT_APPROVAL | OWNER_ACTION_REQUIRED |
| P2 | OWNER_SWAP_PILOT_APPROVAL | OWNER_SWAP_PILOT_APPROVAL | OWNER_ACTION_REQUIRED |
| P2 | OWNER_UPSTREAM_WHIRLPOOL_REVIEW | PROVIDER_ONBOARDING | OWNER_ACTION_REQUIRED |

PCSX: **ANONYMOUS_QUOTA_SUFFICIENT_FOR_LAUNCH** within the actual5/rolling-second, one-process envelope and owner-confirmed shared egress. No mandatory PCSX key is requested. Aerodrome/Slipstream: **PRODUCTION_CONFIG_READY / NO_PROVIDER_CREDENTIAL_REQUIRED**, six current Base pins match; RPC/legal/release gates remain separate.

Recommended order: establish domain/hosting/egress and custody; obtain production provider entitlements/keys and exact independent RPC capacity; commission immutable-base plus supplement audit, approved private pentest and counsel review; then consider separate release/G7/Swap decisions. DNS plan, host choice and intake templates are prepared decisions, never applied changes or signed approvals.

## OWNER_INPUT_UNISWAP_API_KEY

- Category / status / priority: OWNER_INPUT / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Owner creates dedicated Otherbridge Production API key; separate staging; stores server-only UNISWAP_API_KEY; confirms assigned quota (documented default 6 RPS/key), one process and no browser/log exposure.
- Website/dashboard or local intake: https://developers.uniswap.org/dashboard. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: YES — server secret store only; value excluded from evidence.
- Configure: Owner creates dedicated Otherbridge Production API key; separate staging; stores server-only UNISWAP_API_KEY; confirms assigned quota (documented default 6 RPS/key), one process and no browser/log exposure.
- Validate: pnpm release:credentials:check --out=<run>/Uniswap/credentials.json; authenticated GET /v1/supported_chains plus reviewed representative quote must PASS; offline UNISWAP/UNISWAPX kill check must make zero requests.
- Blocks: Uniswap production authenticated quotes and provider gate closure
- Evidence expected: Key name, production namespace, assigned quota, redacted read-only PASS and kill-check receipt; no key value
- Detailed packet: [docs/V117_PROVIDER_ONBOARDING.md](../docs/V117_PROVIDER_ONBOARDING.md).

## OWNER_INPUT_JUPITER_API_KEY

- Category / status / priority: OWNER_INPUT / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Owner-controlled organisation; team Otherbridge Production with separate staging team; dedicated Swap-only key stored as JUPITER_API_KEY server-side. Deny /swap/v2/execute, /tx/v1/submit and unexpected POST for this key; set 1 RPS key firewall rule; review egress IP, organisation shared quota and analytics/logs; no broad Bypass.
- Website/dashboard or local intake: https://developers.jup.ag/portal. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: YES — server secret store only; value excluded from evidence.
- Configure: Owner-controlled organisation; team Otherbridge Production with separate staging team; dedicated Swap-only key stored as JUPITER_API_KEY server-side. Deny /swap/v2/execute, /tx/v1/submit and unexpected POST for this key; set 1 RPS key firewall rule; review egress IP, organisation shared quota and analytics/logs; no broad Bypass.
- Validate: pnpm release:credentials:check --out=<run>/Jupiter/credentials.json; reviewed GET /order and /build read-only quotes; owner permission/firewall/log review; offline Jupiter kill check. No signed execute/submit.
- Blocks: Jupiter production authenticated read-only quotes and verified account restrictions
- Evidence expected: Org/team/key name, Swap-only permissions, rule inventory, plan and static egress observations, redacted read-only/kill receipt and analytics review time; no key value
- Detailed packet: [docs/V117_PROVIDER_ONBOARDING.md](../docs/V117_PROVIDER_ONBOARDING.md).

## OWNER_INPUT_TITAN_WS_ENDPOINT

- Category / status / priority: PROVIDER_ONBOARDING / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Owner obtains enterprise Titan Direct entitlement from Titan/Triton/QuickNode and vendor confirmation that exact accepted wss://api.titan.exchange/api/v1/ws supports uncompressed v1.api.titan.ag, MessagePack and current reviewed request/transaction bounds. Set TITAN_WS_ENDPOINT to that exact URL without auth/query. Obtain numeric account connection/stream/start/update quotas and renewal/reconnect policy. If vendor offers only another endpoint, retain TITAN kill and attach incompatibility statement; do not change pins/allowlist.
- Website/dashboard or local intake: https://titan-exchange.gitbook.io/titan/developer-doc/getting-started/api-access. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Owner obtains enterprise Titan Direct entitlement from Titan/Triton/QuickNode and vendor confirmation that exact accepted wss://api.titan.exchange/api/v1/ws supports uncompressed v1.api.titan.ag, MessagePack and current reviewed request/transaction bounds. Set TITAN_WS_ENDPOINT to that exact URL without auth/query. Obtain numeric account connection/stream/start/update quotas and renewal/reconnect policy. If vendor offers only another endpoint, retain TITAN kill and attach incompatibility statement; do not change pins/allowlist.
- Validate: Vendor compatibility/limits reference plus pnpm release:credentials:check read-only quote; deterministic reconnect/cancel/frame/redaction tests and offline TITAN kill. General REST plan quota is not WebSocket proof.
- Blocks: Titan production quote streams
- Evidence expected: Enterprise entitlement/reference, approved exact endpoint, protocol and numeric per-account limits; no dashboard login or token in evidence
- Detailed packet: [docs/V117_PROVIDER_ONBOARDING.md](../docs/V117_PROVIDER_ONBOARDING.md).

## OWNER_INPUT_TITAN_AUTH_TOKEN

- Category / status / priority: OWNER_INPUT / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Owner obtains a distributor/Titan issued JWT valid for the accepted Direct endpoint, audience api.titan.ag and compatible unbound or synthetic-test-public-key policy; stores server-only TITAN_AUTH_TOKEN with expiry/renewal/rotation procedure. Portal REST x-api-key is not interchangeable. Never mint/sign a token during this task.
- Website/dashboard or local intake: https://developer.titan.exchange/. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: YES — server secret store only; value excluded from evidence.
- Configure: Owner obtains a distributor/Titan issued JWT valid for the accepted Direct endpoint, audience api.titan.ag and compatible unbound or synthetic-test-public-key policy; stores server-only TITAN_AUTH_TOKEN with expiry/renewal/rotation procedure. Portal REST x-api-key is not interchangeable. Never mint/sign a token during this task.
- Validate: pnpm release:credentials:check --out=<run>/Titan/credentials.json and safe runtime deterministic tests; no raw SDK logs, token/query URL or signed financial request.
- Blocks: Titan authenticated production read-only streams
- Evidence expected: Redacted read-only receipt, issuer/renewal reference and vendor key-binding statement; no JWT value
- Detailed packet: [docs/V117_PROVIDER_ONBOARDING.md](../docs/V117_PROVIDER_ONBOARDING.md).

## OWNER_INPUT_PCSX_TRAFFIC_QUOTA

- Category / status / priority: PROVIDER_ONBOARDING / CONDITIONAL_OWNER_ACTION / P0.
- Exact owner/vendor action: Hosting owner records one app process, expected concurrent quote users and static outbound IP/NAT tenancy; confirms aggregate other PCSX traffic plus Otherbridge <=15 RPS steady and within documented short-burst 30, with headroom. Otherbridge itself is capped at 5/rolling second. Request optional PCSX integrator key only if aggregate anonymous envelope cannot be met.
- Website/dashboard or local intake: https://developer.pancakeswap.finance/contracts/pcsx/overview. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Hosting owner records one app process, expected concurrent quote users and static outbound IP/NAT tenancy; confirms aggregate other PCSX traffic plus Otherbridge <=15 RPS steady and within documented short-burst 30, with headroom. Otherbridge itself is capped at 5/rolling second. Request optional PCSX integrator key only if aggregate anonymous envelope cannot be met.
- Validate: Compare host/NAT process inventory and per-egress capacity policy with PCSX/quota-decision.json and production processCount=1; pnpm release:credentials:check. Credentials are not proof of commercial terms.
- Blocks: Production hosting/provider quota admission, not a missing PCSX credential
- Evidence expected: Host process count, egress tenancy/traffic budget and chosen user-demand envelope; conditional vendor quota reference only if larger capacity is actually needed
- Detailed packet: [docs/V117_PROVIDER_ONBOARDING.md](../docs/V117_PROVIDER_ONBOARDING.md).

## OWNER_INPUT_DOMAIN_CONTROL

- Category / status / priority: DOMAIN_CONTROL / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Confirm registrar name, DNS provider name, and owner account control for otherbridge.io; supply a dated redacted domain/zone account-control reference. No password/token and no DNS challenge.
- Website/dashboard or local intake: https://lookup.icann.org/en/lookup?name=otherbridge.io. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Record confirmation only. DNS plan remains unapplied in docs/V117_DOMAIN_DNS_PLAN.md.
- Validate: Review dated confirmation showing exact domain/zone and accountable organization; compare both consoles without retaining secrets.
- Blocks: Production origin control and any future DNS/TLS activation.
- Evidence expected: Registrar and DNS provider names/URLs; Dated redacted account-control confirmation
- Detailed packet: [docs/V117_DOMAIN_DNS_PLAN.md](../docs/V117_DOMAIN_DNS_PLAN.md).

## OWNER_INPUT_PRIVY_PRODUCTION

- Category / status / priority: OWNER_INPUT / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Owner selects dedicated production app, sets public NEXT_PUBLIC_PRIVY_APP_ID and exact https://otherbridge.io allowed origin; reviews app-client overrides; external Ethereum wallet connect-only; all email/social/SMS/passkey and embedded creation OFF; no delegated/session/server execution signers; exact existing CSP retained. No real wallet prompt or App Secret export.
- Website/dashboard or local intake: https://dashboard.privy.io/apps?page=settings&tab=basics. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Owner selects dedicated production app, sets public NEXT_PUBLIC_PRIVY_APP_ID and exact https://otherbridge.io allowed origin; reviews app-client overrides; external Ethereum wallet connect-only; all email/social/SMS/passkey and embedded creation OFF; no delegated/session/server execution signers; exact existing CSP retained. No real wallet prompt or App Secret export.
- Validate: Owner redacted dashboard inventory and review receipt; pnpm release:credentials:check --offline; verify:safety, g7:safety, g7:pilot:safety and existing CSP/browser evidence. CLI cannot prove hidden dashboard settings.
- Blocks: Privy production app/origin/policy verification and external gate closure
- Evidence expected: Public app reference, reviewer/time, exact origin list and client inventory, login/embedded/signer settings and CSP review; no secret/session/wallet interaction
- Detailed packet: [docs/V117_PRIVY_PRODUCTION.md](../docs/V117_PRIVY_PRODUCTION.md).

## OWNER_INPUT_HOSTING

- Category / status / priority: HOSTING_DECISION / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Accept recommended pattern B or document A/C tradeoff; select owner-controlled host and PostgreSQL accounts/region/budget/operator; confirm fixed egress, persistent workers/WSS, private TLS DB, roles, backups/PITR/restore and secret custody. Obtain quote; do not deploy.
- Website/dashboard or local intake: https://nextjs.org/docs/app/guides/self-hosting. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Complete architecture/region/budget/on-call/custodian/RPO/RTO/retention and secret-manager decisions in docs/V117_HOSTING_SECRET_CUSTODY.md.
- Validate: Vendor feature confirmations and dated signed-off decision; initial 8vCPU/16GiB app-worker and 2vCPU/4GiB PG are procurement envelopes only.
- Blocks: Production host configuration and secret custody readiness.
- Evidence expected: Account portal URLs and region/budget decision; Persistent workers/WSS/static-egress/TLS/role feature confirmation; Recovery and custody access matrix
- Detailed packet: [docs/V117_HOSTING_SECRET_CUSTODY.md](../docs/V117_HOSTING_SECRET_CUSTODY.md).

## OWNER_INPUT_RPC_TERMS

- Category / status / priority: RPC_COMMERCIAL_TERMS / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Choose the exact production endpoint subset and counsel-reviewed operator/terms/privacy/quota references. For Arbitrum, obtain a PublicNode personal-token log entitlement or an independently operated Quicknode Paid / Alchemy PAYG witness with proven unrestricted Transfer-topic/history capacity. Avalanche official and PublicNode now match a finalized one-block log digest; retain them as technical candidates only, with contractual quota/history/privacy and independent-operator review still required. Do not purchase multiple alternatives unnecessarily.
- Website/dashboard or local intake: https://www.quicknode.com/chains/arbitrum. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Follow docs/V117_RPC_WITNESS.md and RPC/owner-actions.json: server-only endpoint secret references, exact chain42161/43114 identity, required historical window, range/response/RPS/CU/monthly ceilings, operator independence and legalReviewRef for each selected endpoint. No production admission or provenance flag is changed here.
- Validate: Run the documented read-only exact-finalized-header, complete Transfer-topic current window and oldest-required window tests; compare normalized log digests against an independent operator. Confirm release provenance admits only owner/counsel-reviewed endpoints; current production-approved count is0.
- Blocks: Production RPC profile stays blocked
- Evidence expected: Two operator identities per indexed chain; successful log/block/canonical witness receipt; paid tier/quota support statement; agreement/privacy/legal references.
- Detailed packet: [docs/V117_RPC_WITNESS.md](../docs/V117_RPC_WITNESS.md).

## EXTERNAL_SECURITY_AUDIT

- Category / status / priority: EXTERNAL_SECURITY_AUDIT / OWNER_ACTION_REQUIRED / P0.
- Exact owner/vendor action: Select independent auditor meeting the named skills matrix; record secure portal URL/lead; agree immutable V1.16 RC plus separately hashed V1.17 supplement; commission review and remediation retest using audit/AUDITOR_INTAKE.md and questions.
- Website/dashboard or local intake: local:audit/AUDITOR_INTAKE.md. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Transfer verified immutable package through appointed secure channel; deterministic proof requires no production key or real wallet.
- Validate: Independent report and retest bind exact reviewed identity, hashes, severity/unresolved findings, reviewer and limitations; future receipt schema must pass.
- Blocks: Independent security assurance and production release.
- Evidence expected: Signed scope/intake receipt; Independent report SHA-256 and reviewed RC/checkpoint/supplement hashes; Unresolved finding counts and independent retest
- Detailed packet: [audit/AUDITOR_INTAKE.md](../audit/AUDITOR_INTAKE.md).

## EXTERNAL_PENTEST

- Category / status / priority: EXTERNAL_PENTEST / OWNER_ACTION_REQUIRED / P1.
- Exact owner/vendor action: Select independent tester; record secure intake portal/lead; approve completed private-target ROE with exact targets, window, traffic caps and emergency contacts; commission test and remediation retest.
- Website/dashboard or local intake: local:pentest/PENTEST_INTAKE.md. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Use isolated private staging and synthetic fixtures; temporary API access only via secure engagement channel; no live wallets or upstream attacks.
- Validate: Signed private-target ROE, target ownership, exact candidate/build, report hash/coverage/unresolved counts and independent retest; future receipt schema must pass.
- Blocks: Independent web/API assurance and production release.
- Evidence expected: Approved private-target ROE; Independent test report SHA-256, dates, candidate and severity counts; Independent remediation retest
- Detailed packet: [pentest/PENTEST_INTAKE.md](../pentest/PENTEST_INTAKE.md).

## LEGAL_PROVIDER_PRIVACY

- Category / status / priority: LEGAL_REVIEW / OWNER_ACTION_REQUIRED / P1.
- Exact owner/vendor action: Appoint counsel for intended markets; record secure matter portal and accountable counsel; supply operator entity/markets/host/data-retention facts and actual provider/RPC contracts; commission product/privacy/provider/RPC/OSS review and approved documents.
- Website/dashboard or local intake: local:legal/COUNSEL_INTAKE.md. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Use factual inventory and question set; retain actual contract/policy versions per provider/operator; no account secrets or legal conclusions supplied by agent.
- Validate: Counsel identity/reference, exact reviewed version/doc hashes, provider/RPC terms matrix, jurisdiction policy, approval conditions and future schema validation.
- Blocks: Legal/privacy/provider approval and production release.
- Evidence expected: Counsel approval reference and reviewed document hashes; Provider/RPC terms and OSS obligations matrix; Jurisdiction availability and privacy/terms decisions
- Detailed packet: [legal/COUNSEL_INTAKE.md](../legal/COUNSEL_INTAKE.md).

## OWNER_RELEASE_APPROVAL

- Category / status / priority: OWNER_RELEASE_APPROVAL / OWNER_ACTION_REQUIRED / P2.
- Exact owner/vendor action: Decide whether to authorize the exact candidate after external gates close
- Website/dashboard or local intake: local:docs/V117_EXTERNAL_GATE_VALIDATION.md. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: Separately reviewed future release receipt and trust-root process
- Validate: Follow docs/V117_EXTERNAL_GATE_VALIDATION.md; pnpm release:external-gates must remain EXECUTION_CLOSED until independent evidence verification.
- Blocks: Production execution remains CLOSED
- Evidence expected: Dated owner/vendor/reviewer reference bound to exact RC/checkpoint, with independent verification; never a credential value.
- Detailed packet: [docs/V117_EXTERNAL_GATE_VALIDATION.md](../docs/V117_EXTERNAL_GATE_VALIDATION.md).

## OWNER_G7_PILOT_APPROVAL

- Category / status / priority: OWNER_G7_PILOT_APPROVAL / OWNER_ACTION_REQUIRED / P2.
- Exact owner/vendor action: Separately approve any future real G7 pilot
- Website/dashboard or local intake: local:docs/G7_OWNER_RELEASE_RUNBOOK.md. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: docs/G7_OWNER_RELEASE_RUNBOOK.md
- Validate: Follow docs/G7_OWNER_RELEASE_RUNBOOK.md; pnpm release:external-gates must remain EXECUTION_CLOSED until independent evidence verification.
- Blocks: No real G7 in V1.16
- Evidence expected: Dated owner/vendor/reviewer reference bound to exact RC/checkpoint, with independent verification; never a credential value.
- Detailed packet: [docs/G7_OWNER_RELEASE_RUNBOOK.md](../docs/G7_OWNER_RELEASE_RUNBOOK.md).

## OWNER_SWAP_PILOT_APPROVAL

- Category / status / priority: OWNER_SWAP_PILOT_APPROVAL / OWNER_ACTION_REQUIRED / P2.
- Exact owner/vendor action: Separately approve provider/chain/wallet/amount for any future Swap pilot
- Website/dashboard or local intake: local:docs/SWAP_OWNER_RELEASE_RUNBOOK.md. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: docs/SWAP_OWNER_RELEASE_RUNBOOK.md
- Validate: Follow docs/SWAP_OWNER_RELEASE_RUNBOOK.md; pnpm release:external-gates must remain EXECUTION_CLOSED until independent evidence verification.
- Blocks: No real Swap or Bridge in V1.16
- Evidence expected: Dated owner/vendor/reviewer reference bound to exact RC/checkpoint, with independent verification; never a credential value.
- Detailed packet: [docs/SWAP_OWNER_RELEASE_RUNBOOK.md](../docs/SWAP_OWNER_RELEASE_RUNBOOK.md).

## OWNER_UPSTREAM_WHIRLPOOL_REVIEW

- Category / status / priority: PROVIDER_ONBOARDING / OWNER_ACTION_REQUIRED / P2.
- Exact owner/vendor action: Obtain Orca deployed-binary/source provenance and independent reviewer assessment matching the observed ProgramData/hash/upgrade slot. Affected routes stay BUILD_REVIEW_REQUIRED; any pin update is a separate reviewed candidate.
- Website/dashboard or local intake: https://github.com/orca-so/whirlpools. Account/vendor-selected portals are recorded by owner in the decision reference; none is guessed.
- Secret: NO — nonsecret reference only.
- Configure: No current pin update. Supply exact deployed artifact/build/source/IDL and independent signed compatibility assessment against docs/WHIRLPOOL_UPSTREAM_REVIEW.md.
- Validate: Follow docs/WHIRLPOOL_UPSTREAM_REVIEW.md; pnpm release:external-gates must remain EXECUTION_CLOSED until independent evidence verification.
- Blocks: Affected Jupiter/Titan Whirlpool economic routes remain BUILD_REVIEW_REQUIRED
- Evidence expected: Reproducible deployed binary/source binding and reviewer report; current upstream/source metadata alone is insufficient.
- Detailed packet: [docs/WHIRLPOOL_UPSTREAM_REVIEW.md](../docs/WHIRLPOOL_UPSTREAM_REVIEW.md).
