# Protocol risk metrics

Aave uses protocol-native health factor. Compound III uses borrow collateralization and liquidatability booleans. Morpho shows LTV/LLTV/margin only with reviewed oracle semantics; the current production oracle registry is unreviewed so metrics are unavailable. No universal invented health factor is produced.

Data older than 60 seconds is not presented as fresh risk. “Position may require attention” is informational, not a liquidation prediction. Unpriced debt, unchecked protocols and failed reads never imply a safe position. Unverified APY is omitted.
