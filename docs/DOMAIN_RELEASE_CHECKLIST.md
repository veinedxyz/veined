# Domain release checklist (document only)

No domain, registrar or DNS action was performed by V1.5. Domain ownership and the current registrar state are **not assumed**. Before any public release the owner/operator must verify and record each item (date, who, evidence reference):

- [ ] Domain ownership confirmed in the registrar account of the legal owner (not an individual's personal account).
- [ ] Registrar account protected by MFA for every user; hardware-backed MFA (FIDO2/WebAuthn) where the registrar supports it.
- [ ] Recovery contacts current; recovery email on a separately protected domain/account.
- [ ] Registry lock (server-side) and registrar transfer lock enabled where available; change procedure documented.
- [ ] DNSSEC availability evaluated; decision recorded (enable with key rollover procedure, or justified deferral).
- [ ] Least-privilege DNS access: named individuals, no shared credentials, API tokens scoped to the zone and rotated.
- [ ] Backup/recovery codes stored offline in a controlled secret store; access audited.
- [ ] Expiration and auto-renewal protections; renewal payment method owned by the organization; expiry monitoring.
- [ ] DNS change monitoring and alerting (zone diff, NS/DS/MX/CAA/A/AAAA changes) to the incident channel.
- [ ] CAA records restricting certificate issuance to the chosen CA(s).
- [ ] HSTS `includeSubDomains`/`preload` decision taken only after every subdomain serves HTTPS (`docs/CSP_HARDENING.md`).
- [ ] Origins configured exactly in `OTHERBRIDGE_APP_ORIGINS`; Data API ingress host in `OTHERBRIDGE_DATA_API_HOSTS`.

Status: **BLOCKED — OWNER ACTION REQUIRED**.


## V1.15.1 Swap repair boundary

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Swap Intelligence is now the primary read-only /swap product. Current scoped EVM commands/orders and Solana account/pool/economic proofs are described in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md), [SWAP_PROVIDER_MATRIX.md](SWAP_PROVIDER_MATRIX.md), [SWAP_PROVIDER_SOURCE_INVENTORY.md](SWAP_PROVIDER_SOURCE_INVENTORY.md), [SWAP_TRANSACTION_FIREWALL.md](SWAP_TRANSACTION_FIREWALL.md) and [SWAP_INCIDENT_RUNBOOK.md](SWAP_INCIDENT_RUNBOOK.md). A malicious provider cannot supply a signable payload, URL or signing authority; unknown semantics, pinned deployment drift, missing exact economics or stale binding close review. The durable metrics store contains anonymous bounded aggregates only.

Residual trust: public RPC state may be incorrect or stale; simulation is an economic snapshot and does not prove future execution, signature validity, MEV protection, token safety or source-to-bytecode correspondence. Upgrade headers and exact router code pins close known drift, with a remaining time-of-check/time-of-use boundary. Token-2022 economic extensions and unreviewed CPI/hook/order families stay unsupported. API/RPC terms, copyleft/SDK obligations, provider branding, geographic use and privacy notice require LEGAL_REVIEW_REQUIRED references. Local SDK alias/patch security disposition must be reviewed with the raw root and separate production/dev graphs. No external legal/audit/release gate is self-certified. Real execution and Otherbridge fee collection remain closed/zero.
