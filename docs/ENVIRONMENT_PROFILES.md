# Environment profiles

| Profile | Configuration | Allowed operation |
|---|---|---|
| development | NODE_ENV=development; deployment local/unset | Loopback read-only tooling |
| test | NODE_ENV=test; local fixture services | Deterministic doubles, isolated forks, no real wallet |
| staging-equivalent | NODE_ENV=production; deployment staging with non-public origins | Local/private production build, TLS equivalent, durable DB limits |
| production | OTHERBRIDGE_DEPLOYMENT_ENV=production | Startup requires exact release config/evidence, legal-approved RPCs and production secret namespace; execution still CLOSED |

OTHERBRIDGE_PUBLIC_DEPLOYMENT=true cannot bypass production controls by naming a public origin staging. The existing RPC registry enforces non-public staging hosts. Production uses exact https://otherbridge.io app/API origin, one process per provider key/egress budget, pinned provider paths, reviewed router/program hashes and mandatory evidence. Scaling needs separately reviewed shared quota allocation.

Schemas are generated from src/release/config.ts and receipt.ts. No usable production config or owner approval receipt is generated. Production refuses localhost, placeholder/test secrets, unknown endpoints, unapproved RPC, invalid pins or missing evidence. Startup is integrated into Next instrumentation and the Data API service. Normal public-build tests remain local staging-equivalent. A receipt never alters frozen execution constants.
