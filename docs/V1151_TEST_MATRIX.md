# V1.15.1 test and evidence matrix

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Required floors: unit >=1336, integration >=335, E2E >=276, DB >=38, all accepted tests passing. The six-chunk harness must prove discovered union equality, missing=0, duplicate=0 (or explicitly intentional), flaky=0 and unexpected retries=0. Targeted success never stands in for the full regression. No baseline test deletion or weakened assertion is accepted.

Verified regression counts: unit 1454; integration 335; DB 38; E2E 320. Raw logs and tests/final/regression-summary.json, the final E2E union receipt and fresh-copy reproducibility.json govern acceptance. Overall RETURN_FOR_REPAIR reflects the separate mandatory dependency gate D5; a passing test count does not override that gate.

| Area | Evidence corpus / required check |
|---|---|
| Current EVM routes | fork-simulation/ pinned block/hash, exact build/intent, token deltas, minOut; Ethereum/Base/BSC; V2/V3/V4, mixed/split, Infinity CL/BIN, stable/volatile and Slipstream. Failed discovery/execution attempts retained. |
| Runtime EVM economic simulation | evm-economic/ real eth_simulateV1 and integration economic delta mutations; no overrides/broadcast/signature claim. |
| Solana current economics | solana-economic/ public-route replay, raw current on-chain IDL, LUT/accounts/program headers, same-bank pre/post fee/token/native deltas; recorded fixture tests and rejecting hostile mutations. |
| Titan | transport compatibility/frame bounds, auth redaction, cancellation/reconnect, fixture multi-provider stream, shared economic firewall; live credential gate distinct. |
| EVM hostile transaction changes | Chain/router/version/commands/actions/hooks/pools/tokens/amounts/minOut/recipient/deadline/fees/Permit2/hidden payments/flags/subplans; every rejecting fixture must assert rejection. |
| Solana hostile transaction changes | Payer/signers/writable keys/mints/ATAs/amount/slippage/delegate/extension/LUT/program upgrade/priority fee/hidden transfers/referral plus same-bank post-state mutations. |
| Primary UI | Progressive quotes/stickiness/refresh/abort, exact EVM/Solana import, review success/failure/stale/high impact, Activity read-only preview, execution closed, axe and responsive/RTL. |
| Retained application | Portfolio/global DeFi/Bridge/G7/wallet-first/CSP/production smoke and frozen fresh-D reproduction. |

Responsive captures cover 360/390/768/1440, light/dark and English/Arabic, with the full accepted locale/RTL regression remaining mandatory. Fixture screenshots are synthetic UI evidence; they are never live trade receipts. App initial gzip ceiling is 290690 bytes. Performance must retain first-valid/recommended/settled/build/simulation/refresh/render timing and provider p50/p95 with sample scope.

Evidence root: [evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/). Failed attempts remain alongside repaired runs. The final source checkpoint, gate summary and archive verification are authoritative; absence of a final receipt means PENDING, never an inferred pass.

Gate IDs from the full goal, with final evidence links, are materialized in release-readiness/acceptance-matrix.json. PENDING entries remain engineering verification work. Independent audit, legal review, production origin/quotas and credentials are external; no engineering gap may be relabelled credential-only.
