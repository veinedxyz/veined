# V1.16 release checklist

Machine verdict: release/FINAL_GATE_STATUS.json; raw evidence: evidence/otherbridge-v1-16/20261015T133159055Z-16dfa3. All engineering statuses must be backed by current source-bound receipts.

- Freeze source inventory/checkpoint, locks, migration checksums, source revisions, router/program pins, baseline and config; hash one production artifact.
- Fresh D: frozen installs; generated sources; format/lint/types; unit/integration/DB; safety/G7; build/bundle/smoke; accepted six-chunk E2E and artifact verification.
- SBOM and separate production/dev audits; no old C: project-runtime dependency; no install scripts.
- Credential-safe provider onboarding, bounded quota/egress, kill/no-request proof, source/API drift rejection.
- Config/startup/receipt/dead-man, CSP/CORS/SSRF, redaction and browser secret scan, hostile economic mutation tests, account/chain/disconnect review invalidation.
- Monitoring and alert fire/clear tests, isolated DB backup/restore, private TLS/app/Data API rehearsal, provider/DB/RPC chaos and rollback.
- Eight-page responsive/dark/light/RTL/axe QA and public-claims review.
- Internal adversarial review labeled accurately; external audit/pentest/legal scopes and actual privacy/license inventory; explicit owner inputs.
- Two archives: SHA-256, per-entry hashes, CRC, duplicate names zero, secret leak zero; exact RC source matches both.

No real prompts/signatures/approvals/permits/broadcasts/deploys/fees. No valid approval receipt. Any unclosed internal gate produces RETURN_FOR_REPAIR; only genuine external categories may remain for READY_FOR_EXTERNAL_AUDIT.
