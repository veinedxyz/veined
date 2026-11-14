# Future G7 owner release runbook

V1.16 stops before owner approval and any wallet request. Existing accepted G7 protected files remain byte-identical. No current release receipt authorizes G7.

1. Verify exact RC source, build, package hashes and active 107-member baseline.
2. Run verify-safety, g7:safety and g7:pilot:safety against that artifact.
3. Run read-only preflight; confirm reserve/route pins, amount, chain, recipient and kill state.
4. Obtain separate explicit owner G7 approval with expiry and revocation reference. STOP in V1.16 before this step.
5. Only in a separately authorized future milestone request the owner wallet.
6. Independently review decoded transaction, fees, slippage and expected economic result.
7. Broadcast only the exact approved transaction, once.
8. Verify canonical receipt, finality, balances and reserve accounting; do not call a timeout a success.
9. Any mismatch: kill, preserve evidence, revoke credential/approval as applicable, invalidate RC and follow incident response.

Swap approval never authorizes G7; old pilot authorizations never authorize a new RC.
