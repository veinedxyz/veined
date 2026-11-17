# Manual-wallet owner release preparation

Prepared 17 November 2026. Execution remains disarmed. An owner must separately approve the exact candidate checkpoint, reviewed financial differences and canary before any activation candidate is created. Do not change the accepted candidate.

## Bounded scope

| Route  | Input cap                                                 | Network / target                                                                                                                 |
| ------ | --------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Swap   | Exactly 1 USDC (1,000,000 raw units), max slippage 50 bps | Base 8453 → WETH on Base; Uniswap V3 SwapRouter02 `0x2626664c2603336e57b271c5c0b26f421741e481`                                   |
| Bridge | Exactly 5 USDC (5,000,000 raw units)                      | Base 8453 → Arbitrum 42161 USDC; aggregator diamond `0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae`, Across deposit/fill validation |

Base USDC: `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`. Base WETH: `0x4200000000000000000000000000000000000006`. Arbitrum USDC: `0xaf88d065e77c8cc2239327c5edb3a432268e5831`.

The complete immutable codehash, proxy implementation, pool and provider pins are in `src/swap/lane/pins.ts`, `bridge-pins.ts`, `scope.ts` and `bridge-scope.ts`. The protected baseline and exact allowance changes remain pinned by `release/manual-wallet-protected-baseline.json` and `manual-wallet-allowance-proposal.json`. A live review must match both independent RPC operators and all pins again. Static addresses alone do not establish current provider health.

## Owner wallet sequence after separate release approval

1. Select a fresh public test account in Rabby. Verify its address and Base chain directly in the extension. Keep other wallet activity paused for the bounded canary; the cumulative nonce anchor rejects unrelated account transactions.
2. Read balances, native gas budget including L1 cost, exact amount, minimum receive, fee cap, spender and mandatory Guardian result. Provider disagreement, stale quotes, unknown journals or BLOCK/HOLD stop the attempt.
3. If existing allowance is adequate, confirm only the exchange/deposit. Otherwise confirm an approval for exactly 1 or 5 USDC, then wait for its verified successful receipt. Do not grant unlimited approval.
4. Accept the newly reviewed execution quote only if its minimum preserves the originally displayed minimum. Read the exact target and transaction fields in Rabby. Do not edit target, calldata, value, account, chain or fees beyond the reviewed bounds. The wallet selects the nonce; its prompt remains a manual trust boundary.
5. Confirm the exchange or bridge deposit manually. Record wallet request time, confirmation time, hash and verified receipt. For Bridge, wait for verified destination USDC fill; source success is not destination settlement.
6. On rejection, crash, uncertain hash, refund state or provider mismatch, stop and reconcile. Do not reset journals or resend. A new independent session requires verified settlement of the preceding one. Policy confirmation depth is not L1 finality.

## Remaining operational limits

No real extension prompt, signature or transaction was performed by this release task. Prompt latency and actual owner/Rabby compatibility remain unmeasured. The candidate is one loopback process with one durable writer, a maximum of 64 loaded accounts and 128 archived records per account. Unknown/rejected/used records require read-only investigation; there is no automatic reset endpoint. Storage must persist across restart, and crashed writer locks require investigation rather than deletion.

Production hosting, HTTPS origin/proxy configuration, durable distributed rate limiting, filesystem-tracing packaging, external audit/legal gates and public financial activation require a separate release. Development-branch publication does not satisfy those gates.

The separately locked quote-provider SDK graph retains one unpatched LOW elliptic advisory (`GHSA-848j-6mx2-7j84`). The two manual routes do not use its ECDSA signing; all actual signing is delegated to the owner's wallet. This is disclosed, not a zero-vulnerability claim for the provider graph.
