# Portfolio V1.4 (self-hosted data)

Portfolio means native and fungible tokens held at public wallet addresses. It excludes decoded lending, staking, vault, LP positions and NFTs. Receipt tokens remain tokens; no underlying position is inferred.

Browser → `/api/portfolio` (exact-origin guard, durable/memory limiter, bounded body, consent) → in-process Otherbridge `DataPlane` → `SelfHostedPortfolioProvider` (+ the V1.3 direct native provider as a degraded fallback). No API key reaches the browser and no paid portfolio/indexer API is called. The provider-neutral `PortfolioProvider` contract is retained and extended with optional `describe`, `unscannable`, `scanChain` and `status`.

`scanPortfolio` schedules **every** discovered chain (the V1.3 `.slice(0, 40)` caps were removed) with bounded concurrency (app: 8), per-chain timeouts and a deadline. Unfinished chains are `PENDING` with an identity-scoped continuation cursor that can only narrow the server-computed plan. The UI renders the first page immediately, continues automatically up to three times, then offers "Continue scan"; `mergePortfolio` replaces rescanned chains and never accumulates duplicates. Each continuation changes the revision, so an open quote/review bound to the previous revision is invalidated by the existing binding.

Results: `state` (COMPLETE/PARTIAL/STALE/FAILED), per-chain `coverage` (tier, state, native/tokens status, historicalComplete, indexed from/through, head and observed block, reason), `coverageSummary` (planned/checked/indexed/pending/failed/native-only/catalog-only/unsupported, coverageComplete, historicalComplete), `continuation`, `dataPlane` (AVAILABLE/DEGRADED/UNAVAILABLE). The UI says "Otherbridge checked N networks; M more are still being checked", marks "Token history not fully indexed", "Native balance only", "Catalog only — not checked", "Indexing in progress", and states that unchecked networks are never counted as empty. Coverage details are collapsed by default.

Identity keeps independent evm/solana/bitcoin/sui/tron/stellar fields with the accepted validators. Bitcoin/Sui/Tron/Stellar are CATALOG_ONLY (unsupported ecosystem) in V1.4. Holdings carry provenance (`native`, `indexed`, `known-token`, `enumerated`), observed block and optional price evidence. Metadata is sanitized plain text; spam/suspicious flags; only local inert logos. USD is presentation only. Balance priority for Bridge/Swap: known USD value, non-zero without USD, native gas, routable, remaining.

Privacy: explicit scan consent, no account, no raw-wallet persistence (keyed pseudonyms with TTL, see DATA_RETENTION.md), private/no-store responses, redacted logs.

---

## Historical V1.3 text (superseded by V1.4, preserved verbatim)

### Portfolio V1.3

Portfolio means native and fungible tokens held at public wallet addresses. It excludes decoded lending, staking, vault, LP positions and NFTs. Receipt tokens remain tokens; no underlying position is inferred.

`PortfolioProvider` separates capabilities, activity discovery, fungible balances and native balance reads. The primary indexer uses one activity lookup followed by at most 40 discovered mainnet networks with concurrency three and an overall 20-second deadline. A direct native adapter covers the explicitly registered EVM and Solana endpoints. There is no client RPC fan-out across the catalog. Unsupported ecosystems remain explicit coverage gaps.

Identity has independent evm, solana, bitcoin[], sui, tron and stellar fields. Each uses the accepted native address validators. A missing ecosystem address is never replaced with the EVM address. Connected EVM account changes invalidate the stored result. Manual public addresses require the user's Scan action and can be removed independently.

Results preserve successful network balances when other reads fail: COMPLETE/PARTIAL/STALE/FAILED. An unavailable indexer credential is BLOCKED_CREDENTIAL_REQUIRED, with safe native fallback. No account creation, analytics, persistent server portfolio cache or shared wallet cache is introduced. API results are private/no-store; logs omit addresses and upstream payloads. Refresh uses abort and generation binding. Public network services necessarily observe queried addresses.

Metadata is plain text, bounded and stripped of HTML/control characters; suspicious claims/URLs are marked, spam is hidden, small USD balances can be revealed. Unknown-priced large balances remain visible. Arbitrary token logos cannot load: only the local inert fallback is accepted. USD is presentation only, never transaction math. Holdings affect ordering, never silent selection or transaction authority; result revisions bind quote review.
