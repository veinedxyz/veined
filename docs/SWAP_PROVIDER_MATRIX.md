# Swap provider and route-family matrix

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

| Provider / family | Source and quote path | Reviewed transaction scope | Live / unsupported boundary |
|---|---|---|---|
| Uniswap V2/V3/V4 | API when configured; bounded direct RPC discovery and current singleton quoters on 1/56/8453 | Universal Router 2.1.2; canonical V2/V3 commands, nested V4 swaps/settle/take; exact-in mixed/split; homogeneous ERC20 exact-out | Zero hooks only. Native exact-out and arbitrary actions/subplans are refused. Hosted API acceptance requires key. |
| UniswapX | SDK 3.1.3, current official reactor definitions | DUTCH_V2, DUTCH_V3 and PRIORITY semantic parsing; chain, decay/bounds, deadline/nonce, recipient, cosigner and Permit2 | No signing/filler/submission. External filler settlement is not simulated as an ordinary router swap. Unsupported validation/fee/order types fail closed. |
| Pancake V2/V3 | Smart Router 7.8.0; on-chain candidates | Current pinned router commands; exact-in mixed/split; homogeneous ERC20 exact-out | Router differs by chain; no legacy router substitution. |
| Pancake Infinity CL / BIN | Direct deployed quoters; BSC/Base deployments | Independent sorted pool key/manager/spacing/fee proof; CL and BIN actions, settlement/take, zero hooks | No equivalent V3 interpretation. Absent current liquidity is reported, not synthesized. |
| PCSX | SDK 1.7.2; explicit server opt-in for public price API | Current V1/V3/V4 Dutch schedules, packed nonlinear curves, replay/recipient/filler/exclusivity/cosigner/Permit2 semantics | Native input unsupported by order Permit2 path; wrapped input required. Onboarding/legal/opt-in external. Anonymous API is not described as requiring a secret. |
| Aerodrome classic | Base official router, registry and factory | Safe exact-input stable/volatile direct/multi-hop, native wrap/unwrap | No UNSAFE method or guessed fee-on-transfer route. Exact-out capability false. |
| Slipstream | Base current gauges-v3 factory/router/quoter | Exact-in/out ERC20, multi-hop, native input/output reviewed multicall/refund/unwrap | Only official bounded safe methods; canonical call sequence required. |
| Jupiter Meta / Router | Current Swap V2 /order and /build | Unsigned v0; current on-chain IDL route data; exact-in amounts/mints/accounts; independently decoded Whirlpool pool/vault family; safe SPL/Token-2022 account policy | Live API key absent. Other CPI families stay BUILD_REVIEW_REQUIRED until their independent pool/account semantics are reviewed. No V1 fallback or /execute. |
| Titan | Custom bounded ws/MessagePack transport; SDK 0.1.6 dev-only oracle | Shared Solana structural/economic firewall and independently supported Whirlpool route family | Endpoint/token absent. CODE_READY is scoped to tested protocol and reviewed route family, not every Titan venue/program. |

Evidence root: [evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/). Failed attempts remain alongside repaired runs. The final source checkpoint, gate summary and archive verification are authoritative; absence of a final receipt means PENDING, never an inferred pass.

Every provider is an untrusted source. A quote does not make an unsupported build reviewable. Read-only unsigned construction, independent decode, pool/program proof and exact economic simulation must all pass before the review reports REVIEWABLE. Every execution capability remains false.
