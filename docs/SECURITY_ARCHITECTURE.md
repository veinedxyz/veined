# V1.12 candidate security additions

Two BSC state operators plus a third exact-hash log operator remain mandatory. Static endpoints and method allowlists are unchanged. A shared cooldown is availability metadata, never a vote. Corrupt/malformed/forked evidence fails closed. Public checkpoint checksums do not establish authenticity: fresh external anchors and accepted-baseline ledger replay precede every delta. Global mixed-token inbox indices remain complete; only exact reserve-token obligations enter its sum. Final freshness and one-shot owner/account/chain locks are unchanged. The data plane imports no pilot runtime. See [architecture](G7_RPC_WITNESS_ARCHITECTURE.md) and [ledger](G7_INCREMENTAL_LEDGER.md). The original 99-file protected baseline still blocks these changes at P20; the separate 105-file proposal is not accepted or active. No new signing path or real write was exercised.

# Security foundation V1.9 (current) — Privy connect-only wallet layer

V1.5 and earlier controls below remain. V1.9 replaces the raw injected wallet connection (EIP-6963 discovery,
`window.ethereum` fallback, `eth_requestAccounts`) with Privy external wallets in connect-only mode: (1) Privy
`@privy-io/react-auth@3.47.0` (exact pin) is loaded lazily after the first *Connect wallet* click and used only
through `PrivyProvider`, `useConnectWallet`, `useWallets`, `usePrivy` (ready) and `useModalStatus`; (2) one
normalized session store for every surface, explicit active wallet, EVM boundary, embedded/smart accounts refused;
(3) a single `WalletProviderAdapter` with read/connection allowlist, trusted chain registry and one gated
`sendCanonicalTransaction` that compares the canonical server transaction and the wallet request on
`chainId, from, to, value, data, gas, maxFeePerGas, maxPriorityFeePerGas` and sends the frozen canonical values;
(4) per-epoch adapters revoked on any identity change; (5) CSP exact Privy/WalletConnect origins only when an App ID
is configured, production styles by nonce plus one pinned SDK SVG style hash, the embedded-wallet iframe blocked;
(6) no fallback when Privy is missing or down. The production execution gate, write registry, global kill, fee
policy and G7 one-shot lock are unchanged; the G7 pilot reaches the wallet only through the adapter. Real
signatures/approvals/permits/broadcasts/deploys/fees remain zero. Local engineering review, not an independent
audit. Details: [WALLET_CONNECTION_ARCHITECTURE.md](WALLET_CONNECTION_ARCHITECTURE.md),
[PRIVY_SECURITY_BOUNDARY.md](PRIVY_SECURITY_BOUNDARY.md), [PRIVY_DATA_FLOW.md](PRIVY_DATA_FLOW.md).

---

# Security foundation V1.5 (current)

V1.4 and V1.3 controls below remain. V1.5 adds: (1) **independent log-set witness consensus** for indexed windows — full normalized log-set digests compared across operationally independent operators, 2-of-3 tiebreak, unresolved disputes halt the chain, release semantics (`--witness required`) never commit unwitnessed windows (`docs/INDEXER_LOG_CONSENSUS.md`); (2) **strict production CSP** without `unsafe-inline` for scripts or styles, `style-src-attr 'none'`, generated same-origin network-theme classes, CSSOM-only virtual-list geometry, hash-pinned Data API docs stylesheet (`docs/CSP_HARDENING.md`); (3) **internal-only monitoring** — `/v1/metrics` removed from the public API; token-protected internal listeners; bounded-cardinality registry; frozen security invariants exported as gauges; 21 validated alert rules (`docs/MONITORING_ARCHITECTURE.md`); (4) **least-privilege monitor and backup roles**, append-only witness evidence for the indexer; (5) **configuration schema** that refuses weak/default DB passwords and non-TLS external databases in public mode, non-exact booleans, unknown deployment markers and any security-invariant deviation; (6) **RPC provenance/terms inventory** and a release profile that admits only legally approved endpoints (none today); (7) firewall simulation proofs bound to the exact registry entry (`REGISTRY_DRIFT`) and to state at/after its verification block (`SIMULATION_BLOCK_MISMATCH`) (`docs/TRANSACTION_FIREWALL_SPEC.md`); (8) Data API refuses non-GET/HEAD methods and non-origin-form targets before request construction, and maps datastore outages to 503. Real signatures/approvals/permits/broadcasts/deploys/fees remain zero; the execution gate is frozen closed and the global kill ON. This is local engineering hardening, not an independent audit.

---

# Security foundation V1.4 (current)

V1.3 controls below remain. V1.4 adds: (1) a shared exact-origin policy for all browser app API routes (`OTHERBRIDGE_APP_ORIGINS`, no wildcards, Host must match, forwarded headers trusted only with `OTHERBRIDGE_TRUST_PROXY_HOPS`, malformed configuration fails closed with 503); (2) a `RateLimiter` interface with a deterministic memory limiter and an atomic PostgreSQL limiter (multi-instance tested), keyed by scope and — only behind trusted proxies — hashed client IP; production public deployments that require durable protection fail closed; (3) developer API authentication by hashed API keys and scopes, separate from browser Origin, CORS disabled; (4) RPC admission, pinned-DNS read-only transport and method allowlist for the data plane; (5) Trojan-Source guard (no literal bidi/zero-width controls in executable source). Real signatures/approvals/broadcasts/deploys/fees remain zero; the execution gate is still frozen false/null and the global kill ON.

---

# Security foundation V1.3

The product holds no principal, reserve or user signing key. Seed phrases and server signing do not exist. The frozen production gate remains false/null; the new global execution kill is ON. Future contract registry is empty. Read-only quote/catalog/portfolio features do not authorize wallet writes.

The transaction firewall validates a normalized quote intent and independently decoded transaction, comparing chain/from/contract/value/selector/input token/amount/output token/minimum/recipient/spender/approval amount/platform fee. The decoder is a trusted reviewed adapter, never upstream-supplied decoded data. A future contract entry must match verified runtime and implementation hashes, provenance and verification block/time. Drift moves the route to REVIEW_REQUIRED.

SimulationGate requires successful fresh block-bound simulation/read proof matching both intent and transaction digests. Quote expiry, replay and capacity fail closed. Production has no registry/decoder/sign integration, so the test foundation cannot produce a real signature. Approval review defaults to bounded input amount, current allowance detection and short deadline. No unlimited or blind Permit/Permit2 path is implemented.

Kill policy covers global/chain/provider/protocol/token/spender. Backend transport uses fixed HTTPS hosts/paths, public-DNS validation and pinning, no redirects, JSON MIME, byte/deadline limits and read-only RPC methods. API schemas/methods, same-origin loopback guard, bounded body, rate limits, no-store private responses, sanitized errors and existing CSP/security headers remain enforced. No generic URL proxy or wildcard private CORS exists.

Portfolio metadata/prices are untrusted display data. Local-only logos, spam filtering, strict schemas and address/chain binding prevent executable token metadata. Pattern/static scans, immutable lockfile, SBOM/license/lifecycle inventory and pinned CI are review evidence, not an independent audit. SECURITY_RELEASE_GATE.md lists the separate production requirements.


## V1.13 position intelligence boundary

Threats: malicious protocol metadata/vaults, registry compromise, wrong chain/ABI, manipulated/stale prices or oracle, incorrect decomposition/double counting, nested recursion, LP math error, ERC721 ownership reorg, optional API poisoning and account-change races. Controls: pinned official source hashes, exact identities/curated registry and factory validation, pure minimal view ABI, fixed RPC target/calldata capabilities, bounded deadlines/concurrency/index windows, same-block/hash consistency, native risk semantics, positive debt preserved when unpriced, exposure ownership graph, fresh ownerOf over discovery, stale indicator, no external API override, client-scope cache isolation, default no snapshot retention, explicit coverage and no transaction authority. G7 accepted files untouched. Limitations and proof are in DEFI_* docs and V113_TEST_MATRIX.


## V1.15.1 Swap repair boundary

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Swap Intelligence is now the primary read-only /swap product. Current scoped EVM commands/orders and Solana account/pool/economic proofs are described in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md), [SWAP_PROVIDER_MATRIX.md](SWAP_PROVIDER_MATRIX.md), [SWAP_PROVIDER_SOURCE_INVENTORY.md](SWAP_PROVIDER_SOURCE_INVENTORY.md), [SWAP_TRANSACTION_FIREWALL.md](SWAP_TRANSACTION_FIREWALL.md) and [SWAP_INCIDENT_RUNBOOK.md](SWAP_INCIDENT_RUNBOOK.md). A malicious provider cannot supply a signable payload, URL or signing authority; unknown semantics, pinned deployment drift, missing exact economics or stale binding close review. The durable metrics store contains anonymous bounded aggregates only.

Residual trust: public RPC state may be incorrect or stale; simulation is an economic snapshot and does not prove future execution, signature validity, MEV protection, token safety or source-to-bytecode correspondence. Upgrade headers and exact router code pins close known drift, with a remaining time-of-check/time-of-use boundary. Token-2022 economic extensions and unreviewed CPI/hook/order families stay unsupported. API/RPC terms, copyleft/SDK obligations, provider branding, geographic use and privacy notice require LEGAL_REVIEW_REQUIRED references. Local SDK alias/patch security disposition must be reviewed with the raw root and separate production/dev graphs. No external legal/audit/release gate is self-certified. Real execution and Otherbridge fee collection remain closed/zero.
