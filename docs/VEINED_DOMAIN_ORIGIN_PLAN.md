# VEINED domain and origin plan — execution closed

`https://veined.xyz` is planned canonical identity, not an asserted live endpoint. `https://api.veined.xyz`
is a possible future API origin only. No DNS, registrar, Vercel project, X or Privy account mutation is authorized
by this local rebrand. No redirects from the unconfirmed old domain are created.

| Legacy key | Desired future meaning / value | Protected | Timing |
| --- | --- | --- | --- |
| OTHERBRIDGE_PUBLIC_ORIGIN | https://veined.xyz | `.env.example` is protected; implementation not protected | Owner verifies domain and deployment first |
| OTHERBRIDGE_PUBLIC_INDEXING | true only for authorized public host | Example protected | Default false; owner release action |
| OTHERBRIDGE_PUBLIC_DEPLOYMENT | Explicit public-release context | Origin/release policy retained | Must not be enabled for local/private preview |
| OTHERBRIDGE_APP_ORIGINS | Exact authorized API browser origins | Authorization code unchanged | Preview explicitly uses http://127.0.0.1:3101 |
| OTHERBRIDGE_TRUST_PROXY_HOPS | Trusted hosting topology | Existing policy unchanged | Owner hosting verification |
| OTHERBRIDGE_SOCIAL_X | https://x.com/veinedxyz, only after account control verification | Example protected | Requires separate OTHERBRIDGE_SOCIAL_X_CONFIRMED=true |
| NEXT_PUBLIC_PRIVY_APP_ID | Owner's verified production app | Existing wallet policy retained | Owner dashboard action; blank in isolated preview |

Metadata uses the planned canonical host without using it as a network destination or API allowlist entry.
Indexing additionally requires explicit public deployment, opt-in indexing and the exact canonical origin.
Local/private preview is noindex, robots disallows all and its sitemap is empty. The future public sitemap excludes
Portfolio, Activity, Settings and any wallet-specific URLs. App pages are always noindex.

Languages use the existing cookie-based negotiation on shared paths. No language-specific URL routes exist;
therefore hreflang URLs are deliberately not fabricated. Canonicals contain neither account addresses nor locale
cookies. CSP, CORS, SSRF, host matching and production release receipt validation retain their accepted semantics.
