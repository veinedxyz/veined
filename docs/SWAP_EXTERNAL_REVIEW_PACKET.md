# Focused Swap external review packet

V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

This package is engineering evidence for independent review, not an audit certificate. Read the V1.15.1 goal and current acceptance matrix first. Source checkpoint and hashes freeze the exact implementation. The prior V1.15 checkpoint, preflight diffs/status and all failed repair attempts remain available; no existing dirty work is discarded.

| Review area | Source and evidence to inspect | Required reviewer question |
|---|---|---|
| Normalization / authority | src/swap/model.ts; server provider adapters/coordinator/service; quote/build/review digest and expiry tests | Can a quote, stale identity or late callback change exact tokens/amount/recipient/epoch or gain wallet authority? |
| Universal Router / Infinity | universal.ts, evm.ts, pools.ts, current pinned official Commands/Actions/keys; generated deployment pins; fork-simulation/ and mutation corpus | Are all shown mixed/split legs decoded, settled and attributed, with aggregate bounds and zero/unreviewed hooks closed? |
| Auctions / RFQ | PCSX current SDK/parser and UniswapX DUTCH_V2/V3/PRIORITY; Permit2 bindings and hostile fixtures | Do packed decay schedules, cosigner/filler/replay fields and recipients match? Is external signed/filler settlement limitation explicit? |
| Solana economics | solana.ts, jupiter-decoder.ts, solana-accounts/economics/pools/deltas/programs; on-chain IDL/raw account sources and program headers; accepted public route replay | Are mints/ATAs/pool vaults/amounts/fees/rent/LUT/loaded keys bound and same-bank deltas authoritative? Does an unknown CPI/extension close review? |
| Titan secret boundary | titan-transport.ts, server provider; SDK dev-only compatibility oracle; frame/timeout/reconnect/cancel/auth fixtures | Can any untrusted frame/error or server auth enter logs/client bundle? Can a canceled stream survive? |
| Operational boundaries | Anonymous SQLite health, exact mode/build/review kills, bounded lanes/cache/cooldown and origin checklist | Can metrics contain identity or attacker-controlled dimensions? Does a killed provider receive zero queries? |
| Dependency release gate | Raw/effective prod/dev audits, SBOM/licenses, exact hook/alias/facade, proposed unapplied protected-root patch | Is the actual release graph clean to the accepted standard without hidden advisory or unauthorized G7 rebaseline? |
| Application preservation | Final six-chunk union, unit/integration/DB floors, G7/CSP/production smoke, fresh-D frozen install/build, responsive/RTL/axe and bundle receipts | Were existing assertion strength, zero execution and 290690 gzip ceiling preserved? |

Threats considered: malicious quote/built transaction, command/action smuggling, split-allocation loss, nonstandard hooks/tokens, wrong pool/manager/factory, hidden native/token transfer, stale nonce/deadline/quote/LUT/blockhash, program/router upgrade, provider credential leakage, raw websocket logs, unsafe integers/frame resource exhaustion, canceled-stream races, corrupt RPC state, dependency drift and misleading Best Net. Each admitted family requires successful semantics and representative exact economic evidence; rejecting every transaction is not acceptance.

Known boundaries: public RPC state is an observed snapshot rather than independent Merkle state proof; future state/MEV/token behavior cannot be promised. Economic Solana replay uses zero signature bytes and proves no signature validity or hosted live quote. Unreviewed CPI/hook/economic extension/order families remain visibly non-reviewable. Legal/commercial API/RPC/license/branding terms, native language review, owner origins/secrets/quotas and independent security/release approval remain external. Raw protected-root advisory conflict is an engineering D5 gate unless explicitly resolved; the unapplied proposal must not be described as the actual root lock.

Review package rules: real env/API keys/wallet sessions/private keys/seed phrases/.git/node_modules/build caches/previous ZIPs and browser trace archives are excluded. Archive SHA-256, per-entry hashes, CRC, case-insensitive path uniqueness and secret scans are verified after archive generation. No archive self-hash is fabricated inside the archive. Real wallet prompts/signatures/approvals/permits/broadcasts/deploys/fee collection remain zero.

Evidence root: [evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e](../evidence/otherbridge-v1-15-1/v1151-20261014T082100305Z-35e80e/). Failed attempts remain alongside repaired runs. The final source checkpoint, gate summary and archive verification are authoritative; absence of a final receipt means PENDING, never an inferred pass.

