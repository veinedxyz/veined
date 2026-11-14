# Protocol-native risk

Aave: getUserAccountData health factor at the same pin. Display attention HF < 1, monitor 1 ≤ HF < 1.5, otherwise none. No-debt uint256 sentinel is not shown as real HF; HF zero with debt remains attention. LTV/liquidation threshold from protocol account basis points.

Compound III: isBorrowCollateralized and isLiquidatable from official Comet. Attention if borrow collateralized=false or liquidatable=true. No invented HF.

Morpho Blue: virtual share conversion including expected interest and fee share minting. Debt rounds up; fee recipient shares include accrued fee shares. A reviewed oracle's native IOracle price scale 1e36 computes collateral in loan raw units; LTV / LLTV / margin remain distinct. Attention LTV ≥ LLTV; monitor ≥90% of LLTV. Production curated oracle set currently empty, so ORACLE_NOT_REVIEWED is returned instead of fabricated LTV; deterministic reviewed-oracle fixtures validate the implementation. Nonofficial IRMs cannot receive arbitrary view calls.

Snapshots older than 60 s display stale and suppress fresh metric presentation. No universal threshold or liquidation prediction. Liquidity range is not lending risk; staking/vault positions have no invented HF. Missing risk fields, APY and oracle freshness enrichment are stated, never guessed.
