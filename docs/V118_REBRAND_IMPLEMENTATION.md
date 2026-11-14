# V1.18 rebrand implementation

VEINED is the current public candidate identity; Otherbridge is the preserved historical engineering identity.
This is a local development supplement to the accepted V1.16 RC and V1.17 owner packet, not a new audit result.

Changes: typed brand identity, common navigation/footer/404, 24 locale resource values, EN/TR current product docs,
app page titles, complete canonical/OG/Twitter metadata, manifest, provisional typography assets, API documentation
display text, SDK description and current README introduction. The accepted V1.15.1 Swap interface and technical
routes remain in place. Public indexing and X links gain explicit separate gates; origin authorization is unchanged.

## Repeatable local preview

From `D:\Projeler\otherbridge` with the accepted Node/pnpm environment:

```powershell
node scripts/v118-preview.mjs build
node scripts/v118-preview.mjs start
```

Open http://127.0.0.1:3101. Stop with Ctrl+C in that terminal. The launcher copies only inventoried source into
`.otherbridge/v118-preview`, installs both frozen lockfiles and builds with sanitized environment variables.
Private environment files, production credentials and wallet sessions are not copied. Privy App ID is blank,
indexing is off and API origins explicitly allow only this loopback address. Read-only data may use accepted
public providers; browser acceptance uses synthetic replay where transaction review needs data. No real wallet
connection is needed. A changed source checkpoint requires rebuilding the preview.

Provider dependencies use a fresh project-local pnpm store. The existing machine-wide cache had Windows Hidden
attributes on SDK files, which prevent Node's patch writer from opening them with `w` (EPERM). A clean store fixes
the installation without changing either lockfile, the reviewed patch, pnpm version or dependency graph.

The evidence root is recorded in `.otherbridge/v118-evidence-path.txt`. It contains original source and historical
hashes, classified inventories, failed attempts, repaired tests, production browser screenshots, performance,
frozen reproduction, final checkpoint and acceptance report. Review ZIP packaging excludes private environment,
dependencies, caches, wallet sessions, traces and prior archives.

No commit, push, public deployment, production account change or security rebaseline is performed.
The final report must use READY_FOR_OWNER_BRAND_REVIEW only after every development gate passes; otherwise
RETURN_FOR_REPAIR. Production execution stays CLOSED in both cases.
