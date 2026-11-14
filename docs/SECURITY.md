# Threat model and review readiness

This work is not an independent audit. G6 is ready for local review; the G5 live route blocker and the G7/G8 approval gates are maintained.

| Threat | Control | Evidence |
|---|---|---|
| Wrong token/chain/recipient, quote/payload change | Fixed one-way registry, same EOA address, bigint, quote expiry, ABI decode/exact payload | domain A/M/Q tests |
| Router/proxy/ABI drift | Active registry null; generic ABI documented only, live submission closed | S01, production smoke, live-readonly |
| False API success/payout/batch/index | Source event identity and dual receipt/payout correlation; held/reorg re-evaluation | flow T01–T09 |
| Smart/delegated account | Code observation on both networks, nonempty code is blocked; it is acknowledged that getCode is not a complete classification | W06; live account compatibility is a separate gate |
| Fake provider, icon/XSS | UUID/provider selection/dedup; no authority granted to rdns; icon is never rendered, no raw HTML | W01/X03 E2E |
| Duplicate/uncertain broadcast | Web Locks; unresolved intent check; unknown on hash loss, no automatic retry | lifecycle S03/S04, storage concurrency |
| Account/chain race | Cancellation of stale quote/balance via generation; last-moment provider accounts/chain check | W03 E2E/S05 domain |
| SSRF/private IP/rebinding/redirect | Static URLs, public DNS check and pinned lookup, redirects are not followed | X01 transport/server tests |
| RPC write/large response | Typed read-only method+param allowlist, 1 MB response, 16 KB body, 8s DNS/HTTP, 120 requests/min; 3×20 history and 1000-block log limit | S02/X02 |
| History poisoning/privacy | Strict schema/size, import+mainnet completion untrusted; rejection of unknown secret fields; diagnostics redacted by default | P02/P03/X04 |
| Web injection | Nonce script CSP, no eval production, self connect, frame/object/base restrictions, no-referrer, nosniff | production browser smoke/CSP |
| Math/MAX/gas | Base units bigint, ambiguous commas rejected, bounded conservative MAX, separate gas budget; no msg.value padding | M01–M06/G01 |

The R1 contract-specific observer verifies the source calldata/event identity, the canonical receipt/finalized tag, and the related destination event + single CROSS Transfer payment evidence. Revert/held is interpreted only after identity and canonical status; a batch log with the same amount is not shared. The public status API and storage/import success are not sufficient. Quote/health does not count source-build and spendable reserve as verified. The wallet write API was not called during this work; the mainnet submission boundary is closed by the registry null condition, independently of env/API flags and claimed verified deployment. No unauthorized signing/approve/permit, V2 topup/V3 swap.

## Dependency and license

Exact versions are in `package.json`, the resolution in `pnpm-lock.yaml`. The SDK is not installed; metadata MIT. `bridge-contracts` README MIT; no third-party Solidity code was vendored. The test Solidity fixture was written in this project for synthetic purposes. The brand mark is an original inline SVG; system fonts are used.

`dependency-licenses.json` records the licenses of the installed packages (including the legacy `licenses` field). The `unrs-resolver` postinstall was reviewed and was not run; lint succeeds with the optional prebuilt binary. The exact-version release-age exclusion list that pnpm added during installation covers only the locked, selected packages; auth/OS security controls were not relaxed. Future dependency changes must be reviewed again.

Initial audit: GHSA-7c78-jf6q-g5cm high for solc→tmp 0.2.6. Fixed with a targeted `solc>tmp: 0.2.7` override and a retest; no force audit fix/ignore was performed. Final audit: 0 findings. ESLint 9.39.5 is dev-only and deprecated upstream; the compatible version was kept because the Next lint plugin peer range does not yet accept ESLint 10. This information was not hidden; after an upgrade, peer/type/lint must be checked again.

The style CSP allows inline CSS; the script CSP uses a nonce. Browser localStorage is not encrypted or attacker-proof; no private key/session/signature is stored. Analytics is off. Public RPC services can see query information. The emergency write lock does not close the tracking/reading screens. Public release requires an independent code/protocol review.

## V1.2 locale and reserve boundaries

All 24 shipped dictionaries must match the canonical schema and interpolation placeholders; rich HTML is rejected and translations remain local assets. Unknown provider/status codes produce safe localized messages. Locale selection persists only the supported locale ID. Technical addresses, hashes and chain IDs remain unchanged LTR isolates.

Localized amount input is normalized before BigInt conversion. Grouping, whitespace/NBSP, bidi controls, exponent/sign syntax, mixed separators, ambiguous comma grouping and excessive precision fail closed. Displayed grouped amounts never feed financial state or MAX. UI fee labels are localized without changing provider financial amounts or mandatory protocol names.

The explicit ReserveEvidence model remains verified=false because exact deployment builds and a complete spendable-ledger reconciliation are unavailable. A custody/accounting bound cannot authorize a transfer. Mainnet submission registry and production false/null write gate remain closed. No G7, funds, signing, approval, broadcast, deployment or V2/V3 scope was authorized.
