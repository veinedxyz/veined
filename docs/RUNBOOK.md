# V1.14 global DeFi universe — current

Details: `docs/DEFI_UNIVERSE.md`, `docs/V114_TEST_MATRIX.md`. Everything is read-only; there is no wallet, signing, approve/permit, broadcast, deploy or fee.

- Catalog sync: `pnpm defi:universe:sync` (allowed hosts only, bounded size/gzip; parity, alias and anomaly checks). A rejected sync does not change the last good catalog; to accept the reviewed code, use `--accept-review=CODE`. Dry run `--dry-run`; fixture `--fixture <dir> --out <dir>`; evidence `--evidence <dir>`.
- Reports: `pnpm defi:universe:report` (adapter queue, coverage, networks, source/license inventory).
- Database: `pnpm data:db:migrate` (0005, forward-only), `pnpm defi:sync` (reviewed deployment registry), `pnpm defi:universe:load` (accepted catalog, idempotent).
- Registry lane backfill (e.g. Morpho): `OTHERBRIDGE_DEFI_LOG_RPC_1=<izinli https log kaynağı> node --env-file=.env.data.local --experimental-transform-types --import ./scripts/ts-hooks.mjs services/defi.ts lane morpho-blue-1 markets` (re-runnable, reorg-safe; a record is not considered complete without `historical_complete`).
- Real nonzero proofs: `pnpm defi:proofs --only=<id> --out=<benzersiz kanıt dizini>` (two independent endpoints, no personal identity).
- A new adapter is added only via a literal address from an official source or a recorded on-chain derivation (`src/defi/sources/`, `scripts/defi-registry.mjs`); a catalog change cannot unlock financial logic.

---

# V1.5 pre-release hardening — current

First read `OTHERBRIDGE_V1_HANDOFF.md`, `docs/V15_TEST_MATRIX.md` and `docs/SECURITY_RELEASE_GATE.md`. The V1.4 commands below remain valid; V1.5 additions:

- Indexer witness policy: `pnpm data:indexer:run --witness required` (release semantics; if there is no independent witness, no commit, `WITNESS_UNAVAILABLE`) or the default `best-effort` (development only; windows without a witness are marked as `NO_INDEPENDENT_WITNESS` and are not considered release-eligible). An invalid value is rejected at startup.
- Disagreement: the chain becomes `HALTED` (`LOG_CONSENSUS_UNRESOLVED:from-to`); do not delete/edit the data. After review, `pnpm data:indexer:resume --chain <id> --reason "<gerekçe>" --yes`. Details: `docs/RUNBOOK_INDEXER_INCIDENT.md`, `docs/RUNBOOK_RPC_INCIDENT.md`.
- Re-verifying old (pre-V1.5) windows: `pnpm data:indexer:rewitness --chain <id>`; backward backfill: `pnpm data:indexer:backfill --chain <id> --max-windows N`.
- `pnpm data:verify-index` now reports integrity/eligibility (FULL_INDEXED_RELEASE_ELIGIBLE / FULL_INDEXED_DEVELOPMENT and the blocker list); `pnpm data:rpc:provenance` shows the RPC operator/terms inventory and the profile acceptance (`development`/`staging`/`release`).
- Monitoring: `pnpm data:ops-exporter` (monitor role, internal port, token required); Prometheus/Alertmanager/Grafana local profile `infra/monitoring/` (`docs/RUNBOOK_MONITORING.md`). `/v1/metrics` was removed from the public API.
- Backup: `pnpm data:backup:create|verify|list|prune|restore-test|corruption-test|drill-cleanup` (backups are outside the repo; restore only to a new isolated instance; prune defaults to dry-run). Details: `docs/RUNBOOK_BACKUP_RESTORE.md`.
- Staging-equivalent local stack: `node scripts/staging.mjs init|up|down|status` (`docs/RUNBOOK_STAGING.md`); smoke `node scripts/v15-staging-smoke.mjs`. This is not a production deploy; DNS does not change.
- CSP acceptance: `node scripts/v15-csp.mjs` after `pnpm build`; security/adversarial: `node scripts/v15-security.mjs`.

There is no real signing/approve/permit/broadcast/deploy/fee; G7 and production release are closed without approval; ONEchain G5 BLOCKED_EXTERNAL_EVIDENCE.

---

# V1.4 self-hosted data plane — current

There is no paid portfolio/indexer API. Local isolated PostgreSQL (Docker, 127.0.0.1:55471 only): `pnpm data:db:init` (generates random passwords into the git-ignored `.env.data.local`; does not print the values), `pnpm data:db:up`, `pnpm data:db:migrate` (up-only, checksum, safe to re-run; roles with a SCRAM verifier), `pnpm data:chains:sync`, `pnpm data:rpc:sync --write-snapshot` (candidate → URL policy → public DNS → chainId → read-only probe), `pnpm data:rpc:health --measure-logs`, `pnpm data:tokens:sync`, `pnpm data:indexer:once [--chain id]` / `pnpm data:indexer:run --cycles N` (lease + graceful shutdown), `pnpm data:coverage`, `pnpm data:verify-index` (exit≠0 on inconsistency), `pnpm data:verify`, `pnpm data:retention`.

Local developer API (not published, billing off): `pnpm data:api:dev` → http://127.0.0.1:3200/v1/docs. Key: `pnpm data:client:create --name ... --plan internal --scopes chains:read,...`, `pnpm data:key:create --client cli_... --yes` (the secret value goes to the terminal only once; redirected stdout requires `--stdout-json` and the target must be outside the repo), `pnpm data:key:revoke --key ...`, `pnpm data:usage:show --client ...`. Test: `pnpm test:db` (creates and deletes a temporary database). Production smoke: `node --env-file=.env.data.local scripts/production-v14.mjs` (`pnpm build` first; unique OTHERBRIDGE_EVIDENCE_ROOT). Give every run a unique evidence directory; `verify-safety` no longer overwrites old evidence by default. Do not touch another project's container/port/process; to stop: `pnpm data:db:stop`.

There is no real signing/approve/permit/broadcast/deploy/fee; G7 and production release are closed without approval.

---

# Multichain read-only local check — current

First read the current handoff and the MULTICHAIN_TEST_MATRIX.md file. Node 24.18.0, pnpm 11.25.0; `pnpm install --frozen-lockfile`, `pnpm dev` (3100). `pnpm build` / `pnpm start` (3101) is a loopback preview only. No real .env/key is required; the example values keep submission closed. Do not stop another application's port process.

The network selector reads the live public catalog. Select Ethereum/Base or another distinct mainnet pair, two assets from the real catalog, a positive amount and public addresses in the native VM format. 'Read route' is only an API quote observation; it is not a connected wallet, balance/allowance sufficiency or execution permission. Change the context in the form and verify that the old review is closed. ONE-specific routes are closed under G5; no-route/stale/rate-limit show an explicit error. Activity records previews only; an external hash observation requires a current, context-bound provider response and does not persist completion on reload.

Give every run a unique OTHERBRIDGE_EVIDENCE_ROOT. `node scripts/repair-run.mjs check-name ...` records source/hash/Git/raw log. **The wrapper check-name must not be the same as the JSON basename written by the subcommand** (e.g. bounded-probe for the probe; do not use the name live-readonly or reproducibility). `pnpm exec vitest run --config scripts/live-routing.vitest.config.ts` makes at most seven public GETs; the test runner passing does not mean M9 PASS: read the gate and the real quote record in live-readonly.json. API availability can change at any moment; there is no automatic quote retry.

`pnpm networks:sync`, under the same unique evidence requirement, produces a new hashed asset/source/diff. It does not delete existing logos or custom records and does not commit/deploy. SVG metadata is not loaded as an arbitrary URL. Normal acceptance: verify, test:e2e, production-smoke.mjs, production-multichain.mjs; each production runner shuts down its own loopback child. reproduce.mjs now also copies public assets into the new isolated dependency tree.

M11 NOT_RUN — USER_APPROVAL_REQUIRED; M12 BLOCKED — RELEASE_APPROVAL_REQUIRED. At the end of this milestone, do not start real execution, G7, release, V2/V3 or a new phase. The earlier R1 runbook below represents the historical native acceptance boundaries.

---

# Local use and manual acceptance

First read the `OTHERBRIDGE_V1_HANDOFF.md` and `evidence/otherbridge-v1/repair-r1/acceptance-c/commands.json` files. Normal mode `pnpm dev` (127.0.0.1:3100), production preview `pnpm build; pnpm start` (127.0.0.1:3101). This command is not a production deploy. If the port is in use, do not kill another project; verify your own process identity.

Test mode `pnpm dev:test` may be used only in development. Do not run test automation with a real wallet/active user profile. Playwright creates its own isolated context/provider. The source balance/quote unavailable screen is not a real zero. Do not fill an unknown reserve/fee with zero.

Normal error: diagnose → smallest repair → relevant test → regression → evidence. To avoid overwriting old evidence, choose a new `OTHERBRIDGE_EVIDENCE_ROOT` for every run; the wrapper `node scripts/repair-run.mjs unique-name ...` records HEAD/source SHA-256/command/log/exit code. The E2E JSON, screenshot and output directory are directed to the same unique root. The old `pnpm verify:live-readonly` is a G5 BLOCKED exit2 report. The new real reader probe `pnpm exec vitest run --config scripts/live-native.vitest.config.ts` runs opt-in only with a separate evidence directory; do not interpret its PASS as quote/G5 readiness.

## When the user returns — the executor did not perform these steps

1. The diff/evidence is reviewed independently. The current native ONE deployment/implementation/ABI, fee/min/max/pause, spendable reserve, source-event/destination payout relationship and finality policy are verified. A generic ABI or token balance alone is not sufficient.
2. If needed, the user configures their own public provider/project IDs. No seed/private key is shared. A single verified integration between the SDK and the direct path is maintained.
3. The source-build and spendable reserve evidence for the read-only native quote/simulation/tracker path connected in R1 is completed; after that, the closed write boundary is prepared for a separate security and user acceptance review. **Setting the existing flag to true does not open submission; this handover is not ready for live transfer.**
4. The user connects their own real wallet themselves. EOA/smart account support, source/same BSC recipient, balance and gas are checked. A CEX address is not used as the recipient.
5. A separate explicit approval is given for a small amount above the current minimum; the user performs the review and wallet approval themselves. There is no fixed/unsupported acceptance amount.
6. The source event/index, the receipts/finality on both chains, and the correct BSC token/recipient/amount are verified together. If anything is pending/held/unknown, there is no repeated automatic submission/refund/claim. No large balance is moved.
7. A single successful manual test is not public release approval. Hosting/domain/DNS/legal/commercial conditions and independent review are assessed separately.

`MAINNET_E2E: NOT_RUN — USER_APPROVAL_REQUIRED`. `PUBLIC_RELEASE: BLOCKED — RELEASE_APPROVAL_REQUIRED`.

R1 manual recovery: a hashless mainnet record is not a trusted rejection after reload. Preserve it and inspect wallet history yourself. If a source transaction hash exists, enter it in the Activity detail hash recovery field; this saves only a candidate and reruns read-only source/destination validation. It never signs, retries, deletes the intent or claims delivery without proof. If no hash/proof is available, uncertainty stays blocked; no automatic unlock. Existing known source hashes cannot be overwritten by this field.
# Public copy regression

For a copy-only repair, preserve the provider/dependency versions, all route keys, financial values, wallet VM behavior and the false/null execution gate. Product labels use `src/content/public-labels.ts`; technical dependency names and licenses remain in `docs/INTERNAL/THIRD_PARTY_NOTICES.md`, package/import records and raw evidence.

With a fresh unique `OTHERBRIDGE_EVIDENCE_ROOT`, run `node scripts/public-brand-check.mjs` for all normal public Markdown docs. This intentionally excludes only technical/legal internal records, raw evidence, dependency/import files and original user instructions. Brand detection is case insensitive and recognizes brand tokens; ordinary Turkish words such as "teklifi" are not a vendor identity.

Run unit/integration/E2E/build and both existing production smoke runners in separate unique evidence directories. Production runners check full `document.body.textContent` and save raw text receipts. The multichain runner requires an actual salt-read-only Ethereum→Base review, captures both languages and preserves actual quote response bodies. A missing real quote blocks that acceptance; a synthetic fixture cannot replace it. No signing wallet is required. Inspect the new screenshot, verify source hashes, update the handoff and create a new review bundle without altering earlier evidence.

## V1.2 verification

Read G5_FINAL_EVIDENCE.md before interpreting a probe result. A passing observer test is not G5 readiness. Preserve the exact build/reserve/archive/current-simulation blocker and keep production writes closed.

Use a fresh OTHERBRIDGE_EVIDENCE_ROOT for every repair/retest. Run frozen install, pnpm verify, pnpm test:e2e, the existing production-smoke and production-multichain runners, and production-i18n.mjs against the final production build. The i18n schema check is part of build. E2E fixtures label synthetic quotes and cannot establish live liquidity; the production routing runner retains actual ETH→Base response evidence. Check all 24 SSR locale pages, seven representative languages in both themes at 360/390/768/1440, and AR/FA/HE/UR selector/review/detail behavior at 360/1440. Save raw axe/browser/text receipts and screenshots, inspect them, bind final source hashes and verify a new safe ZIP CRC/SHA-256.

The SSR locale cookie takes precedence over the legacy local preference. For deterministic tests seed both consistently. Unsupported preferences resolve through Accept-Language and English; missing dictionary keys never fall back. In the header or Settings use the searchable native-name selector; selected locale persists on reload. Decimal input accepts the supported local separator or safe ASCII point; grouping and ambiguous values are rejected. See I18N_ARCHITECTURE.md and I18N_TEST_MATRIX.md for complete contracts and known editorial limits.
