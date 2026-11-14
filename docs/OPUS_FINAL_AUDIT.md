# Otherbridge V1.4 — full Opus final audit

Date: 2026-10-04. Executor: Claude Opus 5.5. Method: after feature work, the complete active source tree was re-read in four independent read-only passes (A: server/app boundary, adapters, routing, firewall, catalog; B: self-hosted data plane, services, SDK, migrations/grants; C: browser components, wallet/features, storage, i18n, routing client; D: dependencies, lockfile, CI, verification scripts, configs, committed registry data), plus the executor's own review during implementation and the live read-only sample. Every confirmed in-scope issue was repaired, given a regression test where testable, and all gates were re-run. This is local adversarial engineering review, **not an independent audit**; the release gate still requires external reviews.

## Goal questions — answers

| Question | Answer (evidence) |
|---|---|
| Browser → arbitrary server fetch? | No. App routes reach only fixed hosts/paths (publicData, routing-core path set, bridge exact URLs) with public-DNS pinning and no redirects; portfolio RPC targets come only from the admitted registry; the Data API token endpoint no longer issues RPC for arbitrary contracts (B11). |
| Rate-limit bypass? | Spoofed X-Forwarded-For is ignored without trusted proxies; forwarded values are read at the trusted hop (A-7); public production without trusted proxies now fails closed (A-1); Data API per-client minute quota is consumed before scope/cost work and unauthenticated traffic shares a bounded bucket (B4); Postgres limiter is atomic across instances (`pnpm test:db`). |
| API key enumeration? | No: 256-bit secret, prefix lookup, SHA-256 verifier with constant-time compare, dummy verification for unknown prefixes, uniform 401, failed auth now metered (B4). |
| RPC lies corrupting the DB? | Bounded: chain ID per batch and now per indexing endpoint (B9), strict log schema, same-endpoint sandwich, two-endpoint canonical consensus, conservative finality (B7). Residual: an endpoint can omit logs inside a window (documented). |
| Reorg → duplicate/wrong balances? | No: PK on (chain, tx, log), discovery from inserted rows only, rewind of unfinalized windows only with discovery rebuild, refusal beyond inspected depth (B8); balances are always `balanceOf`. |
| Malicious token → XSS? | No HTML sink anywhere; metadata and routing-catalog text sanitized incl. bidi/zero-width (C6); impersonating symbols flagged (B5/C1). |
| Wallet data leak between users? | Account change now clears any late result (C2); no shared portfolio cache; keyed pseudonyms only; usage/metrics carry no wallet. |
| Stale portfolio mutating a quote? | No: `portfolioRevision` is in `quoteBinding`; a revision change closes the review; merged pages keep the oldest observation time (C4). |
| False completeness? | No: COMPLETE requires every chain COMPLETE; failed token phases now report `FAILED`/`TOKEN_READ_INCOMPLETE` (B2); sentinel native balances excluded (`IMPLAUSIBLE_BALANCE`); gas claims only when native was checked (C5); index `current` no longer refreshed by errors (B3). |
| Fee policy changeable by client? | No: frozen zero policy; quotes with a nonzero upstream integrator share are now rejected (A-6). |
| Write gate via environment? | No: frozen `executionGate`, production forces read-only; SimulationGate now enforces the kill policy itself (A-8). |
| Upstream tx payload bypassing firewall? | No: transaction payloads are stripped at normalization; no signer integration exists. |
| Origin/CORS bypass? | No: exact canonical origins, Host must match, no wildcard, invalid config → 503, no CORS headers. |
| Destructive migrations? | No: up-only, checksum-pinned, destructive statements rejected including block-comment obfuscation (B15). |
| Concurrent indexer races? | No: lease fencing and contiguous checkpoint in the commit transaction; promotion of finalized windows now lease-fenced (B7); 8-way lease race tested on Postgres. |
| Integer/JS number corruption? | No: BigInt everywhere for amounts/blocks; cursor block values capped to int8 (B10); Solana lamports must be safe integers (fails closed otherwise). |
| User-controlled chain/token → arbitrary RPC? | No: chain must be in the registry with admitted endpoints; method allowlist; token targets come from the store/universe. |
| Secret in browser bundle? | No: no `NEXT_PUBLIC_*`; build-artifact scan finds no driver/data env/paid host/API key in static chunks; `postgres` is a server external package. |
| Vendor labels in public UI? | No public-brand denylist hit in UI, locales, OpenAPI, docs page or errors. |

## Findings and dispositions

Severity: H high, M medium, L low, I info. Status: FIXED (with regression test unless noted), DOCUMENTED (accepted residual / release gate).

| ID | Sev | Area | Finding | Status / evidence |
|---|---|---|---|---|
| LIVE-1 | M | Portfolio | Gasless-chain RPC sentinel native balance (4242…42) shown as a holding | FIXED: ≥2^128 excluded, `IMPLAUSIBLE_BALANCE` (v14-data test) |
| LIVE-2 | M | Portfolio | Native ERC20 mirror (Metis) double counted | FIXED: identical-balance mirror skipped (v14-data test) |
| LIVE-3 | M | Pricing | Derived prices post-dated the balance read and were discarded (USD always unknown) | FIXED: pricing requested before balances, conservative observedAt (v14-data test; live 39/73 USD known) |
| LIVE-4 | L | Registry | Native symbol "?" for chains outside routing | FIXED: bounded TVL gas symbol (v14-data test) |
| SELF-1 | L | Admission | Probe rejected chains whose precompile balance exceeded 2^64 (Ethereum/BSC) | FIXED: uint256 balance grammar; 155 chains admitted |
| SELF-2 | M | Source | Literal bidi/zero-width characters in sanitizer regex source (Trojan-Source pattern) | FIXED: explicit escapes + static guard test |
| SELF-3 | M | Evidence | `verify-safety` default path overwrote committed historical evidence | FIXED: restored byte-identical; default now `test-results/`; all 9,496 prior evidence hashes verified |
| SELF-4 | L | Ops | `scramVerifier` first version malformed due to shell escaping (roles briefly unusable) | FIXED: validated verifier format; logins verified |
| A-1 | M | Limiter | Shared per-scope buckets without trusted proxy → cross-user starvation in public deployments | FIXED: `TRUST_PROXY_REQUIRED` fail-closed in public production (audit test); scope-wide ceiling documented for loopback |
| A-2 | L | Catalog | Shared refresh bound to first caller's abort signal | FIXED: shared refresh uses its own timeouts |
| A-3 | L | Upstream quota | Client `refresh:true` bypassed caches | FIXED: route-level global allowance (2/min) |
| A-4 | L | Bridge | Responses lacked `Cache-Control: private, no-store` | FIXED (audit test) |
| A-5 | L→M | Body | Per-chunk-only timeout; **and** pre-existing bug: on timeout `cancel()` resolved the pending read as done, returning a truncated body | FIXED: overall deadline, reject-before-cancel, explicit timeout flag (audit test) |
| A-6 | L | Fees | Nonzero upstream integrator share not rejected | FIXED: `PLATFORM_FEE_NONZERO` (audit test) |
| A-7 | L | Origin | Forwarded host/proto read from the first (client-controlled) value | FIXED: trusted-hop position (audit test) |
| A-8 | I | Firewall | Gate did not enforce kill policy itself | FIXED: `assertNotKilled` in `review()`; V1.3 test constructs an open policy explicitly |
| A-9 / C3 | I | Networks page | Portfolio capability still V1.3 (4 chains) | FIXED: derived from data-plane tiers (audit test) |
| A-10 | I | SSRF | 6to4 IPv6 accepted as public | FIXED (audit test) |
| A-11 | I | Headers | No HSTS; `postgres` not marked server-external | FIXED (HSTS max-age; `serverExternalPackages`). CSP `style-src 'unsafe-inline'` remains a release-gate item |
| B1 | M | Balances | One failing Multicall batch abandoned all later candidates (airdrop griefing) | FIXED: bisection with call budget; routed tokens first, indexed-only last (audit test) |
| B2 | M | Coverage | Failed/partial token reads still labelled "Known tokens checked" | FIXED: `tokens: FAILED` / `TOKEN_READ_INCOMPLETE` + UI marker (audit test) |
| B3 | M | API coverage | Error updates refreshed `updated_at`, keeping `current: true` | FIXED (audit test) |
| B4 | M | API quotas | Quota consumed after scope/cost validation; unauthenticated/health not limited | FIXED: minute bucket right after auth; anonymous bucket; cached health (audit tests) |
| B5 / C1 | M | Spoofing | Unrouted token reusing a routed symbol shown as normal and prefilled into Bridge/Swap | FIXED: suspicious+spam, `routable:false` "Unverified token" marker, excluded from `capable` and Bridge prefill (audit test) |
| B6 | M | Health | Transient DNS failure quarantined endpoints for 24 h | FIXED: `DNS_FAILED` normal backoff (audit test) |
| B7 | L | Finality | Lying/early tags could finalize windows; promotion unfenced | FIXED: min(tag, head−depth), lease-fenced promotion (audit test) |
| B8 | L | Reorg | >64 mismatching windows rewound to the start anchor | FIXED: `REWIND_DEPTH_EXCEEDED` halt (audit test) |
| B9 | L | Integrity | No per-window chain-ID check; log omission undetectable | PARTLY FIXED (chain ID per indexing endpoint); omission detection DOCUMENTED residual |
| B10 | L | API | Cursor block > int8 → 500 | FIXED → 400 (audit test) |
| B11 | L | API | Token endpoint steered RPC to arbitrary contracts | FIXED: index/universe only (audit test) |
| B12 | L | DB roles | Indexer could read API verifiers/usage; unused api grant | FIXED: narrowed grants (DB test) |
| B13 | L | Retention | Limiter tables grew without scheduling | FIXED: data-api purges limiter state every 10 min; memory limiter cap documented |
| B14 | L | SDK | Cleartext non-loopback base URL allowed | FIXED (audit test) |
| B15 | I | Misc | Identity scope key-order dependent; block-comment migration bypass; usage vs charged cost; orphaned service child | FIXED (audit tests for scope/migrations; wrapper kills child on exit) |
| C2 | M | UI race | Wallet account change could leave a late previous-wallet result | FIXED: account change clears result in the same effect that invalidates requests (not separately unit-tested; e2e suite covers account flows) |
| C4 | L | UI | Merged pages reported newest observation time | FIXED (audit test) |
| C5 | L | UI | "No native gas" claimed when native was unmeasurable | FIXED (coverage-aware) |
| C6 | L | Spoofing | Routing-catalog symbols/names kept bidi/zero-width controls | FIXED (audit test); longer address in token options |
| C7 | L | UI | Unknown-decimals tokens prefilled | FIXED via `capable` metadataVerified rule |
| C8 | L | UI | Checksum vs lowercase duplicates in token lists | FIXED (case-insensitive EVM dedupe) |
| C9 / C10 | I | UI/a11y | Long amounts overflow; whole card was a live region; "Block" label forced LTR | FIXED (CSS/aria/bdi) |
| D-1 | M | Verification | `verify-safety` lacked V1.4 invariants and data-plane trees | FIXED |
| D-2 | L | Supply chain | Secret/static scan excluded services/packages/infra/tests | FIXED: `scripts/v14-security.mjs` |
| D-3 | L | CI | DB suite not in CI | FIXED: CI generates per-run secrets, starts the loopback stack, migrates, runs `test:db` |
| D-4 / D-5 | L | Docs/config | Missing dependency repair record; `.env.example` lacked V1.4 variables | FIXED |
| D-6 / D-7 | L | Production smoke | Recorded removed `broadCoverage`; DB mode not recorded | FIXED (`production-v13.mjs` fields; `production-v14.mjs` records store mode) |
| D-8 | I | RPC terms | Keyless public endpoints of commercial RPC operators admitted | DOCUMENTED: provenance + terms review before production traffic |
| D-9 | I | CLI | Key printed to redirected stdout | FIXED: requires TTY or explicit `--stdout-json` |
| D-10 | L | DB | Role passwords sent in plaintext SQL | FIXED: client-computed SCRAM-SHA-256 verifier |
| D-11 | I | node_modules | Orphan store dirs in the working copy | DOCUMENTED: clean frozen reproduction is the artifact proof |

## Unresolved / residual (honest)

- Log omission inside an indexed window by a single dishonest endpoint is not detected (no second-endpoint log-count/bloom check yet); impact is limited to missed discovery, never wrong balances.
- Shared endpoint health means one user's upstream 429 briefly affects others; per-endpoint quarantine is 30 s.
- Without a configured pseudonym key, continuation cursors do not survive process restarts (development only).
- CSP still allows inline styles; HSTS preload/includeSubDomains, monitoring, IAM/secret manager, managed DB TLS, external penetration test and legal review remain release-gate items.
- Third-party public RPC endpoints' terms of service have not been legally reviewed.
- The dev-only high advisory is removed from the graph via a tested override; the override must be revisited when `@next/eslint-plugin-next` changes.
- i18n observation (pre-existing, preserved): nine accepted V1.2 locale files carry stray U+200B zero-width spaces in existing strings (for example `faq.1a` in ja/zh-CN/zh-TW, `errors.QUOTE_EXPIRED` in zh-TW); counts are byte-identical to the V1.3 review bundle. They are not code and contain no directional overrides (the release scanner fails on overrides/isolates in locale JSON), so they were left for editorial review rather than rewritten. Persian (fa) uses U+200C ZWNJ as normal orthography, including in the new V1.4 strings.
