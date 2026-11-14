# VEINED Guardian — architecture

Guardian is the intelligence and defense layer of VEINED: the "king octopus" that sees every arm. VEINED is the
interface (portfolio, swap, bridge across many networks); Guardian reads every action before anything could be
signed and answers one question: **should this be signed, and why?**

## Layers

```
 VEINED surfaces                         AI agents / other apps
 Swap · Bridge · Portfolio · /guardian   (POST /api/guardian)
          │ facts (validated)                      │ wallet JSON, NEP-413, policy
          ▼                                        ▼
 ┌──────────────────────── Guardian core (src/guardian, pure TypeScript) ───────────────────────┐
 │ rules.ts   assets (registry evidence, impersonation, lures) · route (impact, value loss,       │
 │            slippage, staleness, cross-check, outliers) · recipients (self, poisoning, burn,    │
 │            token contract) · approvals (unlimited, Permit2) · bridge steps · portfolio sweep    │
 │ near.ts    NEAR accounts (named / sub / implicit / ETH-implicit, look-alikes, lures, bridged   │
 │            variants) · transactions (Transfer, FunctionCall, AddKey, DeleteKey, DeleteAccount, │
 │            DeployContract, Stake, NEP-366 Delegate) · NEP-413 messages (intents.near payloads)  │
 │ agent.ts   Agent Gate: owner policy (receiver + method allowlists, per-action and daily limits)│
 │            ∧ Guardian review → ALLOW / WARN / ESCALATE / BLOCK                                 │
 │ intents.ts NEAR Intents 1Click wire schemas (dry: true is a literal) + route rules             │
 │ verdict.ts one aggregation rule, ordered safe path, sha256 digest over policy+facts+findings   │
 │ signing.ts Chain Signatures envelope, produced only when the verdict allows it                 │
 └───────────────────────────────────────────────────────────────────────────────────────────────┘
          │                                        │
          ▼ server-only adapters (src/guardian/server)
   intents.ts   1click.chaindefuser.com  GET /v0/tokens, POST /v0/quote (dry) — fixed origin, 8 s, bounded
   near-rpc.ts  NEAR RPC view_account (finality final) — 2.5 s, bounded, failure adds nothing
   narrator.ts  NEAR AI Cloud /v1/chat/completions + /v1/signature/{id} — optional, guarded output
```

## NEAR components and why each is used

| Component | What Guardian does with it | State in this build |
|---|---|---|
| **NEAR Intents (1Click)** | "Route toward NEAR": a dry quote from Base / Ethereum / Arbitrum / BNB / Solana to a NEAR account, reviewed (destination token identity by exact contract, recipient account, refund address, value lost, ETA) before anything could be deposited. | Live, read-only; `dry: true` enforced by the schema; no deposit address is ever requested. |
| **NEAR accounts** | Account-id rules, look-alike detection (confusable skeleton, embedded names, edit distance, implicit-key twins), lure words, sub-account parents, bridged variants (USDC.e vs native USDC), on-chain existence (`view_account`). | Live (RPC is optional and fail-soft). |
| **Access keys** | Full-access key grants block; function-call keys are described (contract, methods) and flagged when unlimited. The Agent Gate design gives an agent only a function-call key. | Reviewed; no key is created. |
| **Meta transactions (NEP-366)** | A `Delegate` is reviewed through its inner actions; the relayer and expiry height are shown. | Reviewed. |
| **NEP-413 messages** | A "sign this message" request for `intents.near` is treated as moving funds; `add_public_key` intents block. | Reviewed. |
| **Chain Signatures** | The signing request (`v1.signer` / `v1.signer-prod.testnet`, `sign`, `payload_v2.Ecdsa`, `domain_id: 0`, path) exists only after Guardian allows the action and carries the verdict digest. | Prepared only; never submitted. |
| **NEAR AI Cloud** | Private (TEE) narration of a finished verdict in the user's language, with the completion signature passed through for verification. | Optional; needs owner credentials. |

## Security model

- **Deterministic first.** Verdicts come from rules over validated facts; the same input always yields the same verdict
  and digest (tested). The language model is a narrator, not a judge.
- **Untrusted text stays data.** Token names, account names and an agent's stated reason are display text: sanitized,
  bounded, never parsed for instructions. The agent's reason cannot change a decision (test G10). The narrator receives
  only finding codes and sanitized parameters; its output is rejected if it adds links, ungrounded numbers or accounts,
  or calls a HOLD/BLOCK safe (test G19).
- **Identity is exact.** Assets are chain + contract, never symbol; NEAR tokens are their contract accounts.
- **Fail closed where it matters, fail soft where it informs.** Malformed actions are refused (strict schemas, no nested
  delegates); a missing named recipient blocks; an unavailable RPC or narrator only removes extra evidence.
- **Closed execution.** No signer, relayer or broadcast code; the existing VEINED safety scan (`scripts/verify-safety.mjs`)
  still passes; one wallet send in the codebase, unchanged.
- **Egress is fixed.** Three hard-coded HTTPS origins, no caller-supplied URL, timeouts and body caps on every call.

## Verdict scale

| Severity | Meaning | Verdict effect |
|---|---|---|
| PASS | a check found the expected evidence | — |
| INFO | context | — |
| CAUTION | proceed only if intended | CAUTION → agent WARN |
| WARNING | verify before continuing | HOLD → agent ESCALATE |
| CRITICAL | matches a fund-losing pattern | BLOCK |

## Next milestone: the Guardian vault (on-chain)

`agent.ts` is the reference semantics for a NEAR contract that makes the policy unbypassable:

1. The owner deploys `guardian.<owner>.near` with the policy (allowlists, per-action and daily limits) and funds it.
2. The agent receives **only a function-call key** for the vault, limited to `propose(action)` — it cannot transfer,
   add keys or call anything else (NEAR access-key semantics).
3. `propose` evaluates the same rules; ALLOW executes (for NEAR actions) or calls `v1.signer.sign` with the vault's own
   deposit (for foreign chains via Chain Signatures — the vault is the predecessor, so derived addresses belong to it);
   ESCALATE queues the action for the owner's full-access confirmation; BLOCK records the reason.
4. The verdict digest is stored with every decision for audit, and a NEAR AI Cloud attestation can be attached to the
   explanation.

This keeps the property the track asks for: **an agent can spend, but never more, never elsewhere and never with the
keys to everything.**
