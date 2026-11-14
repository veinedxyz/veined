# V1.9 additions to the release gate

- **Privy live configuration (W18):** a real Privy App ID, dashboard set to external wallets only (email/SMS/social/
  passkey OFF, embedded wallet creation OFF), exact allowed origins, and the live wallet acceptance in
  [PRIVY_SETUP.md](PRIVY_SETUP.md) §8 including the measured network inventory. Status: **NOT_RUN — App ID required.**
- **License review:** WalletConnect (≥2.21) and Reown AppKit community license agreements (shipped in the lazy wallet
  chunk); MetaMask SDK proprietary license (installed transitively, not shipped). Status: **LEGAL_REVIEW_REQUIRED.**
- **Residual moderate advisory** GHSA-vcc3-ghjq-m6fr (`decode-uri-component` via WalletConnect) — accepted with
  rationale in `docs/INTERNAL/DEPENDENCY_V19_PRIVY.md`; re-check on every WalletConnect update.
- **G7:** READY is STALE after the signing-path change; fresh live dry run and owner approval required.

---

# Production release gate — V1.6 re-evaluation (CLOSED)

Status after V1.6: **production release BLOCKED — RELEASE_APPROVAL_REQUIRED**; G7 **NOT_RUN — USER_APPROVAL_REQUIRED**; ONEchain G5 **PASS** (V1.6 autonomous evidence; point-in-time, drift-enforced). `REAL_EXECUTION=false`; signatures, approvals, permits, broadcasts, deploys, fee collection = 0.

```text
ONECHAIN G5 (A–J)                          PASS   (evidence evidence/otherbridge-v1-6/v16-20261004T190436Z-210476)
INDEPENDENT_EXTERNAL_SOURCE_REVIEW         NOT_RUN
WEB_API_PENTEST_EXTERNAL                   NOT_RUN
TRANSACTION_FIREWALL_EXTERNAL_REVIEW       NOT_RUN
LEGAL_REVIEW                               NOT_RUN
OWNER_RELEASE_APPROVAL                     NOT_RUN
G7 CONTROLLED PILOT                        NOT_RUN — USER_APPROVAL_REQUIRED (plan only)
```

| Blocker | Class |
|---|---|
| Independent external source review, web/API pentest, firewall/decoder/simulation review | EXTERNAL_SECURITY |
| ONEchain route trust model: single admin EOA with instant upgrade, 2-of-3 validator EOAs, single VERIFIER_ROLE EOA (route risk G5-SR-01; drift-enforced, owner risk acceptance needed) | OWNER_APPROVAL |
| RPC operator terms, provider terms, fee model, privacy, jurisdictions | LEGAL |
| Production IAM/secret manager/KMS, managed PostgreSQL TLS, backup key custody, on-call, disclosure channel | OPERATIONS |
| Arbitrum/Avalanche second independent log witness | OPERATIONS |
| Controlled capped pilot (G7) and owner release approval | OWNER_APPROVAL |

The former `ONECHAIN_EXTERNAL` blocker class (deployment-build provenance, spendable reserve, second canonical payout) is closed by V1.6 evidence. Local Opus review cannot set any external status to PASS.

---

# Production release gate — V1.5 re-evaluation (CLOSED)

Status after V1.5 pre-release hardening: **production release BLOCKED — RELEASE_APPROVAL_REQUIRED**; G7 **NOT_RUN — USER_APPROVAL_REQUIRED**; ONEchain G5 **BLOCKED_EXTERNAL_EVIDENCE** (no new external evidence arrived). `REAL_EXECUTION=false`, real fee 0 bps, fee collection disabled; signatures, approvals, permits, broadcasts, deploys = 0.

```text
LOCAL ENGINEERING HARDENING                PASS (local gates H1–H14; evidence evidence/otherbridge-v1-5/v15-20261004T131452Z-64ebac)
EXTERNAL SOURCE SECURITY REVIEW            NOT_RUN
WEB/API PENTEST                            NOT_RUN   (package: OTHERBRIDGE_SECURITY_REVIEW_PACKAGE.zip, docs/PENTEST_TARGET_MAP.md)
TRANSACTION FIREWALL INDEPENDENT REVIEW    NOT_RUN   (docs/TRANSACTION_FIREWALL_SPEC.md)
INFRA/IAM/SECRETS REVIEW                   NOT_RUN   (docs/IAM_SECRETS_ARCHITECTURE.md)
LEGAL REVIEW                               NOT_RUN   (docs/LEGAL_REVIEW_PACKET.md, docs/RPC_PROVENANCE_TERMS.md)
CONTROLLED MAINNET PILOT                   NOT_RUN
OWNER RELEASE APPROVAL                     NOT_RUN
```

Closed locally by V1.5 (engineering, not independent): second-endpoint log-omission detection (witness consensus); CSP inline-style removal; self-hosted monitoring with validated alerts and drills; backup → isolated restore drill with corruption tests; hardened staging-equivalent stack; RPC provenance/terms inventory with release-profile enforcement; firewall registry/simulation-block binding; configuration schema hardening.

## Remaining blockers (classification)

| Blocker | Class |
|---|---|
| Independent external source review, web/API pentest, firewall/decoder/simulation review | EXTERNAL_SECURITY |
| RPC operator terms not approved for release (0 `APPROVED_FOR_RELEASE`); provider/routing terms and attribution; fee model; privacy notice; jurisdictions | LEGAL |
| Production IAM/secret manager/KMS, managed PostgreSQL with TLS, backup encryption key custody, separate Data API DB role, production log/alert routing and on-call, disclosure channel, real incident exercise | OPERATIONS |
| Domain/registrar hardening, HSTS preload decision | OPERATIONS / OWNER_APPROVAL |
| Arbitrum and Avalanche lack a second independent log witness operator (release-ineligible; development indexing only) | OPERATIONS (needs a vetted second operator or contract) |
| ONEchain G5 deployment-build provenance, spendable reserve, second canonical payout | ONECHAIN_EXTERNAL |
| Controlled capped mainnet pilot and owner release approval; G7 | OWNER_APPROVAL |

No engineering blocker from this goal remains open; residual engineering risks are listed in `docs/V15_TEST_MATRIX.md`.

---

# Production release gate — V1.4 re-evaluation (CLOSED)

Status after V1.4 (self-hosted data plane, internal Data API): production release **BLOCKED — RELEASE_APPROVAL_REQUIRED**; G7 **NOT_RUN — USER_APPROVAL_REQUIRED**; ONEchain G5 **BLOCKED_EXTERNAL_EVIDENCE**. Real signatures, approvals, broadcasts, deploys and fee collection remain **0**. The goal invariants `REAL_EXECUTION=false`, `REAL_OTHERBRIDGE_FEE=false` and `PRODUCTION_DEPLOY=false` hold; they are not runtime switches, and setting such environment variables to `true` cannot open the write gate (regression in `tests/unit/v13.test.ts`). The Data API is internal-first on loopback (`publicApiEnabled=false`, `billingEnabled=false`); it is not a public launch.

Closed by V1.4 (locally verified, not an independent review): paid broad portfolio/indexer dependency removed; silent 40-network cap removed; dev-only high advisory removed from the graph by a tested override (prod/dev/all audit 0); exact origin policy with fail-closed production configuration; durable PostgreSQL rate limiter (concurrency-tested across two instances); hashed API keys with scopes, revocation, quotas and usage metering; full Opus active-source audit with repairs and regression tests (`docs/OPUS_FINAL_AUDIT.md`).

Every one of the following remains **open** and must be completed and recorded before any public mainnet release. None is marked complete by this delivery:

1. Independent external security review of the full active source (app, data plane, Data API, indexer).
2. Web/API penetration test, including the `/v1` Data API, API-key handling, rate limiting and origin policy.
3. Independent transaction firewall / decoder / simulation review.
4. Infrastructure, IAM and secrets review (managed PostgreSQL with TLS, role separation, secret manager/KMS, rotation, backups, audit logs).
5. Domain/registrar hardening (MFA, registry lock where available, hardware-backed admin access).
6. Production monitoring and alerting (RPC health, indexer lag/reorgs, API errors, rate-limit saturation, security events).
7. Incident-response drill, tested rollback/restore and a disclosure channel.
8. Legal/compliance review of any fee service, provider terms (including third-party public RPC endpoint terms) and attribution.
9. A controlled, capped mainnet pilot approved separately after all gates.
10. Explicit owner approval for release; ONEchain G5 needs separate new external evidence.

Additional V1.4 data-plane items before production traffic: provenance/terms review of every admitted public RPC endpoint; a configured pseudonym key and `OTHERBRIDGE_PUBLIC_DEPLOYMENT` durable-limiter enforcement in every public instance; HSTS preload/includeSubDomains decision; CSP inline-style removal; second-endpoint log-omission checks for indexed windows.

---

# Separate production release gate — CLOSED

No public mainnet execution or production release is authorized by V1.3. G7 remains NOT_RUN — USER_APPROVAL_REQUIRED and production release BLOCKED — RELEASE_APPROVAL_REQUIRED. Real fees/signatures/approvals/broadcasts/deploys remain zero.

Require before any later release:

1. Independent web/API penetration test and code/security review.
2. Independent adversarial transaction-firewall/decoder/simulation review.
3. Smart-contract audit only if a separately approved custom contract becomes necessary; this milestone adds none.
4. Dependency/supply-chain audit with unresolved findings addressed, cloud/IAM/secret review and CSP/wallet-phishing review.
5. Live monitoring/alerts, incident-response drill, tested backup/rollback and disclosure/bug-bounty channel.
6. Domain/registrar MFA and registry lock where available; hardware-backed admin and least privilege.
7. Legal/compliance and actual provider plan/attribution/fee semantics review.
8. Explicit approval for a small capped mainnet pilot after all gates, including separate ONEchain G5 evidence where applicable.

The audit receipt in this delivery may contain findings. A passing local test is not an audit and does not waive these gates. Production secrets belong in a server-only secret manager/KMS with separate environment roles, rotation runbook and audit logs. No custody, treasury or own liquidity is planned.


## V1.15.1 Swap repair boundary

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Swap Intelligence is now the primary read-only /swap product. Current scoped EVM commands/orders and Solana account/pool/economic proofs are described in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md), [SWAP_PROVIDER_MATRIX.md](SWAP_PROVIDER_MATRIX.md), [SWAP_PROVIDER_SOURCE_INVENTORY.md](SWAP_PROVIDER_SOURCE_INVENTORY.md), [SWAP_TRANSACTION_FIREWALL.md](SWAP_TRANSACTION_FIREWALL.md) and [SWAP_INCIDENT_RUNBOOK.md](SWAP_INCIDENT_RUNBOOK.md). A malicious provider cannot supply a signable payload, URL or signing authority; unknown semantics, pinned deployment drift, missing exact economics or stale binding close review. The durable metrics store contains anonymous bounded aggregates only.

Residual trust: public RPC state may be incorrect or stale; simulation is an economic snapshot and does not prove future execution, signature validity, MEV protection, token safety or source-to-bytecode correspondence. Upgrade headers and exact router code pins close known drift, with a remaining time-of-check/time-of-use boundary. Token-2022 economic extensions and unreviewed CPI/hook/order families stay unsupported. API/RPC terms, copyleft/SDK obligations, provider branding, geographic use and privacy notice require LEGAL_REVIEW_REQUIRED references. Local SDK alias/patch security disposition must be reviewed with the raw root and separate production/dev graphs. No external legal/audit/release gate is self-certified. Real execution and Otherbridge fee collection remain closed/zero.
