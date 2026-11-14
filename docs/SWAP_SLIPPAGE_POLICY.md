# Swap slippage and impact policy
V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Auto currently means a conservative fixed 50 bps, not an implemented volatility oracle or RTSE. Manual is bounded to 1–300 bps. Exact-input minimum must be positive and at least floor(output*(10000-bps)/10000); exact-output requires the exact requested output and bounded maximum input, rounded upward. Unsupported exact-output modes are excluded. No native exact-output build is accepted without its refund proof.

Jupiter order priceImpact is percentage; build priceImpactPct is fraction. Both become bps explicitly. Other provider units are declared by adapters and tested. Absolute impact at or above 1500 bps blocks review. Unknown impact is displayed as unknown and is not represented as safe or low. Changing slippage invalidates old quote/review state.

Current scope: Universal Router native exact-output remains unsupported until exact refund proof is admitted. Slipstream native exact-output uses its independently reviewed bounded refund/unwrap multicall. Unsupported capability stays false.
