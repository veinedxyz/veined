# Platform fee policy

Commercial target: 5 basis points, 0.05%. Hard ordinary-route ceiling: 10 basis points, 0.10%. Current runtime policy is immutable disabled/0 bps/disabled recipient. Real collection, withdrawals and fee wallets are not configured.

`platformFee` validates amount grammar, integer basis points, the hard ceiling and recipient mode. Amount times bps divided by 10,000 uses BigInt and floors at base-unit precision. Tests cover zero, target, ceiling, overflow-sized token balances and rejected invalid policies. Fee fixtures do not enable runtime collection. Upstream queries explicitly request zero integrator fee.

Review displays Otherbridge fee separately from protocol fees, gas and price impact. An upstream service fee is never renamed Otherbridge fee. The received quote rejects a nonzero platform fee envelope. Quote binding and future intent schema prevent a fee mutation after review.

Before future collection: owned integrator account/fee recipient, verified fee semantics and withdrawal/custody behavior, measured complete fee stack, legal review and explicit release approval. Prefer a native integrator mechanism without custody of principal. No Otherbridge fee/router/escrow contract exists or is introduced.
