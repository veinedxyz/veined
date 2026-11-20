# VEINED — engineering history (archived README, English translation)

> **Archive.** This file is the repository README as it was at commit `97736f0623bc0d249e1f2b8a976b162212b1a6e0`
> (2026-11-14), before the README was rewritten in English for the NEAR Hackathon. The sections that were written in
> **Turkish** are given below in a faithful **English translation**. Dates, hashes, identifiers, statuses, commands,
> paths and results are unchanged, and the English sections are unchanged. The original text is preserved in Git
> history: [README.md at 97736f06](https://github.com/veinedxyz/veined/blob/97736f0623bc0d249e1f2b8a976b162212b1a6e0/README.md).
> It is a historical engineering record: milestone names (Otherbridge V1 … V1.18), statuses and file references are
> those of their time, and some links point to internal files that are **not part of this public repository** (for
> example `OTHERBRIDGE_V1_HANDOFF.md`, `release/OWNER_GATE_PACK.md`, `evidence/…`). The current description is
> [README.md](README.md).

---

# VEINED — Multichain Portfolio, Swap & Bridge

## VEINED Guardian (NEAR HACKATHON, AI Security & Defense)

Guardian is VEINED's intelligence and defense layer. It reads an action before it is signed and returns
**ALLOW / WARN / ESCALATE / BLOCK** with reasons and a safe path. It covers swaps, bridges, NEAR transactions,
NEP-366 meta transactions, NEP-413 messages and AI-agent proposals. Verdicts come from deterministic rules and
carry a reproducible digest.

Built on NEAR:

- NEAR Intents: dry quotes toward NEAR
- NEAR accounts and access keys, with on-chain checks
- Chain Signatures: a request is prepared only after Guardian allows the action
- NEAR AI Cloud: optional TEE narration

**Team:** solo project by **Coinisan** (team size 1). NEAR payout account `veined.near`; `veinedxyz.near` is a test account. AI coding assistants were used during development (allowed by the rules, Q-005); the developer reviewed, tested and is responsible for the code.

Start with [HACKATHON.md](HACKATHON.md). It has run steps, a do X → see Y demo, the API and tests. Then read
[architecture](docs/guardian/ARCHITECTURE.md) and the [submission draft](docs/guardian/SUBMISSION.md).

Current public candidate identity: **VEINED**. Historical engineering identity: Otherbridge.
Local development review only; production execution stays **CLOSED**, platform fee **0 bps**.

Discover wallet assets and supported DeFi positions, compare swap quotes, discover bridge routes,
and explore network coverage. Coverage and execution limits remain visible in the product.

The planned domain is `veined.xyz`; this is not a live-origin or ownership verification.
X: [@Veinedxyz](https://x.com/Veinedxyz). The wordmark and text icons are provisional; final assets, legal clearance,
production origin/Privy setup, independent audit and release approval remain owner actions.

Local preview: `node scripts/v118-preview.mjs build`, then `node scripts/v118-preview.mjs start`.
Open http://127.0.0.1:3101 and stop with Ctrl+C. See [V1.18 implementation](docs/V118_REBRAND_IMPLEMENTATION.md),
[brand identity](docs/VEINED_BRAND_CANONICAL.md), [compatibility](docs/VEINED_TECHNICAL_COMPATIBILITY.md)
and [test matrix](docs/V118_TEST_MATRIX.md). API routes, SDK identifiers, storage keys and protected source remain stable.

## Historical engineering archive (V1.0–V1.17)

The following original README is preserved verbatim for release continuity. Its milestone statuses,
product name and capability descriptions are historical; use the V1.18 documents for the current candidate.

<!-- BEGIN V117 CURRENT -->

# Otherbridge V1.17 external gate closure — EXECUTION_CLOSED

Current owner packet: release/OWNER_GATE_PACK.md and release/EXTERNAL_GATES.json. See docs/V117_EXTERNAL_GATE_CLOSURE.md for provider, domain/Privy/hosting/RPC/Whirlpool and independent audit/pentest/legal handoffs. All16 V1.16 blocker IDs are preserved; no external approval or production release is self-certified. Final acceptance/checkpoint/test/ZIP results are generated in evidence/otherbridge-v1-17/20261015T175758204Z-8120f0/final/FINAL_REPORT_TR.md after verification. Commands: pnpm release:credentials:check and pnpm release:external-gates (expected incomplete exit2).

The immutable V1.16 audit base and packages remain referenced by hash. Protected107 unchanged; no rebaseline. Execution CLOSED, global kill ON, fee0bps. Real wallet/signature/approval/permit/broadcast/deploy/fee and DNS mutations remain0. Earlier milestone records below remain preserved.
<!-- END V117 CURRENT -->

---

<!-- BEGIN V116 CURRENT -->

# Otherbridge V1.16 release candidate — EXECUTION_CLOSED

Current candidate: OTHERBRIDGE_RC_V1_16_20261015T133159055Z-16dfa3. Authoritative status is generated after complete verification in evidence/otherbridge-v1-16/20261015T133159055Z-16dfa3/final/FINAL_REPORT_TR.md and release/FINAL_GATE_STATUS.json. See docs/V116_RELEASE_CANDIDATE.md, audit/AUDITOR_REPRODUCTION.md and OWNER_RELEASE_ACTIONS.md. Neither this source document nor prior milestone status constitutes production permission. Final source/build and archive manifests bind the exact candidate. Historical records below remain preserved.

107 protected files and accepted pointer are unchanged; no owner rebaseline. Execution CLOSED, global kill ON, fee 0 bps. Real wallet prompts/signatures/approvals/permits/broadcasts/deploys/fees remain zero. Independent audit, legal approval, domain/dashboard control and production credentials remain external.
<!-- END V116 CURRENT -->

---

# Otherbridge V1.11 — product completion (current)

V1.14.1 DeFi scan performance and coverage hardening (read-only): [report and document index](docs/V1141_DEFI_PERFORMANCE_HARDENING.md) · [performance](docs/DEFI_PERFORMANCE.md) · [request budget](docs/DEFI_REQUEST_BUDGET.md) · [cache policy](docs/DEFI_CACHE_POLICY.md) · [test matrix](docs/V1141_TEST_MATRIX.md).

Product flow: **find assets → understand coverage → bridge → swap**. New routes: `/` public landing page, `/docs`
public documentation (EN + TR canonical), the application starts at `/bridge` (`/swap`, `/portfolio`, `/activity`,
`/networks`, `/help` are kept). Network environments (mainnet/testnet) were separated, a canonical chain identity
registry and a unified asset registry (full network + contract; a symbol is never an identity) were added, the
portfolio scans the connected wallet automatically and read-only (curated balance scan with verified Multicall3), and
G7 BSC reads use the shared finalized pin of two independent operators. Sending is closed; there is no real
signature/approval/broadcast/deploy/fee collection.

Report: docs/V111_PRODUCT_COMPLETION.md · test matrix: docs/V111_TEST_MATRIX.md · G7: docs/G7_RPC_CONSENSUS_RELIABILITY.md ·
registries: docs/CHAIN_IDENTITY_COVERAGE.md, docs/ASSET_REGISTRY.md, docs/ASSET_PROVENANCE.md · portfolio:
docs/PORTFOLIO_DISCOVERY_COVERAGE.md · landing/docs: docs/LANDING_ARCHITECTURE.md, docs/PUBLIC_DOCS_ARCHITECTURE.md.

Registry synchronization (read-only, server-side only): `pnpm assets:sync:all` (or individually `assets:sync:chains`,
`:trustwallet`, `:routing`, `:coingecko`, `:dexscreener`, `:onebridge`), then `pnpm assets:build`,
`pnpm assets:verify`, `pnpm assets:coverage`. Documentation: `pnpm docs:build` / `pnpm docs:check`. G7 dry acceptance:
`pnpm g7:dry-acceptance --sessions 10 --pause-ms 45000 --family <evidence-alt-dizini>` (wallet sending is suppressed).
Optional environment variables (hidden/noindex when undefined): `OTHERBRIDGE_PUBLIC_ORIGIN`, `OTHERBRIDGE_PUBLIC_INDEXING`,
`OTHERBRIDGE_SOCIAL_X|GITHUB|TELEGRAM|DISCORD`, `OTHERBRIDGE_DOCS_URL`, `OTHERBRIDGE_STATUS_URL`; for synchronization
`COINGECKO_API_KEY`/`COINGECKO_API_PLAN` (not required). Not production ready.

---

# Otherbridge V1.4 — self-hosted data plane (current)

The portfolio now uses Otherbridge's own data plane: vetted RPC registry + health, ERC20 indexer (reorg-safe checkpoint), PostgreSQL store, versioned read-only `/v1` Data API (local, not published, billing closed). The paid portfolio key and the 40-network limit were removed; an unchecked network is never counted as empty. Architecture: docs/DATA_PLANE_ARCHITECTURE.md; coverage: docs/PORTFOLIO_COVERAGE.md; operation: docs/RUNBOOK.md; audit: docs/OPUS_FINAL_AUDIT.md; test matrix: docs/V14_TEST_MATRIX.md. Without the data plane the UI keeps working (DEGRADED/UNAVAILABLE is shown explicitly).

---

# Current multichain review

The Otherbridge multichain foundation is in read-only review scope. Sending/sign/approve/broadcast/deploy are closed, ONEbridge G5 BLOCKED. The existing V1/R1 application is preserved. The current checkpoint and all real results are in OTHERBRIDGE_V1_HANDOFF.md; the dynamic network/route architecture is in docs/MULTICHAIN_ARCHITECTURE.md and the test matrix in docs/MULTICHAIN_TEST_MATRIX.md.

Setup: Node 24 + pnpm 11.25.0, `pnpm install --frozen-lockfile`, `pnpm dev` (127.0.0.1:3100). Production preview `pnpm build`, `pnpm start` (3101); this is not a deploy. No real .env or API key is needed. The catalog comes from live public chain/tool/connection data; ONE is kept as a special adapter. The network selector has search/recent networks/real local logos and a user-initiated quote read with addresses matching the VM format. A connection/quote is not execution permission.

Verification: `pnpm verify`, `pnpm test:e2e`; for dedicated production smoke/asset sync/live-readonly runs, follow the unique evidence directory instruction in docs/RUNBOOK.md. Old evidence files belong to historical checkpoints; they are not presented as a new run.

---

# Otherbridge V1

An independent, external-wallet-focused local application for ONEchain native ONE → BSC canonical CROSS. **Live sending is closed; integration verification BLOCKED.** Local scenarios are synthetic, not live settlement evidence.

## Wallet connection (V1.9 — Privy, external wallets only, connect-only)

"Connect wallet" opens Privy's external wallet modal (MetaMask, Rabby, Phantom EVM, Coinbase Wallet, WalletConnect and
other EIP-6963 extensions). No signature is requested when connecting; email/social login and the embedded wallet are
closed. Privy is only the connection layer: route, amount, recipient, firewall, fee and execution policy are
Otherbridge's. To enable it, add `NEXT_PUBLIC_PRIVY_APP_ID=<25 karakter>` to `.env.local` ([PRIVY_SETUP](docs/PRIVY_SETUP.md)); without an
App ID the product runs read-only and shows "Wallet connection is temporarily unavailable." — there is no fallback to
an injected provider. Architecture: [WALLET_CONNECTION_ARCHITECTURE](docs/WALLET_CONNECTION_ARCHITECTURE.md), data flow:
[PRIVY_DATA_FLOW](docs/PRIVY_DATA_FLOW.md), security boundary: [PRIVY_SECURITY_BOUNDARY](docs/PRIVY_SECURITY_BOUNDARY.md).

## Running

Verified with Node 24.18.0 and pnpm 11.25.0. Dependencies are locked to exact versions with a single lockfile.

```powershell
pnpm install --frozen-lockfile
pnpm dev
# http://127.0.0.1:3100 — mainnet-readonly
```

```powershell
pnpm dev:test
# Separate synthetic local-test mode. Do not connect a real wallet.
pnpm build
pnpm start
# http://127.0.0.1:3101 — production build, local preview only
```

The production build always uses mainnet-readonly. `OTHERBRIDGE_MODE=local-test` or the enable flag does not open fixtures/sending in production. R1 connects read-only quote/simulation, limits/health and the two-chain observers to the real API path; the sending lock is closed. The source-build match and the spendable reserve are not counted as verified. An env toggle alone is not sufficient.

## Verification

```powershell
pnpm verify
pnpm test:e2e
node scripts/verify.mjs
node scripts/reproduce.mjs
node scripts/production-smoke.mjs
pnpm verify:live-readonly
```

E2E starts and stops its own 3100 loopback test server. If the port is used by another application, do not stop that application. If needed, Playwright Chromium can be installed with `pnpm exec playwright install chromium`. The tests use a separate browser context and a synthetic provider; they do not access the user profile. The in-memory EVM test uses no private key, signer, RPC or deployment.

`verify:live-readonly` returns **exit 2** because G5 does not fully pass, and it produces evidence. This result is not turned into a local suite failure, nor presented as a live success. `scripts/verify.mjs` records every command with a separate exit code/log.

## Implemented surfaces

Bridge, wallet selection, native amount/fee/MAX, review, two-chain tracking, Activity/detail, safe import/export, Networks, Help, Risk/About and Settings. TR/EN and light/dark theme. CEX/DEX use is explained as a separate transaction belonging to the user. No arbitrary recipient, reverse bridge, social login, analytics, gas top-up or swap engine.

Mainnet completion is observed only through the related source calldata/event, the canonical receipt/finalized tag and the BSC bridge event + a single canonical CROSS Transfer log. The public history API provides only a limited hint for the destination hash. A storage/import success claim is not trusted without fresh evidence. R1 evidence is under `evidence/otherbridge-v1/repair-r1/`; the old 81+4+8 test evidence at the root is preserved as a historical run. The local test module runs only in the development server's controlled fixture branch; production access is blocked by a test.

Starting points: [handoff](OTHERBRIDGE_V1_HANDOFF.md), [architecture](docs/ARCHITECTURE.md), [sources](docs/SOURCES.md), [security](docs/SECURITY.md), [runbook](docs/RUNBOOK.md), [test matrix](docs/TEST_MATRIX.md). V1 is not release/mainnet-ready or audited.

# V1.3 review milestone

Active TVL catalog, wallet-held Portfolio, balance-priority Bridge/Swap selectors, same-chain Swap, route alternatives, zero-enabled platform fee policy and isolated security foundation are implemented. Financial execution remains disabled. Broad live token portfolio needs a server credential; native fallback and synthetic coverage tests are supplied. See [V1.3 test matrix](docs/V13_TEST_MATRIX.md), [Portfolio coverage](docs/PORTFOLIO_COVERAGE.md), [security release gate](docs/SECURITY_RELEASE_GATE.md) and the current handoff. ONEchain G5 and production release remain blocked. Accepted historical documentation follows.

## V1.15.1 Swap completion / repair

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Canonical /swap now uses provider-neutral progressive comparison, current scoped EVM/Solana transaction economic review, exact Solana mint import, bounded refresh/cancellation and durable anonymous health. Source pins, supported families, tests and honest external/engineering gates: [V1.15.1 repair dossier](docs/V1151_SWAP_COMPLETION_REPAIR.md). Real execution remains closed. Both frozen dependency graphs and the reviewed provider SDK patch are required.
