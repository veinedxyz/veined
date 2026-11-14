# V1.15.1 Swap completion / repair

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

The repair starts from V1.15 RETURN_FOR_REPAIR checkpoint `1f4b276d0257319db41c99178c30301df8c71e63d90efd677089e3a23f84cd72`. Preflight re-derived all 938 prior checkpoint files, preserved existing dirty work, and retained the root/G7 lock. No destructive Git cleanup or production state write is part of this milestone.

The canonical /swap surface now uses Swap Intelligence with ecosystem-aware token/mint selection, progressive provider competition, stable manual selection, continuous refresh, collapsed settings, explicit costs and a closed final review. Imported identities remain unverified. Read-only Activity previews preserve intent/route summaries; they are never completed trades. All 24 locale schemas contain the new Swap copy; native language review remains external.

Transaction review uses current Universal Router V4 and Pancake Infinity action layouts, source-driven EVM deployment pins, current PCSX and UniswapX order semantics, and independent Solana account/pool/economic validation. Provider SDKs stay server-only in a separate frozen dependency graph. Titan production uses the reviewed protocol transport; the logging SDK remains a development compatibility oracle. Durable health stores anonymous bounded hourly aggregates.

Evidence root: [evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/). Failed attempts remain alongside repaired runs. The final source checkpoint, gate summary and archive verification are authoritative; absence of a final receipt means PENDING, never an inferred pass.

Successful evidence and honest limits: EVM pinned public-state execution occurs only inside an in-memory test VM, with local synthetic funding/approvals. Runtime eth_simulateV1 uses no state override. Solana acceptance safely replays a recorded public Whirlpool route message with a current blockhash and zero signature bytes against current mainnet state. It proves economics with sigVerify=false; it is not a credentialed live Jupiter/Titan quote and does not prove signature validity. Unsupported hooks, CPI families, Token-2022 economic extensions and future order/program versions stay closed.

The review gate is not production approval. All mandatory nonexternal engineering gates must pass before READY_FOR_REVIEW. The raw protected root dependency audit and effective aliased production graph must both be reported. A remaining HIGH runtime risk has no owner exception and prevents READY.

Documents: [provider matrix](SWAP_PROVIDER_MATRIX.md), [source inventory](SWAP_PROVIDER_SOURCE_INVENTORY.md), [firewall](SWAP_TRANSACTION_FIREWALL.md), [simulation](SWAP_SIMULATION.md), [test matrix](V1151_TEST_MATRIX.md), [incident runbook](SWAP_INCIDENT_RUNBOOK.md), [legal packet](LEGAL_REVIEW_PACKET.md).

Setup: Node 24; pnpm install --frozen-lockfile --ignore-scripts; pnpm swap:deps. Both lockfiles and the reviewed SDK patch are required. This milestone never enables real execution.
