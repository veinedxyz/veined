# DeFi coverage

Explore DeFi coverage lists every protocol and network in the current accepted DeFi catalog with its {{BRAND}} coverage: full, partial, discovery only, not checked, cataloged (position adapter not yet implemented), unsupported, needs review or deprecated. A cataloged protocol without an adapter is never shown as a zero balance. Protocol TVL is shown as context, never as your balance.

Coverage details report actual protocol/chain reads. A successful full read may return zero; failed or unexecuted reads are never zero. Discovery is candidate-driven: account-level protocols are read directly, LP and vault families only behind exact held receipt tokens whose identity is proven on-chain, and Morpho markets and vaults from a complete local registry index where one exists. Non-EVM DeFi positions are not checked yet; those networks remain cataloged.

Missing position reasons include no reviewed adapter for that protocol or network, an unreviewed pool type or strategy, LP staked in another contract (gauges, MasterChef), an incomplete local index, a failed RPC read or an unavailable price. Open coverage details and refresh to inspect the result.
