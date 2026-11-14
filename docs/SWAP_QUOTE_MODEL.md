# Swap intent and normalized quote
V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

src/swap/model.ts is the shared browser-safe domain. Intent binds ecosystem, chain, exact token/mint addresses, decimals, native identity, taker, recipient, EXACT_IN/EXACT_OUT, positive bigint amount, slippage mode/bps, ranking preference, wallet epoch, portfolio revision and expiry. Symbols never determine routing. EVM identity folds address case; Solana identity preserves base58 case. ETH/BNB/SOL presentation retains the exact wrapped address inside route legs.

Quotes bind an intent digest and include provider/mode, input/output/minimum/maximum bigint amounts, explicit fee kinds, null unknown fee amounts/USD costs, normalized price impact bps, routes with pool/venue/type/fee/share, hops/splits, quote time/expiry, block/slot, latency, build and simulation status. The Otherbridge PLATFORM fee is zero. Jupiter/Titan upstream platform fees are PROVIDER costs, not Otherbridge revenue. Wire values are decimal strings; Number is never used for raw monetary arithmetic. Titan numeric SDK amounts must be safe integers or are rejected.

Raw provider payloads and transaction bytes stay in adapters. Store sizes are bounded. Quote ID and intent digests are references, not signatures or authentication. Reviews use the exact server-stored immutable quote and canonical intent; client transaction payloads are not accepted. Complete economic transaction validation remains a separate gate.
