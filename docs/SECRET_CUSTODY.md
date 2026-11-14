# Secret custody

The deployment-neutral interface is environment injection from an owner-controlled secret namespace at process start. No cloud secret manager is selected. Never place secrets in build arguments, NEXT_PUBLIC_ variables, next.config env, git, review ZIPs, shell command arguments, logs or screenshots.

| Class | Values | Custody |
|---|---|---|
| Public | Chain IDs, routers/programs, public URLs, intentionally public Privy App ID | Reviewed config/source; no wallet authority |
| Server secret | Provider keys, Titan token, DB role passwords/URLs, pseudonym HMAC key, monitoring auth, future webhook secret | Separate production/staging namespaces; least-privilege operator injection |
| Never requested | Wallet seed/private key | Never handled by Otherbridge |

Production config checks reject short/placeholder/test/staging provider secrets, public-secret variables, unapproved endpoint/RPC and missing release evidence. Secret provenance cannot be inferred from random-looking bytes: the owner must provision dedicated production keys and a production namespace. Only credential-presence booleans enter evidence.

Rotation: enable affected provider kill; revoke at vendor; create least-privilege replacement in the same environment; update secret reference; restart instances; run read-only preflight; inspect redacted health metrics; keep kill enabled if validation fails. Rotate DB roles without copying owner credentials into the API role. Pseudonym-key rotation changes linkage and requires documented data-retention handling. Monitoring/webhook keys follow independent rotation. Preserve only redacted incident evidence, invalidate the RC if integrity was affected, and obtain a new owner decision before any future execution.

Log boundary: structured fields redact tokens, authorization, headers, cookies, raw transactions, request/response bodies and DB URLs; wallet addresses are removed. Upstream exceptions are reduced to fixed error enums. Titan uses the V1.15.1 bounded redacting transport. See tests/unit/v116-release.test.ts and tests/unit/v1151-titan-transport.test.ts.

Backup encryption keys stay outside both repository and backup directory. The local test restore uses synthetic/public-chain data only. Production backup access, retention and key custody must be selected with hosting.
