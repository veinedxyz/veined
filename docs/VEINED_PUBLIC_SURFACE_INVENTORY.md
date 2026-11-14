# VEINED public surface inventory

Machine-readable before/after occurrence inventories live in the V1.18 run's `brand-inventory/` directory.
The scan covers tracked and untracked active source, public assets, configuration, documentation, tests and
vendor snapshots. Separate preflight/final preservation receipts hash all pre-existing evidence and release records.

| Surface | Implementation / disposition |
| --- | --- |
| Landing, navigation, footer | Shared typed brand; old bridge emblem removed; existing charcoal/sage layout retained |
| Portfolio, Swap, Bridge, Explore, Activity, Networks, Help, Settings | Shared application shell and 24 locale dictionaries |
| Wallet notices, review dialogs, loading, empty/error states | Existing translation keys retained; product name replaced in values |
| Docs | Canonical EN/TR Markdown uses `{{BRAND}}`; generated module rebuilt |
| SEO | Shared complete OG/Twitter metadata avoids nested metadata inheritance loss |
| Icons / OG / manifest | Provisional text assets; legacy OG URL serves current provisional artwork |
| Data API docs / OpenAPI | Human-readable title/description migrated; schema and extension names retained |
| README / SDK | Current VEINED introduction; clearly labelled original README archive and stable SDK identifiers |

Eight inventory categories: CURRENT_PUBLIC_BRAND, PUBLIC_METADATA, PUBLIC_DOCUMENTATION,
FUTURE_PRODUCTION_CONFIGURATION, INTERNAL_COMPATIBILITY_IDENTIFIER, G7_PROTECTED,
IMMUTABLE_HISTORICAL_EVIDENCE, EXTERNAL_VENDOR_REFERENCE. Empty categories are valid.
Remaining names in source comments, storage/events, schemas, fixtures, environment keys and package IDs are
technical compatibility, not user-facing labels. Prior V1.0–V1.17 reports, protected files, original goal files and
audit packages retain their original engineering identity. Existing `docs/` engineering reports remain historical;
the actual current product documentation is `content/docs/` and the new VEINED/V118 documents.

One deliberate visible compatibility exception exists only in the separate, gated G7 local-pilot artifact:
`Otherbridge G7` labels the historical technical pilot alongside the primary VEINED wordmark. Its accepted protected
header assertion and complete financial test stay unchanged. The normal production-public build and final local
VEINED preview never render this label. This is not a public secondary brand or a renamed G7 authorization.

The README's original bytes are preserved after an explicit historical-archive marker. No previous audit is
relabeled as a VEINED audit. Public browser text, titles, accessible navigation names and assets are tested separately
from the source scanner; source classifications alone do not establish visual acceptance.
