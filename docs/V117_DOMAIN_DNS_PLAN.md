# V1.17 domain observations and unapplied DNS plan

Status: **OWNER_INPUT_DOMAIN_CONTROL / ownership UNKNOWN / EXECUTION_CLOSED**. Observed 2026-10-15 UTC; exact timestamps and response digests are in `evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/domain/domain-readonly.json`. This document authorizes no purchase, registration, DNS change, certificate issuance or deployment.

Google Public DNS returned NXDOMAIN (DNS status 3) for apex A, AAAA, NS, SOA, CAA, DS and DNSKEY, and for www/api A, AAAA and CNAME. Cloudflare returned NXDOMAIN for apex A, NS and DS. All observed AD flags were false. The negative responses contain .io SOA authority data; that is not an Otherbridge zone SOA. No active Otherbridge zone, DS chain or certificate restriction was established. These observations do not prove availability, ownership or account control.

The current [IANA RDAP bootstrap](https://data.iana.org/rdap/dns.json) has no .io RDAP service entry; the public rdap.org fallback returned HTTP 403. Registration/availability is therefore **UNCONFIRMED**, rather than available. [IANA's .io delegation](https://www.iana.org/domains/root/db/io.html) identifies the registry and `whois.nic.io`; it does not identify this project's owner. [ICANN Lookup](https://lookup.icann.org/en/lookup?name=otherbridge.io) is an owner-accessible public lookup reference, not an ownership receipt.

| Gate field | Exact action |
|---|---|
| ID/category/status | `OWNER_INPUT_DOMAIN_CONTROL` / `DOMAIN_CONTROL` / `OWNER_INPUT_REQUIRED` |
| Owner action | Confirm the registrar name, DNS provider name and that the owner controls both accounts for `otherbridge.io`. |
| Exact website | Open the registrar and DNS-provider account URLs the owner identifies; public reference: https://lookup.icann.org/en/lookup?name=otherbridge.io . The account URLs cannot be inferred from NXDOMAIN. |
| Secret? | No. Do not send passwords, tokens, recovery codes, session cookies or account exports. |
| Configure/validate | Supply a dated, redacted account-control confirmation naming the domain, registrar and DNS provider; independently compare the domain/zone shown in both consoles. No DNS challenge is requested. |
| Blocks/evidence | Production origin ownership and any future DNS/TLS activation; retain only the confirmation/reference and account URLs. No ownership claim until that evidence is reviewed. |

The following records are a proposal for a separately approved future change. TTL 300 seconds is proposed for initial activation; a stable-zone TTL may be raised later. `<...>` values are deliberately non-resolving placeholders, not instructions to apply a zone.

| Name | Proposed record | Target/value | Purpose |
|---|---|---|---|
| `otherbridge.io` | A; optional AAAA | `<APP_INGRESS_IPV4>`; `<APP_INGRESS_IPV6>` only after IPv6 ingress passes the same controls | Canonical `https://otherbridge.io`; hostnames supplied by a managed platform may instead require that platform's documented apex ALIAS/ANAME/flattening. Never put an apex CNAME beside SOA/NS. |
| `www.otherbridge.io` | CNAME | `otherbridge.io.` | TLS-valid ingress issues HTTP 308 to `https://otherbridge.io`, preserving a validated relative path/query and never accepting an arbitrary redirect target. |
| `api.otherbridge.io` | A/AAAA or CNAME, one chosen model | `<API_INGRESS_IPV4>` / optional `<API_INGRESS_IPV6>` or `<OWNER_SELECTED_API_INGRESS_HOSTNAME>.` | Authenticated developer Data API `/v1`; PostgreSQL and metrics are never public DNS targets. |
| `otherbridge.io` | CAA | `0 issue "<SELECTED_CA_CAA_ISSUER>"`; `0 issuewild ";"` if no wildcard certificate is used | Owner selects the actual ACME CA first; add only that CA's documented issuer identifier. Do not apply the placeholder. |
| Delegation | NS/SOA + DNSKEY; DS at registrar if supported | `<OWNER_CONFIRMED_AUTHORITATIVE_DNS>` and provider-generated DS | Recommend DNSSEC with a documented rollover/recovery procedure. Match provider DS exactly, verify the chain, and avoid stale DS on a provider move. |

TLS must cover apex, www and api before activation; the staging internal CA is not a production certificate. Preserve `Strict-Transport-Security: max-age=31536000`; `includeSubDomains` and preload require a separate decision after every subdomain is HTTPS-ready. No preload submission is made. [Cloudflare's DNSSEC guide](https://developers.cloudflare.com/dns/dnssec/) is a current example of provider signing plus registrar DS configuration, not a choice of DNS vendor.

The browser app and its `/api/*` stay at the same origin, `https://otherbridge.io`. Set `OTHERBRIDGE_APP_ORIGINS=https://otherbridge.io`, `OTHERBRIDGE_DEPLOYMENT_ENV=production` and `OTHERBRIDGE_PUBLIC_DEPLOYMENT=true` only in a future approved host configuration. The separate Data API ingress uses `OTHERBRIDGE_DATA_API_HOSTS=api.otherbridge.io`, API-key auth, and no credentialed CORS. The browser must not start calling `https://api.otherbridge.io` merely because this DNS name exists. Preserve the exact trusted proxy hop count after verifying the ingress topology.

Privy receives the canonical app origin only after `OWNER_INPUT_PRIVY_PRODUCTION` is satisfied; www redirects before loading wallet UI. Keep the existing nonce CSP and exact Privy/WalletConnect origins in `src/proxy.ts`; its browser `connect-src 'self'` already covers the app API. Provider HTTPS/WSS calls stay server-side; do not add provider credentials or provider domains to browser CSP. api origin is not a Privy login origin.

Future validation after separate DNS/deploy authorization: compare authoritative and two recursive resolver results for every record; validate TLS chain/SAN/expiry at all three hosts; verify www 308 and canonical exact-origin rejection/forwarded-header behavior; inspect HSTS/CSP; verify api `/v1/health`, unauthorized 401, scope and rate limits; verify PostgreSQL/metrics have no public listener; verify DS/DNSKEY validation and renewal/rollback. Expected evidence: redacted zone diff, DNS/TLS/header receipts, origin tests and change approver reference. Current counts: DNS mutations **0**, public deploys **0**.
