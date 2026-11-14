# V1.12 candidate threat additions

| Threat | Control and remaining limit |
| --- | --- |
| Provider alias masquerading as quorum | Static operator classification; state pair and witness must be three distinct groups; opaque backing excluded |
| Quota amplification | Shared Retry-After cooldown, bounded jitter/backoff/budget, no quota range split; public capacity is not guaranteed |
| Finalized fork hidden by fallback | Exact hash mismatch stops without choosing another pair |
| Corrupt/stale cache becoming authority | Bounded checksum envelope, exact event filters, fresh external anchors, full accepted-root accounting replay; local checksums are not authentication |
| Concurrent reads/retry enabling duplicate send | Same-kind single-flight; final waits then rereads; existing expiry and persistent one-shot lock remain |
| Mixed token inbox producing false reserve readiness | Complete global index enumeration; exact token-denominated count/sum; missing non-CROSS event still blocks |
| Image identity substitution / remote active content | Chain+contract or case-exact mint, exact chain catalogue identity, SSRF-safe ingest, sanitizer/local hash paths, no symbol trust |
| Unreviewed source changes | Accepted protected hashes continue failing P20; separate proposal requires review; public execution remains closed |

Previous threat sections remain below. Read-only diagnostic success does not establish release readiness or an independent security audit.

# Threat model V1.9 (current) — Privy external-wallet layer additions

Trust boundary added: the Privy SDK (npm bundle, connect-only), Privy's API (`auth.privy.io`), WalletConnect
(relay/verify/registry) and the user's wallet extensions/apps. None of them is a source of truth for any financial
decision. Details: [PRIVY_SECURITY_BOUNDARY.md](PRIVY_SECURITY_BOUNDARY.md), [WALLET_CONNECTION_ARCHITECTURE.md](WALLET_CONNECTION_ARCHITECTURE.md).

| Threat | Control / limit |
|---|---|
| Malicious wallet extension (fake name/icon, lies in events) | Names/icons are display only (bounded labels, data-URI/bundled icons only); identity = the wallet's own `eth_accounts`, re-read before every financial call; user confirms in the wallet. Residual: an extension already runs in the page |
| Connector impersonation (an extension announcing another wallet's rdns, e.g. the G7 test mock) | Wallet id is never an authorization; G7 authorization is the server-bound EOA; the pilot accepts the test-mock rdns only in fixture mode and refuses it in real mode |
| Wrong active wallet | Only the wallet returned by the user's own connect-modal choice (`onSuccess`) becomes active; Change wallet replaces and revokes |
| Linked-wallet ordering used as signer choice | Privy's list is used only to notice a removed connector; never `wallets[0]` |
| accountChanged race (after review, during bind, during send) | Event → session `connecting` without provider → re-bind to the confirmed account → new epoch; old adapter revoked; `sendCanonicalTransaction` re-reads identity and re-checks revocation after the read; reviews/armed pilot state invalidated |
| chainChanged race (after simulation) | Re-bind with the wallet's chain; adapter chain binding; canonical `chainId` must equal session and live chain; G7 needs 612055 and re-runs the preflight after a switch |
| WalletConnect session confusion (stale/other session) | Same explicit selection and identity bind; removed connector → session cleared; disconnect ends the WalletConnect session through Privy |
| Privy outage / blocked network | 20 s ready timeout and error boundary → *Wallet connection is temporarily unavailable.*; read-only product keeps working; no injected fallback |
| Privy SDK compromise | Exact pin + audited lockfile; connect-only hooks only (scanned); adapter has no generic request; canonical comparison; server one-shot lock; wallet confirmation. Residual: page-level compromise is outside what a client can contain |
| App ID misconfiguration (missing, wrong format, other app) | Validated `^[a-z0-9]{25}$`; missing/invalid → unavailable and strict CSP without third-party origins; dashboard steps in PRIVY_SETUP.md; a wrong app only affects branding/login options, which the client pins to wallet-only |
| Remote wallet icon injection (tracking pixel, SVG script) | Only inline `data:image/*` (rendered in `<img>`, where SVG cannot script) or SDK-bundled components; no `next/image`, no image-host allowlist for wallets |
| Multi-tab signer race (G7) | Server-side exclusive lock file; each tab has its own client epoch; second arm refused; in-memory + sessionStorage guard against a second request in one tab |
| Embedded wallet creation | Config off, embedded/smart accounts refused at normalization, CSP blocks the embedded-wallet iframe |
| Message/SIWE signing during connect | Connect-only API; tests record every wallet method during connection |

---

# Threat model V1.6 (current) — ONEchain → BSC route trust model additions

Evidence: `evidence/otherbridge-v1-6/v16-20261004T190436Z-210476` (security/role-holders.json, security/privileged-path-probes.json, fork-tests/). Execution remains globally disabled; these are the threats a future approved pilot inherits.

| Threat | Control / limit |
|---|---|
| Implementation upgrade on either proxy (single admin EOA `0x22c1…f37c`, no timelock/multisig observable) | Runtime pins of implementation address, implementation/proxy runtime hashes, verifier and token code hashes in `src/g5/route-pins.ts`; any difference → `REVIEW_REQUIRED`, non-executable; `pin()` throws `DEPLOYMENT_CHANGED` first. Residual: a malicious upgrade between a fresh check and a user's signature cannot be prevented by a client (time-of-check/time-of-use); only an operator timelock would close it |
| Validator collusion or key compromise (2-of-3 EOAs, same three on both chains) | Validator set and threshold pinned; change → `REVIEW_REQUIRED`. Residual: two keys can finalize arbitrary payouts up to `deposited`; this is the bridge's trust assumption and is disclosed, not mitigated |
| VERIFIER_ROLE redirecting a pending payout / ADMIN removing a pending obligation | Pending set and pendingAmount reconciled per snapshot; VERIFIER_ROLE and admin sets pinned. Residual: affects only items that went pending (BSC thresholds are disabled; pending occurs on transfer failure or pause) |
| Reserve exhaustion / payout above `deposited` stalling the queue | Spendable = min(balance, deposited) − pending − in-flight (exact semantics); route maximum bounded by it; in-flight enumerated or reserve unverified |
| Stranded payout to a bridge/token contract (CBU-09 legacy) | Self-recipient EOA rule plus server-side `isBridgeContract` guard (`UNSUPPORTED_ACCOUNT`) |
| Fee movement between quote and send (exact msg.value, CBU-11 legacy) | ≤60 s quotes, fee re-read at a pinned block, simulation with the exact value; revert loses gas only |
| RPC poisoning of evidence (single operator for ONE) | Cryptographic binding: recomputed header hashes (Istanbul rule) and receipt-trie Merkle proofs; two ONE hostnames are the same organisation and are labelled so; BSC uses two operators plus archive state |
| Lagging load-balanced backends returning `header not found` | Reads pinned 3 blocks behind head; failures fail closed |

---

# Threat model V1.5 (current) — additions

| Threat | Control / limit |
|---|---|
| A single RPC silently omits, adds or alters logs in a window | Full log-set digest (all bound fields, count and window in the domain) compared with an operationally independent operator; tiebreak by a third independent operator; disputes never commit and unresolved disputes halt the chain; release semantics require consensus for every window. Residual: chains with only one independent operator (Arbitrum, Avalanche today) cannot be release-eligible |
| Same provider behind two hostnames faking independence | Operator groups from the provenance inventory; independence only between two KNOWN, different groups (backing provider key for foundation hostnames); aggregators/relays and unknown operators never witness-eligible. Residual: undisclosed shared backing between two known operators cannot be proven absent; Ink providers share Ink-controlled DNS |
| Unreviewed RPC terms reaching production | Release profile admits only `APPROVED_FOR_RELEASE` with a legal reference; public production defaults to the release profile; unknown deployment markers are treated as production |
| Inline style/script injection | Production CSP without `unsafe-inline`, `style-src-attr 'none'`, nonce + `strict-dynamic`; no inline-style sinks in UI source (guarded by tests and verify-safety) |
| Metrics leaking wallets/keys or attacker-controlled cardinality | Internal token-protected listeners only; label validation and address rejection; per-metric series caps; DB-derived metrics via a role that cannot read keys, usage, snapshots or transfers |
| Backup leaking secrets / restore overwriting data | Backups outside the repository, secret-pattern scan on verify, no plaintext keys stored; restore only into a new uniquely named instance after hash/archive/schema/migration verification |
| Misconfigured public deployment | Startup refusal on memory limiter, missing pseudonym key, weak DB password, non-TLS external DB, bad booleans/markers, metrics without token, invariant deviation |
| Request smuggling / method confusion at the Data API | Node HTTP parser rejects CL/TE conflicts; Host allowlist (421); non-origin-form targets 400; only GET/HEAD; uniform error envelope |

---

# Threat model V1.4 (current) — data plane additions

Trust boundaries added: public RPC endpoints and public chain registries (untrusted), the Otherbridge datastore, the loopback Data API and its API keys. Indexed data can at most nominate candidate tokens; balances are re-read with `balanceOf` at an observed block and never authorize transactions.

| Threat | Control / limit |
|---|---|
| RPC poisoning: wrong chain, fake block, malformed/huge logs | Admission chain-ID probe; chain ID re-checked in every native batch (mismatch → 24 h quarantine); strict log schema (3 topics, 32-byte data, in-range, one hash per block, fork check at window end); same-endpoint header sandwich; two-endpoint canonical-hash consensus; byte/time caps; prototype-key rejection |
| Endpoint behind head or pruned | Head-lag exclusion; header must exist before/after logs; absence from one RPC is never absence on-chain; archive capability recorded |
| Reorg | Canonical hash checkpoints, finality-tag or depth policy per chain, rewind of unfinalized windows only, discovery rebuilt for affected pairs, finalized conflict halts the chain |
| Log duplication / concurrent workers | PK (chain_id, tx_hash, log_index) with ON CONFLICT DO NOTHING; discovery counted from inserted rows only; per-chain lease fencing + contiguous checkpoint enforced in the commit transaction |
| Token metadata attack (XSS, bidi, huge strings) | Bounded ABI/bytes32 decoding, NFKC + control/bidi/zero-width stripping, length caps, suspicious/spam flags, no remote logos/HTML/SVG |
| Remote registry / RPC URL injection | Fixed registry document; URL policy (HTTPS, no IP literals/credentials/query/templates/secret-like paths/blocked suffixes); public-DNS pinning per request; no user-supplied URL or generic RPC proxy |
| API scraping / DoS | API keys, scopes, per-minute/day request and cost-unit limits (atomic Postgres), concurrency slots, pre-charged portfolio cost, page-size caps, handler timeouts, loopback binding; app routes keep exact-origin + limits |
| API key theft / enumeration | 256-bit secret, SHA-256 verifier only, public prefix lookup, uniform 401 for unknown/wrong/revoked keys with equalized verification work, immediate revocation, last-used metadata |
| Wallet privacy | Consent, keyed pseudonyms with TTL, no wallet in usage tables/metric labels/logs, private no-store responses |
| SQL injection | Parameterized tagged templates only; `sql.unsafe` limited to checked-in migration/grant files and validated role passwords |
| Migration data loss | Up-only, checksum-pinned, destructive statements rejected, advisory lock |
| Spoofed X-Forwarded-For / Host | Ignored unless trusted proxy hops are configured; Host must equal the exact allowed origin |

No unhackable or audit-certified claim is made. ONEchain G5 external blockers are unchanged.

---

# Threat model V1.3

Trust boundaries: browser/wallet, Otherbridge server, route protocols, public RPC, portfolio/indexer and TVL data. A compromised data feed can misreport prices or balances; it cannot select a signing contract or create transaction authority. A compromised frontend remains a wallet-phishing threat requiring an independent release review.

| Threat | Control / limit |
|---|---|
| Mutated transaction, spender, amount or recipient | Independently decoded intent comparison; empty runtime registry; write gate closed |
| Stale/replayed quote or delayed identity response | 30-second quote expiry, full binding, generations, abort, replay/capacity rejection |
| Failed/fabricated simulation | Fresh intent/transaction digest and chain/block proof required; trusted future simulator review still required |
| Protocol upgrade, outage, incident | Runtime/implementation hash registry, REVIEW_REQUIRED, scoped kill switches |
| API abuse/SSRF/large body/rebinding | Same-origin/method/schema limits, deadlines, pinned public DNS, fixed host/path/method registry |
| Token XSS/SVG/cache poison | Plain bounded text, strict metadata, local inert logos, no address-specific server cache |
| Misleading portfolio coverage | Partial failures preserve successes, explicit native-only/unsupported/credential scope |
| Fee manipulation/revenue bias | Runtime zero fee, hard ceiling, integer math, quote-bound intent, ranking ignores revenue |
| Dependency compromise | Frozen versions, scripts denied, audit/SBOM/licenses/static scan/pinned CI; known findings remain blockers |
| Address privacy | Consent, no account/analytics/server persistence, private/no-store replies; upstream still sees queries |

No unhackable, guaranteed delivery or audit certification claim is made. ONEchain source/build, spendable-reserve reconciliation and second archive payout proof remain separate external G5 blockers; existing funded read-only simulation stays PASS_READ_ONLY_SIMULATION.


## V1.13 position intelligence boundary

Threats: malicious protocol metadata/vaults, registry compromise, wrong chain/ABI, manipulated/stale prices or oracle, incorrect decomposition/double counting, nested recursion, LP math error, ERC721 ownership reorg, optional API poisoning and account-change races. Controls: pinned official source hashes, exact identities/curated registry and factory validation, pure minimal view ABI, fixed RPC target/calldata capabilities, bounded deadlines/concurrency/index windows, same-block/hash consistency, native risk semantics, positive debt preserved when unpriced, exposure ownership graph, fresh ownerOf over discovery, stale indicator, no external API override, client-scope cache isolation, default no snapshot retention, explicit coverage and no transaction authority. G7 accepted files untouched. Limitations and proof are in DEFI_* docs and V113_TEST_MATRIX.


## V1.15.1 Swap repair boundary

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Swap Intelligence is now the primary read-only /swap product. Current scoped EVM commands/orders and Solana account/pool/economic proofs are described in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md), [SWAP_PROVIDER_MATRIX.md](SWAP_PROVIDER_MATRIX.md), [SWAP_PROVIDER_SOURCE_INVENTORY.md](SWAP_PROVIDER_SOURCE_INVENTORY.md), [SWAP_TRANSACTION_FIREWALL.md](SWAP_TRANSACTION_FIREWALL.md) and [SWAP_INCIDENT_RUNBOOK.md](SWAP_INCIDENT_RUNBOOK.md). A malicious provider cannot supply a signable payload, URL or signing authority; unknown semantics, pinned deployment drift, missing exact economics or stale binding close review. The durable metrics store contains anonymous bounded aggregates only.

Residual trust: public RPC state may be incorrect or stale; simulation is an economic snapshot and does not prove future execution, signature validity, MEV protection, token safety or source-to-bytecode correspondence. Upgrade headers and exact router code pins close known drift, with a remaining time-of-check/time-of-use boundary. Token-2022 economic extensions and unreviewed CPI/hook/order families stay unsupported. API/RPC terms, copyleft/SDK obligations, provider branding, geographic use and privacy notice require LEGAL_REVIEW_REQUIRED references. Local SDK alias/patch security disposition must be reviewed with the raw root and separate production/dev graphs. No external legal/audit/release gate is self-certified. Real execution and Otherbridge fee collection remain closed/zero.
