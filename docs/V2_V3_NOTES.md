# V2/V3 — extension boundaries only

`src/core/extensions.ts` contains capabilities and interfaces; there is no working provider. Gas provisioning and swap are `unsupported` today.

V2: the destination native gas asset, the source payment network and the destination delivery are determined separately. No token is created without inventory/liquidity/provider/sponsorship. If source gas is zero, an ordinary tx cannot start; verified sponsorship, pre-funding or payment from another network requires separate financing/security. Topup quote, fee, delivery/refund/timeout; treasury/custody/relayer/paymaster key management; abuse/Sybil, rate limit, accounting and loss limits are in the scope of a separate phase. It is not assumed that the V1 bridge will support this capability in the future.

V3: SwapProvider is separate from the bridge adapter. The native/wrapped distinction, router allowlist, approval, slippage, price impact, minimum output and quote expiry must be verified. Bridge+swap is not atomic; the bridge can complete and the swap can fail. Each leg needs its own gas and recovery path. It is not implemented without real liquidity/router verification and a separate release approval. Explaining external DEX usage in Help is not an integrated swap or a V3 delivery.
