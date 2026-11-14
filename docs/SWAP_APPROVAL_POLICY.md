# Swap approval policy
V1.15.1 repair candidate: **RETURN_FOR_REPAIR / EXECUTION_CLOSED**. Status is a review gate; independent security/legal approval and production release are external.

Native input: no ERC20 approval. Aerodrome ERC20 input: future exact bounded token approval to the pinned router. Universal Router ERC20 input: distinguish the token allowance to the chain/provider-specific Permit2 contract from typed authorization of the router spender. Review displays kind, token-approval spender, authorization spender and maximum amount; no transaction or signature request is emitted.

approval.ts checks quote ID, intent digest, owner, token, spender, chain/domain, nonce, expiry and amount. Unlimited amounts and stale/replayed authorizations are rejected. Requote changes the binding. The model sets signable=false. This does not constitute implemented wallet approval UX or a signed permit verifier. Embedded permit commands are rejected by the current restricted EVM decoder.
