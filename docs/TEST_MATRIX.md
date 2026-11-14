# Acceptance matrix → real evidence

The current R1 results are in `evidence/otherbridge-v1/repair-r1/acceptance-c/commands.json`, `acceptance-c/logs/`, `e2e-final-c/e2e-results.json`, `repro-final-c/` and `production-final-c/`: 103 unit, 19 integration, 14 E2E; skipped/unexpected/flaky=0. The old root evidence is from a historical run. PASS labels are within assertion scope; they do not open submission or the G5 gate.

| Master ID | Assertion / file | Evidence scope |
|---|---|---|
| A01, M06 | domain native calldata/exact msg.value + integration/evm | Native sentinel, no approval, padding reject |
| A02–A05 | domain changed token/sourceChain/destinationChain/route/config | Fixed token/route/chain, decimals identity18, wrong asset fail |
| A06, Q04 | domain sentinel/deployment/router drift | Explorer sentinel and API router are not accepted automatically |
| M01–M03 | domain amount tests | 18digits bigint, zero/negative/exponent/length/locale reject |
| M04–M05 | domain MAX, dependent fee, cap + quote expiry | Balance/gas/route limit is preserved; fee draft is bound |
| W01, W05, X03 | product EIP6963 E2E | Multiple provider selection, injected without identity, malicious icon inert |
| W02 | wallet unit + product rejection/no-wallet E2E | Correct message for rejection/locked/no wallet |
| W03, S05 | product account/chain E2E + domain identity change | Quote/review invalidation, final validation |
| W04 | wallet timeout/pending unit | Timeout does not treat the request as cancelled; no second request |
| W06 | domain smart/delegated preflight | Nonempty code is blocked; real smart-wallet device test NOT_RUN |
| Q01, X01 | transport timeout/429/malformed/redirect/DNS + product network failure | Bounded errors; no fixture fallback |
| Q02–Q03 | domain expiry/calldata/fees/recipient | Stale or manipulated draft reject |
| Q05–Q06, G01 | domain reserve/freshness/pause/simulation/balance preflight | Unknown liquidity/simulation/gas fail closed |
| S01, X05–X06 | wallet closed-gate + integration production-mode + production smoke | Even toggle true does not open write/fixture; nonce CSP & frozen deps |
| S02, X02 | domain RPC deny + transport size + streaming body | Public send/sign, arbitrary call/log range/batch are not accepted |
| S03 | lifecycle unresolved + storage parallel lock | An uncertain intent on the same account blocks a second submission; tab writes are preserved |
| S04 | lifecycle uncertainty/persistence/hash/rejection | Unknown is persisted before the request; no automatic retry on hash loss |
| T01–T05 | domain settlement correlation | Source alone/API status/batch unrelated payout is not completion |
| T06–T09 | domain held/release/reorg/replacement/timeout | Evidence revalidation, nonce/intent separation, no false refund |
| P01 | local transfer E2E reload + storage lock | Tracking continues, no automatic submission |
| P02–P03 | domain strict import, storage completion downgrade, corrupted history E2E | False success untrusted; corrupted data is not overwritten |
| P04 | lifecycle account isolation + E2E account switch | History shows the address; intents do not mix with another account |
| G02 | local review E2E, post panel | The BNB0 warning does not by itself block source acceptance; claim unknown live blocker |
| U01 | product responsive E2E | 360/390/768/1440, scrollWidth assertion and real screenshots |
| U02 | product keyboard/focus/zoom E2E | Tab trap/escape return, **200% CSS zoom** layout test; not an OS/browser chrome zoom test |
| U03 | product TR-dark/EN-light + production a11y | Persistent selection, axe violations0; visual manual screenshot review |
| U04 | product error/no-wallet/history failure + production live health | Unknown/unavailable distinction; no fake 0 |
| X04 | domain diagnostic redact | No address/amount/hash by default; secrets/schema unknownfield reject |

R1: `repair-r1.test.ts` tests the identity/numeric corruption/held/replacement/amount binding/wallet hang-synchronous throw regressions; `history-revalidation.test.ts` tests the separation between storage and in-memory evidence. `native-replay.test.ts` covers public receipt/log replay with the actual API/observer, revert without event, canonical reorg, finalized tag, single and batch payout ownership, revalidation under lock, recovery from a wrong destination hint, bounded history paging and the quote/health ABI path. The quote gas/funded EOA simulation input is an explicit transport double; the public record is not presented as current live data.

`history-proof.spec.ts` covers fresh proof after reload and the Web Locks namespace across two real tabs; `product.spec.ts` covers a stalled chain read, a late permission response, delayed quote→MAX, and the disabled review action/no-write assertion against a valid mainnet-readonly quote + API submission=true. The unit submission boundary, the production config and the production smoke separately test the same closed write boundary.

`native-live-c/` is opt-in real RPC reader evidence: a historical public payout was re-observed; the quote for the selected public account was rejected due to insufficient balance. No other suitable native EOA was found within the last 2×1000 source blocks. Probe PASS does not mean quote success or G5 PASS. The local in-memory EVM test does not use signer/mining/deploy. G5 full source-build/spendable reserve BLOCKED; G7 NOT_RUN, G8 BLOCKED.

## R1 checkpoint-review continuation

Final continue-checkpoint-d acceptance: 112 unit, 23 integration, 22 E2E (all final source hashes matched). wallet.test.ts covers normal grant/competing account/snapshot/chain/disconnect; history-revalidation.test.ts covers exact runtime4001, expiry/import/module-reload/retry timeout/hash-persistence failure; storage.test.ts covers candidate hash preservation/no overwrite. native-replay.test.ts covers stored HELD/reorg → later verified payout and explicit3-page exhaustion. product.spec.ts covers grant and conflicting events plus quote busy after account/chain/disconnect; history-proof.spec.ts covers hashless reload and explicit manual hash recovery before decoder proof. Raw failing and final runs are preserved; verification-summary-continuation.json links actual counts/heads/hashes.
