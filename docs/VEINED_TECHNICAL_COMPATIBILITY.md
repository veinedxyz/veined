# VEINED technical compatibility

Presentation changes do not rename stable interfaces. No database schema migration or package publication.

| Retained identity | Reason |
| --- | --- |
| Repository / private package `otherbridge` | Existing tooling and lockfile identity |
| `@otherbridge/data-client`, `OtherbridgeDataClient` | Existing SDK package/import/export contract |
| `/api/*`, `/v1/*`, `/swap`, `/bridge`, `/portfolio`, `/docs` | Stable route and API contracts |
| `x-otherbridge`, `otherbridge-onebridge`, curated source IDs | Machine-readable provider/schema evidence |
| `otherbridge.locale`, `otherbridge.language`, `otherbridge.theme` | Persisted preferences survive upgrade |
| `otherbridge:*` imports, history, performance marks/events | Existing saved state, listeners and metric consumers |
| `OTHERBRIDGE_*` / `NEXT_PUBLIC_PRIVY_APP_ID` | Security/configuration contract; no blind key migration |
| DB tables, roles, migration IDs, API key prefix and hashes | Storage/authentication compatibility |
| G7 policy IDs, historical RC IDs, evidence paths | Immutable trust chain |
| Visible `Otherbridge G7` technical label in the isolated pilot build only | Preserves the accepted pilot identity and its protected header assertion; VEINED remains the primary wordmark. The normal production-public artifact has no pilot label. |
| `/og/otherbridge-og.png` | Existing image URL retained, now serves provisional VEINED artwork |

The active protected pointer, 107 protected hashes and both dependency locks remain authoritative and unchanged.
Financial accounting, portfolio scan priorities, DeFi normalization, quote comparison, simulation, firewall,
provider permissions, receipt validation and fee policy are outside the rebrand edit scope.
Exact UI assertion strings change to the new identity; their behavioural checks and timeouts remain intact.
