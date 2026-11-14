# VEINED Guardian — submission draft (NEAR HACKATHON)

Status: **draft for the owner**. The event is NEAR HACKATHON. Submissions close on **14 Nov 2026 at 23:59 UTC**, and
judging runs from 16 to 18 Nov.

## Track decision

| Track | Fit | Decision |
|---|---|---|
| **AI Security & Defense** | The track asks for "spending limits, policy engines, sandboxed wallets, reputation and scam detection". Guardian does each of these: the Agent Gate holds the policy and the limits, the NEAR-native rules do the scam detection, and every check returns allow/warn/block with reasons. | **Primary** |
| Unstoppable DeFi | VEINED routes value across chains, and Route toward NEAR uses NEAR Intents. Guardian is the safety layer for that flow. | Secondary |
| Agent Economy | The Agent Gate is a service that agents can call before they spend. | Mention only |
| Autonomous Business / Open Innovation | These are weaker fits and would dilute the story. | No |

## Positioning statement

> VEINED Guardian is a pre-signing firewall for people and AI agents. Before a swap, a bridge, a NEAR transaction or a
> signed intent is approved, Guardian reads it. It checks the exact assets, accounts, keys and routes, then answers
> allow, warn, escalate or block, and explains why. It is built on NEAR Intents, NEAR accounts and Chain Signatures.

## Description (form field, 20–2000 characters)

> VEINED Guardian is a pre-signing security layer for multichain DeFi and for AI agents that hold money. Every action is
> reviewed before it could be signed: swaps, bridges, NEAR transactions (including NEP-366 meta transactions) and
> NEP-413 signed messages. Guardian answers ALLOW, WARN, ESCALATE or BLOCK, gives the reasons and a safe path, and adds
> a reproducible review digest.
>
> What it catches:
> - same-symbol token impersonation
> - look-alike and lure NEAR accounts
> - address poisoning
> - full-access-key grabs and account deletion
> - signed intents that would add a key on intents.near
> - unlimited approvals, price impact and value loss, stale or outlier quotes
> - recipients that do not exist (live NEAR RPC check)
>
> The Agent Gate gives an agent a budget and an allowlist instead of keys. The owner's per-action and daily limits,
> receiver and method allowlists, and Guardian's own review decide every proposal. In our demo, a prompt-injected
> trading agent is blocked three times and escalated once, while its legitimate trades go through.
>
> Built on NEAR:
> - live dry NEAR Intents quotes for routes toward NEAR, reviewed before any deposit
> - NEAR account and access-key semantics
> - a Chain Signatures signing request that is only prepared after Guardian allows the action, bound to the verdict digest
> - optional NEAR AI Cloud narration in a TEE, which explains a verdict but never decides it
>
> Verdicts are deterministic rules, not model output. Untrusted text (token names, agent reasons) can never change a
> decision. The integration runs inside VEINED's existing read-only multichain interface; execution stays closed.

(about 1,600 characters)

## X post outline (attach a 60–90 s video)

1. **Hook:** "AI agents are getting wallets. Who checks what they sign?"
2. **Clip:** the compromised agent replay. Two trades are allowed, then a prompt-injected "claim reward" transfer, a
   full-access key request and a look-alike owner account are all **blocked**, and the over-budget action goes to the
   owner.
3. **Clip:** Inspect blocks a signed `intents.near` message that adds a key, and a look-alike `usdt.tether-tokens.near`.
4. **Clip:** Route toward NEAR. A live NEAR Intents dry quote from Base to `alice.near` is reviewed **Clear**; with a
   look-alike recipient it is **Blocked**.
5. **Close:** "VEINED Guardian: allow / warn / escalate / block, with reasons. Built at #NEARHackathon on NEAR Intents,
   NEAR accounts and Chain Signatures. @NEARProtocol" plus the repo link.

## Demo video script (about 90 s)

| Time | Scene |
|---|---|
| 0–10 s | VEINED landing, then the app. "Guardian is the intelligence layer: it reads before you sign." |
| 10–40 s | `/guardian`, **Replay a compromised agent**. Read the tally, then open one BLOCK review. |
| 40–60 s | Inspect: **Signed intent** (Blocked), **Look-alike token** (Blocked), **Safe wrap** (Clear, with the Chain Signatures request prepared). |
| 60–80 s | Route toward NEAR: run a live dry quote, then change the recipient to a look-alike and show it Blocked. |
| 80–90 s | Swap with the Guardian panel. End on the line "Deterministic review · Nothing is signed". |

## Before final submission (owner checklist)

1. **Public repo.** Apply the Guardian patch on a dedicated branch and tag `pre-hackathon` and `hackathon-submission`.
   Link the diff from the README, as the rules allow for existing products. Make sure no secrets are in the history.
2. **Hosted demo (optional but recommended).** Deploy a read-only preview and keep it up until 18 Nov, ideally 25 Nov.
   It needs owner approval and hosting credentials.
3. **NEAR AI Cloud key (optional).** Enable narration to show TEE-attested explanations.
4. **Vault contract (stretch).** The on-chain Guardian vault on testnet: the agent holds a function-call key and the
   vault calls `v1.signer`. It is the strongest addition for this track if time allows.
5. **Record and post.** Record the video, then publish the X post with @NEARProtocol and #NEARHackathon.
6. **Payout account.** Have a mainnet NEAR account ready for the payout.
7. **Submit.** Use the form or `POST /api/applications` with track `security`. There is one submission per repo.
