# V1.17 external evidence and operator commands

The technical audit base remains immutable V1.16 RC `OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3`, checkpoint `11bea158a16dc3f0528c4b6a9c24950728e1f26a3a3be86c2ca3ba5cabd5fcb9`. V1.17 adds onboarding documents and offline operator validation. It grants no financial, deployment or DNS permission. The V1.17 source checkpoint is generated under the current evidence run after all source changes finish; it does not replace the audit base.

## Credential inventory and authentication

Run `pnpm release:credentials:check --offline` for a zero-request inventory. Run `pnpm release:credentials:check` for minimal authenticated read-only checks when the owner has configured production credentials. The command reads `.env.local` if present, with process environment taking precedence. In production, inject secrets through the chosen server secret mechanism. Never place credential values on a command line, in chat, in screenshots or in an archive.

The server names are `UNISWAP_API_KEY`, `JUPITER_API_KEY`, `TITAN_WS_ENDPOINT`, `TITAN_AUTH_TOKEN`, and optional `PCSX_INTEGRATOR_KEY`. `NEXT_PUBLIC_PRIVY_APP_ID` is a public identifier; dashboard policy requires its own evidence. PCSX remains opt-in through `PCSX_QUOTE_ENABLED=true`; this command does not enable it. Every provider kill in `SWAP_DISABLED_PROVIDERS` prevents authentication requests for that mode. Jupiter probes only its remaining active modes, which are recorded in the receipt. Execution flags and public secrets are rejected before any request. The global execution kill remains on during quote checks.

Uniswap checks the fixed supported-chains GET endpoint and a representative quote. Jupiter checks both `/swap/v2/order` and `/swap/v2/build`, at the existing shared quota. Titan uses the existing safe, bounded, redacting v1 transport for quote streams with its existing reconnect/cancel behavior. No `/execute`, order submission, wallet, signature or broadcast method is available in this command. An endpoint differing from the reviewed Titan endpoint requires separate review and is refused.

`READ_ONLY_PASS` means that these requests returned validated quote data. It does not prove commercial permission, independent audit, scope completeness or wallet execution safety. Missing credentials report `OWNER_INPUT_REQUIRED`; configured but offline credentials report `CONFIGURED_NOT_CHECKED`. Headers, raw responses and error messages are discarded. `--out=evidence/<new-file>.json` writes the same sanitized result and refuses overwriting an existing receipt. The PCSX anonymous quota decision is conditional on the one-process/shared-egress budget in the provider packet; it does not erase `OWNER_INPUT_PCSX_TRAFFIC_QUOTA`.

## External gate command

Run `pnpm release:external-gates`. The default credential input is a current offline inventory; to use actual authentication evidence, pass `--credentials=<sanitized-credential-result.json>` generated within the last 15 minutes. Optional inputs are `--owner-evidence=<file>`, `--audit=<file>`, `--pentest=<file>`, `--legal=<file>` and `--owner-release=<file>`. Default future paths are `release/owner-evidence.json`, `release/audit-result.json`, `release/pentest-result.json`, `release/legal-approval.json`, `release/owner-release.json`; none is manufactured in V1.17. `--out=<new-local-file>` records the sanitized result. Malformed/oversized inputs are refused without printing content.

Exit 2 means the expected `EXECUTION_CLOSED / EXTERNAL_GATES_INCOMPLETE` result. Exit 1 means invalid manifest/input/configuration that needs repair. There is no execution-enabling exit or flag. Do not suppress an exit 1 as an expected external block.

The validator reads `release/EXTERNAL_GATES.json` and refuses removal, renaming or duplicate IDs from all 16 original blockers. Categories are restricted to those authorized by the V1.17 goal. Domain control, Privy settings, hosting and RPC references have separate owner evidence fields. An owner attestation cannot be inferred from DNS, configured keys, a populated JSON document or a successful quote.

## Future result schemas and authority

`pnpm release:schemas` regenerates these JSON Schema contracts from the tested Zod schemas:

- `release/security-audit-result.schema.json`: auditor, exact RC/source/build identity, report hash/reference, scope, severity counts, unresolved findings and remediation retest.
- `release/pentest-result.schema.json`: approved private target, authorization/ROE hash, dates, scope, severities and retest.
- `release/legal-approval.schema.json`: version/identity, hashes of reviewed documents, explicit provider/RPC terms references, jurisdiction policy, counsel identity/reference and conditions.
- `release/owner-evidence.schema.json`: dated nonsecret domain, Privy, hosting and independent RPC references bound to the technical base.
- `release/external-gates.schema.json`: action manifest and immutable V1.16 lineage.

These are schemas, not PASS receipts. Reports must be checked against their actual bytes, signer/reviewer identity, approved target, scope, dates and unresolved findings by the owner and independent reviewers. Current repository code has no external authority trust root or verified owner release signature. A schema-valid document therefore reports `SCHEMA_VALID_REQUIRES_INDEPENDENT_VERIFICATION`; it never authorizes execution. Critical/high or unresolved findings, missing retests, stale identities and invalid dates are separately rejected. The existing V1.16 release inspector continues to reject every owner receipt. Production execution stays structurally closed even if all keys exist.

## Owner sequence

Use `release/OWNER_GATE_PACK.md` and `release/EXTERNAL_GATES.json`. First establish domain/hosting/egress ownership and server secret custody, then complete provider and RPC onboarding. Commission independent audit and approved private pentest against the immutable package; obtain counsel review of the factual intake and terms. Assess any later candidate changes separately. Only after verified external evidence exists may the owner consider a separately reviewed release decision, with separate G7 and Swap pilot permissions. No such permissions are requested or issued by this milestone.
