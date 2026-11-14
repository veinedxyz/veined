# Indexer log-set consensus (V1.5)

Status: implemented and tested locally. This is engineering hardening, not an independent audit.

## Problem

V1.4 verified chain ID, header sandwiches, canonical hashes and reorgs, but one dishonest or broken RPC endpoint could return a valid-looking but **incomplete** `eth_getLogs` result for a window. That omission was undetectable.

## Model

Every Tier A window that is committed to durable indexed state carries a `LogWindowWitness` record (`src/data/indexer/witness.ts`, table `indexed_window_witnesses`, migration `0002_v15_hardening.sql`):

| Field | Meaning |
|---|---|
| `chainId`, `fromBlock`, `toBlock`, `mode` | window and lane (`LIVE`, `BACKFILL`, `REVERIFY`) |
| `primary/witness/tiebreakEndpointId` | endpoints that served the log sets |
| `primary/witness/tiebreakOperator` | operator groups used for independence |
| `primaryBlockStartHash`, `primaryBlockEndHash`, `witnessBlock*Hash` | headers each endpoint held for the window edges |
| `*LogCount`, `*Digest` | per-endpoint log count and log-set digest |
| `consensus` | `MATCH`, `MISMATCH`, `NO_INDEPENDENT_WITNESS`, `TIEBREAK_MATCH_PRIMARY`, `TIEBREAK_MATCH_WITNESS`, `UNRESOLVED` |
| `failure` | `PRIMARY_FAILED`, `WITNESS_FAILED`, `LOG_SET_MISMATCH`, `BLOCK_HASH_MISMATCH`, `NO_WITNESS`, `CONSENSUS_UNRESOLVED` |
| `committed`, `observedAt` | whether the window was committed; timestamp |

Committed windows also store `witness_consensus` and the digest of the **committed** log set (`log_digest`). A database CHECK forbids a committed record with `MISMATCH` or `UNRESOLVED`.

## Log-set digest

`normalizeLogs()` + `logSetDigest()`:

- Strict per-field grammar (address, 1–4 topics, data, block number/hash, transaction hash, optional transaction index, log index, `removed`). Extra provider fields (for example `blockTimestamp`) are ignored and never enter the digest.
- Canonical lowercase hex, decimal block/log numbers, deterministic `(blockNumber, logIndex)` order.
- Duplicate `(block, logIndex)` or `(txHash, logIndex)` keys, logs outside the window, two block hashes for one block number, malformed hex and more than 100,000 logs are **rejected**, never deduplicated or truncated.
- Logs in the edge blocks must sit on the endpoint's own sandwiched headers (`LOG_FORK_MISMATCH` otherwise).
- SHA-256 over a domain header (`otherbridge.log-window.v1`, chain ID, from, to, filter topic0, count) followed by one line per log binding block number, block hash, transaction hash, transaction index (or `-`), log index, contract address, topics, data and `removed`.

Counts alone never decide: a same-count set with one changed log, a fabricated log or a reordered set (which must match) are all covered by seeded property tests (`tests/unit/v15-witness.test.ts`).

## Independence

`src/data/registry/rpc-provenance.json` (`rpc-provenance.ts`) maps hosts (exact or `*.suffix`) to operator groups. Two endpoints are independent only when **both** operators are known (`provenance` not `unknown`), their groups differ, and their normalized URLs differ. When a foundation hostname is served by an infrastructure provider (Ink: Gelato, QuickNode, Tenderly), `backingOperatorGroup` is the independence key, so a provider's own domain and a foundation alias of the same provider never count twice. Aggregators and relays whose per-request backing node operator cannot be determined (dRPC, thirdweb edge, Flashbots Protect; unlisted gateways such as 1RPC, Pocket/Nodies, Blast are UNKNOWN) are **never** witness-eligible. An unknown operator is never independent of anything.

## Consensus algorithm (`witnessWindow`)

1. The primary window read keeps the V1.4 rules (sandwich, chain ID, strict decoding). When two or more witness-eligible operators are healthy, the primary is chosen among them; a primary that is not itself witness-eligible (routing/aggregating providers whose backing operator cannot be attributed, unknown operators) can never form consensus — its windows are `NO_INDEPENDENT_WITNESS`, because the provider may have forwarded the query to the very operator that would "witness" it.
2. A witness is chosen among healthy, log-capable, witness-eligible endpoints independent of the primary. `fetchLogSet` reads the complete window on that endpoint: chain ID check, header sandwich around all log reads, chunking to the endpoint's log range with bisection on range/size/time limits, call budget 64. Any failure throws; **unavailability is never zero logs**.
3. Different edge-block hashes → `MISMATCH` / `BLOCK_HASH_MISMATCH`: nothing is committed; the next cycle reconciles canonical state.
4. Equal digests → `MATCH`: the window commits as trusted.
5. Different digests → a third operator independent of **both** is queried. If it equals the primary → `TIEBREAK_MATCH_PRIMARY` (commit primary set, quarantine the witness for 1 h); if it equals the witness → `TIEBREAK_MATCH_WITNESS` (commit the witness set, quarantine the primary); otherwise, or when no independent third operator exists or it fails → `UNRESOLVED`.
6. `UNRESOLVED` → nothing is committed, the checkpoint gets `halted_reason = LOG_CONSENSUS_UNRESOLVED:<from>-<to>`, the chain stops advancing (also for backfill) until an operator runs `pnpm data:indexer:resume --chain <id> --reason '<note>' --yes`. A halted chain refuses commits even with a valid lease (`CHAIN_HALTED`, store-level).
7. No independent witness or witness unavailable (`NO_INDEPENDENT_WITNESS`): policy `required` (release semantics, staging) commits nothing (`WITNESS_UNAVAILABLE`); policy `best-effort` (default only in the `development` profile) commits a **development-only** window that is never counted as trusted. The default is `required` in the `staging` and `release` profiles, and the `release` profile refuses `best-effort` at startup (`OTHERBRIDGE_INDEX_WITNESS_RELEASE_REQUIRED`). The policy is parsed strictly (`required` | `best-effort`); anything else exits non-zero.

Disputes are stored as witness records and written as bounded, non-secret diagnostics (`witness-disputes.jsonl`: endpoint IDs, digests, key differences — no raw responses).

## Release eligibility

`src/data/indexer/eligibility.ts` separates `FULL_INDEXED_DEVELOPMENT` from `FULL_INDEXED_RELEASE_ELIGIBLE`. Release eligibility requires: a healthy log-capable primary, at least two healthy independent witness-eligible log operators, every committed window trusted (no development or pre-V1.5 unwitnessed window), no halt, a clean `verify-index` (gaps, duplicates, orphans, checkpoint, block-hash consistency, disputed windows, impossible states), a current index, a working balance resolver, **and** release-approved RPC terms for an independent pair. `engineeringEligible` reports everything except the terms review. The Data API exposes this as `index.integrity` (OpenAPI 1.5.0); the public UI keeps its plain coverage wording (a paused index is shown as indexing/lagging).

## Historical lanes and re-verification

- `backfillOnce` (`pnpm data:indexer:backfill --chain <id>`): backward windows below `indexed_from_block`, finalized only, contiguous (the already-indexed first block must build on the window's last block), witnessed with the same consensus, own lease table `indexer_backfill_leases`, store-enforced contiguity/finality/lease checks. `historicalComplete` stays false; `liveIndexedThrough` and `historicalIndexedFrom` are reported.
- `reverifyOnce` (`pnpm data:indexer:rewitness`): witnesses windows committed before V1.5 and requires the agreed set's decoded ERC20 rows to equal the stored rows and the stored end hash; only the exact unwitnessed window is marked. A difference halts the chain (`STORED_WINDOW_MISMATCH`); nothing is rewritten automatically.

## Live read-only results (2026-10-04, evidence `witness/`, `data/`)

| Chain | Independent witness operators | Result |
|---|---|---|
| Ink 57073 | Gelato (rpc-gel), QuickNode (rpc-qnd), Tenderly (rpc-ten) — per official Ink docs | 18 fresh live windows MATCH (`required`), all 217 V1.4 windows re-verified MATCH with stored rows identical, 4 backward backfill windows MATCH, 13 further live windows MATCH; 252/252 windows trusted; `engineeringEligible = true`; release blocked only by RPC terms review |
| World Chain 480 | Alchemy public, Tenderly gateway | assessed and promoted to Tier A in V1.5: 21 live windows MATCH (`required`); 17.5 Transfer logs/block; same terms blocker |
| Arbitrum 42161 | Offchain Labs only (PublicNode refuses unfiltered `eth_getLogs`; other public endpoints are aggregators/relays) | `NO_INDEPENDENT_WITNESS`: development windows only; 260 pre-V1.5 windows cannot be re-verified; release-blocked. Advisory cross-check with two aggregators: 6/6 digests equal (evidence only, not consensus) |
| Avalanche 43114 | Ava Labs public API only (PublicNode refuses unfiltered logs) | same as Arbitrum; advisory 6/6 equal |

In the staging-equivalent stack (`required` policy) Arbitrum and Avalanche commit no window at all (`WITNESS_UNAVAILABLE`, visible in metrics and the `OtherbridgeIndexerStalled` alert) while Ink commits only MATCH windows.

## Cost

Deterministic fixture: witnessing raises RPC calls from 20 to 38 for the same 4 windows (×1.9). Live: Ink 18 witnessed windows (34,635 blocks) in 19.2 s; World Chain 100-block windows ≈ 3.4 s each. Integrity is not weakened to save calls.

## Tests

`tests/unit/v15-witness.test.ts` (digest/normalization properties, provenance, profiles), `tests/integration/v15-witness.test.ts` (the 15 required scenarios plus aliases/unknown operators/empty witness/two-operator dispute), `tests/db/v15.test.ts` (PostgreSQL persistence, halt fencing, backfill, REVERIFY guard, roles), `scripts/v15-drill-a.ts` (end-to-end incident drill with alerts).

## Self-review repairs (V1.5)

- Routing-provider primaries cannot form consensus (see step 1); regression test `11c`.
- `REVERIFY` of a window where the witness won the tiebreak stores the witness (committed) digest, so `verify-index` reports no disputed window; regression test `11d`.
- `REVERIFY` also covers development-only (`NO_INDEPENDENT_WITNESS`) windows, so adding an independent operator later can make a chain release-eligible without rewriting indexed data.
- Integrity quarantines (`LOG_SET_MISMATCH`, `CHAIN_MISMATCH`, `UNSAFE_DNS`, `URL_REJECTED`) are no longer lifted by a later successful call such as an `rpc:health` probe; they last until expiry.

## Residual limits

- A single dishonest witness can pause a chain (`UNRESOLVED`) or stall it (`MISMATCH` on every attempt); this is the intended fail-closed trade-off and is visible via alerts.
- Independence relies on the provenance inventory: undisclosed shared backing between two declared operators, and "official" hostnames whose operator is not named, cannot be ruled out from public information.
- `index.integrity` in the API is computed from stored state; the full `verify-index` scan runs as an operator command/alerted job, not per request.
- The indexer database role can clear a halt; "operator resume" is enforced procedurally (explicit command with `--reason` and `--yes`, logged), not by a separate database role.
