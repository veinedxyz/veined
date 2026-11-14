> Historical V1.15 RETURN_FOR_REPAIR record. Current implementation and gates are in [V1151_SWAP_COMPLETION_REPAIR.md](V1151_SWAP_COMPLETION_REPAIR.md) and [V1151_TEST_MATRIX.md](V1151_TEST_MATRIX.md). The frozen V1.15 evidence remains unchanged.

# V1.15 test and evidence matrix
Candidate status: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. This is an implementation review package, not production readiness or an independent audit.

Accepted floors are unit 1247, integration 297, E2E 266 and DB 38. No accepted test assertions were removed or weakened. Full package totals and exact exit codes live in tests/final/regression-summary.json. Browser suite uses the accepted six-test chunk harness; no monolithic pass is inferred from target-only tests.

| Area | Implemented evidence | Remaining gap |
|---|---|---|
| Intent/ranking/freshness | bigint, exact identity, fee fallback, all ranking modes, sticky choice, expiry | complete current real provider corpus |
| EVM decoder | V2/V3, native commands, classic/CL shapes, altered recipient/router/value/minOut/deadline/extra call | full V4/Infinity/splits, all real ABI variants, fork coverage |
| Pool attribution | independent factory lookup, absent bytecode/substituted pool rejection | audited codehash drift governance |
| Permit2 | amount/spender/domain/quote/replay binding | wallet flow intentionally absent |
| Solana | unsigned v0, compute, payer/signers, unknown program, hidden System transfer, stale blockhash | nested economics, ATA, malicious lookup/writable semantic proofs |
| Jupiter | V2 normalization, fraction vs percentage, fee ownership | credentialed live order/build acceptance, RTSE policy |
| Titan | official SDK adapter, malformed frame and safe integer guards | full captured stream/reconnect/venue mutation corpus and live auth |
| PCSX | current official parser, unknown type refusal | complete V3/V4 filler/exclusivity/nonlinear auction proof |
| UI | multiple quotes, alternate selection, late better quote, changed input, stale/high impact/simulation fail/outage, mobile/desktop/dark/light/RTL/axe | Solana mint import, all new translations and primary UI rollout |

Targeted browser screenshots are synthetic fixtures, labeled by their enclosing evidence path. Live quotes and simulations are separately timestamped under live-readonly/. Failed attempts are retained under failed-attempts/ and e2e/; successful reruns do not erase them. This report does not claim an independent audit or every requested acceptance row passed.
