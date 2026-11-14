# VEINED V1.20 release candidate

Candidate identity: `VEINED_RC_V1_20_20261025T110040038Z`.

This is a candidate for owner brand review and subsequent external audit. Production execution remains **CLOSED**. Owner selection of Quiet Current is open; the recommended integration is not owner or trademark approval.

## Bound source and evidence

The accepted starting source checkpoint is `f5b41238f2a8ca31e12090e8481f527c2294288309c2013c85ff59623c588e4b`. The final source digest and complete per-file manifest are recorded under `evidence/veined-v1-20/20261025T110040038Z/final/source-checkpoint.json`. Keeping the digest in the evidence avoids a self-referential source hash. The E2E runtime/test digest, production preview build digest and complete frozen digest are recorded separately with their scopes; they must not be presented as interchangeable hashes.

The active 107-file G7 baseline is `evidence/otherbridge-v1-12-1/owner-security-20261014T140240767Z/preflight/protected-hashes.json`, SHA-256 `cf7025aeeedac022b8ffa08540ed88345e561d23b50f05ae794f3f5dec1991b4`. Its pointer, content and protected sources are preserved.

Historical references remain immutable:

- V1.16: `release/candidate.json` and `docs/V116_RELEASE_CANDIDATE.md`.
- V1.17: `.otherbridge/v117-evidence-path.txt` and the V117 external-gate documents.
- V1.18: `.otherbridge/v118-evidence-path.txt`, `docs/V118_REBRAND_IMPLEMENTATION.md` and `docs/V118_TEST_MATRIX.md`.
- V1.19: `.otherbridge/v119-evidence-path.txt`, accepted source checkpoint above, atmospheric artwork and the original failure/performance evidence.

The V1.20 candidate record lives in the new evidence directory; it does not overwrite the historical `release/candidate.json`.

## Review contents

Three original native-vector systems, editable geometry/masters, 89 production exports, a local gallery and the recommended Quiet Current integration are included. The four VEINED brand documents define colors, typography, clear space, minimum size and incorrect usage. `V120_PERFORMANCE_REPAIR.md`, `V120_E2E_STABILITY.md` and `V120_TEST_MATRIX.md` explain the engineering changes and verification. Before/after images, raw performance samples, failed attempts, financial equivalence, protected verification and measured final status are retained in this run.

The archive `VEINED_V1_20_BRAND_IDENTITY_RELEASE_CANDIDATE_REVIEW_BUNDLE.zip` is a **verified source-delta supplement to the exact accepted V1.19 checkpoint**, plus V1.20 evidence. It is not a standalone clone. The original source copy and full frozen working directory stay local; large Playwright traces remain in local failure directories and are excluded from the review ZIP, while compact failure reports remain included. Historical giant ZIPs, environment files, dependencies, browser sessions and credentials are excluded. `ENTRY_SHA256.json` records each payload entry, and the adjacent `ZIP_VERIFICATION.json` records the archive and manifest hashes, CRC, duplicate and secret checks.

## Local review

- Product: `http://127.0.0.1:3121/`
- Overview: `http://127.0.0.1:3121/app`
- Brand comparison: `http://127.0.0.1:3121/assets/veined/brand/review.html`
- Restart a verified existing preview: `node scripts/v120-preview.mjs start`.
- If runtime source changes, rebuild first with `node scripts/v120-preview.mjs build`.

The preview uses an isolated production build with no copied environment files or production credentials and no active Privy app ID. It is local-only.

## External decisions

The existing 16-action inventory in `release/EXTERNAL_GATES.json` remains external and is copied into this run for review. Its recorded state is not a new DNS, hosting, account-control or independent-audit verification. Owner brand selection, trademark/legal review, provider credentials/commercial RPC, domain/DNS custody, Privy/hosting configuration, external security audit and pentest remain separate release decisions. `@veinedxyz` is planned and unconfirmed; no active social-profile link was introduced.

Only if every required engineering gate passes may the measured final status be `READY_FOR_OWNER_BRAND_APPROVAL / EXECUTION_CLOSED`. Any unresolved performance, functional, security, stability or reproduction failure requires `RETURN_FOR_REPAIR`. No public deployment, DNS change, real wallet action, signature, approval/Permit, broadcast, token transfer, fee collection, commit, push or G7 rebaseline is authorized or performed in this milestone.
