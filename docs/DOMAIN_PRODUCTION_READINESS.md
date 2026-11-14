# Domain production readiness

Intended domain: otherbridge.io. Ownership and registrar control are UNCONFIRMED; OWNER_INPUT_DOMAIN_CONTROL is required. Read-only Google DNS observations on 2026-10-15 returned NXDOMAIN (status 3) for apex/www A, AAAA, CNAME, NS, CAA and DS. This does not prove the domain is unowned or available. Exact receipts: evidence/otherbridge-v1-16/20261015T133159055Z-16dfa3/sources/domain-readonly.json.

| Item | State / proposed contract |
|---|---|
| Registrar / DNS provider | Owner must identify and prove control |
| Canonical origin | https://otherbridge.io; not activated |
| www | Owner-approved 308 to canonical apex, after TLS; not configured |
| API origin | Same-origin https://otherbridge.io; no arbitrary credentialed origin |
| TLS | Not provisioned; local rehearsal uses internal CA only |
| Privy | Owner must allow canonical production origin |
| CSP | Exact source policy in src/proxy.ts |
| HSTS | max-age=31536000; no preload submission or guessed subdomain policy |
| CAA / DNSSEC | No usable records observed; owner/provider configuration required |

DNS mutations=0. Public deploys=0. No domain purchase, registration, ownership claim or DNS change is part of this milestone.
