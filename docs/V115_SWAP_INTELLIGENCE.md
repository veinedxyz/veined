> Historical V1.15 RETURN_FOR_REPAIR record. Current implementation and gates are in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md) and [V1151_TEST_MATRIX.md](V1151_TEST_MATRIX.md). The frozen V1.15 evidence remains unchanged.

# V1.15 Swap intelligence candidate
Candidate status: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. This is an implementation review package, not production readiness or an independent audit.

The optional **DEX provider preview** on /swap queries independent route sources for Ethereum, BNB Chain, Base and Solana. The accepted Swap surface remains the default until the gaps below are closed. Portfolio, Bridge, wallet connection, global DeFi discovery and the 107-file G7 baseline retain their accepted behavior.

Implemented: strict bigint intent/quote models, bounded concurrent provider lanes, progressive NDJSON, short single-flight cache, ranking, sticky selection, freshness, chain-specific routers, canonical restricted EVM builds and calldata validation, independent pool attribution and RPC simulation, Permit2 binding model, structural Solana decoding, compact preview UI, mutation and browser tests. Every execution capability is false. No provider payload or unsigned transaction is passed to the wallet layer.

Blocking engineering gaps: complete V4/Infinity/split EVM command decoders; current PCSX V3/V4 and UniswapX economic order support; full Jupiter/Titan DEX instruction, token-account and delta proof; Solana mint import; 22 new locale translations (EN/TR authored; other locales retain English preview text); primary Swap migration; durable distributed provider health; comprehensive fork and all-provider hostile fixture coverage. SDK network cancellation and remaining dependency advisories need further hardening. A credential alone does not resolve these gaps.

Evidence root: evidence/otherbridge-v1-15/v115-20261014T062452187Z-6252bb. Final gate results, checkpoint and archive verification are in final/ and release-readiness/. See SWAP_PROVIDER_MATRIX.md and V115_TEST_MATRIX.md for supported subsets. Live evidence uses an unfunded public test address: failed simulations are failures, never acceptance passes.

Setup: run pnpm install --frozen-lockfile --ignore-scripts, then pnpm swap:deps. The isolated swap-providers/ graph has its own frozen lock and disabled install scripts. The root lock is G7-protected and byte-identical to preflight. The clean reproduction script installs both graphs. Do not enable execution or deploy this candidate.

Titan SDK logging gate: official SDK 0.1.6 can print untrusted packet/error bodies. The default real connection is therefore blocked with BUILD_REVIEW_REQUIRED even with valid credentials, pending an isolated redacting transport. Injected synthetic clients retain stream/filter/reconnect coverage. This is an engineering blocker, not a credential-only limitation.
