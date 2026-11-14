# Actual architecture and integration decision

A single Next.js App Router / React / strict TypeScript application. The Product lifecycle in the root layout preserves wallet state during navigation; the allowlist catch-all route returns 404 for unknown pages. UI state is on the client; the public RPC client is on the server side only. No additional database or user account.

| Layer | Actual files | Responsibility |
|---|---|---|
| Domain | `src/core/model.ts`, `amounts.ts`, `flow.ts` | Route/asset identity, bigint amount, controlled state, source/destination correlation |
| Bridge | `src/adapters/onebridge.ts` | Unsigned calldata and decode matching with the generic documented ABI; native ONE live deployment verification is not considered to have been done |
| Public read | `src/adapters/read-only.ts`, `native-service.ts`, `native-decoder.ts`, `deployment.ts`, `src/app/api/bridge/route.ts` | Typed bounded RPC, full proxy/implementation runtime pins, native pair/fee/limit/simulation and two-chain receipt/event/payout correlation |
| Wallet | `src/features/wallet/provider.ts` | EIP-6963 selection, EIP-1193, pending request lock, account/chain change |
| Submission | `src/features/bridge/submission.ts`, `lifecycle.ts` | Single wallet write boundary; always closed while the registry is empty, uncertainty is persisted first |
| History | `src/storage/history.ts`, `src/features/bridge/observation.ts` | Storage claim kept separate from 30-second in-memory evidence; revalidation under namespace lock before the duplicate check |
| Product | `src/components/product.tsx`, `dialog.ts`, `src/content/messages.ts` | Seven product surfaces, TR/EN, theme, accessible modal and error behaviors |
| Test | `tests/fixtures`, `tests/unit`, `tests/integration`, `tests/e2e` | Synthetic scenarios; do not prove mainnet funds/reserves |

## The single chosen path

The injected external wallet requiring no identity + narrow direct adapter path was chosen. viem provides ABI encode/decode; no separate wagmi provider tree or SDK financial panel was set up. The standard EIP-1193 connection is sufficient for the wallet/chain lifecycle. SDK 1.4.2 MIT and peer metadata were reviewed; it was not used because of the missing owned CROSS/Reown ID and the out-of-scope Send/Portfolio/Buy surfaces. WalletConnect `CONFIGURATION_REQUIRED`; the user is not shown a non-working QR.

The R1 reader matches the current chainId/block, EIP-1967 slot and full decoded-byte Keccak-256 runtime hashes against pinned candidates. The native pair has seven fields; the fee comes from the source verifier, limits/pause from real view calls. The quote uses eth_call + eth_estimateGas with the exact native msg.value; there is no fallback for a failed simulation/gas. Subtracting pendingAmount from the smaller of destination accounting and the token balance is only a conservative upper bound; it is not a definitive spendable reserve. The pinned compiler/dependency build of the three public source versions did not match the observed runtime: G5 source-build/reserve verification BLOCKED. **The write registry source/destination values remain null.** The read-only deployment pins do not open this registry.

Production rejects the `local-test` request. The test fixture module may be present in the server bundle but is unreachable in the production branch; there is no signer/test key, and no active demo route is opened. The UI local scenario likewise produces only a synthetic record. This is not a real bridge, and there is no automatic fixture fallback in the event of a live error.

localStorage is used for at most 100 records/150 KB. Corrupted data is preserved; new writes stop. Web Locks operate in the mode/route/config/chain/account namespace; they do not globally lock the wallet's operations in other applications. A mainnet terminal storage claim is downgraded; fresh observer proof is held only in memory and is re-read on reload. The public native receipt/log replay tests use the real handler/decoder/verifier path; the gas simulation transport double is explicitly separate. Finality depends on the node's finalized tag and the canonical block hash; it is not a light client or an independent validator proof.

R1 continuation: permission grant identity is checked inside connect with event-aware bounded accounts/chain snapshots. Actual request4001 creates a module-private exact-intent proof for30s; storage/import cannot restore it, next dispatch revokes it. Hashless history remains blocked after reload; a user may attach a source hash under history lock for read-only observer validation while preserving records. Stored HELD/reorg destination hashes also trigger bounded fresh receipt discovery; all payout/finality checks remain required.
