# Transaction firewall specification (V1.5)

Status: specification of the existing, **disabled** write-path foundation. No signer, wallet write, approval, permit, broadcast or deploy is enabled by this code: the execution gate is frozen closed, the global kill is frozen ON, the production contract registry is frozen empty, and the real Otherbridge fee is 0 bps. This document lists every invariant the code enforces so an independent reviewer can check that nothing is hidden in code. Source: `src/security/firewall.ts`, `src/routing/model.ts`, `src/routing/fee-policy.ts`, `src/security/invariants.ts`.

## Objects

- **ExpectedIntent** (`intentSchema`, strict): what Otherbridge reviewed and the user would approve.
- **PreparedTransaction** (`transactionSchema`, strict): the raw transaction an upstream/adapter proposes (`chainId`, `from`, `to`, `value`, `data`).
- **ContractEntry**: reviewed registry record (`chainId`, `protocol`, `provider`, `contract`, `spender`, `token`, `selector`, `runtimeHash`, `implementationHash`, `verifiedAt`, `verifiedBlock`, `provenance`, `status`). Production registry: `Object.freeze([])`.
- **TrustedDecoder**: an independently reviewed calldata decoder supplied by a future adapter; upstream "decoded" objects are never accepted.
- **SimulationProof** (strict): `success`, `transactionDigest`, `intentDigest`, `chainId`, `block`, `observedAt`, `registryDigest` (V1.5).
- **KillPolicy**: `global`, `chains`, `providers`, `protocols`, `tokens`, `spenders`. Production: frozen, `global: true`.

## Invariants

| # | Invariant | Enforced by | Failure | Tests |
|---|---|---|---|---|
| I1 | Chain ID: intent, raw transaction, registry entry and simulation proof name the same chain | `compareIntent` (registry vs intent), normalized intent equality (tx), gate (`proof.chainId`) | `REGISTRY_MISMATCH` / `INTENT_MISMATCH` / `SIMULATION_REQUIRED` | v13 "reject upstream tx chainId", v15 "chain mutation (tx/registry/simulation)" |
| I2 | `from` equals the reviewed account | normalized intent equality | `INTENT_MISMATCH` | v13, v15 one-bit address mutations |
| I3 | Destination contract equals the reviewed registry contract and the intent | registry check + tx `to` equality | `REGISTRY_MISMATCH` / `INTENT_MISMATCH` | v15 address mutations |
| I4 | Calldata selector: first 4 bytes of `data` equal intent and registry selector | normalized `calldataSelector` + registry | `INTENT_MISMATCH` / `REGISTRY_MISMATCH` | v15 "selector mutation" |
| I5 | Native value equals the intent (unsigned decimal ≤ 78 digits) | schema + equality | schema error / `INTENT_MISMATCH` | v13 value mutation, v15 one-bit value |
| I6 | Input token equals intent and registry token | decoder field + registry | `INTENT_MISMATCH` / `REGISTRY_MISMATCH` | v15 |
| I7 | Input amount equals the reviewed amount | decoder field | `INTENT_MISMATCH` | v15 one-bit amounts |
| I8 | Output token equals the intent | decoder field | `INTENT_MISMATCH` | v15 |
| I9 | Minimum output equals the reviewed minimum | decoder field | `INTENT_MISMATCH` | v15 |
| I10 | Recipient equals the reviewed recipient; zero address never allowed | schema (`address` refuses zero) + decoder field | schema / `INTENT_MISMATCH` | v15 "recipient mutation" |
| I11 | Approval spender equals intent and registry spender | registry + decoder field | `REGISTRY_MISMATCH` / `INTENT_MISMATCH` | v15 "spender mutation" |
| I12 | Approval amount equals intent and never exceeds the input amount (finite approvals only; `2^256-1` impossible); approval deadline ≤ 5 min | equality + `UNLIMITED_APPROVAL_REJECTED`; `reviewApproval` | `INTENT_MISMATCH` / `UNLIMITED_APPROVAL_REJECTED` | v13, v15 "approval amount +1", "unlimited approvals" |
| I13 | Platform fee bps is literally 0 in intent and decoded data; the fee policy is frozen (`enabled:false`, `bps:0`, hard max 10) and quotes carrying a non-zero integrator share are rejected | `platformFeeBps: z.literal(0)`, `platformFee()`, normalization (`PLATFORM_FEE_NONZERO`) | schema / `INVALID_FEE_POLICY` | v13 fee tests, v15 "fee change", hostile environment |
| I14 | Quote ID is single-use per gate (replay guard, capacity 1,000) | `SimulationGate.used` | `REPLAY_REJECTED` / `REPLAY_CAPACITY_REACHED` | v13, v15 "duplicate quote" |
| I15 | Expiry: review strictly before `expiresAt` | `compareIntent` | `QUOTE_EXPIRED` | v15 "quote expiry boundary" (last ms passes, expiry instant fails) |
| I16 | Simulation digest binds the exact raw transaction (SHA-256 of the strict transaction) and the exact intent; success required; proof younger than 15 s and not from the future | gate | `SIMULATION_REQUIRED` | v13, v15 digest/age/future/"alternate economically identical payload" |
| I17 | Registry version: the proof's `registryDigest` equals the fixed-order digest of the entry under review (contract, spender, token, selector, runtime/implementation hashes, verified block, status) | gate (`entryDigest`) | `REGISTRY_DRIFT` | v15 "registry drift", "implementation hash drift", digest field test |
| I18 | Simulation block ≥ the entry's verified block (no simulation on state older than the reviewed deployment) | gate | `SIMULATION_BLOCK_MISMATCH` | v15 |
| I19 | Only `ACTIVE` registry entries; runtime/implementation hash drift against live hashes closes the route | gate + `routeHealth` | `REVIEW_REQUIRED` | v13, v15 |
| I20 | Kill policy is enforced at review time by the gate itself (global, chain, provider, protocol, token, spender), so a kill flipped after a quote/simulation still closes the gate | `assertNotKilled` in `review` and `routeHealth` | `EXECUTION_PAUSED` | v15 "kill switch flipping after the quote" |
| I21 | Execution gate frozen: `enabled:false`, `sign/approve/broadcast/deploy: null`; `requestExecution()`/`futureExecution()` always throw | `executionGate`, `requestExecution` | `WRITE_DISABLED` | v13/v15 hostile environment |
| I22 | Environment cannot open anything: no runtime switch reads the environment for gate, fee, kill or registry; monitoring invariants mirror the constants | `src/security/invariants.ts`; `dataConfig` refuses to start on any deviation | `EXECUTION_GATE_ANOMALY` / `FEE_COLLECTION_ANOMALY` | v15 hostile toggles, config schema tests, Drill C |
| I23 | Strict schemas: unknown fields in intent, transaction or proof are rejected | `.strict()` | schema error | v15 "unknown proof field" |

Every rejection is counted (`security_firewall_rejections_total{reason}`) and rethrown unchanged.

## Known limits (must be resolved before any write path is enabled)

- The replay guard is in-memory per gate instance; a durable, cross-instance store is required before execution.
- There is no production `TrustedDecoder`; each protocol adapter needs an independently reviewed decoder and an independent firewall review (release gate item 3).
- `contract_registry_drift` is 0 by construction while the registry is empty; a non-empty registry must replace it with live runtime-hash checks.
- Simulation itself (who runs it, against which node) is outside this module; the proof is only accepted when it binds the exact bytes, intent, entry and recent state.

## Property testing

`tests/unit/v15-firewall.test.ts` uses seeded loops (seeds 1, 7, 42, 1337, 20261004) for one-bit address/amount/value mutations of every bound field plus a table of targeted mutations; every mutation must fail closed. Total V1.5 firewall cases: 41 (in addition to the accepted V1.3 suite).
